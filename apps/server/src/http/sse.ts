/**
 * SSE 编码：把 StreamEvent 写成 `data: {...}\n\n`。
 *
 * 两个必须注意的细节：
 * 1. 周期性发心跳注释帧，否则经过反向代理（Nginx / Cloudflare）时空闲连接会被掐断；
 * 2. 用 `setHeader` 逐个写头再 `writeHead(200)`，**不要**用 `writeHead(200, {...})`——
 *    后者会覆盖掉此前已设置的头（我们的 CORS 头就是这样被吃掉过一次）。
 */

import type { ServerResponse } from 'node:http';
import type { StreamEvent } from '@paperflow/core';

export interface SseChannel {
  send(event: StreamEvent | { type: 'ping' }): void;
  close(): void;
  readonly closed: boolean;
}

export function openSse(res: ServerResponse, heartbeatMs = 15_000): SseChannel {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 关闭 Nginx 的响应缓冲，否则流式会被攒成一坨再下发。
  res.setHeader('X-Accel-Buffering', 'no');
  res.writeHead(200);
  res.write(': connected\n\n');

  let closed = false;
  const timer = setInterval(() => {
    if (closed) return;
    res.write(': ping\n\n');
  }, heartbeatMs);

  return {
    get closed() {
      return closed;
    },
    send(event) {
      if (closed) return;
      if ((event as { type: string }).type === 'ping') {
        res.write(': ping\n\n');
        return;
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      res.end();
    },
  };
}
