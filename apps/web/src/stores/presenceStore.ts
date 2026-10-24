/**
 * 在线成员（来自协同时的 awareness）。
 *
 * 协同的 `useCollabDocument` 已经通过 awareness 拿到了"谁在场"，
 * 但那份数据原来只活在编辑器组件里。这里复制一份到全局，
 * 让群聊头部也能显示"谁在线"。
 */

import { create } from 'zustand';

export interface PresenceMember {
  /** 用于去重（自己用 'me'）。 */
  id: string;
  name: string;
  color: string;
  self: boolean;
}

interface PresenceState {
  members: PresenceMember[];
  setMembers: (members: PresenceMember[]) => void;
}

export const usePresenceStore = create<PresenceState>()((set) => ({
  members: [],
  setMembers: (members) => set({ members }),
}));
