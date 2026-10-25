/**
 * 工作区状态：文档、编辑器选区、编译产物、共享知识。
 *
 * 设计约束：这个 store 只负责"文档这一侧"的事实。
 * 与模型对话相关的一切都在 chatStore，二者通过显式 action 交互（applyProposal），
 * 避免两个 store 互相订阅造成循环更新。
 */

import { create } from 'zustand';
import {
  applyHunks,
  type ReferenceDocument,
  type CompileDiagnostic,
  type DiffHunk,
  type EditProposal,
  type FileId,
  type PaperFile,
  type Selection,
  type LatexEngine,
  type SharedContext,
} from '@paperflow/core';
import { DEMO_CONTEXT, DEMO_DOCUMENT } from '@paperflow/context';
import { findTextInSource, positionAtOffset } from '@paperflow/core';
import { API_BASE, apiUrl, getBackendMode } from '@/lib/backend';
import { useChatStore } from './chatStore';
import { HttpCompiler, MockCompiler, type LatexCompiler, type SourceAnchor } from '@paperflow/latex';

export type LeftRailView = 'files' | 'outline' | 'notes' | 'annotations' | 'context' | 'models';

/** 左侧工作区呈现方式：仅编辑器 / 仅 PDF / 上下分栏。 */
/**
 * 工作区布局。
 *
 * 原来只有 'split'（编辑器在上、PDF 在下），但用户会想要"PDF 在右"这种竖列布局
 * ——Overleaf 就是左右分栏。所以把方向拆成两个明确的取值：
 * 图标与实际布局一一对应，不会再出现"按了竖排却变成横排"的错位感。
 */
export type WorkspaceView = 'editor' | 'pdf' | 'split-rows' | 'split-columns';

export type CompileStatus = 'idle' | 'compiling' | 'ok' | 'error';

export interface CompileState {
  status: CompileStatus;
  pdfUrl?: string;
  anchors: SourceAnchor[];
  diagnostics: CompileDiagnostic[];
  log: string;
  durationMs?: number;
  compiledAt?: string;
  /** 编译时的源码版本，用于判断预览是否已过期。 */
  compiledVersion?: number;
  /** 实际使用的编译引擎：'tectonic' 是真排版，'mock' 是浏览器内近似排版。 */
  engine?: string;
}

interface WorkspaceState {
  document: typeof DEMO_DOCUMENT;
  context: SharedContext;
  activeFileId: FileId;
  selection: Selection | null;
  leftRailView: LeftRailView;
  workspaceView: WorkspaceView;
  compileState: CompileState;
  /** 编辑器要跳转到的行（由大纲/诊断点击触发）。 */
  revealLine: number | null;
  /** 需要高亮的源码行范围（由"定位到 PDF"或 AI 提议触发）。 */
  /**
   * 高亮区间：**行号 + 列号**（都 1 起）。行用于和 PDF 锚点比较，列用于把光标落到具体那个词上。
   *
   * ⚠️ 这里踩过坑：PDF→源码定位时曾把字符偏移写进来，而 Monaco 的
   * `startLineNumber` 与 PDF 锚点的 `anchor.line` 都按行号解释，
   * 于是 offset≈1500 被当成第 1500 行 → 编辑器直接跳到文件末尾。
   * 现在字段名带 Line/Column，类型层面就挡得住。
   */
  highlightRange: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;

  activeFile: () => PaperFile;
  setActiveFile: (id: FileId) => void;
  /**
   * 已打开的编辑器标签（有序）。
   *
   * 之前 TopBar 直接把**项目里所有文件**渲染成标签：ICRA 项目有 22 个文件（15 张图），
   * 顶栏被瞬间铺满、还关不掉。现在只有"你真正打开过的文件"才占标签，
   * 并且每个标签都能关掉——和 VS Code 一致。
   */
  openFileIds: string[];
  closeFile: (id: string) => void;
  closeOtherFiles: (id: string) => void;
  closeAllFiles: () => void;
  updateFileContent: (id: FileId, content: string) => void;
  /** 把当前文件立刻写回服务端（编辑器失焦 / 手动保存时调用）。 */
  saveActiveFile: () => Promise<void>;
  setSelection: (selection: Selection | null) => void;
  setLeftRailView: (view: LeftRailView) => void;
  setWorkspaceView: (view: WorkspaceView) => void;
  togglePdf: () => void;
  reveal: (line: number) => void;
  clearReveal: () => void;
  /** 设置高亮区间（**行号**，闭区间）。 */
  setHighlightRange: (
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null,
  ) => void;
  /** 应用 AI 提议：只应用被接受的 hunk，返回是否成功。 */
  applyProposal: (proposal: EditProposal, hunks: DiffHunk[], acceptedHunkIds: string[]) => boolean;
  compile: (options?: { engine?: LatexEngine }) => Promise<void>;
  updateTerminology: (id: string, patch: Partial<SharedContext['terminology'][number]>) => void;

  /** 从服务端拉取共享知识（文献/术语/图表/参考资料）。未连后端时保持本地演示数据。 */
  loadSharedContext: () => Promise<void>;
  /** 添加参考资料：连得上后端就落库（模型可见），否则只存在本地（mock 模式）。 */
  addReference: (input: {
    title: string;
    text: string;
    kind: ReferenceDocument['kind'];
    source?: string;
    tags?: string[];
    /** PDF 渲染出的页面图像（data URL），供视觉模型直接看图。 */
    pageImages?: string[];
    pageCount?: number;
  }) => Promise<{ ok: boolean; error?: string; reference?: ReferenceDocument }>;
  removeReference: (id: string) => Promise<void>;
  /** 导入 BibTeX 文本：服务端解析成结构化文献条目。 */
  importBibtex: (bibtex: string) => Promise<{ ok: boolean; added?: number; error?: string }>;

  /** 服务端项目操作（对应 Overleaf 的文件树） */
  rootPath: string;
  /** 所有项目（ICRA / RAL / IROS …），彼此独立。 */
  projects: { id: string; name: string; updatedAt: string; collab?: boolean }[];
  activeProjectId: string;
  loadProjects: () => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  createProject: (name: string, zip?: File) => Promise<{ ok: boolean; error?: string }>;
  /** 从服务器本地路径导入（目录或 zip），大项目不走上传。 */
  importProjectFromPath: (
    path: string,
    name?: string,
  ) => Promise<{ ok: boolean; name?: string; imported?: number; skipped?: number; error?: string }>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** 按需读取二进制文件内容（图片 / PDF 的查看器需要 base64 数据）。 */
  ensureFileContent: (path: string) => Promise<void>;
  /**
   * 在 PDF 里选中的文字 → 跳到对应源码行（Overleaf 的 SyncTeX 反向定位）。
   * 先找主文档，再找其它 .tex（处理 `\input` 的子文件）。
   */
  locateTextInSource: (
    text: string,
    context?: { ratio?: number; before?: string; after?: string },
  ) => {
    ok: boolean;
    file?: string;
    line?: number;
    column?: number;
  };
  /**
   * PDF 坐标 → 源码位置（SyncTeX 精确反向搜索）。
   * 坐标单位是 bp（1/72 英寸），原点在页面左下角。
   */
  locatePdfPoint: (
    page: number,
    x: number,
    y: number,
    pageHeight: number,
  ) => Promise<{ ok: boolean; reason?: string; file?: string; line?: number }>;
  projectError?: string;
  loadProject: () => Promise<void>;
  createFile: (path: string, content?: string) => Promise<{ ok: boolean; error?: string }>;
  createFolder: (path: string) => Promise<{ ok: boolean; error?: string }>;
  renameEntry: (from: string, to: string) => Promise<{ ok: boolean; error?: string }>;
  removeEntry: (path: string) => Promise<{ ok: boolean; error?: string }>;
  /** 上传本地文件（支持多选；.zip 会当作整个项目导入） */
  uploadFiles: (files: File[], intoDir?: string) => Promise<{ ok: boolean; message: string }>;
  setRootFile: (path: string) => Promise<void>;
  /** 把整个项目下载成 zip */
  exportProject: () => Promise<void>;
}

/**
 * 编译后端选择。
 *
 * ⚠️ 这里踩过一个和前"资料存不进后端"完全同类的坑：
 * 早先只看 `VITE_API_BASE` 是否存在，而零配置方案**不设**这个变量（走同源 /api 代理），
 * 于是前端误判"没有后端"、一直用浏览器里的 MockCompiler 编译 ——
 * 用户看到的是作者块错乱、中文变成 `????`，却以为是服务端编译器坏了。
 *
 * 正确做法：是否走服务端，取决于**后端探测结果**（chatStore 写进 lib/backend 的共享状态），
 * 而不是取决于有没有配环境变量。探测失败时才回落到浏览器内的近似排版。
 */
class AdaptiveCompiler implements LatexCompiler {
  private readonly remote = new HttpCompiler({ baseUrl: API_BASE, path: '/api/compile' });

  private readonly local = new MockCompiler({ fileName: 'main.tex' });

  get name(): string {
    return this.active().name;
  }

  /** 当前实际会用的引擎名，供 UI 显示（用户必须能一眼看出是真 TeX 还是近似排版）。 */
  get engineInUse(): string {
    return this.active().name;
  }

  private active(): LatexCompiler {
    return getBackendMode() === 'http' ? this.remote : this.local;
  }

  async compile(req: Parameters<LatexCompiler['compile']>[0]) {
    if (getBackendMode() !== 'http') return this.local.compile(req);
    try {
      return await this.remote.compile(req);
    } catch (err) {
      /*
       * **不再静默回退到"近似排版"。**
       *
       * 之前这里 catch 之后直接 `this.local.compile(req)`，后果很严重：
       * 真引擎失败（超时、500、服务没起）时，浏览器会把源码当成普通文字"排"一版出来，
       * 界面照旧显示「编译成功」，用户看到的却是一份把 `\captionsetup{}`、`\lstset{}`
       * 当正文排出来的垃圾 PDF（实测就被当成了"编译结果不对"）。
       * 失败就得说失败——近似排版只在**完全没有后端**时用作演示。
       */
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[paperflow] 服务端编译失败（不再回退到近似排版）：', reason);
      return {
        ok: false,
        log: '',
        diagnostics: [
          {
            level: 'error' as const,
            file: '(编译服务)',
            line: 0,
            message:
              `服务端编译不可用：${reason.slice(0, 300)}` +
              '。为避免把源码当排版结果，已停止自动回退到"近似排版"；请确认 npm run dev 正在运行。',
          },
        ],
        anchors: [],
        engine: 'unavailable',
        durationMs: 0,
      };
    }
  }
}

/** 共享知识接口要带项目 id：不同项目的术语表/文献库不能混用。 */
function projectQuery(): string {
  const id = useWorkspaceStore.getState().activeProjectId;
  return id ? `?project=${encodeURIComponent(id)}` : '';
}

/** 统一的项目文件 API 调用：把 HTTP 错误也转成 {ok,error}，避免各处重复写 try/catch。 */
async function fileApi(
  method: 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(apiUrl(path), {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => '');
    let message = `HTTP ${res.status}`;
    try {
      message = (JSON.parse(detail) as { message?: string }).message ?? message;
    } catch {
      /* 非 JSON 响应就用状态码 */
    }
    return { ok: false, error: message };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '网络错误' };
  }
}

/** 把"HTTP 失败"翻译成用户能据以行动的话。 */
function describeHttpFailure(status: number, size?: number): string {
  if (status === 413) {
    return `文件太大${size ? `（${formatBytes(size)}）` : ''}：超过服务端上传上限。真引擎编译通常不需要这么大的单文件，请确认压缩包里没有意外的大文件。`;
  }
  if (status === 404) return '接口不存在：请确认后端已重启到最新版本（npm run dev）';
  return `HTTP ${status}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 以原始字节上传（zip / 图片），不走 base64+JSON。 */
async function rawUpload(
  path: string,
  file: File,
  contentType: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: file,
    });
    if (res.ok) return { ok: true };
    const detail = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false, error: detail.message ?? describeHttpFailure(res.status, file.size) };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && /failed to fetch|network/i.test(err.message)
          ? `上传 ${file.name}（${formatBytes(file.size)}）时连接中断——多半是超过了服务端上限`
          : (err instanceof Error ? err.message : '网络错误'),
    };
  }
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

/** 由扩展名判断文件类型（与服务端 projectStore 的规则保持一致）。 */
function kindForPath(path: string): PaperFile['kind'] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tex')) return 'tex';
  if (lower.endsWith('.bib')) return 'bib';
  if (/\.(cls|sty|bst|def|cfg)$/.test(lower)) return 'style';
  if (/\.(png|jpe?g|pdf|eps|gif|webp|svg)$/.test(lower)) return 'image';
  return 'other';
}

function createCompiler(): LatexCompiler {
  // 显式指定了专用 TeX 服务时直连它（不再经过 BFF 的缓存层）
  const dedicated = (import.meta.env.VITE_COMPILER_URL as string | undefined)?.trim();
  if (dedicated) return new HttpCompiler({ baseUrl: dedicated, path: '/compile' });
  return new AdaptiveCompiler();
}

const compiler = createCompiler();

/**
 * 释放 blob URL 必须延迟。
 *
 * pdf.js 拿到 url 后是**异步**去读取的；如果编译一完成就 revoke 上一版，
 * 正在加载中的文档会立刻变成 `ERR_FILE_NOT_FOUND`（在走 HTTP 编译时几乎必现，
 * 因为网络延迟让"加载中"的窗口变长）。这里延迟释放，让在读的文档先读完。
 */
/**
 * 编辑内容防抖写回服务端。
 *
 * 不做这一步的话，刷新页面改动就没了——而"文件树 + 编辑器"的整个前提是
 * 项目是持久化的。800ms 是打字停顿与请求数之间的折中。
 */
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(path: string, content: string): void {
  const previous = pendingSaves.get(path);
  if (previous) clearTimeout(previous);
  pendingSaves.set(
    path,
    setTimeout(() => {
      pendingSaves.delete(path);
      void fetch(apiUrl('/api/project/file'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content, encoding: 'utf8' }),
      }).catch(() => undefined);
    }, 800),
  );
}

const REVOKE_DELAY_MS = 15_000;

function scheduleBlobRevoke(url?: string): void {
  if (!url?.startsWith('blob:')) return;
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  document: DEMO_DOCUMENT,
  context: DEMO_CONTEXT,
  activeFileId: DEMO_DOCUMENT.rootFileId,
  selection: null,
  leftRailView: 'files',
  workspaceView: 'split-rows',
  compileState: { status: 'idle', anchors: [], diagnostics: [], log: '尚未编译。' },
  revealLine: null,
  highlightRange: null,
  openFileIds: [],
  rootPath: 'main.tex',
  projects: [],
  activeProjectId: '',

  activeFile: () => {
    const { document, activeFileId } = get();
    const found = document.files[activeFileId] ?? document.files[document.rootFileId];
    if (found) return found;
    /*
     * 兜底：项目还没加载完、或加载失败时，绝不能返回 undefined。
     * 曾经因此让 <LatexEditor>/<PdfPreview> 直接抛错 —— 表现是**整页白屏**，
     * 而且只在"刚审批通过、项目还没拉下来"这一瞬间触发，极难复现。
     */
    const first = Object.values(document.files)[0];
    if (first) return first;
    return {
      id: '__empty__',
      path: 'untitled.tex',
      kind: 'tex',
      encoding: 'utf8',
      content: '',
      version: 0,
    } as PaperFile;
  },

  setActiveFile: (id) =>
    set((state) => ({
      activeFileId: id,
      selection: null,
      // 打开文件即入标签栏（已打开则不重复、不改变顺序——避免标签乱跳）
      openFileIds: state.openFileIds.includes(id) ? state.openFileIds : [...state.openFileIds, id],
    })),

  saveActiveFile: async () => {
    const file = get().activeFile();
    // 二进制文件不可编辑，也不该被写回
    if (file.encoding === 'base64') return;
    await fileApi('PUT', `/api/projects/${get().activeProjectId}/file`, { path: file.path, content: file.content });
  },

  updateFileContent: (id, content) =>
    set((state) => {
      const file = state.document.files[id];
      if (!file) return state;
      if (file.content === content) return state;
      scheduleSave(id, content);
      return {
        document: {
          ...state.document,
          updatedAt: new Date().toISOString(),
          files: { ...state.document.files, [id]: { ...file, content, version: file.version + 1 } },
        },
      };
    }),

  setSelection: (selection) => set({ selection }),

  setLeftRailView: (leftRailView) => set({ leftRailView }),

  setWorkspaceView: (workspaceView) => set({ workspaceView }),

  closeFile: (id) =>
    set((state) => {
      const index = state.openFileIds.indexOf(id);
      if (index === -1) return state;
      const openFileIds = state.openFileIds.filter((f) => f !== id);
      // 关掉当前标签时切到相邻的（优先左边），都没有就回到主文档
      const nextActive =
        state.activeFileId === id
          ? (openFileIds[index - 1] ?? openFileIds[index] ?? state.rootPath)
          : state.activeFileId;
      return { openFileIds, activeFileId: nextActive };
    }),

  closeOtherFiles: (id) => set((state) => ({ openFileIds: [id], activeFileId: id })),

  closeAllFiles: () => set((state) => ({ openFileIds: [], activeFileId: state.rootPath })),

  togglePdf: () =>
    set((state) => ({ workspaceView: state.workspaceView === 'editor' ? 'split-rows' : 'editor' })),

  reveal: (line) => set({ revealLine: line }),

  clearReveal: () => set({ revealLine: null }),

  setHighlightRange: (highlightRange) => set({ highlightRange }),

  applyProposal: (proposal, hunks, acceptedHunkIds) => {
    const state = get();
    const file = state.document.files[proposal.fileId];
    if (!file) return false;
    // 版本漂移保护：提议基于旧版本生成时必须让用户重新确认。
    if (file.version !== proposal.baseVersion) return false;

    const nextContent = applyHunks(file.content, hunks, acceptedHunkIds);
    get().updateFileContent(proposal.fileId, nextContent);
    set({
      selection: null,
      highlightRange: {
        startLine: proposal.range.startLine,
        startColumn: 1,
        endLine: proposal.range.startLine + proposal.replacement.split('\n').length - 1,
        endColumn: 1,
      },
    });
    return true;
  },

  compile: async (options) => {
    // 并发保护：React StrictMode 会双调用 effect，重复编译既浪费又会放大下面的 blob 竞态。
    if (get().compileState.status === 'compiling') return;
    const file = get().activeFile();
    set((state) => ({ compileState: { ...state.compileState, status: 'compiling' } }));
    try {
      const output = await compiler.compile({
        fileId: file.id,
        content: file.content,
        engine: options?.engine,
        /*
         * 必须带上项目 id：服务端的 `/api/compile` 兼容入口如果没有它，
         * 就会退回到"默认项目"去编译，于是本项目的 .cls 找不到
         * （实测：ICRA 报 ieeeconf.cls not found，SZTU 报 SZTUthesis.cls not found）。
         */
        projectId: get().activeProjectId,
        // 显式指定主文档：不这样写的话，服务端只能自己猜，
        // 猜错时用户会看到"明明项目里有这个 .cls 却说找不到"这种莫名其妙的错误。
        mainPath: get().rootPath,
      });
      scheduleBlobRevoke(get().compileState.pdfUrl);
      set((state) => ({
        compileState: {
          status: output.ok ? 'ok' : 'error',
          pdfUrl: output.pdfUrl,
          anchors: output.anchors,
          diagnostics: output.diagnostics,
          log: output.log,
          durationMs: output.durationMs,
          compiledAt: new Date().toISOString(),
          compiledVersion: state.document.files[file.id]?.version,
          // 优先用服务端报告的真实引擎（tectonic），拿不到才退回传输层名字
          engine: output.engine ?? compiler.name,
        },
      }));
    } catch (err) {
      set((state) => ({
        compileState: {
          ...state.compileState,
          status: 'error',
          log: err instanceof Error ? err.message : String(err),
          diagnostics: [
            { level: 'error', file: file.path, line: 1, message: err instanceof Error ? err.message : '编译失败' },
          ],
        },
      }));
    }
  },

  updateTerminology: (id, patch) =>
    set((state) => ({
      context: {
        ...state.context,
        terminology: state.context.terminology.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      },
    })),

  loadProjects: async () => {
    try {
      const res = await fetch(apiUrl('/api/projects'));
      if (!res.ok) return;
      const { projects } = (await res.json()) as { projects: { id: string; name: string; updatedAt: string }[] };
      // 当前项目被删掉时自动切到第一个，避免界面停在空项目上
      const active = projects.some((p) => p.id === get().activeProjectId)
        ? get().activeProjectId
        : (projects[0]?.id ?? '');
      set({ projects, activeProjectId: active });
    } catch {
      /* 列表拉不到时保持现状 */
    }
  },

  switchProject: async (id) => {
    if (id === get().activeProjectId) return;
    await get().saveActiveFile();
    // 换项目 = 换一套文件、共享知识与对话线程（互不干扰的关键）
    set({
      activeProjectId: id,
      selection: null,
      highlightRange: null,
      compileState: { status: 'idle', anchors: [], diagnostics: [], log: '尚未编译。' },
    });
    useChatStore.getState().resetForProject(id);
    await Promise.all([get().loadProject(), get().loadSharedContext()]);
    await get().compile();
  },

  createProject: async (name, zip) => {
    try {
      // zip 走**原始字节**提交：base64 会让体积膨胀 33%，
      // 真实 Overleaf 项目（带图）很容易因此撞上服务端的 body 上限——
      // 表现就是"上传失败"，而且错误信息毫无线索。
      const res = zip
        ? await fetch(apiUrl(`/api/projects/import?name=${encodeURIComponent(name)}`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: zip,
          })
        : await fetch(apiUrl('/api/projects'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, seed: true }),
          });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { message?: string };
        return { ok: false, error: detail.message ?? describeHttpFailure(res.status, zip?.size) };
      }
      const { project } = (await res.json()) as { project: { id: string; name: string } };
      await get().loadProjects();
      await get().switchProject(project.id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '创建失败' };
    }
  },

  importProjectFromPath: async (path, name) => {
    try {
      const res = await fetch(apiUrl('/api/projects/import-path'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { message?: string };
        return { ok: false, error: detail.message ?? `HTTP ${res.status}` };
      }
      const payload = (await res.json()) as {
        project: { id: string; name: string };
        imported: number;
        skipped: string[];
      };
      await get().loadProjects();
      await get().switchProject(payload.project.id);
      return {
        ok: true,
        name: payload.project.name,
        imported: payload.imported,
        skipped: payload.skipped?.length ?? 0,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '导入失败' };
    }
  },

  renameProject: async (id, name) => {
    await fetch(apiUrl(`/api/projects/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await get().loadProjects();
  },

  deleteProject: async (id) => {
    const res = await fetch(apiUrl(`/api/projects/${id}`), { method: 'DELETE' });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { message?: string };
      return { ok: false, error: detail.message ?? `HTTP ${res.status}` };
    }
    await get().loadProjects();
    const next = get().projects[0]?.id;
    if (next) await get().switchProject(next);
    return { ok: true };
  },

  locateTextInSource: (text, context) => {
    const state = get();
    const files = Object.values(state.document.files).filter(
      (f) => f.kind === 'tex' && f.encoding !== 'base64',
    );
    // 主文档优先：绝大多数命中都在主文档里，先查它能少读一遍
    files.sort((a, b) => (a.path === state.rootPath ? -1 : b.path === state.rootPath ? 1 : 0));
    for (const file of files) {
      const hit = findTextInSource(file.content, text, context ?? {});
      if (!hit) continue;
      const start = positionAtOffset(file.content, hit.index);
      const end = positionAtOffset(file.content, hit.index + hit.length);
      set({
        activeFileId: file.id,
        openFileIds: state.openFileIds.includes(file.id)
          ? state.openFileIds
          : [...state.openFileIds, file.id],
        revealLine: start.line,
        // 精确到列：编辑器据此把光标放到那个词上并选中它
        highlightRange: {
          startLine: start.line,
          startColumn: start.column,
          endLine: end.line,
          endColumn: end.column,
        },
      });
      return { ok: true, file: file.path, line: start.line, column: start.column };
    }
    return { ok: false };
  },

  locatePdfPoint: async (page, x, y, pageHeight) => {
    try {
      const res = await fetch(apiUrl(`/api/projects/${get().activeProjectId}/locate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, x, y, pageHeight }),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const data = (await res.json()) as
        | { ok: true; file: string; line: number; column: number }
        | { ok: false; reason: string };
      if (!data.ok) return { ok: false, reason: data.reason };

      const state = get();
      const file = state.document.files[data.file];
      if (!file) return { ok: false, reason: `项目里没有 ${data.file}` };
      set({
        activeFileId: file.id,
        openFileIds: state.openFileIds.includes(file.id)
          ? state.openFileIds
          : [...state.openFileIds, file.id],
        revealLine: data.line,
        // SyncTeX 通常只给行、不给列。列未知时必须让区间**覆盖整行**：
        // 早先写成 startColumn === endColumn，是个零宽区间，Monaco 什么都不会高亮——
        // 用户看到的就是"跳过去了但没有任何高亮"。
        highlightRange: {
          startLine: data.line,
          startColumn: data.column > 0 ? data.column : 1,
          endLine: data.line,
          endColumn: data.column > 0 ? data.column : Number.MAX_SAFE_INTEGER,
        },
      });
      return { ok: true, file: file.path, line: data.line };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : '网络错误' };
    }
  },

  ensureFileContent: async (path) => {
    const file = get().document.files[path];
    if (!file || file.encoding !== 'base64' || file.content) return;
    try {
      const res = await fetch(
        apiUrl(`/api/projects/${get().activeProjectId}/file?path=${encodeURIComponent(path)}`),
      );
      if (!res.ok) return;
      const { content } = (await res.json()) as { content: string };
      set((state) => {
        const target = state.document.files[path];
        if (!target) return state;
        return {
          document: { ...state.document, files: { ...state.document.files, [path]: { ...target, content } } },
        };
      });
    } catch {
      /* 查看器会显示"无法加载" */
    }
  },

  loadProject: async () => {
    // 防御：项目 id 还没确定时先拉列表。之前这里只是直接 return，
    // 一旦调用顺序有误就会静默"什么都不做"，界面停在旧文档且毫无提示。
    if (!get().activeProjectId) await get().loadProjects();
    const projectId = get().activeProjectId;
    if (!projectId) {
      set({ projectError: '没有可用项目：请检查后端是否正常（npm run dev）' });
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/projects/${projectId}/manifest`));
      if (!res.ok) return;
      const manifest = (await res.json()) as {
        rootPath: string;
        files: { path: string; encoding: 'utf8' | 'base64'; size: number; isDirectory?: boolean }[];
      };

      // 文本文件的内容一次读进来（体积小、编辑体验好）；二进制只留元信息，
      // 编辑器本来也打不开图片，没必要把 base64 塞进内存。
      const files: Record<string, PaperFile> = {};
      await Promise.all(
        manifest.files
          .filter((f) => !f.isDirectory)
          .map(async (entry) => {
            let content = '';
            if (entry.encoding === 'utf8') {
              const fileRes = await fetch(
                apiUrl(`/api/projects/${projectId}/file?path=${encodeURIComponent(entry.path)}`),
              );
              if (fileRes.ok) content = ((await fileRes.json()) as { content: string }).content;
            }
            files[entry.path] = {
              // 用路径当 id：与服务端的键一致，省掉一层映射
              id: entry.path,
              path: entry.path,
              kind: kindForPath(entry.path),
              content,
              encoding: entry.encoding,
              size: entry.size,
              version: 1,
            };
          }),
      );

      const rootPath = manifest.rootPath;
      set((state) => ({
        rootPath,
        document: {
          ...state.document,
          rootFileId: rootPath,
          files,
        },
        // 当前打开的文件若已不存在（例如刚导入了新项目），切到主文档
        activeFileId: files[state.activeFileId] ? state.activeFileId : rootPath,
        // 切换项目时只保留主文档这一个标签：
        // 之前的实现把项目里每个文件都塞进标签栏，22 个文件的 ICRA 项目直接把顶栏铺满。
        openFileIds: files[state.activeFileId]
          ? state.openFileIds.filter((id) => files[id])
          : [rootPath],
        selection: null,
        projectError: undefined,
      }));


    } catch (err) {
      set({ projectError: err instanceof Error ? err.message : '无法读取项目' });
    }
  },

  createFile: async (path, content = '') => {
    const result = await fileApi('PUT', `/api/projects/${get().activeProjectId}/file`, { path, content });
    if (result.ok) await get().loadProject();
    return result;
  },

  createFolder: async (path) => {
    const result = await fileApi('POST', `/api/projects/${get().activeProjectId}/folder`, { path });
    if (result.ok) await get().loadProject();
    return result;
  },

  renameEntry: async (from, to) => {
    const result = await fileApi('POST', `/api/projects/${get().activeProjectId}/rename`, { from, to });
    if (result.ok) {
      await get().loadProject();
      // 当前打开的文件被改名了：跟随过去，不然会看到"文件不见了"
      if (get().activeFileId === from) set({ activeFileId: to });
    }
    return result;
  },

  removeEntry: async (path) => {
    const result = await fileApi('DELETE', `/api/projects/${get().activeProjectId}/entry?path=${encodeURIComponent(path)}`);
    if (result.ok) {
      await get().loadProject();
      const state = get();
      if (!state.document.files[state.activeFileId]) set({ activeFileId: state.rootPath });
    }
    return result;
  },

  uploadFiles: async (files, intoDir) => {
    // 拖进来的如果是一个 zip，就当作"导入项目"——这正是 Overleaf 的 Upload Project
    const zip = files.find((f) => f.name.toLowerCase().endsWith('.zip'));
    if (zip) {
      const result = await rawUpload(
        `/api/projects/${get().activeProjectId}/import`,
        zip,
        'application/zip',
      );
      if (result.ok) await get().loadProject();
      return result.ok
        ? { ok: true, message: `已从 ${zip.name}（${formatBytes(zip.size)}）导入到当前项目` }
        : { ok: false, message: result.error ?? '导入失败' };
    }

    let uploaded = 0;
    const errors: string[] = [];
    for (const file of files) {
      // 一律走原始字节：图片动辄几 MB，base64 会让体积膨胀 33% 并撞上 body 上限
      // 上传到指定目录里（Overleaf 里可以往 figures/ 单独加图）
      const targetPath = intoDir ? `${intoDir}/${file.name}` : file.name;
      const result = await rawUpload(
        `/api/projects/${get().activeProjectId}/raw?path=${encodeURIComponent(targetPath)}`,
        file,
        'application/octet-stream',
      );
      if (result.ok) uploaded += 1;
      else errors.push(`${file.name}: ${result.error}`);
    }
    if (uploaded > 0) await get().loadProject();
    if (uploaded === 0) {
      return { ok: false, message: errors.length > 0 ? `上传失败：${errors.join('；')}` : '没有可上传的文件' };
    }
    return {
      ok: errors.length === 0,
      message: errors.length === 0 ? `已上传 ${uploaded} 个文件` : `上传 ${uploaded} 个成功，失败：${errors.join('；')}`,
    };
  },

  setRootFile: async (path) => {
    await fileApi('PUT', `/api/projects/${get().activeProjectId}/root`, { path });
    set({ rootPath: path, document: { ...get().document, rootFileId: path } });
  },

  exportProject: async () => {
    const res = await fetch(apiUrl(`/api/projects/${get().activeProjectId}/export`));
    if (!res.ok) return;
    const { zipBase64, filename } = (await res.json()) as { zipBase64: string; filename: string };
    const bytes = Uint8Array.from(atob(zipBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  },

  loadSharedContext: async () => {
    try {
      const project = get().activeProjectId;
      const query = project ? `?project=${encodeURIComponent(project)}` : '';
      const res = await fetch(apiUrl(`/api/context${query}`));
      if (!res.ok) return;
      const payload = (await res.json()) as Omit<SharedContext, 'references'> & {
        references: (Omit<ReferenceDocument, 'text'> & { hasText: boolean })[];
      };
      set((state) => ({
        context: {
          citations: payload.citations,
          terminology: payload.terminology,
          figures: payload.figures,
          // 列表接口不回传全文；本地已有的正文保留下来，避免刚添加的内容"消失"
          references: payload.references.map((meta) => ({
            ...meta,
            text: state.context.references.find((r) => r.id === meta.id)?.text ?? '',
          })),
        },
      }));
    } catch {
      // 拉取失败不影响本地演示数据
    }
  },

  addReference: async (input) => {
    // 总是先尝试服务端：这是唯一的"模型能看到"的路径。
    // 注意不能再用"有没有配 API_BASE"来决定是否发请求——同源相对路径也是合法的后端地址。
    try {
      const res = await fetch(apiUrl(`/api/context/references${projectQuery()}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (res.ok) {
        const payload = (await res.json()) as { reference: ReferenceDocument };
        // 服务端只回传元信息，正文用本地的（同一份）
        const reference: ReferenceDocument = {
          ...payload.reference,
          text: input.text,
          // 服务端只回传元信息，图像较大的话不回传；用本地的同一份
          pageImages: payload.reference.pageImages ?? input.pageImages,
          pageCount: payload.reference.pageCount ?? input.pageCount,
        };
        set((state) => ({
          context: {
            ...state.context,
            references: [...state.context.references.filter((r) => r.id !== reference.id), reference],
          },
        }));
        return { ok: true, reference };
      }
      // 4xx 说明请求本身有问题（内容为空、太长等），此时**不能**假装成功存到本地
      if (res.status >= 400 && res.status < 500) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `后端拒绝了这次添加（${res.status}）：${detail.slice(0, 200)}` };
      }
    } catch {
      // 网络层失败：后端多半没起来，退回本地（浏览器内 mock 模式）
    }

    // 后端不可用：只存在本地。UI 会提示"模型看不到"，避免用户白等。
    const reference: ReferenceDocument = {
      id: `local-${Date.now().toString(36)}`,
      title: input.title.trim() || '未命名资料',
      kind: input.kind,
      text: input.text,
      source: input.source,
      tags: input.tags ?? [],
      addedAt: new Date().toISOString(),
      charCount: input.text.length,
      pageImages: input.pageImages,
      pageCount: input.pageCount,
    };
    set((state) => ({ context: { ...state.context, references: [...state.context.references, reference] } }));
    return {
      ok: true,
      reference,
      error: '编排服务未连接：资料只保存在浏览器里，模型本轮看不到它（启动 npm run dev 后重新添加即可）',
    };
  },

  removeReference: async (id) => {
    if (!id.startsWith('local-')) {
      await fetch(apiUrl(`/api/context/references/${id}${projectQuery()}`), { method: 'DELETE' }).catch(() => undefined);
    }
    set((state) => ({
      context: { ...state.context, references: state.context.references.filter((r) => r.id !== id) },
    }));
  },

  importBibtex: async (bibtex) => {
    try {
      const res = await fetch(apiUrl(`/api/context/citations${projectQuery()}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bibtex }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `后端返回 ${res.status}：${detail.slice(0, 200)}` };
      }
      const payload = (await res.json()) as { citations: SharedContext['citations']; added: number };
      set((state) => ({ context: { ...state.context, citations: payload.citations } }));
      return { ok: true, added: payload.added };
    } catch (err) {
      return {
        ok: false,
        error: `无法连接编排服务：${err instanceof Error ? err.message : String(err)}（BibTeX 导入需要后端）`,
      };
    }
  },
}));
