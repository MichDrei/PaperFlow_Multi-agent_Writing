/**
 * 纯文本处理工具：定性的文本变换与统计。
 *
 * 放在 core 而不是某个 app 里，是因为它被三处共用：
 * - 前端 mock 引擎（浏览器内模拟模型）；
 * - 服务端 Mock 提供方（无 Key 时的本地回退）；
 * - 术语/一致性检查。
 * 全部是确定性函数，无 IO、无副作用，因此谁都能安全依赖。
 */

/**
 * 行尾归一化：CRLF / CR → LF。
 *
 * 必须在"进入解析管线"的边界上调用。原因：Windows 编辑器（或 git 的 autocrlf）
 * 可能把源码变成 CRLF，而 JS 正则里不带 m 标志的 `$` 只匹配输入末尾，
 * `.` 又不匹配 `\r`——于是 `/% .*$/` 这类"剥离 LaTeX 注释"的写法会**静默失效**，
 * 注释里的花括号被当成真代码，报出假的编译错误。这个坑真的踩过。
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

const FILLERS: [RegExp, string][] = [
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bthe fact that\b/gi, 'that'],
  [/\bit is worth noting that\b/gi, ''],
  [/\bit should be noted that\b/gi, ''],
  [/\bvery\s+/gi, ''],
  [/\bquite\s+/gi, ''],
  [/\breally\s+/gi, ''],
  [/\bbasically\s+/gi, ''],
  [/\bin particular,?\s+/gi, ''],
  [/\bwe further show that\b/gi, 'We show that'],
  [/\ba large number of\b/gi, 'many'],
  [/\bis able to\b/gi, 'can'],
  [/\bare able to\b/gi, 'can'],
  [/\bhas the ability to\b/gi, 'can'],
  [/\bmake use of\b/gi, 'use'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bconducted an experiment\b/gi, 'experimented'],
  [/\bin spite of the fact that\b/gi, 'although'],
  [/\bfor the purpose of\b/gi, 'to'],
];

export const HEDGE_WORDS = [
  'may',
  'might',
  'could possibly',
  'somewhat',
  'arguably',
  'seems to',
  'appears to',
  'relatively',
];

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?=\S)/g, '$1 ')
    .replace(/\s+$/gm, '')
    .replace(/^\s+/gm, (m, offset: number) => (offset === 0 ? '' : m))
    .trim();
}

/** 压缩冗余表达，保留全部事实性信息。 */
export function tighten(text: string): string {
  let out = text;
  for (const [pattern, replacement] of FILLERS) out = out.replace(pattern, replacement);
  // 删掉句首填充词后可能留下小写开头（如 "In order to X" → "to X"），需要重新大写。
  out = restoreSentenceCase(out);
  return tidy(out);
}

/** 把句首字母恢复为大写（不动公式与命令）。 */
function restoreSentenceCase(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, prefix: string, ch: string) => `${prefix}${ch.toUpperCase()}`);
}

/**
 * 合并段内硬换行（LaTeX 里源码换行不影响排版，但会让 diff 变得难以阅读）。
 *
 * 安全性规则：命令独占一行、以 \\ 结尾、空行、注释行都**不**参与合并，
 * 否则会把 `\begin{document}` 和 `\maketitle` 拼成一行，直接破坏文档结构。
 */
/** 行尾是否以反斜杠结束（`\\` 是 LaTeX 换行，`\` 是续行）——这类行不能合并。 */
function endsWithBackslash(line: string): boolean {
  const trimmed = line.trimEnd();
  return trimmed.endsWith('\\');
}

export function rewrapParagraphs(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    const prev = out[out.length - 1];
    const isBlank = line.trim() === '';
    const startsWithCommand = /^\s*\\/.test(line);
    const prevIsBlank = prev === undefined || prev.trim() === '';
    const prevStartsWithCommand = prev !== undefined && /^\s*\\/.test(prev);
    const prevIsComment = prev !== undefined && /(^|[^\\])%/.test(prev);
    const prevHasExplicitBreak = prev !== undefined && endsWithBackslash(prev);

    const joinable =
      prev !== undefined &&
      !isBlank &&
      !startsWithCommand &&
      !prevIsBlank &&
      !prevStartsWithCommand &&
      !prevIsComment &&
      !prevHasExplicitBreak;

    if (joinable) out[out.length - 1] = `${prev!.trimEnd()} ${line.trimStart()}`;
    else out.push(line);
  }
  return out.join('\n');
}

/** 润色：修标点、统一数学模式空格、把口语连接词换成学术表达。 */
export function polish(text: string): string {
  let out = tighten(text);
  out = out.replace(/\s*\$\s*/g, ' $');
  out = out.replace(/\s*\$\s*/g, '$ ');
  out = out.replace(/\bbut\b/g, 'however,');
  out = out.replace(/\bso\b(?=\s+\w)/g, 'therefore,');
  out = out.replace(/\ba lot of\b/g, 'substantial');
  out = out.replace(/([.!?])\s+([a-z])/g, (_m, p: string, c: string) => `${p} ${c.toUpperCase()}`);
  out = out.replace(/,\s*,/g, ',');
  return tidy(out);
}

/** 扩写：为段落补充一个可验证的收尾句，不编造数据。 */
export function expand(text: string, topic: string): string {
  const base = polish(text);
  return `${base} We report the effect size and its confidence interval for ${topic} in the experiments section, so that the claim can be checked against the main results table.`;
}

export interface ReviewFinding {
  severity: 'high' | 'medium' | 'low';
  message: string;
}

const CITATION_RE = /\\(cite|citep|citet|autocite)\{/;
const CLAIM_WORDS = [
  'outperforms',
  'improves',
  'reduces',
  'achieves',
  'significantly',
  'state-of-the-art',
  'novel',
  'first',
];

/** 对一段文本做"审稿式"静态分析，返回可定位的具体问题。 */
export function reviewFindings(text: string, terminologyViolations = 0): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const long = sentences.filter((s) => s.split(/\s+/).length > 38);
  if (long.length > 0) {
    const longest = Math.max(...long.map((s) => s.split(/\s+/).length));
    findings.push({
      severity: 'medium',
      message: `${long.length} 个句子超过 38 词（最长 ${longest} 词），建议拆句：审稿人通常把超长句视为论证不清晰的信号。`,
    });
  }

  const passive = sentences.filter((s) => /\b(is|are|was|were|been)\s+\w+(ed|en)\s+by\b/i.test(s));
  if (passive.length > 0) {
    findings.push({
      severity: 'low',
      message: `检测到 ${passive.length} 处被动语态，方法部分可改为主动语态以明确施事者。`,
    });
  }

  const claims = sentences.filter((s) => CLAIM_WORDS.some((w) => s.toLowerCase().includes(w)));
  const unsupported = claims.filter((s) => !CITATION_RE.test(s) && !/\\ref\{/.test(s) && !/\d/.test(s));
  if (unsupported.length > 0) {
    findings.push({
      severity: 'high',
      message: `有 ${unsupported.length} 处强结论表述缺少引用或数据支撑，例如：“${truncate(unsupported[0]!, 90)}”。请补 \\cite{} 或指向具体表格。`,
    });
  }

  const hedges = sentences.filter((s) => HEDGE_WORDS.some((h) => new RegExp(`\\b${h}\\b`, 'i').test(s)));
  if (hedges.length > 0) {
    findings.push({
      severity: 'medium',
      message: `${hedges.length} 处模糊限定（${HEDGE_WORDS.slice(0, 4).join('/')}…）削弱了结论强度；若数据支持，请给出确定表述。`,
    });
  }

  if (terminologyViolations > 0) {
    findings.push({
      severity: 'high',
      message: `与共享术语表冲突 ${terminologyViolations} 处，会导致全文概念不统一。`,
    });
  }

  const numbers = text.match(/\d+(\.\d+)?x?\b/g) ?? [];
  if (numbers.length === 0 && CLAIM_WORDS.some((w) => text.toLowerCase().includes(w))) {
    findings.push({ severity: 'medium', message: '该段落包含效果性论断但没有任何数值，建议给出量化结果。' });
  }

  if (findings.length === 0) {
    findings.push({ severity: 'low', message: '未发现结构性问题；论证链条与引用看起来完整。' });
  }
  return findings;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 统计词数：英文按词、中日韩按字。 */
export function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const latin = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9$\\][^\s]*/g) ?? []).length;
  return cjk + latin;
}

/** 粗略 token 估算：英文 ~4 字符/token，中日韩 ~1.5 字符/token。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.round(cjk / 1.5 + rest / 4);
}


/**
 * 一轮对话里"论文 + 资料"可用的字符预算。
 *
 * 取值理由：上下文窗口的一半留给输入（其余给输出与安全余量），
 * 再按 2.5 字符/token 保守换算（英文约 4、中文约 1.5，取中间值以免中文论文爆掉）。
 *
 * 抽到 core 是为了让**序列化器与前端界面共用同一份公式**——
 * 否则界面上显示的预算与实际发出的内容会不一致，用户没法据此规划成本。
 */
export const CONTEXT_INPUT_RATIO = 0.5;
export const CHARS_PER_TOKEN_ESTIMATE = 2.5;
/** 论文正文最多占用上面预算的比例，剩下的留给参考资料。 */
export const PAPER_BUDGET_RATIO = 0.7;

export function contextBudgetChars(contextWindow: number): number {
  return Math.floor(contextWindow * CONTEXT_INPUT_RATIO * CHARS_PER_TOKEN_ESTIMATE);
}

export function paperBudgetChars(contextWindow: number): number {
  return Math.floor(contextBudgetChars(contextWindow) * PAPER_BUDGET_RATIO);
}

/**
 * 在 LaTeX 源码里找到 PDF 中选中的那段文字。
 *
 * 场景：用户在 PDF 预览里选了一句话、双击，希望编辑器跳到对应的源码行
 * （Overleaf 的 SyncTeX 反向定位）。我们不用 SyncTeX，而是做**文本匹配**：
 * PDF 里的正文文字通常与 .tex 源码里的文字逐字对应，所以直接找就够了。
 *
 * 几个必须处理的现实差异：
 * 1. PDF 提取出的文字里，行内换行会变成空格、还可能多出多余空白 → 两边都做空白归一化；
 * 2. TeX 会把 `--`/`---` 排成 en/em dash、把引号排成弯引号 → 反向映射回 ASCII；
 * 3. 一句话中间可能夹着公式或 `\cite{}`，导致整句匹配不上 →
 *    **逐步截短前缀**（最多试前 3 个词），至少能跳到这句话的开头，而不是什么都找不到。
 *
 * 返回源码中的字符区间，调用方据此算出行号并高亮。
 */
export interface LocateContext {
  /** 点击处占全文的比例（0~1）——根据页码粗略判断大致位置。 */
  ratio?: number;
  /** PDF 里紧挨在选中内容**前面**的文字（同一行的左侧）。用于消歧。 */
  before?: string;
  /** PDF 里紧挨在选中内容**后面**的文字（同一行的右侧）。 */
  after?: string;
}

/**
 * 给候选位置打分：看它**左右紧邻的文字**是否和 PDF 里一致。
 *
 * 为什么需要它：同一个词在论文里出现几十次，只按"离页面比例最近"猜并不可靠。
 * 但 PDF 那一行的左右文字是确定的——把它们和源码里候选处的前后文比对，
 * 就能把候选分辨开。这比页码比例强得多，而且不依赖 SyncTeX。
 */
function contextScore(
  source: string,
  index: number,
  length: number,
  before = '',
  after = '',
): number {
  let score = 0;
  const normalize = (text: string) => normalizeForSearch(text).toLowerCase();
  const sourceBefore = normalize(source.slice(Math.max(0, index - 120), index));
  // ⚠️ 必须从匹配**之后**开始取：早先写成 source.slice(index, …)，
  // 于是比较的第一个词是匹配本身（"wrench space…" 里比的是 "wrench"），
  // 右侧上下文永远匹配不上、整个信号等于没用。
  const sourceAfter = normalize(source.slice(index + length, index + length + 120));
  // 从紧邻处往外比：越靠近的词权重越高
  const tail = normalize(before).split(' ').filter(Boolean).slice(-6).reverse();
  const head = normalize(after).split(' ').filter(Boolean).slice(0, 6);
  for (let i = 0; i < tail.length; i += 1) {
    if (sourceBefore.endsWith(tail.slice(0, i + 1).reverse().join(' '))) score += 6 - i;
  }
  for (let i = 0; i < head.length; i += 1) {
    if (sourceAfter.startsWith(head.slice(0, i + 1).join(' '))) score += 6 - i;
  }
  return score;
}

export function findTextInSource(
  source: string,
  needle: string,
  options: LocateContext = {},
): { index: number; length: number } | null {
  const cleaned = normalizeForSearch(needle);
  if (cleaned.length < 2) return null;

  const words = cleaned.split(' ').filter(Boolean);
  if (words.length === 0) return null;

  // 从整句开始，逐步退到只用前 3 个词
  for (let take = words.length; take >= Math.min(3, words.length); take -= 1) {
    const phrase = words.slice(0, take).join(' ');
    // 空白处允许任意空白（源码里的换行、缩进都能匹配）
    const pattern = phrase.split(' ').map(escapeRegExp).join('\\s+');
    const regex = new RegExp(pattern, 'gi');
    const matches: { index: number; length: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      matches.push({ index: match.index, length: match[0].length });
      if (matches.length >= 200) break;
      if (match[0].length === 0) regex.lastIndex += 1; // 防零宽匹配死循环
    }
    if (matches.length === 0) continue;

    // 同一个词/句常出现多次。只取第一处会让人感觉"跳错了地方"。
    if (matches.length === 1) return matches[0]!;

    const target = options.ratio === undefined ? undefined : Math.max(0, Math.min(1, options.ratio)) * source.length;
    const hasContext = Boolean(options.before || options.after);

    let best = matches[0]!;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of matches) {
      // ① 上下文匹配（最可信的信号）
      const score = hasContext
        ? contextScore(source, candidate.index, candidate.length, options.before, options.after)
        : 0;
      // ② 比例接近度只作为次要信号，且量纲要压到不会盖过上下文
      const proximity =
        target === undefined ? 0 : 1 - Math.min(1, Math.abs(candidate.index - target) / Math.max(1, source.length));
      const total = score + proximity * (hasContext ? 0.5 : 100);
      if (total > bestScore) {
        best = candidate;
        bestScore = total;
      }
    }
    return best;
  }
  return null;
}

/** PDF 提取文字与源码之间需要抹平的排版差异。 */
export function normalizeForSearch(text: string): string {
  return (
    text
      .replace(/\u00a0/g, ' ') // 不换行空格
      .replace(/[\u2018\u2019\u201b]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\u2013/g, '--')
      .replace(/\u2014/g, '---')
      .replace(/\u2026/g, '\\ldots')
      .replace(/\ufb01/g, 'fi') // ﬁ 连字
      .replace(/\ufb02/g, 'fl') // ﬂ 连字
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 由字符下标算出行号（1 起）。 */
export function lineAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * 由字符下标算出**行 + 列**（都是 1 起，列按 UTF-16 码元计——与 Monaco 一致）。
 *
 * 只给行号是不够的：用户要的是"定位到那个词"，而不是"跳到那一行"。
 * 编辑器需要 (line, column) 才能把光标放到词上并选中它。
 */
export function positionAtOffset(source: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}
