/**
 * LaTeX 编辑器（Monaco）。
 *
 * 承载 Cursor 式交互的左半边：
 * - 选区变化 → 写回 workspaceStore.selection（快照），并驱动浮动工具栏；
 * - 右键菜单 / 快捷键 → 直接把选区交给多模型群聊；
 * - AI 提议被应用后 → 用行装饰高亮改动区间。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { Range } from 'monaco-editor';
import type * as Monaco from 'monaco-editor';
import { Check, Highlighter, MessageSquarePlus, Sparkles, Wand2 } from 'lucide-react';
import type { EditIntent, Selection } from '@paperflow/core';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useEditorStore } from '@/stores/editorStore';
import { useChatStore } from '@/stores/chatStore';
import { languageForPath } from '@/lib/monaco-setup';
import { EditorHoverPreview } from './EditorHoverPreview';
import { useCollabDocument } from '@/features/realtime/useCollabDocument';
import { apiUrl } from '@/lib/backend';
import { useAnnotationStore } from '@/stores/annotationStore';
import { useThemeStore } from '@/stores/themeStore';
import { useSessionStore } from '@/stores/sessionStore';
import { resolveLabels } from './latexHover';
import { PDFJS_ASSET_OPTIONS } from '@/lib/pdf';
import { BinaryViewer, isBinaryFile } from '@/features/viewer/BinaryViewer';
import { INTENT_ACTIONS } from '@/lib/intent';

interface FloatingBar {
  top: number;
  left: number;
}

/**
 * 协同覆盖层。
 *
 * 只有团队模式才连；连上后在编辑器右上角显示"谁也在编辑"，
 * 光标本身由 y-monaco 渲染（每人一种颜色，带名字标签的竖条）。
 */
/**
 * 协同状态条 + 在线成员 + 批注列表。
 *
 * 光标本身由 y-monaco 渲染（每人一种颜色、带名字的竖条），这里只做状态与摘要。
 */
function CollabOverlay(props: {
  status: 'off' | 'connecting' | 'connected' | 'disconnected';
  peers: { clientId: number; name: string; color: string }[];
}) {
  if (props.status === 'off') {
    // 诊断用：off 时也留一个不可见标记，方便排查"为什么没连上"
    return <span data-collab-status="off" className="hidden" />;
  }

  return (
    <div
      data-collab-status={props.status}
      className="pointer-events-none absolute right-2 top-1.5 z-20 flex max-w-[46%] flex-col items-end gap-1"
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`rounded-full px-1.5 py-0.5 text-[9.5px] ${
            props.status === 'connected'
              ? 'bg-accent-teal/15 text-accent-teal'
              : props.status === 'connecting'
                ? 'bg-accent-amber/15 text-accent-amber'
                : 'bg-ink-800 text-ink-500'
          }`}
          title="实时协同连接状态"
        >
          {props.status === 'connected' ? '协同中' : props.status === 'connecting' ? '连接中…' : '未连接'}
        </span>
        {props.peers.map((peer) => (
          <span
            key={peer.clientId}
            className="flex items-center gap-1 rounded-full bg-ink-850/90 px-1.5 py-0.5 text-[9.5px] text-ink-200 ring-1 ring-ink-700"
            title={`${peer.name} 也在编辑`}
          >
            <span className="size-1.5 rounded-full" style={{ background: peer.color }} />
            {peer.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function LatexEditor() {
  /** 白天模式：Monaco 有自己的一套颜色，必须切主题而不是改 CSS。 */
  const lightMode = useThemeStore((s) => s.light);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const [bar, setBar] = useState<FloatingBar | null>(null);
  /** onMount 里拿到 editor/monaco 实例后置真，用于挂载悬浮预览面板。 */
  const [editorReady, setEditorReady] = useState(false);
  const editorReadyRef = useRef(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const definitionDisposableRef = useRef<{ dispose: () => void } | null>(null);

  /**
   * 把浮动栏限制在编辑器面板内。
   *
   * 之前只钳了左边界（`Math.max(8, visible.left)`），没管右边——选区靠右时
   * 浮动栏会溢出面板被裁掉。这里按**实测宽度**回收 left，让整条栏始终可见。
   * 用 layout effect：必须在浏览器绘制前调整，否则会看到一次跳动。
   */
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el || !bar) return;
    const container = el.offsetParent as HTMLElement | null;
    if (!container) return;
    const maxLeft = Math.max(8, container.clientWidth - el.offsetWidth - 8);
    if (bar.left > maxLeft) setBar({ ...bar, left: maxLeft });
  });

  const activeFile = useWorkspaceStore((s) => s.activeFile());
  const revealLine = useWorkspaceStore((s) => s.revealLine);
  const clearReveal = useWorkspaceStore((s) => s.clearReveal);
  const highlightRange = useWorkspaceStore((s) => s.highlightRange);
  const setSelection = useWorkspaceStore((s) => s.setSelection);
  const updateFileContent = useWorkspaceStore((s) => s.updateFileContent);
  const send = useChatStore((s) => s.send);

  const metrics = useEditorStore();
  const language = useMemo(() => languageForPath(activeFile.path), [activeFile.path]);

  /** 把 Monaco 的选区转成领域模型 Selection（并计算浮动工具栏位置）。 */
  const syncSelection = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor) => {
      const model = editor.getModel();
      const range = editor.getSelection();
      const position = editor.getPosition();
      if (position) metrics.setCursor({ line: position.lineNumber, column: position.column });
      if (!model || !range) {
        setBar(null);
        metrics.setSelectionMetrics(0, 0);
        setSelection(null);
        return;
      }
      if (range.isEmpty()) {
        setBar(null);
        metrics.setSelectionMetrics(0, 0);
        setSelection(null);
        return;
      }
      const text = model.getValueInRange(range);
      const start = range.getStartPosition();
      const end = range.getEndPosition();
      const selection: Selection = {
        fileId: activeFile.id,
        start: { line: start.lineNumber, column: start.column },
        end: { line: end.lineNumber, column: end.column },
        // 选区文本按"整行快照"保存：多数改写意图作用于完整句子/段落，
        // 行内半截选择会把 LaTeX 命令切断，模型很难给出可编译的结果。
        text: expandToLines(model, range),
      };
      setSelection(selection);
      metrics.setSelectionMetrics(end.lineNumber - start.lineNumber + 1, text.length);

      const visible = editor.getScrolledVisiblePosition(range.getStartPosition());
      if (visible) {
        setBar({ top: Math.max(4, visible.top - 40), left: Math.max(8, visible.left) });
      } else {
        setBar(null);
      }
    },
    [activeFile.id, metrics, setSelection],
  );

  /**
   * 把项目里的图片读成可显示的 URL。
   * 位图直接拼 data URL；PDF 用 pdf.js 渲染第一页（论文里的图常是 PDF，直接显示不了）。
   */
  const loadImageUrl = useCallback(async (rawPath: string): Promise<string | undefined> => {
    const state = useWorkspaceStore.getState();
    const files = Object.values(state.document.files);
    const normalize = (p: string) => p.replace(/^(\.\/)+/, '').replace(/^figures\//, '');
    const wanted = normalize(rawPath);
    // LaTeX 里常省略扩展名，这里按"同名 + 常见图片扩展名"匹配
    const file =
      files.find((f) => f.path === rawPath) ??
      files.find((f) => normalize(f.path) === wanted) ??
      files.find((f) => normalize(f.path).replace(/\.[a-z0-9]+$/i, '') === wanted.replace(/\.[a-z0-9]+$/i, ''));
    if (!file) return undefined;

    const extension = file.path.split('.').pop()?.toLowerCase() ?? '';
    if (extension === 'pdf') {
      // PDF 图：渲染第一页为 PNG（限制宽度，避免 hover 里出现巨图）
      const binary = await loadBase64(file.path);
      if (!binary) return undefined;
      try {
        const pdfjs = await import('pdfjs-dist');
        const doc = await pdfjs.getDocument({ data: base64ToBytes(binary), ...PDFJS_ASSET_OPTIONS }).promise;
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const targetWidth = 420;
        const scaled = page.getViewport({ scale: targetWidth / viewport.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(scaled.width);
        canvas.height = Math.ceil(scaled.height);
        const context = canvas.getContext('2d');
        if (!context) return undefined;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport: scaled }).promise;
        void doc.destroy();
        return canvas.toDataURL('image/png');
      } catch {
        return undefined;
      }
    }

    const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension || 'png'}`;
    // 图片内容按需从服务端拉（项目清单里只带元信息）
    await useWorkspaceStore.getState().ensureFileContent(file.path);
    const content = useWorkspaceStore.getState().document.files[file.path]?.content;
    return content ? `data:${mime};base64,${content}` : undefined;
  }, []);

  /**
   * 在 Monaco **创建编辑器之前**注册主题。
   *
   * 放在 onMount 里不生效：那时编辑器已经用默认主题渲染完成
   * （实测浅色模式仍是白底黑字，羊皮纸底色出不来）。
   */
  /*
   * 主题：定义 + 应用。
   *
   * 试过把 defineTheme 放进 onMount / beforeMount，实测都没生效（编辑器仍是默认主题）。
   * 这里直接用全局 API：先 defineTheme（幂等），再 setTheme——
   * setTheme 会立刻重绘，不依赖组件挂载顺序。
   */
  useEffect(() => {
    const m = monacoRef.current;
    if (!m || !editorReady) return;
    m.editor.defineTheme('paperflow-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#0e121a' },
    });
    m.editor.defineTheme('paperflow-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '8a8171' },
        { token: 'keyword', foreground: '8c4a1f' },
        { token: 'string', foreground: '3f6b3a' },
      ],
      colors: {
        'editor.background': '#faf4e6',
        'editor.foreground': '#2b2519',
        'editorLineNumber.foreground': '#b3a992',
        'editorLineNumber.activeForeground': '#6b6047',
        'editor.selectionBackground': '#e8d9b5',
        'editor.inactiveSelectionBackground': '#efe4c9',
        'editor.lineHighlightBackground': '#f3ecd9',
        'editorCursor.foreground': '#8c4a1f',
        'editorWidget.background': '#fffdf6',
        'editorWidget.border': '#e0d6bd',
      },
    });
    m.editor.setTheme(lightMode ? 'paperflow-light' : 'paperflow-dark');
  }, [lightMode, editorReady]);

  const beforeMount = useCallback((monaco: typeof Monaco) => {
    monaco.editor.defineTheme('paperflow-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#0e121a' },
    });
    monaco.editor.defineTheme('paperflow-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '8a8171' },
        { token: 'keyword', foreground: '8c4a1f' },
        { token: 'string', foreground: '3f6b3a' },
      ],
      colors: {
        'editor.background': '#faf4e6',
        'editor.foreground': '#2b2519',
        'editorLineNumber.foreground': '#b3a992',
        'editorLineNumber.activeForeground': '#6b6047',
        'editor.selectionBackground': '#e8d9b5',
        'editor.inactiveSelectionBackground': '#efe4c9',
        'editor.lineHighlightBackground': '#f3ecd9',
        'editorCursor.foreground': '#8c4a1f',
        'editorWidget.background': '#fffdf6',
        'editorWidget.border': '#e0d6bd',
      },
    });
  }, []);


  const onMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      /*
       * `\ref{key}` → `\label{key}` 的"转到定义"（F12 / Ctrl+点击）。
       *
       * 之前 `\ref` 只是当普通文字，点了没反应；而用户对"文内引用跳转"的期待正是
       * 跳到被引用的那一节/图/表。这里把标签解析出来，返回它的位置。
       */
      definitionDisposableRef.current?.dispose();
      definitionDisposableRef.current = monaco.languages.registerDefinitionProvider('latex', {
        provideDefinition(model, position) {
          const line = model.getLineContent(position.lineNumber);
          const re = /\\(?:ref|eqref|autoref|cref|Cref|pageref)\*?\{([^}]*)\}/g;
          let match: RegExpExecArray | null;
          let key: string | undefined;
          while ((match = re.exec(line)) !== null) {
            if (position.column - 1 < match.index || position.column - 1 > match.index + match[0].length) continue;
            key = match[1]!.trim();
            break;
          }
          if (!key) return null;
          const labels = resolveLabels((n) => model.getLineContent(n), model.getLineCount());
          const label = labels.get(key);
          if (!label) return null;
          return {
            uri: model.uri,
            range: {
              startLineNumber: label.line,
              startColumn: 1,
              endLineNumber: label.line,
              endColumn: 1,
            },
          };
        },
      });

      /*
       * 记住最近一次非空选区：批注浮层里点"批注"时焦点已经跑到输入框，
       * 直接读 editor.getSelection() 可能已经空了，所以在这里持续记录。
       */
      editor.onDidChangeCursorSelection(() => {
        const sel = editor.getSelection();
        const model = editor.getModel();
        if (!sel || !model || sel.isEmpty()) return;
        lastSelectionRef.current = {
          from: model.getOffsetAt(sel.getStartPosition()),
          to: model.getOffsetAt(sel.getEndPosition()),
          text: model.getValueInRange(sel),
        };
      });

      /*
       * Ctrl/⌘+Alt+A：给选区加一条批注。
       * 批注存在 Y.Doc 里，所有协作者立刻可见；锚点是相对位置，不会被别人的编辑带跑。
       */
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyA, () => {
        const selection = editor.getSelection();
        const model = editor.getModel();
        if (!selection || !model || selection.isEmpty()) return;
        const quoted = model.getValueInRange(selection);
        const body = window.prompt('批注内容（全体协作者可见）：', '');
        if (!body?.trim()) return;
        addAnnotationRef.current(
          model.getOffsetAt(selection.getStartPosition()),
          model.getOffsetAt(selection.getEndPosition()),
          quoted.slice(0, 300),
          body.trim(),
        );
      });

      // 悬浮预览改用自定义面板（见 EditorHoverPreview）：
      // Monaco 的 hover 内容走 markdown 渲染器，会过滤掉 KaTeX 的 HTML/CSS、
      // 并且**不解析** `![](data:...)` 图片（实测图片语法被原样输出成文字）。
      setEditorReady(true);
      editorReadyRef.current = true;
      decorationsRef.current = editor.createDecorationsCollection([]);

      editor.onDidChangeCursorSelection(() => syncSelection(editor));
      editor.onDidChangeCursorPosition((e) =>
        metrics.setCursor({ line: e.position.lineNumber, column: e.position.column }),
      );
      editor.onDidFocusEditorText(() => metrics.setFocused(true));
      editor.onDidBlurEditorText(() => {
        metrics.setFocused(false);
        setBar(null);
      });

      editor.addAction({
        id: 'paperflow.revise',
        label: 'PaperFlow: 选中内容交给多模型改写',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyK],
        contextMenuGroupId: 'paperflow',
        contextMenuOrder: 1,
        run: (ed) => {
          const range = ed.getSelection();
          const model = ed.getModel();
          if (!range || !model || range.isEmpty()) return;
          const selection: Selection = {
            fileId: activeFile.id,
            start: { line: range.startLineNumber, column: range.startColumn },
            end: { line: range.endLineNumber, column: range.endColumn },
            text: expandToLines(model, range),
          };
          void send('@all 请审阅并改写这段', { selection, intent: 'rewrite' });
        },
      });

      editor.focus();
    },
    [activeFile.id, metrics, send],
  );

  // 大纲 / 诊断跳转
  useEffect(() => {
    if (revealLine == null) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(revealLine);
    editor.setPosition({ lineNumber: revealLine, column: 1 });
    editor.focus();
    clearReveal();
  }, [revealLine, clearReveal]);

  // AI 提议应用后的高亮
  useEffect(() => {
    const decorations = decorationsRef.current;
    if (!decorations) return;
    if (!highlightRange) {
      decorations.set([]);
      return;
    }
    // 精确到列：高亮的就是那个词/那句，而不是整行（用户要的是单词级定位）
    const range = {
      startLineNumber: highlightRange.startLine,
      startColumn: highlightRange.startColumn,
      endLineNumber: highlightRange.endLine,
      endColumn: highlightRange.endColumn,
    };
    const isSingleLine = highlightRange.startLine === highlightRange.endLine;
    decorations.set([
      {
        range,
        options: isSingleLine
          ? { className: 'pf-selection-decoration', inlineClassName: 'pf-word-decoration' }
          : { isWholeLine: true, className: 'pf-selection-decoration' },
      },
    ]);

    // 把光标放到命中处并**选中**它：这样"PDF 里选的词"和"代码里的词"一眼能对上
    const editor = editorRef.current;
    if (editor) {
      editor.setSelection(range);
      editor.revealRangeInCenterIfOutsideViewport(range);
      editor.focus();
    }
  }, [highlightRange, activeFile.id]);

  // 图片 / PDF 不能用 Monaco 打开（它是纯文本控件）——分流到查看器，
  // 否则用户点开一张图只会看到空白，以为文件坏了。
  if (isBinaryFile(activeFile.path, activeFile.kind)) {
    return <BinaryViewer path={activeFile.path} />;
  }

  /*
   * 协同绑定必须**只建一次**（两个绑定会互相打架），所以 hook 放在编辑器本体，
   * 覆盖层只负责展示状态与成员。
   */
  /*
   * 这里必须用**订阅**而不是 `getState()`：
   * 首帧时 session.mode 还是 'solo'、activeFile 还是兜底文件，
   * 用 getState() 取到的是那一瞬间的旧值，collabEnabled 会一直是 false
   * （实测表现：编辑器右上角根本没有"协同中"胶囊，同步自然也没发生）。
   */
  const sessionMode = useSessionStore((s) => s.mode);
  const currentPath = useWorkspaceStore((s) => s.activeFile().path);
  const projectId = useWorkspaceStore((s) => s.activeProjectId);
  /** 协同是否真正生效（同时用于：是否连接、是否让 Yjs 接管 Monaco 的内容）。 */
  /*
   * 团队模式下默认开启协同；需要临时关闭时设 `VITE_COLLAB=0`。
   * （曾经因为两个 bug 默认关过：① 渲染死循环 ② sync 帧缺子类型，
   *   两个都已修复并实测通过：双方 connected、互相看到名字、编辑双向同步。）
   */
  /*
   * 是否开启协同，**由项目决定**：
   * 只有该项目已经进入协作模式（有人被批准加入，`collab=true`）才连。
   * 之前只看"团队模式"，导致单人项目里也会出现别人的光标和"协作中"标识——
   * 用户看到两个同名账号在同一个单人项目里互相同步，非常困惑。
   */
  const projectCollab = useWorkspaceStore((s) => {
    const meta = s.projects.find((p) => p.id === s.activeProjectId);
    return Boolean(meta?.collab);
  });
  const collabOn =
    import.meta.env.VITE_COLLAB !== '0' &&
    sessionMode === 'team' &&
    projectCollab &&
    /\.(tex|bib|cls|sty)$/.test(currentPath);
  const collab = useCollabDocument(
    editorReady ? editorRef.current : null,
    editorReady ? monacoRef.current : null,
    currentPath,
    /*
     * 协同默认**关闭**，需要显式开启（`VITE_COLLAB=1`）。
     * 原因：当前实现还有稳定性问题（浏览器渲染进程会在连接后崩溃），
     * 在修好之前不能让它影响正常使用——这和当初 SyncTeX 的处理方式一致。
     */
    collabOn,
    projectId ?? undefined,
  );
  const addAnnotationRef = useRef(collab.addAnnotation);
  addAnnotationRef.current = collab.addAnnotation;
  const annotationRangesRef = useRef(collab.annotationRanges);
  annotationRangesRef.current = collab.annotationRanges;

  /*
   * 批注高亮：把相对位置解出的区间画成 Monaco decoration。
   * 悬浮显示"谁写了什么"，这样标注在正文里是看得见的，而不是只躺在列表里。
   */
  const annotationDecorationsRef = useRef<string[]>([]);
  // 把"回复批注"的能力注入面板（面板不直接依赖 Y.Doc）
  useEffect(() => {
    useAnnotationStore.getState().setReplyHandler((id, text) => collab.addReply(id, text));
    return () => useAnnotationStore.getState().setReplyHandler(null);
  }, [collab.addReply]);
  /** 面板里点了某条批注 → 滚到它并选中。 */
  const jumpRequest = useAnnotationStore((s) => s.jumpRequest);
  const clearJump = useAnnotationStore((s) => s.clearJump);
  const annotationItems = useAnnotationStore((s) => s.items);
  useEffect(() => {
    if (!jumpRequest) return;
    const ed = editorRef.current;
    const model = ed?.getModel();
    const item = annotationItems.find((a) => a.id === jumpRequest);
    if (ed && model && item) {
      const start = model.getPositionAt(item.start);
      const end = model.getPositionAt(item.end);
      ed.revealPositionInCenter(start, 0);
      ed.setSelection(new Range(start.lineNumber, start.column, end.lineNumber, end.column));
      ed.focus();
    }
    clearJump();
  }, [jumpRequest, annotationItems, clearJump]);
  const lastSelectionRef = useRef<{ from: number; to: number; text: string } | null>(null);
  /** 批注草稿：浮层放在编辑器层，工具条卸载也不会丢。 */
  const [annotDraft, setAnnotDraft] = useState<{ top: number; left: number; body: string } | null>(null);
  const [annotRoster, setAnnotRoster] = useState<{ id: string; displayName: string; color: string }[]>([]);
  useEffect(() => {
    const ed = editorRef.current;
    const m = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !m || !model || !editorReady) return;
    const decorations = collab.annotationRanges.map((range) => {
      const start = model.getPositionAt(range.start);
      const end = model.getPositionAt(range.end);
      return {
        range: new m.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: {
          className: 'pf-annotation-range',
          hoverMessage: { value: `**${range.authorName}**：${range.body}` },
        },
      };
    });
    annotationDecorationsRef.current = ed.deltaDecorations(annotationDecorationsRef.current, decorations);
  }, [collab.annotationRanges, editorReady]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <Editor
        height="100%"
        language={language}
        path={activeFile.path}
        /*
       * 协同开启时**不要**用 store 的值反向驱动 Monaco：
       * Yjs 才是内容真相源，再让 value 也去 setValue 就会形成
       * store → Monaco → onChange → store 的无限循环（实测 React 直接抛
       * "Maximum update depth exceeded"，页面随之崩溃）。
       */
      value={collabOn ? undefined : activeFile.content}
      theme={lightMode ? 'paperflow-light' : 'paperflow-dark'}
      beforeMount={beforeMount}
        onChange={(value) => updateFileContent(activeFile.id, value ?? '')}
        onMount={onMount}
        options={{
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
          fontLigatures: true,
          lineHeight: 21,
          minimap: { enabled: true, maxColumn: 70, renderCharacters: false },
          wordWrap: 'on',
          wrappingIndent: 'same',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'all',
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          automaticLayout: true,
          padding: { top: 14, bottom: 40 },
          lineNumbersMinChars: 3,
          guides: { indentation: false },
          bracketPairColorization: { enabled: true },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
          overviewRulerBorder: false,
          stickyScroll: { enabled: false },
        }}
      />
      {bar && (
        <SelectionToolbar
          position={bar}
          toolbarRef={barRef}
          annotateEnabled={collabOn}
          onStartAnnotate={() => {
            const range = lastSelectionRef.current;
            if (!range) return;
            setAnnotDraft({ top: (bar?.top ?? 0) + 34, left: bar?.left ?? 0, body: '' });
            void fetch(apiUrl('/api/team/roster'))
              .then((r) => r.json())
              .then((d: { members?: { id: string; displayName: string; color: string }[] }) => setAnnotRoster(d.members ?? []))
              .catch(() => setAnnotRoster([]));
          }}
        />
      )}
      {editorReady && editorRef.current && monacoRef.current && (
        <EditorHoverPreview editor={editorRef.current} monaco={monacoRef.current} />
      )}
      {annotDraft && (
        <div
          data-testid="annotation-composer"
          className="pf-enter absolute z-40 w-[320px] rounded-lg border border-accent-amber/40 bg-ink-900 p-2 shadow-2xl"
          style={{ top: annotDraft.top, left: annotDraft.left }}
        >
          <div className="mb-1 truncate text-[10px] text-ink-500">
            「{lastSelectionRef.current?.text.slice(0, 40) ?? ''}」
          </div>
          <textarea
            autoFocus
            rows={3}
            value={annotDraft.body}
            onChange={(e) => setAnnotDraft({ ...annotDraft, body: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                const range = lastSelectionRef.current;
                if (range && annotDraft.body.trim()) {
                  collab.addAnnotation(range.from, range.to, range.text.slice(0, 300), annotDraft.body.trim());
                  setAnnotDraft(null);
                }
              }
              if (e.key === 'Escape') setAnnotDraft(null);
            }}
            placeholder="写批注…（Ctrl/⌘+Enter 提交，可点下方成员 @ 他）"
            className="w-full resize-none rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] text-ink-100 placeholder:text-ink-600 focus:border-accent-amber/60 focus:outline-none"
          />
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {annotRoster
              .filter((m) => m.id !== useSessionStore.getState().me?.id)
              .slice(0, 6)
              .map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setAnnotDraft({ ...annotDraft, body: `${annotDraft.body}${annotDraft.body ? ' ' : ''}@${m.displayName} ` })}
                  className="flex items-center gap-1 rounded-full border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-brand-500/60 hover:text-brand-300"
                  title={`@${m.displayName}`}
                >
                  <span className="size-1.5 rounded-full" style={{ background: m.color }} />@{m.displayName}
                </button>
              ))}
          </div>
          <div className="mt-1.5 flex justify-end gap-1">
            <button type="button" onClick={() => setAnnotDraft(null)} className="rounded px-2 py-0.5 text-[11px] text-ink-400 hover:text-ink-200">
              取消
            </button>
            <button
              type="button"
              disabled={!annotDraft.body.trim()}
              onClick={() => {
                const range = lastSelectionRef.current;
                if (!range || !annotDraft.body.trim()) return;
                collab.addAnnotation(range.from, range.to, range.text.slice(0, 300), annotDraft.body.trim());
                setAnnotDraft(null);
              }}
              className="rounded bg-accent-amber/90 px-2 py-0.5 text-[11px] font-medium text-ink-950 disabled:opacity-40"
            >
              批注
            </button>
          </div>
        </div>
      )}
      <CollabOverlay
        status={collab.status}
        peers={collab.peers}
      />
    </div>
  );
}

/** 把选区扩展到完整行：避免把 \cite{...} 之类的命令切一半。 */
function expandToLines(model: Monaco.editor.ITextModel, range: Monaco.Range): string {
  const endLine = range.endLineNumber;
  return model.getValueInRange({
    startLineNumber: range.startLineNumber,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: model.getLineMaxColumn(endLine),
  });
}

function SelectionToolbar({
  position,
  toolbarRef,
  onStartAnnotate,
  annotateEnabled,
}: {
  position: FloatingBar;
  /** 父组件用它测量实际宽度，把浮动栏钳制在面板内（避免溢出被裁）。 */
  toolbarRef: React.MutableRefObject<HTMLDivElement | null>;
  /** 开始写批注：浮层由父组件渲染，避免工具条卸载时丢失状态。 */
  onStartAnnotate?: () => void;
  annotateEnabled?: boolean;
}) {
  const send = useChatStore((s) => s.send);
  const selection = useWorkspaceStore((s) => s.selection);
  const selectedChars = useEditorStore((s) => s.selectedChars);
  const [sent, setSent] = useState<EditIntent | null>(null);
  const [roster, setRoster] = useState<{ id: string; displayName: string; color: string }[]>([]);
  const sessionUserId = useSessionStore((s) => s.me?.id);

  const run = (intent: EditIntent, label: string) => {
    if (!selection) return;
    setSent(intent);
    window.setTimeout(() => setSent(null), 900);
    void send(label, { selection, intent });
  };

  return (
    <div
      data-testid="selection-toolbar"
      ref={toolbarRef}
      /*
        绝对定位元素默认按"容器宽度 − left"收缩：选区靠右时可用宽度变小，
        里面的按钮被压缩、文字折成两行（用户看到的就是这个）。
        所以这里显式 w-max 让它按内容取宽，位置再由下面的钳制逻辑保证不越界。
      */
      className="pf-enter absolute z-30 flex w-max items-center gap-0.5 rounded-lg border border-ink-700 bg-ink-850/95 p-0.5 whitespace-nowrap shadow-xl shadow-black/40 backdrop-blur"
      style={{ top: position.top, left: position.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="flex items-center gap-1 px-1.5 text-[10.5px] text-ink-400">
        <Sparkles className="size-3 text-brand-400" />
        {selectedChars} 字符
      </span>
      <span className="mx-0.5 h-4 w-px bg-ink-700" />
      {INTENT_ACTIONS.map((action) => (
        <button
          key={action.intent}
          type="button"
          title={`${action.hint}（发给群聊中所有模型）`}
          onClick={() => run(action.intent, action.label)}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-[3px] text-[11px] font-medium whitespace-nowrap text-ink-200 transition-colors hover:bg-brand-500/20 hover:text-brand-300"
        >
          {sent === action.intent ? <Check className="size-3 text-accent-teal" /> : <Wand2 className="size-3" />}
          {action.label}
        </button>
      ))}
      <span className="mx-0.5 h-4 w-px bg-ink-700" />
      {annotateEnabled && (
        <button
          type="button"
          title="给这段加批注（可 @ 成员，所有人可见）"
          onClick={() => onStartAnnotate?.()}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-[3px] text-[11px] font-medium whitespace-nowrap text-accent-amber transition-colors hover:bg-accent-amber/15"
        >
          <Highlighter className="size-3" />
          批注
        </button>
      )}
      <span className="mx-0.5 h-4 w-px bg-ink-700" />
      <button
        type="button"
        title="把这段作为上下文附加到输入框，自己写指令"
        onClick={() => document.getElementById('pf-composer')?.focus()}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-[3px] text-[11px] font-medium whitespace-nowrap text-ink-200 transition-colors hover:bg-ink-750"
      >
        <MessageSquarePlus className="size-3" />
        自定义
      </button>

    </div>
  );
}


/** 读取项目里某个文件的 base64 内容（图片/PDF 用）。 */
async function loadBase64(path: string): Promise<string | undefined> {
  const store = useWorkspaceStore.getState();
  await store.ensureFileContent(path);
  return store.document.files[path]?.content || undefined;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
