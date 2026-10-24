/**
 * HttpTransport —— 连接 apps/server 的真实多模型编排（SSE 流式）。
 *
 * 与 MockTransport 实现同一个接口、发出同一组 StreamEvent，因此切换后端对 UI 透明。
 * 协议：POST /api/chat（JSON body）→ text/event-stream，每帧 `data: {...StreamEvent}`。
 */

import type { ChatTurnRequest, StreamEvent } from '@paperflow/core';
import { uid, type ChatTransport, type TransportListener } from './types';

export interface HttpTransportOptions {
  baseUrl: string;
  /** 断线后是否自动重连（仅对网络类错误重试一次）。 */
  retryOnNetworkError?: boolean;
}

export class HttpTransport implements ChatTransport {
  readonly kind = 'http' as const;

  private readonly baseUrl: string;

  private readonly retryOnNetworkError: boolean;

  private controllers = new Map<string, AbortController>();

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.retryOnNetworkError = options.retryOnNetworkError ?? true;
  }

  cancel(turnId: string): void {
    this.controllers.get(turnId)?.abort();
    this.controllers.delete(turnId);
  }

  async send(req: ChatTurnRequest, onEvent: TransportListener): Promise<void> {
    const localTurnId = uid('turn');
    let attempt = 0;
    // 服务端会下发权威 turnId；在它到达前先用本地 id 占位，避免 UI 无法取消。
    let serverTurnId: string | undefined;

    for (;;) {
      const controller = new AbortController();
      this.controllers.set(serverTurnId ?? localTurnId, controller);
      try {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(req),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          onEvent({
            type: 'message.error',
            messageId: localTurnId,
            code: `http_${res.status}`,
            message: detail.slice(0, 500) || `后端返回 ${res.status}`,
          });
          onEvent({ type: 'turn.end', turnId: localTurnId, status: 'error' });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let sawTurnEnd = false;

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const dataLines = frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim());
            if (dataLines.length === 0) continue;
            let event: StreamEvent;
            try {
              event = JSON.parse(dataLines.join('\n')) as StreamEvent;
            } catch {
              continue; // 忽略心跳或损坏帧
            }
            if (event.type === 'turn.start') serverTurnId = event.turnId;
            if (event.type === 'turn.end') sawTurnEnd = true;
            onEvent(event);
          }
        }

        if (!sawTurnEnd) onEvent({ type: 'turn.end', turnId: serverTurnId ?? localTurnId, status: 'done' });
        return;
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (aborted) {
          onEvent({ type: 'turn.end', turnId: serverTurnId ?? localTurnId, status: 'cancelled' });
          return;
        }
        attempt += 1;
        if (!this.retryOnNetworkError || attempt > 1) {
          onEvent({
            type: 'message.error',
            messageId: localTurnId,
            code: 'network_error',
            message: err instanceof Error ? err.message : '无法连接编排服务',
          });
          onEvent({ type: 'turn.end', turnId: serverTurnId ?? localTurnId, status: 'error' });
          return;
        }
        await new Promise((r) => setTimeout(r, 600));
      } finally {
        this.controllers.delete(serverTurnId ?? localTurnId);
      }
    }
  }
}
