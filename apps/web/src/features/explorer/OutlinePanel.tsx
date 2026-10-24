/** 章节大纲：点击跳转到源码行。 */

import { useMemo } from 'react';
import { ListTree } from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useEditorStore } from '@/stores/editorStore';
import { extractOutline, sectionAtLine } from '@/lib/latex';

export function OutlinePanel() {
  const activeFile = useWorkspaceStore((s) => s.activeFile());
  const reveal = useWorkspaceStore((s) => s.reveal);
  // 大纲跟随**编辑器光标行**。
  // 之前读的是 highlightRange.start —— 语义不对（那是"高亮区间"，不是光标），
  // 而且高亮区间现在是行号区间，字段名也不一样了。
  const cursorLine = useEditorStore((s) => s.cursor.line);

  const outline = useMemo(() => extractOutline(activeFile.content), [activeFile.content]);
  const current = useMemo(() => sectionAtLine(activeFile.content, cursorLine), [activeFile.content, cursorLine]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <ListTree className="size-3 text-ink-500" />
        <span className="text-[10.5px] font-semibold tracking-wide text-ink-400 uppercase">大纲</span>
        <span className="ml-auto font-mono text-[10px] text-ink-600">{activeFile.path}</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
        {outline.length === 0 && (
          <li className="px-2.5 py-2 text-[11px] text-ink-600">该文件没有 \section 结构。</li>
        )}
        {outline.map((item) => {
          const active = current?.line === item.line;
          return (
            <li key={`${item.line}-${item.title}`}>
              <button
                type="button"
                onClick={() => reveal(item.line)}
                style={{ paddingLeft: 10 + (item.level - 1) * 12 }}
                className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left transition-colors ${
                  active ? 'bg-brand-500/12 text-brand-300' : 'text-ink-300 hover:bg-ink-850'
                }`}
              >
                <span
                  className={`truncate ${
                    item.level === 1 ? 'text-[11.5px] font-medium' : 'text-[11px] text-ink-400'
                  }`}
                >
                  {item.title || '(无标题)'}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-600">L{item.line}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
