/**
 * BibTeX 解析：把 .bib 文本转成规范化 Citation[]。
 *
 * 刻意不引入解析库——但**必须**自己实现括号配对扫描：
 * 用正则匹配条目体在遇到 `title = {A {B} C}` 这类嵌套花括号时会提前截断，
 * 这是最典型的"看起来能跑、实际丢字段"的 bug。
 */

import type { Citation } from '@paperflow/core';

interface RawEntry {
  type: string;
  key: string;
  body: string;
}

/** 从 `start` 处的开括号扫描到配对的闭括号，返回内容区间 [from, to)。 */
function scanBalanced(source: string, openIndex: number): { content: string; end: number } | null {
  const open = source[openIndex];
  const close = open === '{' ? '}' : open === '(' ? ')' : null;
  if (!close) return null;

  let depth = 0;
  let inQuote = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') {
      i++; // 跳过转义字符
      continue;
    }
    if (ch === '"' && open === '{') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { content: source.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** 扫描出所有条目（忽略 @string / @preamble / @comment）。 */
function scanEntries(source: string): RawEntry[] {
  const entries: RawEntry[] = [];
  const re = /@([A-Za-z]+)\s*([{(])/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const type = (match[1] ?? '').toLowerCase();
    const openIndex = match.index + match[0].length - 1;
    const scanned = scanBalanced(source, openIndex);
    if (!scanned) continue;
    re.lastIndex = scanned.end;

    if (type === 'string' || type === 'preamble' || type === 'comment') continue;

    const body = scanned.content;
    const comma = body.indexOf(',');
    const key = (comma === -1 ? body : body.slice(0, comma)).trim();
    const fields = comma === -1 ? '' : body.slice(comma + 1);
    entries.push({ type, key, body: fields });
  }
  return entries;
}

/** 扫描条目体里的 `name = value` 对，值同样按括号配对切分。 */
function scanFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;

  while (i < body.length) {
    // 跳过分隔符与空白
    while (i < body.length && /[\s,]/.test(body[i]!)) i++;
    const nameMatch = /^([A-Za-z][\w-]*)\s*=/.exec(body.slice(i));
    if (!nameMatch) {
      // 无法识别的片段：跳到下一个逗号，避免死循环
      const next = body.indexOf(',', i);
      if (next === -1) break;
      i = next + 1;
      continue;
    }
    i += nameMatch[0].length;
    while (i < body.length && /\s/.test(body[i]!)) i++;

    const ch = body[i];
    let value = '';
    if (ch === '{' || ch === '(') {
      const scanned = scanBalanced(body, i);
      if (!scanned) break;
      value = scanned.content;
      i = scanned.end;
    } else if (ch === '"') {
      const end = body.indexOf('"', i + 1);
      value = end === -1 ? body.slice(i + 1) : body.slice(i + 1, end);
      i = end === -1 ? body.length : end + 1;
    } else {
      const end = body.indexOf(',', i);
      value = end === -1 ? body.slice(i) : body.slice(i, end);
      i = end === -1 ? body.length : end + 1;
    }
    fields[nameMatch[1]!.toLowerCase()] = value;
  }
  return fields;
}

/** 去掉 BibTeX 的括号保护与常见 LaTeX 转义。 */
function unwrap(value: string): string {
  return value
    .replace(/[{}]/g, '')
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_')
    .replace(/\\['`^"~=.]/g, '')
    .replace(/---?/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitAuthors(raw: string): string[] {
  return raw
    .split(/\s+and\s+/i)
    .map((a) => unwrap(a))
    .filter(Boolean);
}

export function parseBibtex(source: string): Citation[] {
  return scanEntries(source).map((entry) => {
    const fields = scanFields(entry.body);
    const yearNum = Number.parseInt(unwrap(fields.year ?? ''), 10);
    return {
      key: entry.key,
      type: (['article', 'inproceedings', 'book', 'techreport'].includes(entry.type)
        ? entry.type
        : 'misc') as Citation['type'],
      title: unwrap(fields.title ?? '') || '(untitled)',
      authors: splitAuthors(fields.author ?? ''),
      year: Number.isFinite(yearNum) ? yearNum : 0,
      venue: fields.journal ? unwrap(fields.journal) : fields.booktitle ? unwrap(fields.booktitle) : fields.publisher ? unwrap(fields.publisher) : undefined,
      doi: fields.doi ? unwrap(fields.doi) : undefined,
      url: fields.url ? unwrap(fields.url) : undefined,
      tags: unwrap(fields.keywords ?? '')
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter(Boolean),
    } satisfies Citation;
  });
}

/** 把结构化条目写回 BibTeX（导出用）。 */
export function toBibtex(citation: Citation): string {
  const lines = [`@${citation.type}{${citation.key},`];
  lines.push(`  title = {${citation.title}},`);
  if (citation.authors.length) lines.push(`  author = {${citation.authors.join(' and ')}},`);
  if (citation.year) lines.push(`  year = {${citation.year}},`);
  if (citation.venue) lines.push(`  ${citation.type === 'article' ? 'journal' : 'booktitle'} = {${citation.venue}},`);
  if (citation.doi) lines.push(`  doi = {${citation.doi}},`);
  if (citation.url) lines.push(`  url = {${citation.url}},`);
  if (citation.tags.length) lines.push(`  keywords = {${citation.tags.join(', ')}},`);
  return `${lines.join('\n')}\n}`;
}

/** 找出源码里引用了但 .bib 中不存在的 key，以及从未被引用的条目。 */
export function auditCitations(
  texSource: string,
  citations: Citation[],
): { missing: string[]; unused: string[] } {
  const cited = new Set<string>();
  const re = /\\(?:cite|citep|citet|autocite)\{([^}]*)\}/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(texSource)) !== null) {
    for (const key of (hit[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean)) cited.add(key);
  }
  const known = new Set(citations.map((c) => c.key));
  return {
    missing: [...cited].filter((k) => !known.has(k)),
    unused: [...known].filter((k) => !cited.has(k)),
  };
}
