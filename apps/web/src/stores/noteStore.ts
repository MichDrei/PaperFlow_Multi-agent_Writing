/**
 * 个人笔记。
 *
 * 和"批注"的区别：
 * - 批注是**协作**产物（全组可见，锚在文字上，可回复）
 * - 笔记是**私人**产物（只有自己能看到，存在本机，公私项目都能用）
 *
 * 所以笔记不走 Y.Doc / 服务器，只落 localStorage。
 */

import { create } from 'zustand';

export interface Note {
  id: string;
  projectId: string;
  fileId: string;
  /** 锚定的源码行（1-based）；纯想法可以为空。 */
  line?: number;
  /** 摘录的原文，便于回顾。 */
  quoted?: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface NoteState {
  notes: Note[];
  /** 新建/更新/删除都同步到 localStorage。 */
  add: (note: Omit<Note, 'id' | 'createdAt' | 'updatedAt'>) => void;
  update: (id: string, body: string) => void;
  remove: (id: string) => void;
  clearProject: (projectId: string) => void;
  markSeen: () => void;
  seenCount: number;
}

const KEY = 'pf.notes.v1';

function load(): Note[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Note[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(notes: Note[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(notes));
  } catch {
    /* 存储满了就跳过，不影响写作 */
  }
}

export const useNoteStore = create<NoteState>()((set, get) => ({
  notes: load(),
  seenCount: 0,
  add: (note) =>
    set((state) => {
      const now = new Date().toISOString();
      const next = [
        { ...note, id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, createdAt: now, updatedAt: now },
        ...state.notes,
      ];
      persist(next);
      return { notes: next };
    }),
  update: (id, body) =>
    set((state) => {
      const next = state.notes.map((n) => (n.id === id ? { ...n, body, updatedAt: new Date().toISOString() } : n));
      persist(next);
      return { notes: next };
    }),
  remove: (id) =>
    set((state) => {
      const next = state.notes.filter((n) => n.id !== id);
      persist(next);
      return { notes: next };
    }),
  clearProject: (projectId) =>
    set((state) => {
      const next = state.notes.filter((n) => n.projectId !== projectId);
      persist(next);
      return { notes: next };
    }),
  markSeen: () => set((state) => ({ seenCount: state.notes.length })),
}));

/** 读取某个项目的笔记（新的在前）。 */
export function notesOf(notes: Note[], projectId: string | null): Note[] {
  if (!projectId) return [];
  return notes.filter((n) => n.projectId === projectId);
}
