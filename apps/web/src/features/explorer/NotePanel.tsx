/** 笔记面板：只有自己能看到，公私项目都能用（存在本机）。 */

import { useState } from 'react';
import { NotebookPen, Trash2 } from 'lucide-react';
import { useNoteStore, notesOf } from '@/stores/noteStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

export function NotePanel() {
  const notes = useNoteStore((s) => s.notes);
  const add = useNoteStore((s) => s.add);
  const remove = useNoteStore((s) => s.remove);
  const projectId = useWorkspaceStore((s) => s.activeProjectId);
  const activeFile = useWorkspaceStore((s) => s.activeFile());
  const reveal = useWorkspaceStore((s) => s.reveal);
  const list = notesOf(notes, projectId);
  const [draft, setDraft] = useState('');

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <NotebookPen className="size-3 text-ink-500" />
        <span className="text-[10.5px] font-semibold tracking-wide text-ink-400 uppercase">笔记 {list.length}</span>
        <span className="ml-auto text-[9.5px] text-ink-600">仅自己可见</span>
      </div>

      <div className="px-2.5 pb-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) {
              add({ projectId: projectId ?? '', fileId: activeFile?.id ?? '', body: draft.trim() });
              setDraft('');
            }
          }}
          placeholder="记点什么…（⌘/Ctrl+Enter 保存）"
          className="h-16 w-full resize-none rounded border border-ink-750 bg-ink-850 px-2 py-1.5 text-[11.5px] text-ink-100 placeholder:text-ink-600 focus:border-brand-600/60 focus:outline-none"
        />
        <button
          type="button"
          disabled={!draft.trim() || !projectId}
          onClick={() => {
            add({ projectId: projectId ?? '', fileId: activeFile?.id ?? '', body: draft.trim() });
            setDraft('');
          }}
          className="mt-1 w-full rounded border border-ink-700 py-1 text-[10.5px] text-ink-300 hover:border-brand-600/60 hover:text-brand-300 disabled:opacity-40"
        >
          保存笔记
        </button>
      </div>

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-2">
        {list.length === 0 && (
          <li className="rounded border border-ink-800 px-2 py-3 text-center text-[10.5px] text-ink-600">
            还没有笔记。写下你的想法，只有你能看到。
          </li>
        )}
        {list.map((note) => (
          <li key={note.id} className="rounded border border-ink-800 bg-ink-900/60 px-2 py-1.5">
            <div className="flex items-start gap-1">
              <p className="min-w-0 flex-1 whitespace-pre-wrap text-[11px] leading-snug text-ink-200">{note.body}</p>
              <button
                type="button"
                onClick={() => remove(note.id)}
                title="删除这条笔记"
                className="shrink-0 rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-accent-rose"
              >
                <Trash2 className="size-2.5" />
              </button>
            </div>
            {note.quoted && (
              <p className="mt-0.5 truncate text-[9.5px] text-ink-600">「{note.quoted}」</p>
            )}
            <div className="mt-0.5 flex items-center gap-1.5 text-[9.5px] text-ink-600">
              <span>{new Date(note.createdAt).toLocaleString()}</span>
              {note.line && (
                <button
                  type="button"
                  onClick={() => reveal(note.line ?? 1)}
                  className="text-brand-400 hover:underline"
                >
                  跳到 L{note.line}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
