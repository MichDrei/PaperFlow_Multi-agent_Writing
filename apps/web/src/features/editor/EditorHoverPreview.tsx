/**
 * 编辑器里的自定义悬浮预览面板。
 *
 * 为什么不用 Monaco 自带的 hover provider（那是第一版的做法，已废弃）：
 *
 * · **公式**：provider 的内容走 markdown 渲染器，KaTeX 产出的 HTML/CSS 会被过滤掉
 *   （即使设了 `isTrusted: true` + `supportHtml: true`，实测悬浮框里没有 `.katex` 元素），
 *   分数、根号、上下标的位置全丢，只剩扁平文字；
 * · **图片**：markdown 的 `![](data:...)` 语法**直接不被解析**——Monaco 会把它原样当文字输出
 *   （dump 出来就是 `<p>![alt](data:image/png;base64,…)</p>`），于是所有图片的悬浮都长一个样。
 *
 * 这两件事在 provider 里都没法修，所以改成**自己的 DOM 面板**：KaTeX 能正常排版、
 * 图片能直接显示、PDF 图还能当场渲染第一页。
 */

import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import {
  detectBlockAt,
  detectHoverTarget,
  parseBibEntries,
  renderMath,
  renderTableLatex,
  resolveLabels,
} from './latexHover';
import { useWorkspaceStore } from '@/stores/workspaceStore';

interface PreviewState {
  /** 面板左上角（视口坐标）。 */
  x: number;
  y: number;
  kind: 'cite' | 'ref' | 'image' | 'math' | 'symbol' | 'table';
  /** 文献条目 / 图片 URL / KaTeX HTML 等已算好的内容。 */
  title?: string;
  detail?: string;
  imageUrl?: string;
  imageError?: string;
  katexHtml?: string;
  katexFallback?: string;
  /** 表格预览的 HTML（已按 tabular 解析成 table）。 */
  tableHtml?: string;
  /** 符号命令是否自带参数。 */
  hasArgument?: boolean;
  source: string;
}

export function EditorHoverPreview({ editor, monaco }: { editor: Monaco.editor.IStandaloneCodeEditor; monaco: typeof Monaco }) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const timerRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const hide = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      setPreview(null);
    };

    const buildPreview = async (state: PreviewState, lineText: string) => {
      const store = useWorkspaceStore.getState();
      const id = ++requestIdRef.current;

      if (state.kind === 'cite' || state.kind === 'ref') {
        const entries = parseBibEntries(
          Object.values(store.document.files)
            .filter((f) => f.kind === 'bib' && f.encoding !== 'base64')
            .map((f) => f.content)
            .join('\n'),
        );
        const keys = state.source.split(',').map((k) => k.trim()).filter(Boolean);
        const found = keys.map((key) => entries.find((e) => e.key === key)).filter(Boolean);
        if (found.length === 0) {
          // 不是文献 key：多半是 `\ref{sec:...}` / `\ref{fig:...}`，去文档里找标签
          const model = editor.getModel();
          const labels = model ? resolveLabels((n) => model.getLineContent(n), model.getLineCount()) : new Map();
          const hits = keys.map((key) => labels.get(key)).filter(Boolean);
          if (hits.length > 0) {
            const first = hits[0]!;
            const kindLabel =
              first.kind === 'section' || first.kind === 'subsection'
                ? '小节'
                : first.kind === 'figure'
                  ? '图'
                  : first.kind === 'table'
                    ? '表'
                    : first.kind === 'equation'
                      ? '公式'
                      : '标签';
            setPreview({
              ...state,
              title: first.title ? `${kindLabel}：${first.title}` : `${kindLabel}标签`,
              detail: `第 ${first.line} 行 · Ctrl/⌘+点击可直接跳转`,
            });
            return;
          }
          setPreview({
            ...state,
            title: '未找到该标签',
            detail: `文档里既没有这个文献 key，也没有 \\label{${state.source}}`,
          });
          return;
        }
        const first = found[0]!;
        setPreview({
          ...state,
          title: first.title ?? first.key,
          detail: [first.author, first.venue, first.year].filter(Boolean).join(' · '),
        });
        return;
      }

      if (state.kind === 'image') {
        const url = await loadImageUrl(state.source);
        if (id !== requestIdRef.current) return; // 鼠标已经移开了，别用过期的结果覆盖
        setPreview(
          url
            ? { ...state, imageUrl: url }
            : { ...state, imageError: '项目里找不到这个文件，或该格式无法预览' },
        );
        return;
      }

      // 已经带参数（`\bar{a}_t`、`\mathbf{d}`）就原样渲染；否则补占位符
      const tex = state.kind === 'symbol' && !state.hasArgument ? normalizeSymbol(state.source) : state.source;
      const rendered = renderMath(tex, false);
      setPreview({
        ...state,
        katexHtml: rendered?.html,
        katexFallback: rendered?.text,
      });
    };

    const onMove = (event: Monaco.editor.IEditorMouseEvent) => {
      const position = event.target.position;
      if (!position || event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) {
        hide();
        return;
      }
      const model = editor.getModel();
      const lineText = model?.getLineContent(position.lineNumber) ?? '';

      // ① 先看是否落在**跨行块**里（多行公式环境 / 表格）。
      //    只按当前行取内容是不够的：`\begin{equation} … \end{equation}` 里的每一行
      //    单看都没有公式定界符，会被误判成普通符号（这正是"公式渲染错误"的原因）。
      const block = model
        ? detectBlockAt(
            (n) => model.getLineContent(n),
            model.getLineCount(),
            position.lineNumber,
          )
        : undefined;
      if (block) {
        const anchor = { x: event.event.posx + 14, y: event.event.posy + 18 };
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          if (block.kind === 'table') {
            // 表格里还有 `\begin{table}` 的 caption/label，一并找出来显示
            const caption = findTableCaption(model!, block.startLine, block.endLine);
            setPreview({
              ...anchor,
              kind: 'table',
              source: `${block.environment}（第 ${block.startLine}–${block.endLine} 行）`,
              tableHtml: renderTableLatex(block.content),
              title: caption,
            });
          } else {
            const tex = toKatexable(block.environment, block.content);
            const rendered = renderMath(tex, true);
            setPreview({
              ...anchor,
              kind: 'math',
              source: `${block.environment}（第 ${block.startLine}–${block.endLine} 行）`,
              katexHtml: rendered?.html,
              katexFallback: rendered?.text,
            });
          }
        }, 220);
        return;
      }

      // ② 行内目标
      const target = detectHoverTarget(lineText, position.column);
      if (!target) {
        hide();
        return;
      }
      const source = target.value;
      // 防抖：鼠标扫过一行时不要一路弹面板
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        void buildPreview(
          {
            x: event.event.posx + 14,
            y: event.event.posy + 18,
            kind: target.kind,
            source,
            hasArgument: target.hasArgument,
          },
          lineText,
        );
      }, 220);
    };

    const disposable = editor.onMouseMove(onMove);
    const leave = editor.onMouseLeave(() => hide());
    const scroll = editor.onDidScrollChange(() => hide());
    return () => {
      disposable.dispose();
      leave.dispose();
      scroll.dispose();
      hide();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, monaco]);

  if (!preview) return null;

  // 面板不允许跑出视口
  const width = preview.kind === 'image' ? 340 : preview.kind === 'table' ? 460 : 380;
  const left = Math.min(preview.x, window.innerWidth - width - 12);
  const top = Math.min(preview.y, window.innerHeight - 200);

  return (
    <div
      data-editor-hover
      className="pf-enter pointer-events-none fixed z-50 max-w-[380px] rounded-lg border border-ink-700 bg-ink-850/98 px-2.5 py-2 shadow-2xl shadow-black/60 backdrop-blur"
      style={{ left, top, width }}
    >
      {(preview.kind === 'cite' || preview.kind === 'ref') && (
        <>
          <div className="text-[11.5px] leading-snug font-semibold text-ink-100">{preview.title}</div>
          {preview.detail && <div className="mt-0.5 text-[10.5px] leading-snug text-ink-400">{preview.detail}</div>}
          <div className="mt-1 font-mono text-[9.5px] text-ink-600">{preview.source}</div>
        </>
      )}

      {preview.kind === 'image' && (
        <>
          <div className="mb-1 truncate font-mono text-[10px] text-ink-400">{preview.source}</div>
          {preview.imageUrl ? (
            <img src={preview.imageUrl} alt={preview.source} className="max-h-[240px] w-full rounded object-contain ring-1 ring-ink-800" />
          ) : (
            <div className="py-2 text-[10.5px] text-accent-amber">{preview.imageError ?? '正在加载…'}</div>
          )}
        </>
      )}

      {preview.kind === 'math' && (
        <>
          {/* KaTeX 在这里能真正排版：面板是我们自己的 DOM，不受 markdown 渲染器过滤 */}
          {preview.katexHtml ? (
            <div className="pf-katex-hover overflow-x-auto text-ink-100" dangerouslySetInnerHTML={{ __html: preview.katexHtml }} />
          ) : (
            <div className="font-mono text-[11px] text-ink-300">{preview.source}</div>
          )}
        </>
      )}

      {preview.kind === 'table' && (
        <>
          {preview.title && (
            <div className="mb-1 text-[11px] font-semibold text-ink-100">{preview.title}</div>
          )}
          {preview.tableHtml ? (
            <div
              className="pf-table-wrap overflow-x-auto text-ink-100"
              dangerouslySetInnerHTML={{ __html: preview.tableHtml }}
            />
          ) : (
            <div className="py-1 text-[10.5px] text-accent-amber">这个表格的写法暂不支持预览</div>
          )}
          <div className="mt-1 font-mono text-[9.5px] text-ink-500">{preview.source}</div>
        </>
      )}

      {preview.kind === 'symbol' && (
        <>
          {preview.katexHtml ? (
            <div className="pf-katex-hover text-[15px] text-ink-100" dangerouslySetInnerHTML={{ __html: preview.katexHtml }} />
          ) : (
            <div className="text-[13px] text-ink-200">{preview.katexFallback ?? preview.source}</div>
          )}
          <div className="mt-1 font-mono text-[9.5px] text-ink-500">{preview.source}</div>
        </>
      )}
    </div>
  );
}

/**
 * 把环境体转成 KaTeX 能渲染的形式。
 * `align`/`gather` 这些是**文档级**环境，KaTeX 只认对应的 `aligned`/`gathered`，
 * 不转换的话会直接渲染失败（用户看到的就是"公式错误"）。
 */
function toKatexable(environment: string, content: string): string {
  const map: Record<string, string> = {
    align: 'aligned',
    'align*': 'aligned',
    eqnarray: 'aligned',
    'eqnarray*': 'aligned',
    gather: 'gathered',
    'gather*': 'gathered',
    multline: 'gathered',
    'multline*': 'gathered',
    split: 'aligned',
  };
  const inner = map[environment];
  if (!inner) return content;
  // 去掉对齐用的 & 之外的多余行内标注（\notag 等 KaTeX 不认）
  return `\\begin{${inner}}${content.replace(/\\notag/g, '')}\\end{${inner}}`;
}

/** 在表格块周围找 `\caption{...}` 作为预览标题。 */
function findTableCaption(
  model: Monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
): string | undefined {
  const from = Math.max(1, startLine - 12);
  const to = Math.min(model.getLineCount(), endLine + 4);
  for (let i = from; i <= to; i += 1) {
    const text = model.getLineContent(i);
    const match = /\\caption(?:\[[^\]]*\])?\{([^}]*)\}/.exec(text);
    if (match) return match[1]!.replace(/\\[a-zA-Z]+/g, '').replace(/[{}]/g, '').trim();
  }
  return undefined;
}

/** 只写了命令没写参数时补一个占位参数，便于直接渲染（`\mathcal` → `\mathcal{F}`）。 */
function normalizeSymbol(command: string): string {
  const needsArgument =
    /^\\(math[a-z]+|mathcal|mathbf|mathrm|mathit|mathsf|mathtt|mathfrak|overline|underline|hat|bar|vec|dot|ddot|tilde|sqrt|text|operatorname)$/.test(
      command,
    );
  return needsArgument ? `${command}{F}` : command;
}

/**
 * 把项目里的图片读成可显示的 URL。
 * 位图直接拼 data URL；PDF 用 pdf.js 渲染第一页（论文里的图常是 PDF，`<img>` 显示不了）。
 */
async function loadImageUrl(rawPath: string): Promise<string | undefined> {
  const store = useWorkspaceStore.getState();
  const files = Object.values(store.document.files);
  const normalize = (p: string) => p.replace(/^(\.\/)+/, '').replace(/^figures\//, '');
  const wanted = normalize(rawPath);
  // LaTeX 里常省略扩展名：按"同名 + 常见图片扩展名"匹配
  const file =
    files.find((f) => f.path === rawPath) ??
    files.find((f) => normalize(f.path) === wanted) ??
    files.find(
      (f) => normalize(f.path).replace(/\.[a-z0-9]+$/i, '') === wanted.replace(/\.[a-z0-9]+$/i, ''),
    );
  if (!file) return undefined;

  await store.ensureFileContent(file.path);
  const content = useWorkspaceStore.getState().document.files[file.path]?.content;
  if (!content) return undefined;

  const extension = file.path.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'pdf') {
    try {
      const pdfjs = await import('pdfjs-dist');
      const { PDFJS_ASSET_OPTIONS } = await import('@/lib/pdf');
      const binary = atob(content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const doc = await pdfjs.getDocument({ data: bytes, ...PDFJS_ASSET_OPTIONS }).promise;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 420 / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) return undefined;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      void doc.destroy();
      return canvas.toDataURL('image/png');
    } catch {
      return undefined;
    }
  }

  const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension || 'png'}`;
  return `data:${mime};base64,${content}`;
}
