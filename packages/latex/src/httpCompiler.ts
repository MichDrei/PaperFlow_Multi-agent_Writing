/**
 * 通过 HTTP 调用独立的 LaTeX 编译服务（services/latex-compiler）。
 * 接口契约与 MockCompiler 完全一致，因此可以在运行时无缝替换。
 */

import type { CompileRequest } from '@paperflow/core';
import type { CompileOutput, LatexCompiler, SourceAnchor } from './compiler.js';

interface HttpCompilerOptions {
  /** 编译服务地址，例如 http://localhost:8787 */
  baseUrl: string;
  /**
   * 编译端点路径。可以是函数，用于**多项目**场景——路径要带当前项目 id，
   * 而项目 id 在运行时才确定（`/api/projects/<id>/compile`）。
   */
  path?: string | (() => string);
  /** 单次编译超时（毫秒）。TeX 首次拉取宏包可能较慢。 */
  timeoutMs?: number;
}

export class HttpCompiler implements LatexCompiler {
  readonly name = 'http';

  private readonly baseUrl: string;

  private readonly path: string | (() => string);

  private readonly timeoutMs: number;

  constructor(options: HttpCompilerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.path = options.path ?? '/compile';
    /*
     * 300 秒。
     *
     * 原来 120 秒：一份 144 个文件、几百张图的毕设首次编译要 85 秒以上
     * （服务端 Tectonic 要预热字体和宏包），客户端等不及就 abort，
     * 界面上显示"编译失败"，而服务端其实编译成功了——极难排查。
     */
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async compile(req: CompileRequest): Promise<CompileOutput> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const path = typeof this.path === 'function' ? this.path() : this.path;
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`compile service returned ${res.status}: ${detail.slice(0, 400)}`);
      }
      const payload = (await res.json()) as {
        ok: boolean;
        log: string;
        diagnostics: CompileOutput['diagnostics'];
        pdfBase64?: string;
        pdfUrl?: string;
        anchors?: SourceAnchor[];
        engine?: string;
      };
      const pdfBytes = payload.pdfBase64 ? base64ToBytes(payload.pdfBase64) : undefined;
      // 服务端编译大 PDF 时只给 URL（base64 会超过字符串上限），交给 pdf.js 直接取
      const servedUrl = payload.pdfUrl
        ? new URL(payload.pdfUrl, this.baseUrl || window.location.origin).href
        : undefined;
      return {
        ok: payload.ok,
        log: payload.log,
        diagnostics: payload.diagnostics ?? [],
        pdfBytes,
        pdfUrl: servedUrl ?? (pdfBytes ? toBlobUrl(pdfBytes) : undefined),
        anchors: payload.anchors ?? [],
        engine: payload.engine,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const buffer = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (buffer) return new Uint8Array(buffer.from(b64, 'base64'));
  throw new Error('No base64 decoder available in this runtime');
}

function toBlobUrl(bytes: Uint8Array): string | undefined {
  if (typeof URL === 'undefined' || typeof Blob === 'undefined') return undefined;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));
}
