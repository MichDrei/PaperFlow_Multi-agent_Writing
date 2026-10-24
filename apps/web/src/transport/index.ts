import type { SharedContext } from '@paperflow/core';
import { HttpTransport } from './httpTransport';
import { MockTransport } from './mockTransport';
import type { ChatTransport } from './types';

export * from './types';
export { MockTransport } from './mockTransport';
export { HttpTransport } from './httpTransport';

/**
 * 编排服务地址。
 *
 * - 显式配置 `VITE_API_BASE` → 用它（后端在别的机器/端口时用）；
 * - 未配置 → 用**同源相对路径** `/api`，由 Vite dev proxy（或生产环境的反向代理）转发。
 *   这样 `npm run dev` 起来就自动接上后端，不需要任何 .env ——
 *   "忘了配 VITE_API_BASE 于是永远停在 mock 模式"是个很难察觉的坑，这里从设计上消除它。
 */
export { API_BASE } from '@/lib/backend';

export interface CreateTransportOptions {
  getContext: () => SharedContext;
  getDocumentContent: () => string;
}

export interface TransportBundle {
  transport: ChatTransport;
  /** 未显式配置 API_BASE：探测失败时应退回浏览器内 mock，而不是报"后端离线"。 */
  autoDetect: boolean;
  /** 探测失败时使用的降级实现。 */
  mockFallback: ChatTransport;
}

export function createTransport(options: CreateTransportOptions): TransportBundle {
  const mockFallback = new MockTransport({
    getContext: options.getContext,
    getDocumentContent: options.getDocumentContent,
  });

  const explicit = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
  if (explicit) {
    return { transport: new HttpTransport({ baseUrl: explicit }), autoDetect: false, mockFallback };
  }

  return { transport: new HttpTransport({ baseUrl: '' }), autoDetect: true, mockFallback };
}
