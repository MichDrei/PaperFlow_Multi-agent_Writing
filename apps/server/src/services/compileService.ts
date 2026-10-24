/**
 * 编译用例：按内容哈希缓存编译结果，避免多模型反复触发同一份 PDF 的重编译。
 * 这是"聊天与编译互相不阻塞"的基础：同一份源码只会真正编译一次。
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { CompileRequest, CompileResult } from '@paperflow/core';
import {
  HttpCompiler,
  MockCompiler,
  inverseSearch,
  parseSyncTeX,
  type LatexCompiler,
  type SyncTeXIndex,
} from '@paperflow/latex';
import { TectonicCompiler, isTectonicAvailable } from '@paperflow/latex/tectonic';

export interface CompileServiceOptions {
  /** 编译产物 PDF 的缓存路径（按项目 id）。 */
  /** 远端 TeX 服务地址；不设置则本地引擎。 */
  remoteUrl?: string;
  /** 本地 Tectonic 二进制路径（默认自动探测仓库内 .tectonic/bin/tectonic）。 */
  tectonicPath?: string;
  /** 强制指定引擎，主要用于测试。 */
  forceEngine?: 'tectonic' | 'mock';
  /** 缓存条目上限。 */
  cacheSize?: number;
  /** 编译产物 PDF 的缓存文件路径（按项目 id）——大 PDF 不塞进 JSON。 */
  pdfCachePath?: (projectId: string) => string;
  fileName?: string;
}

interface CacheEntry {
  result: CompileResult;
  storedAt: number;
}

export class CompileService {
  private readonly compiler: LatexCompiler;

  private readonly cache = new Map<string, CacheEntry>();

  /**
   * 每个项目最近一次编译的 SyncTeX 索引。
   *
   * 索引体积很大（一篇 8 页论文解压后上兆），所以**留在服务端**，
   * 只提供一个"给坐标、返回源码位置"的小接口，不随编译响应下发。
   */
  private readonly synctex = new Map<string, SyncTeXIndex>();

  /** 每个项目最近一次编译产物的 PDF 全文。 */
  private readonly compiledText = new Map<string, string>();

  private readonly cacheSize: number;

  private readonly pdfCachePath?: (projectId: string) => string;

  constructor(options: CompileServiceOptions = {}) {
    // 引擎选择顺序：远端服务 → 本地 Tectonic（真排版） → MockCompiler（纯前端近似排版）
    if (options.remoteUrl) {
      this.compiler = new HttpCompiler({ baseUrl: options.remoteUrl });
    } else if (options.forceEngine === 'mock' || (options.forceEngine !== 'tectonic' && !isTectonicAvailable(options.tectonicPath))) {
      this.compiler = new MockCompiler({ fileName: options.fileName ?? 'main.tex' });
    } else {
      this.compiler = new TectonicCompiler({ binaryPath: options.tectonicPath });
    }
    this.cacheSize = options.cacheSize ?? 32;
    this.pdfCachePath = options.pdfCachePath;
  }

  get engine(): string {
    return this.compiler.name;
  }

  /** 解析并缓存本次编译的 SyncTeX 索引。 */
  private cacheSyncTeX(projectId: string | undefined, text: string, mainPath: string): void {
    if (!projectId) return;
    try {
      const index = parseSyncTeX(text);
      // synctex 记的是编译时的绝对路径；转成相对项目根的路径，前端才能对上文件树里的条目
      const mainDir = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : '';
      index.inputs = index.inputs.map((path) => {
        if (!path) return path;
        const normalized = path.replace(/\\/g, '/');
        const anchor = `/main.tex`;
        const cut = normalized.lastIndexOf(anchor);
        if (cut !== -1) return mainDir + normalized.slice(cut + 1);
        // 其它文件：只保留文件名（子目录结构在 synctex 里不可靠）
        return mainDir + normalized.slice(normalized.lastIndexOf('/') + 1);
      });
      this.synctex.set(projectId, index);
    } catch {
      // 解析失败只是没有精确跳转，不影响编译结果
    }
  }

  /**
   * PDF 坐标 → 源码位置（SyncTeX 反向搜索）。
   * 坐标为 bp（1/72 英寸），原点在页面左下角。
   */
  locate(
    projectId: string,
    page: number,
    xBp: number,
    yBp: number,
    pageHeightBp: number,
  ): { file: string; line: number; column: number } | undefined {
    const index = this.synctex.get(projectId);
    if (!index) return undefined;
    const hit = inverseSearch(index, page, xBp, yBp, pageHeightBp);
    if (!hit) return undefined;
    return { file: hit.file, line: hit.line, column: hit.column };
  }

  /** 是否已有可用的 SyncTeX 索引（前端据此决定用精确定位还是文本匹配兜底）。 */
  hasSyncTeX(projectId: string): boolean {
    return this.synctex.has(projectId);
  }

  /**
   * 从编译产物的 PDF 里提取全文。
   *
   * 为什么要它：源码里有宏、注释、被注释掉的段落，agent 读源码并不等于"读到了这篇文章"。
   * PDF 才是**读者看到的正文**。提取结果按项目缓存，随编译刷新。
   */
  private async extractPdfText(projectId: string | undefined, pdf: Uint8Array): Promise<void> {
    if (!projectId) return;
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await pdfjs.getDocument({ data: pdf, useSystemFonts: false }).promise;
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      }
      // 依赖升级后 pdfjs 的类型里没暴露 destroy，运行时存在；用可选调用兜住
      void (doc as unknown as { destroy?: () => void }).destroy?.();
      this.compiledText.set(projectId, pages.join('\n\n').replace(/[ \t]+/g, ' ').trim());
    } catch {
      // 提取失败只是少一份上下文，不影响编译结果
      this.compiledText.delete(projectId);
    }
  }

  /** 某项目最近一次编译产物的全文（供 chat 注入）。 */
  compiledTextOf(projectId: string): string | undefined {
    return this.compiledText.get(projectId);
  }

  async compile(req: CompileRequest): Promise<CompileResult> {
    /*
     * 缓存键：**逐文件喂给哈希**，不要先拼成一个大字符串。
     *
     * 原先写的是 `auxFiles.map(f => path + content).join('\0')`，
     * 毕设项目有 479MB 图片（base64 后更大），拼出来的字符串超过 V8 上限，
     * 编译接口直接 500 `Invalid string length` —— 报错信息完全看不出真实原因。
     */
    const hasher = createHash('sha256').update(req.content ?? '').update('\u0000');
    for (const file of req.auxFiles ?? []) {
      hasher.update(file.path).update('\u0000').update(file.content).update('\u0000');
    }
    const key = hasher.digest('hex');

    const hit = this.cache.get(key);
    if (hit) {
      const projectId = req.projectId;
      const pdfUrl =
        projectId && this.pdfCachePath && hit.result.ok
          ? `/api/projects/${encodeURIComponent(projectId)}/pdf?v=${encodeURIComponent(key)}`
          : undefined;
      return { ...hit.result, pdfUrl, cached: true };
    }

    const output = await this.compiler.compile(req);
    /*
     * PDF 落盘，响应里只给 URL。
     *
     * 之前把 PDF 直接 base64 进 JSON：几百 MB 的产物会让 base64 字符串超过 V8 上限，
     * 整个编译接口报 500 `Invalid string length`（导入毕设项目后就是这么炸的）。
     */
    let pdfUrl: string | undefined;
    if (output.pdfBytes && req.projectId && this.pdfCachePath) {
      try {
        const target = this.pdfCachePath(req.projectId);
        await writeFile(target, output.pdfBytes);
        // `?v=` 用内容哈希做缓存令牌，产物变了浏览器不会拿到旧 PDF
        pdfUrl = `/api/projects/${encodeURIComponent(req.projectId)}/pdf?v=${encodeURIComponent(key)}`;
      } catch {
        pdfUrl = undefined;
      }
    }
    if (output.synctexText) {
      this.cacheSyncTeX(req.projectId, output.synctexText, req.mainPath ?? 'main.tex');
    }
    if (output.pdfBytes) {
      await this.extractPdfText(req.projectId, output.pdfBytes);
    }
    const result: CompileResult = {
      ok: output.ok,
      log: output.log,
      diagnostics: output.diagnostics,
      // anchors 必须随结果一起返回：前端靠它把"AI 改动的源码行"映射到 PDF 页面。
      // （这里曾经漏掉过，导致后端编译模式下点击定位无反应——被测试逮到。）
      anchors: output.anchors,
      durationMs: output.durationMs,
    };

    // LRU 式淘汰：Map 的插入顺序即访问顺序，超限时删最早的一条。
    this.cache.set(key, { result, storedAt: Date.now() });
    if (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    return { ...result, pdfUrl, cached: false };
  }
}
