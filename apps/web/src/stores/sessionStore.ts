/**
 * 团队模式的会话状态。
 *
 * `solo` 模式下服务端不做鉴权，这里保持 `me = null` 且不拦任何界面；
 * `team` 模式下没登录就只显示入组页（见 JoinGate）。
 */

import { create } from 'zustand';
import { apiUrl } from '@/lib/backend';

export interface SessionUser {
  id: string;
  displayName: string;
  color: string;
  isOwner: boolean;
  createdAt: string;
}

interface SessionState {
  mode: 'solo' | 'team';
  me: SessionUser | null;
  loading: boolean;
  /** 服务端是否还没有 owner（首次部署，需要认领链接）。 */
  hasOwner: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set) => ({
  mode: 'solo',
  me: null,
  loading: true,
  hasOwner: true,

  refresh: async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/state'));
      const data = (await res.json()) as {
        mode: 'solo' | 'team';
        hasOwner: boolean;
        me: SessionUser | null;
      };
      set({ mode: data.mode, me: data.me, hasOwner: data.hasOwner, loading: false });
    } catch {
      // 后端不可达时不要卡在加载态：退化为单机模式，让界面照常可用
      set({ mode: 'solo', me: null, loading: false });
    }
  },

  logout: async () => {
    await fetch(apiUrl('/api/auth/logout'), { method: 'POST' });
    set({ me: null });
  },
}));
