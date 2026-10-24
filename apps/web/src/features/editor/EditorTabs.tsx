/**
 * 编辑器标签栏（VS Code 式）。
 *
 * 两个关键点，都是踩过的坑：
 * 1. 只显示"打开过的文件"，而不是项目里的全部文件——否则一个带 15 张图的论文项目
 *    会把顶栏瞬间铺满；
 * 2. 每个标签有独立的关闭按钮，标签多了会**横向滚动**而不是换行挤压布局。
 */

import { FileCode2, FileText, Quote, X, XCircle } from 'lucide-react';
import type { PaperFile } from '@paperflow/core';
import { useWorkspaceStore } from '@/stores/workspaceStore';

function iconFor(kind: PaperFile['kind'], path: string) {
  if (kind === 'bib') return <Quote className="size-3 shrink-0 text-accent-amber" />;
  if (kind === 'image') return <FileText className="size-3 shrink-0 text-accent-violet" />;
  if (path.includes('/')) return <FileText className="size-3 shrink-0 text-ink-500" />;
  return <FileCode2 className="size-3 shrink-0 text-brand-400" />;
}

export function EditorTabs() {
  const files = useWorkspaceStore((s) => s.document.files);
  const openFileIds = useWorkspaceStore((s) => s.openFileIds);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const closeAllFiles = useWorkspaceStore((s) => s.closeAllFiles);

  // 过滤掉已被删除的文件，避免标签指向不存在的条目
  const open = openFileIds.filter((id) => files[id]);

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b border-ink-800 bg-ink-925">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {open.map((id) => {
          const file = files[id]!;
          const active = id === activeFileId;
          return (
            <div
              key={id}
              className={`group flex max-w-[240px] shrink-0 items-center gap-1.5 border-r border-ink-850 px-2.5 text-[11px] transition-colors ${
                active ? 'bg-ink-900 text-ink-100' : 'text-ink-500 hover:bg-ink-900/60 hover:text-ink-300'
              }`}
            >
              <button
                type="button"
                onClick={() => setActiveFile(id)}
                title={file.path}
                className="flex min-w-0 items-center gap-1.5"
              >
                {iconFor(file.kind, file.path)}
                <span className="truncate font-mono">{file.path}</span>
                {file.path === rootPath && (
                  <span className="shrink-0 rounded bg-accent-amber/15 px-1 text-[9px] text-accent-amber">主</span>
                )}
              </button>
              <button
                type="button"
                title="关闭（Ctrl/Cmd+W）"
                onClick={(e) => {
                  e.stopPropagation();
                  closeFile(id);
                }}
                className={`shrink-0 rounded p-0.5 transition-opacity hover:bg-ink-750 hover:text-ink-100 ${
                  active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
                }`}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}

        {open.length === 0 && (
          <span className="flex items-center px-3 text-[10.5px] text-ink-600">
            没有打开的文件 —— 在左侧文件树里点一个文件即可
          </span>
        )}
      </div>

      {open.length > 1 && (
        <button
          type="button"
          title="关闭全部标签"
          onClick={closeAllFiles}
          className="flex shrink-0 items-center gap-1 border-l border-ink-850 px-2 text-[10.5px] text-ink-500 hover:bg-ink-900 hover:text-ink-200"
        >
          <XCircle className="size-3" />
          全部关闭
        </button>
      )}
    </div>
  );
}
