/**
 * 批注的全局状态。
 *
 * 为什么要把批注从编辑器里"提"出来：原来它渲染成编辑器右上角的一块浮层，
 * 常驻、挡内容，而且点 × 会把整条批注删掉（对别人也一样）。
 * 现在改成像群聊一样**独立面板**，批注列表放在左侧面板里，正文只留高亮。
 *
 * 数据仍然存在每个文件自己的 Y.Doc 里（所以天然多人同步），
 * 这个 store 只是把它复制一份给面板用，并提供"点击跳转"的请求通道。
 */

import { create } from 'zustand';
import type { AnnotationRange } from '@/features/realtime/useCollabDocument';

export interface AnnotationItem extends AnnotationRange {
  /** 写这条批注的人。只有他能删除。 */
  authorId: string;
  createdAt: string;
  /** 被批注的原文片段。 */
  quoted: string;
  replies?: { id: string; authorName: string; color: string; text: string; at: string }[];
}

interface AnnotationState {
  items: AnnotationItem[];
  /** 上次查看批注面板时看到的条数，用来算未读。 */
  seenCount: number;
  markSeen: () => void;
  /** 请求跳转到某条批注（编辑器监听后滚动 + 选中）。 */
  jumpRequest: string | null;
  setItems: (items: AnnotationItem[]) => void;
  requestJump: (id: string) => void;
  clearJump: () => void;
  /** 删除回调由编辑器注入（真正改 Y.Doc 的地方在那儿）。 */
  removeHandler: ((id: string) => void) | null;
  setRemoveHandler: (handler: ((id: string) => void) | null) => void;
  /** 回复回调（同样由编辑器注入）。 */
  replyHandler: ((id: string, text: string) => void) | null;
  setReplyHandler: (handler: ((id: string, text: string) => void) | null) => void;
}

export const useAnnotationStore = create<AnnotationState>()((set) => ({
  items: [],
  seenCount: 0,
  markSeen: () => set((state) => ({ seenCount: state.items.length })),
  jumpRequest: null,
  setItems: (items) => set({ items }),
  requestJump: (id) => set({ jumpRequest: id }),
  clearJump: () => set({ jumpRequest: null }),
  removeHandler: null,
  setRemoveHandler: (handler) => set({ removeHandler: handler }),
  replyHandler: null,
  setReplyHandler: (handler) => set({ replyHandler: handler }),
}));
