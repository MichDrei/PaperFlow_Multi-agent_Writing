/**
 * 前端与"多模型编排后端"之间的唯一接口。
 *
 * - MockTransport：完全在浏览器内模拟多模型并发流式输出（无 Key 也能演示全链路）。
 * - HttpTransport：连到 apps/server 的 SSE 接口（真实模型）。
 *
 * 两者行为、事件序列完全一致，切换只需改一个环境变量，UI 代码零改动。
 */

import type { ChatTurnRequest, StreamEvent } from '@paperflow/core';

export type TransportListener = (event: StreamEvent) => void;

export interface ChatTransport {
  readonly kind: 'mock' | 'http';
  /** 发起一次群聊回合；事件通过 listener 增量回流。 */
  send(req: ChatTurnRequest, onEvent: TransportListener): Promise<void>;
  /** 取消进行中的回合。 */
  cancel(turnId: string): void;
}

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
