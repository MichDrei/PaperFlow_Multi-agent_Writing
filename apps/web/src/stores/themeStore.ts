/** 白天/黑夜模式（持久化）。Monaco 主题也要跟着切，所以做成全局状态。 */
import { create } from 'zustand';

interface ThemeState {
  light: boolean;
  toggle: () => void;
}

const initial = typeof localStorage !== 'undefined' && localStorage.getItem('pf.theme') === 'light';

export const useThemeStore = create<ThemeState>()((set) => ({
  light: initial,
  toggle: () =>
    set((state) => {
      const light = !state.light;
      localStorage.setItem('pf.theme', light ? 'light' : 'dark');
      document.documentElement.classList.toggle('light', light);
      return { light };
    }),
}));

/** 启动时把持久化的选择应用到 <html>。 */
export function applyInitialTheme(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('light', useThemeStore.getState().light);
}
