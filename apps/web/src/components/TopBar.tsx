/** 顶栏：项目标识、文件标签、编译入口、视图切换与运行模式。 */

import { useEffect, useState } from 'react';
import { BookOpenCheck, Columns3, FileCode2, FileText, LogOut, Moon, Play, Rows3, Square, Sun, Users } from 'lucide-react';
import { Button, Kbd, Pill, Segmented } from '@paperflow/ui';
import { useWorkspaceStore, type WorkspaceView } from '@/stores/workspaceStore';
import { useChatStore } from '@/stores/chatStore';
import { ProjectSwitcher } from '@/features/projects/ProjectSwitcher';
import { TeamPanel } from '@/features/auth/TeamPanel';
import { useSessionStore } from '@/stores/sessionStore';
import { useThemeStore } from '@/stores/themeStore';

/** 如实描述"现在是谁在回答"，避免用户误以为已接入真实模型。 */
function describeBackend(backend: {
  mode: 'browser-mock' | 'http';
  status: 'unknown' | 'online' | 'offline';
  hasRealProvider: boolean;
  providers: { configured: boolean; id: string }[];
}): { label: string; color: string; hint: string } {
  if (backend.mode === 'browser-mock') {
    return {
      label: '浏览器内 Mock',
      color: '#f5b544',
      hint: '未设置 VITE_API_BASE：回复由浏览器内的本地引擎生成，不消耗任何 token。',
    };
  }
  if (backend.status === 'offline') {
    return { label: '后端离线', color: '#f4636c', hint: '无法连接编排服务（apps/server），请检查它是否在运行。' };
  }
  if (backend.status === 'unknown') {
    return { label: '检测后端…', color: '#74829a', hint: '正在探测编排服务与厂商配置。' };
  }
  const configured = backend.providers.filter((p) => p.configured && p.id !== 'mock');
  if (backend.hasRealProvider && configured.length > 0) {
    return {
      label: `真实模型 · ${configured.map((p) => p.id).join('/')}`,
      color: '#2dd4bf',
      hint: `已配置厂商：${configured.map((p) => p.id).join('、')}`,
    };
  }
  return {
    label: '后端已连 · 无 Key',
    color: '#f5b544',
    hint: '编排服务在线，但没有任何厂商 API Key，回复由服务端本地回退引擎生成。',
  };
}

export function TopBar() {
  const teamUser = useSessionStore((s) => s.me);
  const logout = useSessionStore((s) => s.logout);
  const [teamOpen, setTeamOpen] = useState(false);
  /*
   * 白天/黑夜模式：只切换 `html.light` 这个类，
   * 颜色全部由 CSS 变量接管（见 styles/index.css 里的 html.light 覆盖）。
   */
  const light = useThemeStore((s) => s.light);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const compile = useWorkspaceStore((s) => s.compile);
  const compileState = useWorkspaceStore((s) => s.compileState);
  const workspaceView = useWorkspaceStore((s) => s.workspaceView);
  const setWorkspaceView = useWorkspaceStore((s) => s.setWorkspaceView);
  const participants = useChatStore((s) => s.thread.participants);
  const busy = useChatStore((s) => s.activeTurnIds.length > 0);
  const backend = useChatStore((s) => s.backend);

  const compiling = compileState.status === 'compiling';
  const errorCount = compileState.diagnostics.filter((d) => d.level === 'error').length;
  const mode = describeBackend(backend);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-925 px-3">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-brand-400 to-brand-600 shadow-sm shadow-brand-500/30">
          <BookOpenCheck className="size-3.5 text-white" />
        </span>
        <div className="leading-none">
          <div className="text-[12.5px] font-semibold tracking-tight text-ink-100">PaperFlow</div>
          <div className="mt-[2px] text-[9.5px] text-ink-500">多模型论文协作台</div>
        </div>
      </div>

      <span className="h-5 w-px bg-ink-800" />

      <ProjectSwitcher />

      <span className="h-5 w-px bg-ink-800" />

      <div className="ml-auto flex items-center gap-2">
        {teamUser && (
          <span className="flex items-center gap-1.5 rounded-md border border-ink-750 px-1.5 py-0.5">
            <span className="size-2 rounded-full" style={{ background: teamUser.color }} />
            <span className="max-w-[90px] truncate text-[11px] text-ink-200">{teamUser.displayName}</span>
            {teamUser.isOwner && (
              <button
                type="button"
                onClick={() => setTeamOpen(true)}
                title="团队成员与审批"
                className="ml-0.5 flex items-center gap-0.5 text-[10px] text-brand-400 hover:text-brand-300"
              >
                <Users className="size-3" /> 团队
              </button>
            )}
            <button
              type="button"
              onClick={() => void logout()}
              title="退出登录"
              className="text-ink-600 hover:text-accent-red"
            >
              <LogOut className="size-3" />
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={toggleTheme}
          title={light ? '切换到黑夜模式' : '切换到白天模式'}
          className="flex size-6 items-center justify-center rounded-md text-ink-400 hover:bg-ink-850 hover:text-ink-100"
        >
          {light ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
        </button>
        <Pill accent={mode.color} title={mode.hint}>
          {mode.label}
        </Pill>
        <Pill title="当前房间内的模型数量">{participants.length} 个模型</Pill>
        {errorCount > 0 && <Pill accent="#f4636c">{errorCount} 个编译错误</Pill>}
        <TeamPanel open={teamOpen} onClose={() => setTeamOpen(false)} />
        {busy && <Pill accent="#4f8cff">生成中…</Pill>}

        <Segmented<WorkspaceView>
          value={workspaceView}
          onChange={setWorkspaceView}
          options={[
            { value: 'editor', label: <FileCode2 className="size-3" />, title: '仅编辑器' },
            // 图标与实际布局一一对应：Rows3 = 上下堆叠，Columns3 = 左右并排。
            // 之前 "仅 PDF" 用的是 Columns3 图标，看起来像"竖排切换"，所以显得是反的。
            { value: 'split-rows', label: <Rows3 className="size-3" />, title: '上下分栏：编辑器在上，PDF 在下' },
            { value: 'split-columns', label: <Columns3 className="size-3" />, title: '左右分栏：编辑器在左，PDF 在右（同 Overleaf）' },
            { value: 'pdf', label: <FileText className="size-3" />, title: '仅 PDF' },
          ]}
        />

        <Button
          variant="primary"
          size="sm"
          /*
           * 固定宽度：中文是按字断行的，`whitespace-nowrap` 挡不住，
           * 窄到一定程度"编译"就会拆成上下两行（用户看到的就是三角图标和文字换行）。
           */
          /* 去掉图标：图标 + 中文在窄屏一定会折行，纯文字最稳 */
          className="min-w-max shrink-0 whitespace-nowrap px-3"
          onClick={() => void compile()}
          disabled={compiling}
        >
          {compiling ? '编译中' : '编译'}
        </Button>
        <span className="hidden items-center gap-0.5 xl:flex">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </span>
      </div>
    </header>
  );
}
