/**
 * 编辑器里的 LaTeX 悬浮预览（对齐 Overleaf 的体验）。
 *
 * 四类目标：
 *  1. `\cite{...}` / `\ref{...}` → 参考文献条目的标题、作者、年份
 *     （`\ref` 指向图表时给出它是什么）；
 *  2. `\includegraphics{...}` → 项目里那张图的缩略图（PDF 图渲染第一页）；
 *  3. 数学环境（`$...$`、`$$...$$`、`\[...\]`、`equation`/`align` 等）→ 用 KaTeX 渲染出成品；
 *  4. 符号命令（`\alpha_T`、`\mathcal{F}`、`\sum`…）→ 渲染成它编译后的样子。
 *
 * 为什么要这么做事先说明：**公式不能靠猜**。编辑器里看到的是 LaTeX 源码，
 * 而作者关心的是"它排出来长什么样"，所以这里用 KaTeX 真渲染，而不是显示源码。
 *
 * 注意 KaTeX 覆盖的是常见数学写法；`\begin{align}` 里的 `&` 对齐、自定义宏包命令
 * 可能渲染失败——那种情况会**回退显示源码**而不是给一个空白框（免得让人以为坏了）。
 */

import katex from 'katex';
import type * as Monaco from 'monaco-editor';
import type { PaperFile } from '@paperflow/core';

export interface HoverDeps {
  /** 取项目内文件（用于找图片、.bib）。 */
  getFile: (path: string) => PaperFile | undefined;
  /** 列出项目里所有文件（用于按文件名模糊找图）。 */
  listFiles: () => PaperFile[];
  /** 把图片文件转成可直接显示的 URL（data URL）。PDF 由调用方渲染第一页。 */
  loadImage: (path: string) => Promise<string | undefined>;
  /** 读 .bib 文本内容（可能来自多个文件）。 */
  readBib: () => string[];
}

interface BibEntry {
  key: string;
  title?: string;
  author?: string;
  year?: string;
  venue?: string;
}

/**
 * 解析 BibTeX 条目。
 *
 * 只取悬浮里要用的几个字段，所以用的是"按条目切分 + 按字段抓取"的轻量做法；
 * 大括号嵌套（标题里常有 `{IEEE}`）靠花括号计数处理，不能用正则一刀切。
 */
export function parseBibEntries(bibText: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const entryRe = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(bibText)) !== null) {
    const key = match[2]!;
    // 从条目开始处按花括号计数找到该条目的结尾
    let depth = 1;
    let i = entryRe.lastIndex;
    for (; i < bibText.length && depth > 0; i += 1) {
      const ch = bibText[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    const body = bibText.slice(entryRe.lastIndex, i - 1);
    entries.push({
      key,
      title: fieldOf(body, 'title'),
      author: fieldOf(body, 'author'),
      year: fieldOf(body, 'year'),
      venue: fieldOf(body, 'journal') ?? fieldOf(body, 'booktitle') ?? fieldOf(body, 'publisher'),
    });
  }
  return entries;
}

/** 取一个字段的值（支持 `field = {..}` 与 `field = ".."`，花括号计数防止被嵌套截断）。 */
function fieldOf(body: string, field: string): string | undefined {
  const re = new RegExp(`${field}\\s*=\\s*`, 'i');
  const match = re.exec(body);
  if (!match) return undefined;
  let i = match.index + match[0].length;
  const opener = body[i];
  if (opener === '{') {
    let depth = 0;
    const start = i + 1;
    for (; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return body.slice(start, i).replace(/\s+/g, ' ').replace(/[{}]/g, '').trim();
  }
  if (opener === '"') {
    const end = body.indexOf('"', i + 1);
    return body.slice(i + 1, end === -1 ? body.length : end).trim();
  }
  const end = body.indexOf(',', i);
  return body.slice(i, end === -1 ? body.length : end).trim();
}

/**
 * 渲染前先剥掉 KaTeX 不认识的**排版类命令**。
 *
 * 这一步是必需的：`equation` 环境里几乎总会带 `\\label{eq:...}`，
 * KaTeX 遇到未知命令会直接报错（`throwOnError: true`），于是整条公式渲染失败、
 * 面板退化成显示源码 —— 用户看到的就是"公式渲染错误"。
 */
export function sanitizeForKatex(tex: string): string {
  return tex
    // 注意转义：`\\(` 是"字面反斜杠 + 分组"，写成 `\\\\` 会去找**两个**反斜杠，
    // 永远匹配不上（这个坑我在同一份文件里踩了四处）。
    .replace(/\\(label|tag|index)\s*\{[^{}]*\}/g, '')
    .replace(/\\(nonumber|notag)\b/g, '')
    .replace(/\\(hfill|medskip|smallskip|bigskip|noindent|centering)\b/g, '')
    .replace(/\\(vspace|hspace)\*?\s*\{[^{}]*\}/g, '')
    .trim();
}

/**
 * 用 KaTeX 渲染。
 *
 * 返回 `{ html, text }`：
 * - `html` 给支持 HTML 的容器用（Monaco 的悬浮对它做了白名单过滤，可能整段被剥掉）；
 * - `text` 是去掉标签后的纯文本（`\alpha_T` → `αT`）。**必须带上它**——
 *   一旦 HTML 被过滤，悬浮框里至少还能看到渲染后的字符，而不是一片空白。
 */
export function renderMath(
  tex: string,
  displayMode: boolean,
): { html: string; text: string } | undefined {
  try {
    const cleaned = sanitizeForKatex(tex);
    if (!cleaned) return undefined;
    const html = katex.renderToString(cleaned, { displayMode, throwOnError: true, output: 'html' });
    return { html, text: htmlToText(html) };
  } catch {
    return undefined;
  }
}

/** 把 KaTeX 的 HTML 压成纯文本（去标签 + 还原常见实体）。 */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    // KaTeX 会插入零宽字符用于排版（U+200B 等）；纯文本里必须去掉，
    // 否则"预览"那一行看着一样、复制出来却是脏的。
    .replace(/[\u200b-\u200f\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 自动补全"只写了命令没写参数"的符号，便于直接渲染（如 `\mathcal` → `\mathcal{F}`）。 */
function normalizeSymbolCommand(command: string): string | undefined {
  const needsArgument = /^\\(math[a-z]+|mathcal|mathbf|mathrm|mathit|mathsf|mathtt|mathfrak|overline|underline|hat|bar|vec|dot|ddot|tilde|sqrt|text|operatorname)$/.test(
    command,
  );
  return needsArgument ? `${command}{F}` : command;
}

interface HoverTarget {
  kind: 'cite' | 'ref' | 'image' | 'math' | 'symbol';
  value: string;
  /** 命令整体在行内的区间，用于限制悬浮高亮范围。 */
  start: number;
  end: number;
  /** 数学模式用（行内公式 / 独立公式）。 */
  display?: boolean;
  /** 符号命令是否已经带了参数（带了就不该再补占位符，否则渲染成 F）。 */
  hasArgument?: boolean;
}

/**
 * 判断光标落在哪种目标上。
 *
 * 顺序有讲究：先看"带参数的命令"（cite/ref/includegraphics），
 * 再看数学环境，最后才是裸符号命令——否则 `\includegraphics` 会被当成 `\includegraphics` 符号。
 */
export function detectHoverTarget(lineText: string, column: number): HoverTarget | undefined {
  const offset = Math.max(0, column - 1);

  // ① 带参数的命令（cite / ref / includegraphics）
  const commandRe =
    /\\(cite|citep|citet|citeauthor|citeyear|ref|eqref|autoref|cref|includegraphics)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = commandRe.exec(lineText)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (offset < start || offset > end) continue;
    const command = m[1]!;
    const kind = command === 'includegraphics' ? 'image' : command.startsWith('cite') ? 'cite' : 'ref';
    return { kind, value: m[2]?.trim() ?? '', start, end };
  }

  // ② 光标**直接落在**某个符号命令上 → 只预览这个符号。
  //    放在数学环境之前是有意的：用户把鼠标点在 `\alpha_T` 上时想看的是这个符号，
  //    而不是整条公式（点在公式的其它位置时才给整条公式）。
  const symbol = symbolAt(lineText, offset);
  if (symbol) return symbol;

  // ③ 数学环境：$$…$$、\[…\]、\(…\)、$…$
  //    ⚠️ `\(…\)` 必须支持：模型生成的 LaTeX 里大量使用这种写法。
  const mathPatterns: { re: RegExp; display: boolean }[] = [
    { re: /\$\$([\s\S]+?)\$\$/g, display: true },
    { re: /\\\[([\s\S]+?)\\\]/g, display: true },
    { re: /\\\(([\s\S]+?)\\\)/g, display: false },
    { re: /(?<!\$)\$([^$]+?)\$(?!\$)/g, display: false },
  ];
  for (const { re, display } of mathPatterns) {
    re.lastIndex = 0;
    while ((m = re.exec(lineText)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (offset < start || offset > end) continue;
      return { kind: 'math', value: m[1]!.trim(), start, end, display };
    }
  }
  return undefined;
}

/**
 * 光标是否正落在某个符号命令上。
 *
 * 要一起带上**命令的参数与上下标**，否则渲染出来是错的：
 *   · `\bar{a}_t` 若只取到 `\bar`，就只能套占位符渲染成 "F̄"（实测用户看到的"上下标不对"）；
 *   · `\mathbf{d}` 若丢掉 `{d}`，会渲染成 "F"。
 * 所以这里按"参数（`{…}`/`[…]`）+ 任意组上下标"的顺序尽量多取。
 */
function symbolAt(lineText: string, offset: number): HoverTarget | undefined {
  const re = /\\([a-zA-Z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    const start = m.index;
    const rest = lineText.slice(start + m[0].length);
    // ① 命令参数：`{...}` 或 `[...]`（可能是空的，如 `\bar{}`）
    const argument = /^(\{[^{}]*\}|\[[^\]]*\])?/.exec(rest)?.[0] ?? '';
    // ② 任意组上下标：`_t`、`^{2}`、`_{i,j}`…
    const scripts =
      /^((?:_\{[^{}]*\}|_[A-Za-z0-9]|\^\{[^{}]*\}|\^[A-Za-z0-9])*)/.exec(
        rest.slice(argument.length),
      )?.[1] ?? '';
    const suffix = `${argument}${scripts}`;
    const end = start + m[0].length + suffix.length;
    if (offset < start || offset > end) continue;
    return {
      kind: 'symbol',
      // hasArgument 让渲染端知道"不用再补占位参数"
      value: `\\${m[1]!}${suffix}`,
      start,
      end,
      hasArgument: suffix.startsWith('{') || suffix.startsWith('['),
    };
  }
  return undefined;
}

/** 把一条目标转成悬浮内容（Markdown）。找不到依据时返回 undefined，由调用方给出提示。 */
export async function buildHoverMarkdown(
  target: HoverTarget,
  deps: HoverDeps,
): Promise<{ value: string; hasHtml: boolean } | undefined> {
  if (target.kind === 'cite' || target.kind === 'ref') {
    const entries = parseBibEntries(deps.readBib().join('\n'));
    const keys = target.value.split(',').map((k) => k.trim()).filter(Boolean);
    const found = keys.map((key) => entries.find((e) => e.key === key)).filter(Boolean) as BibEntry[];
    if (found.length === 0) {
      // 不是文献 key：可能是图表标签，说明它指向什么就够了
      return {
        value:
          target.kind === 'ref'
            ? `**\\${target.kind === 'ref' ? 'ref' : 'cite'}**：\`${target.value}\`\n\n在 .bib 里没找到这个 key。若是图表标签，请把光标移到 \`\\label\` 上查看。`
            : `**引用** \`${target.value}\`：.bib 里没有这个 key`,
        hasHtml: false,
      };
    }
    const body = found
      .map(
        (entry) =>
          `**${entry.title ?? entry.key}**\n\n${[entry.author, entry.venue, entry.year].filter(Boolean).join(' · ')}`,
      )
      .join('\n\n---\n\n');
    return { value: body, hasHtml: false };
  }

  if (target.kind === 'image') {
    const url = await deps.loadImage(target.value);
    if (!url) return { value: `**图片** \`${target.value}\`：项目里找不到这个文件`, hasHtml: false };
    return { value: `**${target.value}**\n\n![${target.value}](${url})`, hasHtml: false };
  }

  // math / symbol
  const tex = target.kind === 'symbol' ? normalizeSymbolCommand(target.value) : target.value;
  if (!tex) return undefined;
  const rendered = renderMath(tex, target.display ?? false);
  if (!rendered) {
    return {
      value: `**公式源码**（KaTeX 无法渲染，可能含自定义宏）\n\n\`\`\`latex\n${target.value}\n\`\`\``,
      hasHtml: false,
    };
  }
  // HTML 与纯文本都给出：Monaco 可能过滤 HTML，纯文本兜底让悬浮框不会是空的
  const label = target.kind === 'symbol' ? `符号 \`${target.value}\`` : '公式';
  return {
    value: `<div class="pf-katex-hover">${rendered.html}</div>\n\n**预览**：${rendered.text}\n\n<sub>${label}</sub>`,
    hasHtml: true,
  };
}

/** 注册 Monaco 悬浮提供器。返回可用于销毁的 disposable。 */
export function registerLatexHover(
  monaco: typeof Monaco,
  deps: HoverDeps,
): Monaco.IDisposable {
  return monaco.languages.registerHoverProvider('latex', {
    async provideHover(model, position) {
      const lineText = model.getLineContent(position.lineNumber);
      const target = detectHoverTarget(lineText, position.column);
      if (!target) return null;
      const content = await buildHoverMarkdown(target, deps);
      if (!content) return null;
      return {
        range: new monaco.Range(position.lineNumber, target.start + 1, position.lineNumber, target.end + 1),
        contents: [
          {
            value: content.value,
            // ⚠️ Monaco 只在 isTrusted 为 true 时才允许 HTML：
            // 少了它，KaTeX 渲染出来的 HTML 会被当成不可信内容整段剥掉，
            // 悬浮框就变成空的了（实测踩过）。
            supportHtml: content.hasHtml,
            isTrusted: true,
          } as Monaco.IMarkdownString,
        ],
      };
    },
  });
}


/* ─────────────────────────────────────────────────────────────
   跨行结构：多行公式环境 与 表格
   ─────────────────────────────────────────────────────────────
   只按"光标那一行"取内容是不够的：论文里的公式几乎都写成
       \begin{equation}
         \mathbb{E}[A \mid K] = \sum ...
       \end{equation}
   逐行看，光标所在行既没有 `$` 也没有 `\(`，于是会被当成普通符号（`\mathbb`），
   渲染出来自然不对。表格同理，必须整块取。
*/

/** 需要整块取出渲染的数学环境。 */
const MATH_ENVIRONMENTS = [
  'equation',
  'equation*',
  'align',
  'align*',
  'aligned',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'displaymath',
  'array',
  'split',
  'cases',
];

/** 表格环境。 */
const TABLE_ENVIRONMENTS = ['tabular', 'tabular*', 'tabularx', 'array', 'longtable'];

export interface BlockTarget {
  kind: 'math-block' | 'table';
  /** 用于渲染的 LaTeX 内容（公式不含 \begin/\end，表格保留表格体）。 */
  content: string;
  /** 整块在文档中的行范围（1 起，闭区间），用于限制悬浮高亮。 */
  startLine: number;
  endLine: number;
  environment: string;
}

/**
 * 找出光标所在的**跨行环境**（公式或表格）。
 *
 * 做法：从光标行向上找最近的 `\begin{env}`，再向下找配对的 `\end{env}`。
 * 用"最近且未被闭合"的判断，避免把多个环境混在一起。
 */
export function detectBlockAt(
  getLine: (lineNumber: number) => string,
  lineCount: number,
  lineNumber: number,
): BlockTarget | undefined {
  const valid = [...MATH_ENVIRONMENTS, ...TABLE_ENVIRONMENTS];

  /*
   * 用**环境栈**从文件头扫到光标行，栈顶就是光标所在的环境。
   *
   * 早先的做法是"从光标往上找最近的 \\begin{env}"，那会把**已经闭合**的环境
   * 也当成外层：实测光标在第 206 行，却返回了第 156–159 行的 split 环境。
   */
  const stack: { env: string; line: number }[] = [];
  for (let line = 1; line <= lineNumber; line += 1) {
    for (const token of getLine(line).matchAll(/\\(begin|end)\{([\w*]+)\}/g)) {
      const env = token[2]!;
      if (token[1] === 'begin') {
        stack.push({ env, line });
      } else {
        const index = stack.map((s) => s.env).lastIndexOf(env);
        if (index !== -1) stack.length = index;
      }
    }
  }

  const top = stack[stack.length - 1];
  // eslint-disable-next-line no-console
  if (top && valid.includes(top.env)) {
    const isTable = TABLE_ENVIRONMENTS.includes(top.env);
    let depth = 0;
    for (let line = top.line; line <= Math.min(lineCount, top.line + 500); line += 1) {
      for (const token of getLine(line).matchAll(/\\(begin|end)\{([\w*]+)\}/g)) {
        if (token[2] !== top.env) continue;
        depth += token[1] === 'begin' ? 1 : -1;
        if (depth === 0) {
          return {
            kind: isTable ? 'table' : 'math-block',
            content: collectContent(getLine, top.line, line, top.env),
            startLine: top.line,
            endLine: line,
            environment: top.env,
          };
        }
      }
    }
  }

  // 没有环境：看 `$$ … $$` / `\\[ … \\]` 这种跨行定界（同样要判"是否还开着"）
  let openLine = 0;
  let openToken = '';
  for (let line = 1; line <= lineNumber; line += 1) {
    const text = getLine(line);
    if (text.includes('$$')) {
      openToken = openToken === '$$' ? '' : '$$';
      openLine = line;
    }
    if (text.includes('\\[')) {
      openToken = '\\[';
      openLine = line;
    }
    if (text.includes('\\]') && openToken === '\\[') {
      openToken = '';
    }
  }
  if (!openToken || !openLine) return undefined;

  const closer = openToken === '$$' ? '$$' : '\\]';
  for (let line = openLine; line <= Math.min(lineCount, openLine + 200); line += 1) {
    if (line !== openLine && getLine(line).includes(closer)) {
      const pieces: string[] = [];
      for (let i = openLine; i <= line; i += 1) pieces.push(getLine(i));
      const inner = pieces
        .join('\n')
        .replace(/^[\s\S]*?(\$\$|\\\[)/, '')
        .replace(/(\$\$|\\\])[\s\S]*$/, '')
        .trim();
      return { kind: 'math-block', content: inner, startLine: openLine, endLine: line, environment: 'delimiter' };
    }
  }
  return undefined;
}

function collectContent(
  getLine: (lineNumber: number) => string,
  startLine: number,
  endLine: number,
  env: string,
): string {
  const pieces: string[] = [];
  for (let i = startLine; i <= endLine; i += 1) pieces.push(getLine(i));
  let joined = pieces.join('\n');
  joined = joined.replace(new RegExp(`^[\\s\\S]*?\\\\begin\\{${env.replace('*', '\\*')}\\}`), '');
  joined = joined.replace(new RegExp(`\\\\end\\{${env.replace('*', '\\*')}\\}[\\s\\S]*$`), '');
  // 剥掉列定义：`\begin{tabular}{@{}ll@{}}` 里的 `{@{}ll@{}}`（tabularx 还多一个宽度参数）。
  // 不剥的话它会被当成表格的第一行渲染出来（实测表格里多出一行 `@ll@`）。
  if (TABLE_ENVIRONMENTS.includes(env)) {
    joined = joined.replace(/^\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/, '');
    joined = joined.replace(/^\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/, '');
  }
  return joined.trim();
}

/**
 * 把 `tabular` 体渲染成 HTML 表格。
 *
 * 只处理论文里常见的那几种写法：`&` 分列、`\\` 分行、`\toprule/\midrule/\bottomrule/\hline`
 * 画线、`\multicolumn{n}{..}{..}` 跨列。复杂写法（多行单元格、嵌套表格）会退化成纯文本，
 * 但**不会渲染成错误的表**——那比不显示更糟。
 */
export function renderTableLatex(body: string): string | undefined {
  const html: string[] = [];
  /** 正在累积的一行（LaTeX 允许一行写在多行源码里，遇到 `\\` 才算结束）。 */
  let buffer = '';
  let sawRule = false;
  let emittedDataRow = false;

  const flushRow = () => {
    const text = buffer.trim();
    buffer = '';
    if (!text) return;
    const cells = splitCells(text);
    if (cells.length === 0 || (cells.length === 1 && cells[0] === '')) return;
    // 第一行数据当表头（三线表的写法通常就是 \toprule 后紧跟表头）
    const tag = !emittedDataRow ? 'th' : 'td';
    emittedDataRow = true;
    html.push(
      `<tr>${cells
        .map((cell) => {
          const span = /^\\multicolumn\{(\d+)\}/.exec(cell.trim());
          const text2 = cleanCell(span ? cell.replace(/^\\multicolumn\{\d+\}\{[^}]*\}/, '') : cell);
          const attr = span ? ` colspan="${span[1]}"` : '';
          return `<${tag}${attr}>${text2}</${tag}>`;
        })
        .join('')}</tr>`,
    );
  };

  const pushRule = (kind: 'top' | 'mid' | 'bottom') => {
    flushRow();
    const cls = kind === 'top' ? 'pf-tbl-top' : kind === 'bottom' ? 'pf-tbl-bottom' : 'pf-tbl-mid';
    html.push(`<tr class="${cls}"><td colspan="99"></td></tr>`);
    sawRule = true;
  };

  /*
   * 按**行**解析，而不是先按 `\\` 切分整段。
   *
   * 后者会把 `\toprule` 和紧跟其后的数据行粘成一格（它们之间没有 `\\`），
   * 实测渲染出「\toprule Method」这样的单元格——表格看着就"错"了。
   */
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/%.*$/, '').trim();
    if (!line) continue;

    // 一行里可能有多条规则与多行数据（如 `\midrule a & b \\ c & d \\`）
    const tokens = line.split(/(\\(?:toprule|midrule|bottomrule|hline)\b)/g);
    for (const token of tokens) {
      if (!token) continue;
      if (/^\\(toprule|midrule|bottomrule|hline)$/.test(token)) {
        pushRule(/toprule/.test(token) ? 'top' : /bottomrule/.test(token) ? 'bottom' : 'mid');
        continue;
      }
      // 普通内容：按 `\\` 切出完整的行，最后一段留在 buffer 里等后续行续上
      const parts = token.split(/\\\\/);
      for (let i = 0; i < parts.length - 1; i += 1) {
        buffer += parts[i];
        flushRow();
      }
      buffer += parts[parts.length - 1] ?? '';
    }
  }
  flushRow();

  if (html.length === 0) return undefined;
  void sawRule;
  return `<table class="pf-table">${html.join('')}</table>`;
}

/** 按 `&` 切分单元格，但跳过 `\&`（转义的和号）与花括号内的 `&`。 */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (ch === '\\' && row[i + 1] === '&') {
      current += '&';
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (ch === '&' && depth === 0) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/** 清掉单元格里的常见命令，保留可读文字（表格预览要的是内容，不是源码）。 */
function cleanCell(cell: string): string {
  /*
   * 单元格里**必须渲染公式**，不能把 `$...$` 当普通文字剥掉。
   * 论文表格里大量出现 `$\rho_s$ (rad/s)`、`$r^{\text{box}}$`、`\uparrow` 这类写法，
   * 直接剥命令会留下 `(rad/s)` 前面一片空白、箭头也不见——用户看到的就是"表格里的符号渲染错误"。
   */
  const segments = cell.split(/(\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\))/g);
  return segments
    .map((segment) => {
      const math =
        /^\$\$([\s\S]*)\$\$$/.exec(segment) ??
        /^\$([\s\S]*)\$$/.exec(segment) ??
        /^\\\(([\s\S]*)\\\)$/.exec(segment);
      if (math) {
        const rendered = renderMath(math[1]!, false);
        return rendered
          ? `<span class="pf-cell-math">${rendered.html}</span>`
          : `<span class="pf-cell-math">${escapeHtml(segment)}</span>`;
      }
      return escapeHtml(plainCellText(segment));
    })
    .join('');
}

/** 单元格里的**非公式**部分：去掉命令、把常见符号换成 Unicode。 */
function plainCellText(text: string): string {
  return text
    .replace(/\\(textbf|textit|emph|mathrm|mathbf|text|mbox|multicolumn|thead|scriptsize|footnotesize|small)\s*\{([^{}]*)\}/g, '$2')
    .replace(/\\(cite|ref|eqref)\s*\{([^{}]*)\}/g, '[$2]')
    .replace(/\\label\s*\{[^{}]*\}/g, '')
    // 常见符号 → Unicode（表格里很常用，靠 KaTeX 之外的文字部分也要能看）
    .replace(/\\downarrow\b/g, '↓')
    .replace(/\\uparrow\b/g, '↑')
    .replace(/\\leftrightarrow\b/g, '↔')
    .replace(/\\rightarrow\b/g, '→')
    .replace(/\\leftarrow\b/g, '←')
    .replace(/\\leq?\b/g, '≤')
    .replace(/\\geq?\b/g, '≥')
    .replace(/\\approx\b/g, '≈')
    .replace(/\\times\b/g, '×')
    .replace(/\\pm\b/g, '±')
    .replace(/\\checkmark\b/g, '✓')
    .replace(/\\ast\b/g, '*')
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_')
    .replace(/\\&/g, '&')
    .replace(/\\[a-zA-Z]+\b/g, '') // 其余命令直接去掉，避免残留反斜杠
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 插进 HTML 前必须转义：表格里出现 `&`/`<` 会破坏结构。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


/* ─────────────────────────────────────────────────────────────
   标签解析：`\ref{sec:xxx}` / `\ref{fig:xxx}` / `\ref{tab:xxx}`
   ─────────────────────────────────────────────────────────────
   之前 `\ref{}` 只会去 .bib 里找，找不到就说"未在 .bib 中找到" —— 而它多半指向
   小节、图或表。这里解析文档里所有 `\label{}`，向上找出它属于哪个标题/题注，
   于是悬停能显示"小节 · 标题（第 N 行）"，Ctrl+点击也能跳到标签所在行。
*/

export interface LabelInfo {
  key: string;
  /** `\label{}` 所在行（1 起）。 */
  line: number;
  kind: 'section' | 'subsection' | 'figure' | 'table' | 'equation' | 'other';
  title?: string;
}

export function resolveLabels(
  getLine: (lineNumber: number) => string,
  lineCount: number,
): Map<string, LabelInfo> {
  const labels = new Map<string, LabelInfo>();

  for (let line = 1; line <= lineCount; line += 1) {
    for (const match of getLine(line).matchAll(/\\label\{([^}]*)\}/g)) {
      const key = match[1]!.trim();
      if (!key) continue;
      labels.set(key, { key, line, ...classifyLabel(getLine, line) });
    }
  }
  return labels;
}

/** 向上找出这个标签属于什么（小节标题 / 图的题注 / 表的题注 / 公式）。 */
function classifyLabel(
  getLine: (lineNumber: number) => string,
  labelLine: number,
): { kind: LabelInfo['kind']; title?: string } {
  /*
   * 向上扫，按**就近**决定类型。
   *
   * 注意 `\caption` 通常出现在 `\begin{table}` **下面**，所以先遇到的是题注、
   * 之后才是外层环境。早先的实现一遇到题注就按当时已知的环境判定，结果 `\begin{table}`
   * 还没扫到，于是表格标签被误判成 figure（实测就是这么错的）。
   * 现在的做法是：遇到题注先记下，继续往上找外层环境，再由外层环境决定 figure/table。
   */
  let caption: string | undefined;
  let enclosing: 'figure' | 'table' | 'equation' | undefined;
  let equationOnly = false;

  for (let line = labelLine; line >= Math.max(1, labelLine - 80); line -= 1) {
    const text = getLine(line);

    if (!enclosing) {
      if (/\\begin\{figure\*?\}/.test(text)) enclosing = 'figure';
      else if (/\\begin\{table\*?\}/.test(text)) enclosing = 'table';
      else if (/\\begin\{(equation|align|gather|multline|displaymath)\*?\}/.test(text)) enclosing = 'equation';
    }
    if (!caption) {
      const match = /\\caption(?:\[[^\]]*\])?\{([^}]*)\}/.exec(text);
      if (match) caption = stripCommands(match[1]!);
    }

    if (enclosing === 'equation' && !equationOnly) {
      return { kind: 'equation' };
    }
    if (enclosing === 'figure' || enclosing === 'table') {
      return { kind: enclosing, title: caption };
    }

    // 还没进任何环境：那就看标题（小节优先于章）
    const subsection = /\\subsection\*?\{([^}]*)\}/.exec(text);
    if (subsection) return { kind: 'subsection', title: stripCommands(subsection[1]!) };
    const section = /\\section\*?\{([^}]*)\}/.exec(text);
    if (section) return { kind: 'section', title: stripCommands(section[1]!) };
  }

  if (caption) return { kind: 'figure', title: caption };
  return { kind: 'other' };
}

/** 去掉标题里的排版命令，只留可读文字。 */
export function stripCommands(text: string): string {
  return text
    .replace(/\\(textbf|textit|emph|texttt|mathrm|text)\{([^{}]*)\}/g, '$2')
    .replace(/\\[a-zA-Z]+\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
