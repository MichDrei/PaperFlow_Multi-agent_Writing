/**
 * 二进制文件查看器：图片与 PDF。
 *
 * 为什么需要它：编辑器是 Monaco（纯文本控件），而项目里必然有图片、`.pdf` 甚至字体。
 * 早先的实现只给二进制文件留了元信息、点开是一张白纸——用户会以为"文件坏了"。
 * 现在按类型分流：图片直接显示，PDF 用 pdf.js 渲染（与编译产物预览共用同一套 CMap 配置，
 * 中文 PDF 才不会整页空白）。
 */

import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { FileWarning, Loader2 } from 'lucide-react';
import { EmptyState } from '@paperflow/ui';
import { PDFJS_ASSET_OPTIONS } from '@/lib/pdf';
import { useWorkspaceStore } from '@/stores/workspaceStore';

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/** 是否该交给查看器而不是 Monaco。 */
export function isBinaryFile(path: string, kind: string): boolean {
  return kind === 'image' || /\.(png|jpe?g|gif|webp|svg|bmp|pdf|eps|ttf|otf)$/i.test(path);
}

export function BinaryViewer({ path }: { path: string }) {
  const file = useWorkspaceStore((s) => s.document.files[path]);
  const ensureFileContent = useWorkspaceStore((s) => s.ensureFileContent);
  const [loading, setLoading] = useState(true);

  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const isPdf = extension === 'pdf';

  // 按需拉取 base64 内容：项目清单里只带元信息，避免一进页面就把所有图片塞进内存
  useEffect(() => {
    setLoading(true);
    void ensureFileContent(path).finally(() => setLoading(false));
  }, [path, ensureFileContent]);

  if (loading || !file?.content) {
    return (
      <EmptyState
        icon={<Loader2 className="size-6 animate-spin" />}
        title="正在加载文件…"
        hint={file?.size ? `${(file.size / 1024).toFixed(1)} KB` : undefined}
      />
    );
  }

  if (isPdf) return <PdfFileView path={path} base64={file.content} />;

  const mime = IMAGE_TYPES[extension];
  if (mime) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-ink-950 p-4">
        <img
          src={`data:${mime};base64,${file.content}`}
          alt={path}
          className="max-h-full max-w-full rounded shadow-2xl shadow-black/60 ring-1 ring-ink-800"
        />
      </div>
    );
  }

  // EPS / 字体等：没有通用渲染方案，如实说明而不是给一张白纸
  const size = file.size ?? 0;
  return (
    <EmptyState
      icon={<FileWarning className="size-6" />}
      title="这个格式暂不支持预览"
      hint={`${path}（${size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`}）会在编译时一并交给 TeX 引擎，只是无法在编辑器里显示。`}
    />
  );
}

/** PDF 文件预览：分页 + 缩放。 */
function PdfFileView({ path, base64 }: { path: string; base64: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setError(null);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const task = pdfjs.getDocument({ data: bytes, ...PDFJS_ASSET_OPTIONS });
    task.promise
      .then((doc) => {
        if (disposed) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : 'PDF 解析失败');
      });
    return () => {
      disposed = true;
      void docRef.current?.destroy();
      docRef.current = null;
    };
  }, [base64]);

  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    void (async () => {
      try {
        const pdfPage = await doc.getPage(page);
        const viewport = pdfPage.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({
          canvasContext: context,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
      } catch (err) {
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
          setError(err instanceof Error ? err.message : '渲染失败');
        }
      }
    })();
  }, [page, scale, numPages]);

  if (error) {
    return <EmptyState icon={<FileWarning className="size-6" />} title="PDF 无法渲染" hint={error} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-925">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-ink-800 px-2.5 text-[11px] text-ink-400">
        <span className="truncate font-mono">{path}</span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded px-1.5 py-0.5 hover:bg-ink-800">
            ←
          </button>
          <span className="font-mono">
            {page} / {numPages || '…'}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(numPages || 1, p + 1))}
            className="rounded px-1.5 py-0.5 hover:bg-ink-800"
          >
            →
          </button>
          <span className="mx-1 h-3 w-px bg-ink-800" />
          <button type="button" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))} className="rounded px-1.5 py-0.5 hover:bg-ink-800">
            −
          </button>
          <span className="w-9 text-center font-mono">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScale((s) => Math.min(3, s + 0.2))} className="rounded px-1.5 py-0.5 hover:bg-ink-800">
            +
          </button>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-ink-950 p-3">
        <div className="mx-auto w-fit">
          <canvas ref={canvasRef} className="rounded shadow-2xl shadow-black/60 ring-1 ring-ink-800" />
        </div>
      </div>
    </div>
  );
}
