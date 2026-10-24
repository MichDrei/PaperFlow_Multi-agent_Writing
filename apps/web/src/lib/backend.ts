/**
 * 后端地址解析。
 *
 * ⚠️ 这里踩过一个很隐蔽的坑：早先的实现是 `VITE_API_BASE || ''`，
 * 然后调用方写 `if (!base) return;` —— 而"零配置"方案恰恰是 **不设** VITE_API_BASE、
 * 走同源 `/api` 代理（Vite dev proxy）。于是空字符串被当成"没有后端"，
 * 导致界面里添加的参考资料**只存在浏览器内存、从未 POST 到服务端**：
 * 列表里看得见，模型却读不到。
 *
 * 正确语义：**空字符串 = 同源相对路径**（`/api/...`），这是完全合法的地址；
 * "有没有后端"应该由探测结果（chatStore.backend.mode）判断，而不是由这个函数判断。
 */

/**
 * 编排服务基地址：显式配置优先；未配置时为空字符串 = **同源相对路径**（合法地址）。
 * 注意：空字符串不代表"没有后端"——那是探测结果说了算（见 getBackendMode）。
 */
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').trim();

/** 把 `/api/context` 解析成可直接 fetch 的地址。 */
export function apiUrl(path: string): string {
  const explicit = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
  if (explicit) return `${explicit.replace(/\/$/, '')}${path}`;
  return path; // 同源相对路径：由 Vite dev proxy / 生产反向代理转发
}

/** 是否显式配置了后端地址（用于区分"同源兜底"与"用户指定"）。 */
export function hasExplicitApiBase(): boolean {
  return Boolean((import.meta.env.VITE_API_BASE as string | undefined)?.trim());
}

/**
 * 当前后端可用性。由 chatStore 探测后写入，供其它模块读取。
 *
 * 为什么放在这个独立模块：chatStore 依赖 workspaceStore（读文档内容），
 * 如果 workspaceStore 反过来 import chatStore 就会形成循环。这里做一个无依赖的小中转站。
 */
export type BackendMode = 'http' | 'browser-mock';

let currentMode: BackendMode = 'http'; // 先按"有后端"起步，探测失败后再回落
let probeDone = false;

export function setBackendMode(mode: BackendMode): void {
  currentMode = mode;
  probeDone = true;
}

export function getBackendMode(): BackendMode {
  return currentMode;
}

export function isProbeDone(): boolean {
  return probeDone;
}
