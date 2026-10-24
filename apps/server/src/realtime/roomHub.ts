/**
 * 群聊房间：把「用户 + 多个 agent」放进同一个广播频道。
 *
 * 现有链路是"一问一答、只回给发起者"（SSE 单播）。这里再加一条
 * 房间通道：同一项目里所有人的发言、以及 agent 的回复，都广播给房间内所有连接。
 *
 * 传输和协同复用的是同一个 HTTP server（不同路径），鉴权同样用会话 cookie。
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { TeamStore } from '../auth/teamStore.js';

export const ROOM_PATH = '/room';

interface RoomOptions {
  team?: TeamStore;
  authMode: 'solo' | 'team';
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface RoomHub {
  /** 广播给某项目的所有连接（可排除发起者）。 */
  broadcast: (projectId: string, payload: unknown, exceptClientId?: string) => void;
  close: () => void;
}

interface Conn {
  ws: WebSocket;
  projectId: string;
  clientId: string;
}

export function attachRoomHub(server: HttpServer, options: RoomOptions): RoomHub {
  const wss = new WebSocketServer({ noServer: true });
  const conns = new Set<Conn>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== ROOM_PATH) return; // 交给别的 handler（/collab）

    if (options.authMode === 'team') {
      const token = cookieValue(request.headers.cookie, 'pf_session');
      if (!options.team?.userForSession(token)) {
        options.log?.('room upgrade rejected', { hasCookie: Boolean(request.headers.cookie) });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, url));
  };

  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, url: URL) => {
    const projectId = url.searchParams.get('project') ?? '';
    const clientId = url.searchParams.get('client') ?? '';
    if (!projectId) {
      ws.close(1008, 'project required');
      return;
    }
    const conn: Conn = { ws, projectId, clientId };
    conns.add(conn);
    ws.on('close', () => conns.delete(conn));
    ws.on('error', () => conns.delete(conn));
    // 心跳：代理/浏览器会掐掉长时间无数据的连接
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 25_000);
    ws.on('close', () => clearInterval(ping));
  });

  const broadcast = (projectId: string, payload: unknown, exceptClientId?: string): void => {
    const text = JSON.stringify(payload);
    for (const conn of conns) {
      if (conn.projectId !== projectId) continue;
      if (exceptClientId && conn.clientId === exceptClientId) continue;
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      conn.ws.send(text);
    }
  };

  const close = (): void => {
    for (const conn of conns) conn.ws.close();
    wss.close();
    server.off('upgrade', onUpgrade);
  };

  return { broadcast, close };
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}
