/**
 * LaTeX 编译抽象。
 *
 * - `LatexCompiler`：调用方唯一依赖的接口。
 * - `MockCompiler`：纯浏览器/Node 实现，把 LaTeX 粗排成真实 PDF（pdf-lib），
 *   用于在未接入 TeX 引擎时让"编辑 → 编译 → 预览 → 定位"整条链路可跑通。
 * - `HttpCompiler`（httpCompiler.ts）：接入 services/latex-compiler 或 apps/server。
 */

import type { CompileRequest, CompileResult, SourceAnchor } from '@paperflow/core';

export type { SourceAnchor };

export interface CompileOutput extends CompileResult {
  /** PDF 原始字节（浏览器端可直接做 blob URL）。 */
  pdfBytes?: Uint8Array;
  /**
   * 实际执行编译的引擎名（'tectonic' / 'mock' / 'http'）。
   * 由服务端在响应里给出——客户端编译器的 name 是传输层（'http'），
   * 直接显示它会让人看到"引擎 = http"这种没有意义的信息。
   */
  engine?: string;
  /**
   * SyncTeX 原始文本（已解压）。体积可达 MB 级，**不随 HTTP 响应下发**：
   * 由编译服务解析成索引缓存起来，供"PDF 坐标 → 源码位置"的定位接口使用。
   */
  synctexText?: string;
}

export interface LatexCompiler {
  readonly name: string;
  compile(req: CompileRequest): Promise<CompileOutput>;
}
