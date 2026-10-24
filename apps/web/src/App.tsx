/**
 * 应用外壳：Overleaf 式三栏布局。
 *
 * ┌────────────────────────────────────────────────────────────┐
 * │ TopBar  项目 / 文件标签 / 编译 / 视图切换 / 运行模式           │
 * ├────────┬───────────────────────────────┬───────────────────┤
 * │ 活动栏 │  编辑器 ⇅ PDF 预览（可拖拽）    │  多模型群聊         │
 * ├────────┴───────────────────────────────┴───────────────────┤
 * │ StatusBar  编译状态 / 光标 / 字数 / token 估算                │
 * └────────────────────────────────────────────────────────────┘
 *
 * 布局尺寸用 autoSaveId 持久化，刷新后保持用户习惯。
 */

import { Component, useEffect, type ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { TopBar } from '@/components/TopBar';
import { StatusBar } from '@/components/StatusBar';
import { LeftRail } from '@/features/explorer/LeftRail';
import { LatexEditor } from '@/features/editor/LatexEditor';
import { JoinGate } from '@/features/auth/JoinGate';
import { useSessionStore } from '@/stores/sessionStore';
import { EditorTabs } from '@/features/editor/EditorTabs';
import { PdfPreview } from '@/features/pdf/PdfPreview';
import { ChatPanel } from '@/features/chat/ChatPanel';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useComposerStore } from '@/stores/composerStore';
import { useChatStore } from '@/stores/chatStore';
import { applyInitialTheme } from '@/stores/themeStore';

const HANDLE_H = 'h-[3px] shrink-0 bg-ink-850 transition-colors hover:bg-brand-500';
const HANDLE_V = 'w-[3px] shrink-0 bg-ink-850 transition-colors hover:bg-brand-500';

/**
 * 兜底错误边界。
 *
 * 没有它时，任何一个组件抛错都会让整页变成**纯白**（实测：组员刚审批通过、
 * 项目还没加载完的那一瞬间，<LatexEditor> 读不到文件就崩了，页面全白且没有任何提示）。
 */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen items-center justify-center bg-ink-950 p-8">
          <div className="max-w-[520px] rounded-lg border border-accent-red/40 bg-accent-red/10 p-5 text-ink-100">
            <div className="mb-2 text-[13px] font-semibold text-accent-red">界面出错了</div>
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap text-[11px] leading-snug text-ink-300">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-3 rounded border border-ink-600 px-2 py-1 text-[11.5px] text-ink-200 hover:border-brand-500"
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

applyInitialTheme();

export function App() {
  const session = useSessionStore();
  const workspaceView = useWorkspaceStore((s) => s.workspaceView);
  const compile = useWorkspaceStore((s) => s.compile);
  const requestFocus = useComposerStore((s) => s.requestFocus);
  const probeBackend = useChatStore((s) => s.probeBackend);
  const loadSharedContext = useWorkspaceStore((s) => s.loadSharedContext);
  const loadProject = useWorkspaceStore((s) => s.loadProject);
  const loadProjects = useWorkspaceStore((s) => s.loadProjects);

  // 首次挂载：编译一次让 PDF 面板立刻有内容，并探测后端真实可用性。
  useEffect(() => {
    // 顺序很重要，且每一步都不可省：
    // 1) 探测后端（拿到有哪些模型、是否可用）
    // 2) 拉项目列表并**确定当前项目** —— loadProject 依赖 activeProjectId，
    //    少了这一步它只会空转，界面永远停在旧文档（这个回归真实发生过）
    // 3) 拉该项目自己的文件与共享知识
    // 4) 项目就绪后再编译，否则编译的是"上一次的活动文件"
    void (async () => {
      // 先确认身份：团队模式下没登录就不该去拉项目/编译
      await session.refresh();
      if (useSessionStore.getState().mode === 'team' && !useSessionStore.getState().me) return;
      await probeBackend();
      await loadProjects();
      await Promise.all([loadProject(), loadSharedContext()]);
      // 群聊房间：其他人的发言与 agent 回复通过它广播进来（发起者自己走 SSE）
      useChatStore.getState().connectRoom();
      await compile();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切回页面时重新探测后端：刚在 .env 里加了 Key 并重启服务端后，
  // 不需要刷新页面，切回浏览器就能看到新模型。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void probeBackend();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [probeBackend]);

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        void compile();
      }
      if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        requestFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compile, requestFocus]);

  /*
   * 团队模式且未登录：只显示入组页。
   * 注意要等 `loading` 结束再判断，否则刷新瞬间会闪一下入组页。
   */
  if (session.mode === 'team' && !session.loading && !session.me) {
    return <JoinGate />;
  }

  return (
    <AppErrorBoundary>
    <div className="flex h-full flex-col bg-ink-950 text-ink-100">
      <TopBar />
      {workspaceView !== 'pdf' && <EditorTabs />}

      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="paperflow.layout.v1">
          <Panel id="rail" order={1} defaultSize={18} minSize={12} maxSize={32} className="min-w-[240px]">
            <LeftRail />
          </Panel>
          <PanelResizeHandle className={HANDLE_V} />

          <Panel id="workspace" order={2} minSize={28}>
            {workspaceView === 'split-rows' ? (
              <PanelGroup direction="vertical" autoSaveId="paperflow.workspace.rows.v1">
                <Panel id="editor" order={1} defaultSize={58} minSize={20}>
                  <LatexEditor />
                </Panel>
                <PanelResizeHandle className={HANDLE_H} />
                <Panel id="pdf" order={2} defaultSize={42} minSize={15}>
                  <PdfPreview />
                </Panel>
              </PanelGroup>
            ) : workspaceView === 'split-columns' ? (
              // 左右分栏：Overleaf 的默认布局
              <PanelGroup direction="horizontal" autoSaveId="paperflow.workspace.columns.v1">
                <Panel id="editor" order={1} defaultSize={55} minSize={25}>
                  <LatexEditor />
                </Panel>
                <PanelResizeHandle className={HANDLE_V} />
                <Panel id="pdf" order={2} defaultSize={45} minSize={20}>
                  <PdfPreview />
                </Panel>
              </PanelGroup>
            ) : workspaceView === 'editor' ? (
              <LatexEditor />
            ) : (
              <PdfPreview />
            )}
          </Panel>
          <PanelResizeHandle className={HANDLE_V} />

          <Panel id="chat" order={3} defaultSize={34} minSize={22} maxSize={55} className="min-w-[320px]">
            <ChatPanel />
          </Panel>
        </PanelGroup>
      </div>

      <StatusBar />
    </div>
    </AppErrorBoundary>
  );
}
