/**
 * MockCompiler —— 浏览器端"伪 LaTeX 排版器"。
 *
 * 它不做真正的 TeX 排版，而是把 LaTeX 源码转成结构化行块后用 pdf-lib 画成真正的 PDF，
 * 目的是：在尚接触不到 TeX 引擎（Tectonic / TeX Live）时，让
 * 「编辑源码 → 触发编译 → PDF 预览 → 源码行高亮定位」这条链路完整可跑。
 *
 * 接入真实引擎后，只需把注入的 compiler 换成 HttpCompiler，上层代码零改动。
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { normalizeEol, type CompileDiagnostic, type CompileRequest } from '@paperflow/core';
import type { CompileOutput, LatexCompiler, SourceAnchor } from './compiler.js';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 64;
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 16.5;

type BlockKind = 'title' | 'author' | 'heading' | 'subheading' | 'body' | 'math' | 'caption' | 'bullet';

interface Block {
  kind: BlockKind;
  text: string;
  /** 该块起始的源码行号（1-based）。 */
  line: number;
}

/** WinAnsi 无法编码的字符统一降级，避免 embedFont 抛错。 */
function toWinAnsi(input: string): string {
  return input
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\u0000-\u00ff]/g, '?');
}

/** 行内命令清洗：把 LaTeX 标记压成可读文本。 */
function cleanInline(input: string): string {
  let out = input;
  out = out.replace(/(?<!\\)%.*$/, ''); // 注释
  out = out.replace(/\\(textbf|bf|emph|textit|it|texttt|tt|mathrm|mathbf|text)\{([^{}]*)\}/g, '$2');
  out = out.replace(/\\(cite|citep|citet|ref|eqref|autoref|label)\{([^{}]*)\}/g, (_m, cmd: string, arg: string) =>
    cmd === 'label' ? '' : `[${arg}]`,
  );
  out = out.replace(/\\(?:begin|end)\{[^{}]*\}/g, '');
  out = out.replace(/\\(?:noindent|centering|small|large|hfill|newline|clearpage|hline)\b/g, '');
  out = out.replace(/\\%/g, '%');
  out = out.replace(/\\([a-zA-Z]+)/g, '$1'); // 其余命令留名去反斜杠
  out = out.replace(/\$([^$]*)\$/g, (_m, math: string) => math.replace(/\\[a-zA-Z]+/g, ' ').trim());
  out = out.replace(/[{}]/g, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

function stripCommand(line: string, command: string): string | null {
  const re = new RegExp(`^\\\\${command}\\*?\\{(.*)\\}\\s*$`);
  const m = re.exec(line.trim());
  return m ? cleanInline(m[1] ?? '') : null;
}

/** LaTeX 源码 → 块序列。 */
export function latexToBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = normalizeEol(source).split('\n');
  let inAbstract = false;
  let inEquation = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (!trimmed || trimmed.startsWith('%')) {
      if (!inEquation && blocks.length > 0 && blocks[blocks.length - 1]!.kind !== 'body') continue;
      continue;
    }
    if (/^\\(documentclass|usepackage|newcommand|renewcommand|def|input|include|bibliography|bibliographystyle)\b/.test(trimmed)) {
      continue;
    }
    if (/^\\begin\{document\}|^\\end\{document\}|^\\maketitle/.test(trimmed)) continue;

    if (/^\\begin\{abstract\}/.test(trimmed)) {
      inAbstract = true;
      blocks.push({ kind: 'heading', text: 'Abstract', line: lineNo });
      continue;
    }
    if (/^\\end\{abstract\}/.test(trimmed)) {
      inAbstract = false;
      continue;
    }
    if (/^\\begin\{(equation|align|equation\*|align\*)\}/.test(trimmed)) {
      inEquation = true;
      continue;
    }
    if (/^\\end\{(equation|align|equation\*|align\*)\}/.test(trimmed)) {
      inEquation = false;
      continue;
    }
    if (inEquation) {
      const t = cleanInline(trimmed);
      if (t) blocks.push({ kind: 'math', text: t, line: lineNo });
      continue;
    }

    const title = stripCommand(trimmed, 'title');
    if (title !== null) {
      blocks.push({ kind: 'title', text: title, line: lineNo });
      continue;
    }
    const author = stripCommand(trimmed, 'author');
    if (author !== null) {
      blocks.push({ kind: 'author', text: author.replace(/\\and/g, ','), line: lineNo });
      continue;
    }
    const section = stripCommand(trimmed, 'section');
    if (section !== null) {
      blocks.push({ kind: 'heading', text: section, line: lineNo });
      continue;
    }
    const subsection = stripCommand(trimmed, 'subsection');
    if (subsection !== null) {
      blocks.push({ kind: 'subheading', text: subsection, line: lineNo });
      continue;
    }
    const caption = stripCommand(trimmed, 'caption');
    if (caption !== null) {
      blocks.push({ kind: 'caption', text: caption, line: lineNo });
      continue;
    }
    if (/^\\item\b/.test(trimmed)) {
      const text = cleanInline(trimmed.replace(/^\\item\s*/, ''));
      if (text) blocks.push({ kind: 'bullet', text, line: lineNo });
      continue;
    }
    if (/^\\(begin|end)\{(figure|table|itemize|enumerate|tabular|center|thebibliography)\}/.test(trimmed)) {
      continue;
    }
    if (/^\\bibitem/.test(trimmed)) {
      const text = cleanInline(trimmed.replace(/^\\bibitem\{[^}]*\}/, ''));
      if (text) blocks.push({ kind: 'bullet', text, line: lineNo });
      continue;
    }

    const text = cleanInline(trimmed);
    if (text) blocks.push({ kind: inAbstract ? 'body' : 'body', text, line: lineNo });
  }
  return blocks;
}

/** 基础静态检查，产出可定位到行的诊断。 */
export function lintLatex(source: string): CompileDiagnostic[] {
  const diags: CompileDiagnostic[] = [];
  // CRLF 源码会让下面剥离注释的正则失效（`$` 不带 m 标志），必须先归一化
  const lines = normalizeEol(source).split('\n');
  let depth = 0;
  lines.forEach((line, idx) => {
    const stripped = line.replace(/(?<!\\)%.*$/, '');
    for (const ch of stripped) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth < 0) {
          diags.push({
            level: 'error',
            file: 'main.tex',
            line: idx + 1,
            column: line.indexOf('}') + 1,
            message: 'Unexpected "}": no matching "{"',
          });
          depth = 0;
        }
      }
    }
  });
  if (depth > 0) {
    diags.push({ level: 'error', file: 'main.tex', line: lines.length, message: `Unbalanced braces: ${depth} "{" never closed` });
  }
  lines.forEach((line, idx) => {
    const m = /\\(?:cite|citep|citet|ref|eqref)\{([^}]*)\}/g;
    let hit: RegExpExecArray | null;
    while ((hit = m.exec(line)) !== null) {
      const key = hit[1] ?? '';
      if (key.includes('TODO')) {
        diags.push({ level: 'warning', file: 'main.tex', line: idx + 1, message: `Unresolved reference "${key}"` });
      }
    }
  });
  if (!/\\end\{document\}/.test(source)) {
    diags.push({ level: 'error', file: 'main.tex', line: Math.max(1, lines.length), message: 'Missing \\end{document}' });
  }
  return diags;
}

function wrap(text: string, font: { widthOfTextAtSize: (t: string, s: number) => number }, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out.length ? out : [''];
}

export interface MockCompilerOptions {
  /** 用于诊断中的文件名。 */
  fileName?: string;
}

export class MockCompiler implements LatexCompiler {
  readonly name = 'mock';

  private readonly fileName: string;

  constructor(options: MockCompilerOptions = {}) {
    this.fileName = options.fileName ?? 'main.tex';
  }

  async compile(req: CompileRequest): Promise<CompileOutput> {
    const startedAt = Date.now();
    // 统一行尾：无论源码来自 WSL、Windows 编辑器还是 git autocrlf，
    // 后面的解析与 diff 都只面对 LF，避免出现"整篇重写"式的假 diff。
    const content = normalizeEol(req.content);
    const blocks = latexToBlocks(content);
    const diagnostics = lintLatex(content);

    const pdf = await PDFDocument.create();
    pdf.setTitle('PaperFlow preview');
    const body = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

    const anchors: SourceAnchor[] = [];
    let page = pdf.addPage([A4.width, A4.height]);
    let pageIndex = 0;
    let y = A4.height - MARGIN;

    const newPage = () => {
      page = pdf.addPage([A4.width, A4.height]);
      pageIndex += 1;
      y = A4.height - MARGIN;
    };
    const ensureRoom = (needed: number) => {
      if (y - needed < MARGIN) newPage();
    };

    for (const block of blocks) {
      const text = toWinAnsi(block.text);
      let font = body;
      let size = BODY_SIZE;
      let indent = 0;
      let gapBefore = 0;
      let gapAfter = 4;

      switch (block.kind) {
        case 'title':
          font = bold;
          size = 16;
          gapBefore = 0;
          gapAfter = 8;
          break;
        case 'author':
          font = italic;
          size = 11;
          gapAfter = 14;
          break;
        case 'heading':
          font = bold;
          size = 12.5;
          gapBefore = 10;
          gapAfter = 6;
          break;
        case 'subheading':
          font = bold;
          size = 11;
          gapBefore = 8;
          gapAfter = 4;
          break;
        case 'math':
          font = italic;
          indent = 24;
          gapBefore = 4;
          gapAfter = 6;
          break;
        case 'caption':
          font = italic;
          size = 9.5;
          indent = 10;
          gapAfter = 8;
          break;
        case 'bullet':
          indent = 14;
          gapAfter = 3;
          break;
        default:
          gapAfter = 6;
      }

      ensureRoom(gapBefore + LINE_HEIGHT);
      y -= gapBefore;

      const maxWidth = A4.width - MARGIN * 2 - indent;
      const lines = wrap(text, font, size, maxWidth);

      lines.forEach((lineText, i) => {
        ensureRoom(LINE_HEIGHT);
        const drawText = block.kind === 'bullet' && i === 0 ? `\u2022  ${lineText}` : lineText;
        y -= LINE_HEIGHT;
        page.drawText(toWinAnsi(drawText), {
          x: MARGIN + indent,
          y,
          size,
          font,
          color: rgb(0.09, 0.1, 0.12),
        });
        anchors.push({ line: block.line, page: pageIndex, y: y - 3 });
      });

      y -= gapAfter;
    }

    if (blocks.length === 0) {
      page.drawText('Empty document', { x: MARGIN, y: y - LINE_HEIGHT, size: 12, font: italic, color: rgb(0.5, 0.5, 0.5) });
    }

    const pdfBytes = await pdf.save();
    const errors = diagnostics.filter((d) => d.level === 'error').length;
    const warnings = diagnostics.filter((d) => d.level === 'warning').length;

    const log = [
      `[paperflow-mock] ${this.fileName}`,
      `pages: ${pdf.getPageCount()}  blocks: ${blocks.length}`,
      ...diagnostics.map((d) => `${d.level === 'error' ? '!' : '~'} ${d.file}:${d.line} ${d.message}`),
      errors === 0 ? `Output written (${pdfBytes.byteLength} bytes).` : 'Compilation finished with errors.',
    ].join('\n');

    return {
      ok: errors === 0,
      pdfBytes,
      pdfUrl: toBlobUrl(pdfBytes),
      log,
      diagnostics,
      durationMs: Date.now() - startedAt,
      anchors,
    };
  }
}

function toBlobUrl(bytes: Uint8Array): string | undefined {
  if (typeof URL === 'undefined' || typeof Blob === 'undefined') return undefined;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));
}
