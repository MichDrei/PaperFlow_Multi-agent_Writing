/**
 * 实时协同服务端（Yjs 同步 + 在线光标）。
 *
 * 协议与 `y-websocket` 客户端**完全兼容**（y-websocket 3.x 只发布客户端，
 * 服务端 utils 已被移除，所以这里按协议实现：sync + awareness 两种消息）。
 *
 * 设计要点：
 * 1. 一个房间 = 一个项目里的一个文件（`/collab/<projectId>:<path>`）
 * 2. 首连时从磁盘读内容灌进 Y.Text，之后**由 Y.Doc 作为真相源**
 * 3. 空闲 400ms 落盘一次，保证编译/导出看到的仍是最新内容
 * 4. 鉴权复用团队模式的会话 cookie：没有有效会话直接断开
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { ProjectStore } from '../storage/projectStore.js';
import type { TeamStore } from '../auth/teamStore.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** WebSocket 路径前缀。前端用它拼 `ws://host/collab/<room>`。 */
export const COLLAB_PATH = '/collab';

interface Room {
  doc: Y.Doc;
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
  /** 每个连接"拥有"哪些 awareness clientId，断开时据此清理光标。 */
  conns: Map<WebSocket, Set<number>>;
  persistTimer?: NodeJS.Timeout;
  loaded: boolean;
  projectId: string;
  filePath: string;
  /** 脏标记：只有内容真的变了才写盘。 */
  dirty: boolean;
}

export interface CollabOptions {
  store: ProjectStore;
  team?: TeamStore;
  authMode: 'solo' | 'team';
  /** 诊断日志（连接/拒绝原因），便于排查"连不上"。 */
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Yjs 快照目录（默认 `<cwd>/.paperflow/collab`）。 */
  stateDir?: string;
}

/**
 * 把协同服务挂到 Fastify 底层的 HTTP server 上。
 * 只处理 `${COLLAB_PATH}/...` 的 upgrade，其余原样返回（不拦截别的 ws 用法）。
 */
export function attachCollabServer(server: HttpServer, options: CollabOptions): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Room>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    /*
     * 只处理 /collab 的升级请求；**不要**销毁其他路径的 socket。
     * 同一个 HTTP server 上还挂着 /room（群聊广播），
     * 早先这里直接 `socket.destroy()`，把 /room 的连接也一起掐了
     * （表现：实时协同正常，但群聊广播一条都收不到）。
     */
    if (!url.pathname.startsWith(`${COLLAB_PATH}/`)) return;

    // 鉴权：团队模式下必须是有效会话，否则直接拒绝（不握手）
    if (options.authMode === 'team') {
      const token = cookieValue(request.headers.cookie, 'pf_session');
      const user = options.team?.userForSession(token);
      if (!user) {
        options.log?.('collab upgrade rejected', {
          hasCookie: Boolean(request.headers.cookie),
          hasSession: Boolean(token),
          origin: request.headers.origin,
          path: url.pathname,
        });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    options.log?.('collab upgrade accepted', { path: url.pathname, origin: request.headers.origin });
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };

  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const roomId = decodeURIComponent(url.pathname.slice(COLLAB_PATH.length + 1));
    const [projectId, ...rest] = roomId.split(':');
    const filePath = rest.join(':');
    if (!projectId || !filePath) {
      ws.close(1008, 'room must be <projectId>:<path>');
      return;
    }

    const room = getRoom(rooms, options, projectId, filePath);
    const controlled = new Set<number>();
    room.conns.set(ws, controlled);

    ws.binaryType = 'arraybuffer';

    // 1) 先发 sync step1，让客户端把本地已有的状态带回来
    {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, room.doc);
      send(ws, encoding.toUint8Array(encoder));
    }

    // 2) 把当前所有在线状态（其他人的光标）推给新连接
    const states = room.awareness.getStates();
    if (states.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]),
      );
      send(ws, encoding.toUint8Array(encoder));
    }

    ws.on('message', (data: ArrayBuffer | Buffer) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      const decoder = decoding.createDecoder(bytes);
      const messageType = decoding.readVarUint(decoder);

      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
        if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
        return;
      }

      if (messageType === MESSAGE_AWARENESS) {
        // 记录这个连接"拥有"哪些 clientId：对比应用前后的状态集合
        const before = new Set(room.awareness.getStates().keys());
        awarenessProtocol.applyAwarenessUpdate(
          room.awareness,
          decoding.readVarUint8Array(decoder),
          ws,
        );
        for (const id of room.awareness.getStates().keys()) {
          if (!before.has(id)) controlled.add(id);
        }
      }
    });

    const cleanup = (): void => {
      room.conns.delete(ws);
      // 断开时清掉它带来的光标，否则别人会看到"幽灵光标"一直停在原地
      if (controlled.size > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, [...controlled], null);
      }
      if (room.conns.size === 0) {
        flush(room, options);
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  // 服务关闭时把所有房间落盘
  const close = (): void => {
    for (const room of rooms.values()) flush(room, options);
    wss.close();
    server.off('upgrade', onUpgrade);
  };

  return { close };
}

function getRoom(
  rooms: Map<string, Room>,
  options: CollabOptions,
  projectId: string,
  filePath: string,
): Room {
  const key = `${projectId}:${filePath}`;
  const existing = rooms.get(key);
  if (existing) return existing;

  const doc = new Y.Doc();
  const text = doc.getText('content');
  const awareness = new awarenessProtocol.Awareness(doc);

  /*
   * 初始状态：优先加载 **Yjs 快照**（`<data>/collab/<room>.bin`）。
   *
   * 只从文本重建文档是不行的：服务端一重启历史就没了，客户端带着旧状态重连时，
   * 两边的插入会被 Yjs 当成**并发编辑合并**，于是内容成倍重复
   * （实测一份 120 行的 main.tex 被撑到 12009 行）。
   * 所以这里必须持久化 `Y.encodeStateAsUpdate`。
   */
  const stateFile = collabStatePath(options, projectId, filePath);
  let loaded = false;
  try {
    if (existsSync(stateFile)) {
      Y.applyUpdate(doc, new Uint8Array(readFileSync(stateFile)), 'init');
      loaded = true;
    }
  } catch {
    loaded = false;
  }
  if (!loaded) {
    let initial = '';
    try {
      const file = options.store.read(projectId, filePath);
      if (file.encoding === 'utf8') initial = file.content;
    } catch {
      initial = '';
    }
    if (initial) {
      doc.transact(() => {
        text.insert(0, initial);
      }, 'init');
    }
  }

  const room: Room = {
    doc,
    text,
    awareness,
    conns: new Map(),
    loaded: true,
    projectId,
    filePath,
    dirty: false,
  };

  // 文档变更 → 广播给其他连接 + 安排落盘
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    /*
     * ⚠️ 必须用 `syncProtocol.writeUpdate`，不能自己 `writeVarUint8Array`：
     * y-websocket 的 sync 帧是 `[messageSync][子类型][数据]`，
     * 少了子类型，客户端会把它当成未知消息（实测报 "Unknown message type"，
     * 表现就是"编辑完全不同步"）。
     */
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    for (const conn of room.conns.keys()) {
      if (conn === origin) continue;
      send(conn, message);
    }
    if (origin !== 'init') {
      room.dirty = true;
      schedulePersist(room, options);
    }
  });

  // 在线状态变更 → 广播
  awareness.on(
    'update',
    (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const ids = [...changes.added, ...changes.updated, ...changes.removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, ids));
      const message = encoding.toUint8Array(encoder);
      for (const conn of room.conns.keys()) {
        if (conn === origin) continue;
        send(conn, message);
      }
    },
  );

  rooms.set(key, room);
  return room;
}

/** 空闲 400ms 落盘：既不太频繁，也不会让编译读到旧内容。 */
function schedulePersist(room: Room, options: CollabOptions): void {
  if (room.persistTimer) clearTimeout(room.persistTimer);
  room.persistTimer = setTimeout(() => {
    room.persistTimer = undefined;
    flush(room, options);
  }, 400);
}

function flush(room: Room, options: CollabOptions): void {
  if (!room.dirty) return;
  room.dirty = false;
  try {
    // 文本给编译/导出用；Yjs 快照给下次启动用（保证历史不丢、内容不重复）
    options.store.write(room.projectId, room.filePath, room.text.toString());
    const stateFile = collabStatePath(options, room.projectId, room.filePath);
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, Buffer.from(Y.encodeStateAsUpdate(room.doc)));
    renameSync(tmp, stateFile);
  } catch {
    // 写盘失败（比如文件被删）不应影响协同；下次更新会重试
    room.dirty = true;
  }
}

/** Yjs 快照路径：`<data>/collab/<project>__<file>.bin`。 */
function collabStatePath(options: CollabOptions, projectId: string, filePath: string): string {
  const safe = `${projectId}__${filePath}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(options.stateDir ?? '.paperflow/collab', `${safe}.bin`);
}

function send(ws: WebSocket, message: Uint8Array): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(message, (err) => {
    if (err) ws.close();
  });
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
