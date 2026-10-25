/** 左侧活动栏：切换 文件 / 大纲 / 共享知识 / 模型设置 四个面板。 */

import { BookOpen, Files, ListTree, MessageSquareText, Settings2, NotebookPen} from 'lucide-react';
import type { LeftRailView } from '@/stores/workspaceStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useAnnotationStore } from '@/stores/annotationStore';
import { FileTree } from './FileTree';
import { OutlinePanel } from './OutlinePanel';
import { AnnotationPanel } from './AnnotationPanel';
import { NotePanel } from './NotePanel';
import { ContextPanel } from './ContextPanel';
import { ModelSettingsPanel } from './ModelSettingsPanel';

const VIEWS: { id: LeftRailView; icon: typeof Files; label: string }[] = [
  { id: 'files', icon: Files, label: '项目文件' },
  { id: 'outline', icon: ListTree, label: '章节大纲' },
  { id: 'notes', label: '笔记', icon: NotebookPen },
  { id: 'annotations', icon: MessageSquareText, label: '批注（点击可跳转）' },
  { id: 'context', icon: BookOpen, label: '共享知识（文献/术语/图表）' },
  { id: 'models', icon: Settings2, label: '模型与后端设置' },
];

export function LeftRail() {
  const view = useWorkspaceStore((s) => s.leftRailView);
  const setView = useWorkspaceStore((s) => s.setLeftRailView);
  const annotationCount = useAnnotationStore((s) => s.items.length);
  const seenCount = useAnnotationStore((s) => s.seenCount);
  const markSeen = useAnnotationStore((s) => s.markSeen);
  const unreadAnnotations = Math.max(0, annotationCount - seenCount);

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-ink-850 bg-ink-925 py-2">
        {VIEWS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            title={label}
            onClick={() => {
              setView(id);
              if (id === 'annotations') markSeen();
            }}
            className={`relative flex size-8 items-center justify-center rounded-md transition-colors ${
              view === id ? 'bg-brand-500/15 text-brand-300' : 'text-ink-500 hover:bg-ink-850 hover:text-ink-200'
            }`}
          >
            {view === id && <span className="absolute -left-2 h-4 w-[2px] rounded-r bg-brand-400" />}
            {id === 'annotations' && unreadAnnotations > 0 && view !== 'annotations' && (
              <span className="absolute -top-0.5 -right-0.5 flex size-3 items-center justify-center rounded-full bg-red-600 text-[8px] font-medium text-white ring-1 ring-white/80">
                {unreadAnnotations > 9 ? '9+' : unreadAnnotations}
              </span>
            )}
            <Icon className="size-4" />
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 bg-ink-900">
        {view === 'files' && <FileTree />}
        {view === 'outline' && <OutlinePanel />}
        {view === 'annotations' && <AnnotationPanel />}
        {view === 'notes' && <NotePanel />}
        {view === 'context' && <ContextPanel />}
        {view === 'models' && <ModelSettingsPanel />}
      </div>
    </div>
  );
}
