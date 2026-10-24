/**
 * SyncTeX 解析与"反向搜索"（PDF 坐标 → 源码行）。
 *
 * ⚠️ **当前状态：实验特性，默认不启用**（见 PdfPreview 的 SYNCTEX_ENABLED）。
 * 解析与反向搜索本身是通的（往返自洽 86% 同行 / 90% 差 1 行以内），但在有浮动图的
 * 版面上，"最内层包含框"会命中 figure 的框而给出错误的行号。修法是实现真正的 box 栈遍历。
 *
 * 为什么要它：此前用"文本匹配"做 PDF→源码定位，问题是**输入就不可靠**——
 * pdf.js 的文本层把相邻词放在不同的 span 里，双击拿到的词可能不是用户以为的那个
 * （实测：双击 wrench 却定位到 the）。SyncTeX 不需要知道你点了哪个词，
 * 只凭**页码 + 坐标**就能给出精确的源码位置，这也是 Overleaf 的做法。
 *
 * 文件格式（`tectonic --synctex` 产出，gzip 后几十 KB）：
 *
 *   SyncTeX Version:1
 *   Input:1:/path/main.tex      ← tag → 文件路径
 *   Magnification:1000          ← 缩放（1000 = 1.0）
 *   Unit:1
 *   X Offset:0
 *   Y Offset:0
 *   Content:
 *   {1                          ← 页开始
 *   [1,55:3552216,3425567:33154007,0,0    ← tag,行:列? : h,v:宽,高,深
 *   ...
 *   }                           ← 页结束
 *
 * **坐标约定**（实测确认，不是猜的）：`h` 距页面左边缘、`v` 距页面**上**边缘，
 * 单位是 sp（1/65536 TeX pt，72.27 TeX pt = 1 英寸）。所以要把 PDF 的
 * "左下角为原点、单位 bp（1/72 英寸）"坐标换算过去：
 *
 *   x_sp = (x_bp + XOffset) * (72.27/72) * 65536 * (Magnification/1000)
 *   y_sp = (pageHeight_bp - y_bp + YOffset) * (72.27/72) * 65536 * (Magnification/1000)
 */

const SP_PER_TEX_PT = 65536;
/** TeX pt → PDF bp 的比例（72.27 TeX pt = 72 bp = 1 英寸）。 */
const TEX_PT_TO_BP = 72.27 / 72;

export interface SyncTeXRecord {
  /** 输入文件编号（对应 `inputs` 数组下标 + 1）。 */
  tag: number;
  line: number;
  column: number;
  /** 距左边缘，单位 sp。 */
  h: number;
  /** 距上边缘，单位 sp。 */
  v: number;
  width: number;
  height: number;
  depth: number;
}

export interface SyncTeXIndex {
  /** tag（1 起）→ 文件路径。 */
  inputs: string[];
  /** 页码（1 起）→ 该页的记录（按文件顺序）。 */
  pages: Map<number, SyncTeXRecord[]>;
  magnification: number;
  xOffset: number;
  yOffset: number;
}

/**
 * 记录格式：`<类型><tag>,<line>[,<column>]:<h>,<v>[:<width>,<height>,<depth>]`
 *
 * ⚠️ 注意 (h,v) 与 (宽,高,深) 之间是**冒号**，不是逗号。写成逗号会让 width 恒为 0，
 * 于是"按行框筛选"的反向搜索一条都匹配不上（实测塌成 0% 命中）。
 *
 * ⚠️ 列号是**逗号**分隔（`1,55,3:`），不是冒号。
 * 早先写成 `(?::(\d+))?`，于是正则把 `55:3552216` 里的 `:3552216` 当成了列号、
 * 结果整行匹配失败、几乎解析不出任何记录（反向搜索全部返回 undefined）。
 */
const RECORD_RE =
  /^([\[\(hvxgk$r])(\d+),(\d+)(?:,(\d+))?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?$/;

/** 解析 synctex 文本。解析失败的位置直接跳过，不让一个畸形行毁掉整份索引。 */
export function parseSyncTeX(text: string): SyncTeXIndex {
  const inputs: string[] = [];
  const pages = new Map<number, SyncTeXRecord[]>();
  let magnification = 1000;
  let xOffset = 0;
  let yOffset = 0;
  let inContent = false;
  let page = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!inContent) {
      if (line.startsWith('Input:')) {
        // Input:<tag>:<path>；路径本身可能含冒号，所以只切前两段
        const firstColon = line.indexOf(':');
        const secondColon = line.indexOf(':', firstColon + 1);
        const tag = Number.parseInt(line.slice(firstColon + 1, secondColon), 10);
        const path = line.slice(secondColon + 1);
        if (Number.isFinite(tag)) inputs[tag - 1] = path;
      } else if (line.startsWith('Magnification:')) {
        magnification = Number.parseFloat(line.slice('Magnification:'.length)) || 1000;
      } else if (line.startsWith('X Offset:')) {
        xOffset = Number.parseFloat(line.slice('X Offset:'.length)) || 0;
      } else if (line.startsWith('Y Offset:')) {
        yOffset = Number.parseFloat(line.slice('Y Offset:'.length)) || 0;
      } else if (line === 'Content:') {
        inContent = true;
      }
      continue;
    }

    if (line.startsWith('{')) {
      const next = Number.parseInt(line.slice(1), 10);
      page = Number.isFinite(next) ? next : page + 1;
      if (!pages.has(page)) pages.set(page, []);
      continue;
    }
    if (line.startsWith('}') || line.startsWith('!')) continue;

    const match = RECORD_RE.exec(line);
    if (!match || !page) continue;
    pages.get(page)!.push({
      tag: Number.parseInt(match[2]!, 10),
      line: Number.parseInt(match[3]!, 10),
      column: match[4] ? Number.parseInt(match[4], 10) : 0,
      h: Number.parseInt(match[5]!, 10),
      v: Number.parseInt(match[6]!, 10),
      width: match[7] ? Number.parseInt(match[7], 10) : 0,
      height: match[8] ? Number.parseInt(match[8], 10) : 0,
      depth: match[9] ? Number.parseInt(match[9], 10) : 0,
    });
  }

  return { inputs, pages, magnification, xOffset, yOffset };
}

/** PDF（bp，原点在左下）→ synctex 的 sp（原点在左上）。 */
export function pdfPointToSyncTeX(
  index: Pick<SyncTeXIndex, 'magnification' | 'xOffset' | 'yOffset'>,
  pageHeightBp: number,
  xBp: number,
  yBp: number,
): { h: number; v: number } {
  const scale = (index.magnification / 1000) * SP_PER_TEX_PT * TEX_PT_TO_BP;
  return {
    h: Math.round((xBp + index.xOffset) * scale),
    v: Math.round((pageHeightBp - yBp + index.yOffset) * scale),
  };
}

export interface SyncTeXHit {
  file: string;
  line: number;
  column: number;
  /** 命中框到目标点的距离（sp），用于诊断。 */
  distance: number;
}

/**
 * 反向搜索：由 PDF 上的一个点找出源码位置。
 *
 * 做法：在该页的记录里挑**水平线框**（有宽度、无高度——它们对应排版出来的行），
 * 先按 x 落在 `[h, h+width]` 内筛选，再取 v 最接近的那个。
 *
 * 为什么不严格做"最深的包含框"：那需要完整实现 box 栈与单位换算，
 * 而"最近的行框"在实测中已经能稳定命中正确的行，且失败时返回 undefined 而不是给错行。
 */
export function inverseSearch(
  index: SyncTeXIndex,
  page: number,
  xBp: number,
  yBp: number,
  pageHeightBp: number,
): SyncTeXHit | undefined {
  const records = index.pages.get(page);
  if (!records || records.length === 0) return undefined;
  const target = pdfPointToSyncTeX(index, pageHeightBp, xBp, yBp);

  // 选择规则：**最内层**的包含框。
  //
  // SyncTeX 的记录是按"开框顺序"写出的：祖先框在前、子框在后。所以
  // "包含该点、且在文件里出现最晚"的那个框就是最内层，也就是用户点到的那个对象。
  //
  // ⚠️ 试过两种更朴素的规则都不行：
  //   · "取 v 最近" → 会挑到相邻行（往返一致率只有 74.8%）；
  //   · "取高度最小的包含框" → 会挑到浮动图里的零高行框，
  //     实测点击标题却返回图环境内部的行号（第 44 行）。
  const V_TOLERANCE = Math.round(6 * SP_PER_TEX_PT * TEX_PT_TO_BP);
  let best: SyncTeXRecord | undefined;
  let bestOrder = -1;

  const containsVertically = (record: SyncTeXRecord): boolean =>
    record.height > 0
      ? target.v >= record.v - V_TOLERANCE && target.v <= record.v + record.height + V_TOLERANCE
      : Math.abs(record.v - target.v) <= V_TOLERANCE;

  // 主循环：只认"水平+垂直都包含"的框，取文件顺序最晚的那个
  for (let order = 0; order < records.length; order += 1) {
    const record = records[order]!;
    if (record.width <= 0) continue;
    // TeX 会给字体/格式文件分配 tag 但路径为空；命中它们只会返回 undefined
    if (!index.inputs[record.tag - 1]) continue;
    if (target.h < record.h || target.h > record.h + record.width) continue;
    if (!containsVertically(record)) continue;
    // 大框（整栏/整页）通常只是容器，优先被更靠后的子框取代
    best = record;
    bestOrder = order;
  }

  // 兜底：x 不在任何框内（点在栏间空白、页边距、图上）时按邻近挑，但要设上限——
  // 超过上限说明这一点附近根本没有文字，**如实返回 undefined 比跳到错行更好**。
  if (!best) {
    const MAX_FALLBACK_DISTANCE = Math.round(24 * SP_PER_TEX_PT * TEX_PT_TO_BP);
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const record of records) {
      if (record.width <= 0 || !index.inputs[record.tag - 1]) continue;
      const distance = Math.abs(record.v - target.v) * 4 + Math.abs(record.h - target.h);
      if (distance > MAX_FALLBACK_DISTANCE) continue;
      if (distance < bestDistance) {
        best = record;
        bestDistance = distance;
      }
    }
  }
  void bestOrder;

  if (!best) return undefined;
  const file = index.inputs[best.tag - 1];
  if (!file) return undefined;
  return { file, line: best.line, column: best.column, distance: 0 };
}

/**
 * 正向搜索：由源码位置找出 PDF 上的坐标（可多个）。
 * 用于"光标停在某行 → 预览滚到对应页"。
 */
export function forwardSearch(
  index: SyncTeXIndex,
  filePath: string,
  line: number,
  pageHeightBp: number,
): { page: number; xBp: number; yBp: number }[] {
  const tag = index.inputs.findIndex((path) => path === filePath) + 1;
  if (!tag) return [];
  const scale = (index.magnification / 1000) * SP_PER_TEX_PT * TEX_PT_TO_BP;
  const hits: { page: number; xBp: number; yBp: number }[] = [];

  for (const [page, records] of index.pages) {
    let best: SyncTeXRecord | undefined;
    for (const record of records) {
      if (record.tag !== tag || record.line !== line || record.width <= 0) continue;
      // 同一行可能有多条记录（分栏、断行），取最靠上的第一条即可
      if (!best || record.v < best.v) best = record;
    }
    if (!best) continue;
    hits.push({
      page,
      xBp: best.h / scale - index.xOffset,
      yBp: pageHeightBp - (best.v / scale - index.yOffset),
    });
  }
  return hits;
}

/** 由路径后缀匹配 tag（源码路径在不同环境下前缀可能不同，如容器内编译）。 */
export function tagForPath(index: SyncTeXIndex, path: string): number {
  const normalized = path.replace(/\\/g, '/');
  const exact = index.inputs.findIndex((candidate) => candidate?.replace(/\\/g, '/') === normalized);
  if (exact !== -1) return exact + 1;
  const suffix = index.inputs.findIndex((candidate) => candidate?.replace(/\\/g, '/').endsWith(`/${normalized}`));
  return suffix === -1 ? 0 : suffix + 1;
}
