/**
 * 轻量检索器：BM25 打分 + 关键片段抽取。
 *
 * 目前用于把"整篇论文 + 全部文献"压缩成能塞进上下文窗口的相关片段。
 * 后续可替换为向量检索（retriever 接口不变），因此上层编排代码无需改动。
 */

import type { Citation, PaperFile, SharedContext } from '@paperflow/core';

export interface RetrievedChunk {
  /** 来源标识，如 "main.tex#L42" 或 "bib:vaswani2017"。 */
  ref: string;
  kind: 'paper' | 'citation' | 'terminology' | 'figure' | 'reference';
  text: string;
  score: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'in', 'is', 'are', 'for', 'on', 'with', 'that', 'this',
  'we', 'as', 'by', 'be', 'it', 'at', 'from', 'or', 'can', 'our', 'which', 'these', 'using',
]);

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 分词：英文按词，日中韩按**字 + 相邻二元组（bigram）**。
 *
 * 为什么必须这样：中文没有空格，如果整段当做一个 token，
 * 那么"关键结论"这个查询永远匹配不上"关键结论是……"这段正文——
 * 表现就是"我加了中文资料，但模型完全用不上"。bigram 是中文检索的经典折中：
 * 不需要词典也能有可用的召回率与区分度。
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const part of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue;
    if (CJK_RE.test(part)) {
      const chars = [...part];
      if (chars.length === 1) {
        // 单个汉字（如"率"）没有 bigram 可用，只能保留原字
        if (!STOPWORDS.has(chars[0]!)) out.push(chars[0]!);
        continue;
      }
      // 只用二元组，不保留单字：单字噪音太大——
      // 曾因为"关"这个字在"关键"和"相关"里都出现，把完全不相关的查询也召回了。
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    } else if (part.length > 1 && !STOPWORDS.has(part)) {
      out.push(part);
    }
  }
  return out;
}

interface Doc {
  ref: string;
  kind: RetrievedChunk['kind'];
  text: string;
  tokens: string[];
  tf: Map<string, number>;
}

function buildDocs(files: PaperFile[], context: SharedContext, windowSize: number): Doc[] {
  const docs: Doc[] = [];
  for (const file of files) {
    if (file.kind !== 'tex') continue;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += windowSize) {
      const slice = lines.slice(i, i + windowSize).join('\n');
      if (slice.trim().length < 24) continue;
      const tokens = tokenize(slice);
      docs.push({
        ref: `${file.path}#L${i + 1}`,
        kind: 'paper',
        text: slice,
        tokens,
        tf: countTokens(tokens),
      });
    }
  }
  for (const c of context.citations) {
    const text = `${c.title} — ${c.authors.join(', ')} (${c.year}) ${c.venue ?? ''} ${c.tags.join(' ')}`.trim();
    const tokens = tokenize(text);
    docs.push({ ref: `bib:${c.key}`, kind: 'citation', text, tokens, tf: countTokens(tokens) });
  }
  for (const t of context.terminology) {
    const text = `${t.term} / ${t.translation}: ${t.definition}`;
    const tokens = tokenize(text);
    docs.push({ ref: `term:${t.id}`, kind: 'terminology', text, tokens, tf: countTokens(tokens) });
  }
  for (const f of context.figures) {
    const text = `Figure ${f.label}: ${f.caption}`;
    const tokens = tokenize(text);
    docs.push({ ref: `fig:${f.id}`, kind: 'figure', text, tokens, tf: countTokens(tokens) });
  }

  // 用户添加的参考资料：按字符切块，保证长文档也能被检索到相关段落。
  // 块太长会挤爆上下文预算，太短会丢语义，600 字符是经验值。
  const REFERENCE_CHUNK = 600;
  for (const reference of context.references ?? []) {
    const text = reference.text.trim();
    if (!text) continue;
    for (let i = 0; i < text.length; i += REFERENCE_CHUNK) {
      const slice = text.slice(i, i + REFERENCE_CHUNK);
      const tokens = tokenize(slice);
      if (tokens.length === 0) continue;
      docs.push({
        ref: `ref:${reference.id}${i > 0 ? `#${Math.floor(i / REFERENCE_CHUNK) + 1}` : ''}`,
        kind: 'reference',
        text: `《${reference.title}》\n${slice}`,
        tokens,
        tf: countTokens(tokens),
      });
    }
  }
  return docs;
}

function countTokens(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

export interface RetrieveOptions {
  /** 返回片段数上限。 */
  topK?: number;
  /** 每个源码窗口包含的行数（越大上下文越连贯，越占 token）。 */
  windowSize?: number;
  /** 只在这些类型里检索。 */
  kinds?: RetrievedChunk['kind'][];
}

/** BM25（k1=1.5, b=0.75）。 */
export function retrieve(
  query: string,
  files: PaperFile[],
  context: SharedContext,
  options: RetrieveOptions = {},
): RetrievedChunk[] {
  const { topK = 8, windowSize = 12, kinds } = options;
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];

  const docs = buildDocs(files, context, windowSize).filter((d) => !kinds || kinds.includes(d.kind));
  if (docs.length === 0) return [];

  const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored = docs.map((doc) => {
    let score = 0;
    for (const term of queryTokens) {
      const f = doc.tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.tokens.length) / avgLen)));
    }
    return { ref: doc.ref, kind: doc.kind, text: doc.text, score } satisfies RetrievedChunk;
  });

  return scored
    .filter((c) => c.score > 0)
    .sort((a, z) => z.score - a.score)
    .slice(0, topK);
}

/** 把检索结果拼成提示词块。 */
export function formatRetrieved(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '';
  return [
    '【从共享知识库中检索到的相关片段】',
    ...chunks.map((c) => `— (${c.kind} ${c.ref}, 相关度 ${c.score.toFixed(2)})\n${c.text}`),
  ].join('\n\n');
}

/** 便捷封装：直接按文献 key 取条目。 */
export function citationByKey(citations: Citation[], key: string): Citation | undefined {
  return citations.find((c) => c.key === key);
}
