/**
 * PDF 文本提取（浏览器端）。
 *
 * 为什么在浏览器里提取而不是上传 PDF 到服务端：
 * - 服务端不必解析二进制、不装 poppler 之类的依赖；
 * - 避免大文件上传，也不需要临时文件清理；
 * - 用户能立刻看到"提取出多少字"，对提取质量心里有数。
 * 上传给服务端的只是提取后的纯文本。
 */

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// 与 PdfPreview 共用同一个 worker 配置（重复设置是幂等的）
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * 中日韩文字在 PDF 里用预定义 CMap 编码，pdf.js 必须显式拿到这些表才画得出字形。
 * 缺了它的表现是：英文 PDF 正常、中文 PDF **整片空白**（且复制不出文字）。
 * 资源由 scripts/setup-pdfjs-assets.mjs 同步到 public/pdfjs。
 */
export const PDFJS_ASSET_OPTIONS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
} as const;

export interface ExtractedPdf {
  text: string;
  pages: number;
  /** 没有文字的页数（纯扫描件会全部命中） */
  emptyPages: number;
  /** 渲染出的页面图像（data URL）。视觉模型可以直接"看"这些图，无需 OCR。 */
  pageImages: string[];
}

/** 最多渲染多少页为图像：图像 token 很贵（每张可达上千 token），必须限流。 */
export const MAX_RENDERED_PAGES = 8;
/** 渲染宽度（像素）。太大会爆 token，太小公式看不清；1100 是可读性与成本的折中。 */
const RENDER_WIDTH = 1100;

export async function extractPdfText(
  file: File,
  onProgress?: (page: number, total: number) => void,
): Promise<ExtractedPdf> {
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data, ...PDFJS_ASSET_OPTIONS }).promise;
  const total = doc.numPages;
  const parts: string[] = [];
  const pageImages: string[] = [];
  let emptyPages = 0;

  for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (text.length < 20) emptyPages += 1;
    parts.push(`[第 ${pageNumber} 页]\n${text}`);

    // 前若干页渲染成图像：这样视觉模型能直接读版面、公式、表格与图，
    // 而不依赖文本提取（扫描件提取为空时尤其重要）。
    if (pageNumber <= MAX_RENDERED_PAGES) {
      const rendered = await renderPageToDataUrl(page, pageNumber, total);
      if (rendered) pageImages.push(rendered);
    }
    onProgress?.(pageNumber, total);
  }

  await doc.destroy();
  return { text: parts.join('\n\n'), pages: total, emptyPages, pageImages };
}

/** 把一页渲染成 JPEG data URL（用 JPEG 而非 PNG：截图类内容体积小很多）。 */
async function renderPageToDataUrl(
  page: pdfjs.PDFPageProxy,
  pageNumber: number,
  total: number,
): Promise<string | null> {
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, RENDER_WIDTH / base.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    // 白底：PDF 默认透明，直接转 JPEG 会变成黑底
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    void pageNumber;
    void total;
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null; // 单页渲染失败不影响整体提取
  }
}

/** 按文件扩展名猜参考资料类型。 */
export function referenceKindForFile(name: string): 'pdf' | 'text' | 'bibtex' {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.bib')) return 'bibtex';
  return 'text';
}
