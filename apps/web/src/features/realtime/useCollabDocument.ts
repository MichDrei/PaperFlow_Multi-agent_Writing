/**
 * 把 Monaco 接到 Yjs 上：多人同时编辑 + 在线光标。
 *
 * 服务端在 `/collab/<projectId>:<path>` 上跑标准 y-websocket 协议，
 * 这里用 `y-monaco` 的 MonacoBinding 做双向绑定——它会自动
 *   · 把本地编辑发出去
 *   · 把远端编辑合进来（CRDT，不会互相覆盖）
 *   · 把本地光标/选区写进 awareness，并渲染其他人的光标
 */

import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useAnnotationStore } from '@/stores/annotationStore';
import { usePresenceStore } from '@/stores/presenceStore';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
}

export interface Annotation {
  id: string;
  authorId: string;
  authorName: string;
  color: string;
  body: string;
  quoted: string;
  createdAt: string;
  /** Yjs 相对位置（编码后的 Uint8Array）：文字增删后锚点会跟着走。 */
  from: Uint8Array;
  to: Uint8Array;
  /** 回复串（存在同一个 Y.Array 里，天然同步）。 */
  replies?: { id: string; authorName: string; color: string; text: string; at: string }[];
}

/** 把相对位置解成**当前**绝对下标的批注（用于渲染高亮）。 */
export interface AnnotationRange {
  id: string;
  start: number;
  end: number;
  body: string;
  authorName: string;
  color: string;
}

export interface CollabState {
  status: 'off' | 'connecting' | 'connected' | 'disconnected';
  peers: Peer[];
  annotations: Annotation[];
  /** 相对位置解析后的当前区间（文字增删会自动跟着走）。 */
  annotationRanges: AnnotationRange[];
  /** 基于当前绝对下标创建一条批注。 */
  addAnnotation: (fromIndex: number, toIndex: number, quoted: string, body: string) => void;
  resolveAnnotation: (id: string) => void;
  /** 给某条批注追加一条回复。 */
  addReply: (id: string, text: string) => void;
}

/** 给每个远端 clientId 注入一段 CSS：y-monaco 只加类名，颜色得我们自己给。 */
function ensurePeerStyle(clientId: number, color: string): void {
  const id = `y-remote-${clientId}`;
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    .yRemoteSelection-${clientId} { background-color: ${color}33; }
    .yRemoteSelectionHead-${clientId} {
      position: absolute;
      border-left: 2px solid ${color};
      border-top: 2px solid ${color};
      border-bottom: 2px solid ${color};
      box-sizing: border-box;
      height: 100%;
    }
    .yRemoteSelectionHead-${clientId}::after {
      position: absolute;
      content: ' ';
      border: 1px solid ${color};
      background-color: ${color};
      left: -2px;
      top: -1.4em;
      height: 1.4em;
      width: 6px;
    }
  `;
  document.head.appendChild(style);
}

export function useCollabDocument(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  monaco: typeof Monaco | null,
  filePath: string | undefined,
  enabled: boolean,
  /** 当前项目 id。必须作为依赖：首帧它往往还没加载出来，漏了它就不会重连。 */
  projectId?: string,
): CollabState {
  const [status, setStatus] = useState<CollabState['status']>('off');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationRanges, setAnnotationRanges] = useState<AnnotationRange[]>([]);
  /** 让组件能拿到当前 doc，用于 addAnnotation（每次 effect 重建）。 */
  const apiRef = useRef<{
    add: CollabState['addAnnotation'];
    resolve: CollabState['resolveAnnotation'];
    reply: CollabState['addReply'];
  }>({ add: () => {}, resolve: () => {}, reply: () => {} });
  const refreshAnnotationsRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled || !editor || !monaco || !filePath || !projectId) {
      setStatus('off');
      setPeers([]);
      setAnnotations([]);
      setAnnotationRanges([]);
      return;
    }

    const doc = new Y.Doc();
    const room = `${projectId}:${filePath}`;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const provider = new WebsocketProvider(`${protocol}//${window.location.host}/collab`, room, doc, {
      connect: true,
    });

    const me = useSessionStore.getState().me;
    provider.awareness.setLocalStateField('user', {
      name: me?.displayName ?? '我',
      color: me?.color ?? '#4f9cf9',
    });

    const model = editor.getModel();
    const binding = model
      ? new MonacoBinding(doc.getText('content'), model, new Set([editor]), provider.awareness)
      : undefined;

    // 把协同后的内容同步回 store：编译、字数统计、状态栏都读它
    const text = doc.getText('content');
    const onText = (): void => {
      const current = useWorkspaceStore.getState().activeFile();
      const next = text.toString();
      // 内容没变（例如只是远端光标移动）就不要写 store，避免无谓的整树重渲染
      if (next === current.content) return;
      useWorkspaceStore.getState().updateFileContent(current.id, next);
      // 文字变了，相对位置对应的绝对下标也要重算
      if (refreshAnnotationsRef.current) refreshAnnotationsRef.current();
    };
    text.observe(onText);

    const refreshPeers = (): void => {
      const list: Peer[] = [];
      for (const [clientId, state] of provider.awareness.getStates()) {
        if (clientId === doc.clientID) continue;
        const user = (state as { user?: { name?: string; color?: string } }).user;
        if (!user?.name) continue;
        const color = user.color ?? '#4f9cf9';
        ensurePeerStyle(clientId, color);
        list.push({ clientId, name: user.name, color });
      }
      setPeers(list);
      // 同步给群聊头部（自己 + 其他人）
      const meUser = useSessionStore.getState().me;
      usePresenceStore.getState().setMembers([
        ...(meUser ? [{ id: 'me', name: meUser.displayName, color: meUser.color, self: true }] : []),
        ...list.map((peer) => ({ id: String(peer.clientId), name: peer.name, color: peer.color, self: false })),
      ]);
    };
    provider.awareness.on('change', refreshPeers);
    refreshPeers();

    /*
     * 批注存在同一个 Y.Doc 的 Y.Array 里 —— 天然同步给所有人，服务端不用改一行。
     * 锚点用 `Y.createRelativePositionFromTypeIndex`（相对位置）而不是字符下标：
     * 否则别人在前面插一段话，批注就会跑到别的地方去。
     */
    const store = doc.getArray<Annotation>('annotations');
    const decode = (bytes: Uint8Array): number | undefined => {
      try {
        const relative = Y.decodeRelativePosition(Uint8Array.from(bytes));
        const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);
        return absolute?.index;
      } catch {
        return undefined;
      }
    };
    const refreshAnnotations = (): void => {
      const list = store.toArray();
      setAnnotations(list);
      const ranges: AnnotationRange[] = [];
      for (const item of list) {
        const start = decode(item.from);
        const end = decode(item.to);
        if (start === undefined || end === undefined) continue;
        ranges.push({ id: item.id, start, end, body: item.body, authorName: item.authorName, color: item.color });
      }
      setAnnotationRanges(ranges);
      // 同步给左侧"批注"面板（面板与编辑器共用同一份数据）
      useAnnotationStore.getState().setItems(
        list.map((item, index) => ({
          id: item.id,
          authorId: item.authorId,
          createdAt: item.createdAt,
          body: item.body,
          quoted: item.quoted,
          replies: item.replies,
          authorName: item.authorName,
          color: item.color,
          start: ranges[index]?.start ?? 0,
          end: ranges[index]?.end ?? 0,
        })),
      );
    };
    refreshAnnotationsRef.current = refreshAnnotations;
    // 面板里的"删除"也要落到同一个 Y.Array 上（权限由 UI 控制：只有作者能点）
    useAnnotationStore.getState().setRemoveHandler((id) => {
      const list = store.toArray();
      const index = list.findIndex((a) => a.id === id);
      if (index !== -1) store.delete(index, 1);
    });
    store.observe(refreshAnnotations);
    refreshAnnotations();

    apiRef.current = {
      add: (fromIndex, toIndex, quoted, body) => {
        const fromPos = Y.createRelativePositionFromTypeIndex(text, Math.max(0, fromIndex));
        const toPos = Y.createRelativePositionFromTypeIndex(text, Math.max(fromIndex, toIndex));
        const author = useSessionStore.getState().me;
        store.push([
          {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            authorId: author?.id ?? 'anonymous',
            authorName: author?.displayName ?? '我',
            color: author?.color ?? '#4f9cf9',
            body,
            quoted,
            createdAt: new Date().toISOString(),
            from: Y.encodeRelativePosition(fromPos),
            to: Y.encodeRelativePosition(toPos),
          } satisfies Annotation,
        ]);
      },
      resolve: (id) => {
        const list = store.toArray();
        const index = list.findIndex((a) => a.id === id);
        if (index === -1) return;
        store.delete(index, 1);
      },
      reply: (id, text) => {
        const list = store.toArray();
        const index = list.findIndex((a) => a.id === id);
        if (index === -1) return;
        const author = useSessionStore.getState().me;
        const item = list[index]!;
        const replies = [
          ...(item.replies ?? []),
          {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            authorName: author?.displayName ?? '我',
            color: author?.color ?? '#4f9cf9',
            text,
            at: new Date().toISOString(),
          },
        ];
        // Y.Array 没有"就地改字段"，用 delete + insert 保留位置
        store.delete(index, 1);
        store.insert(index, [{ ...item, replies }]);
      },
    };

    provider.on('connection-error', (event: unknown) => {
      console.warn('[collab] WebSocket 连接失败（可能是未登录或代理不支持 upgrade）', event);
    });
    provider.on('connection-close', (event: unknown) => {
      console.warn('[collab] WebSocket 连接关闭', event);
    });
    const onStatus = (event: { status: string }): void => {
      setStatus(event.status === 'connected' ? 'connected' : event.status === 'connecting' ? 'connecting' : 'disconnected');
    };
    provider.on('status', onStatus);

    return () => {
      useAnnotationStore.getState().setRemoveHandler(null);
      useAnnotationStore.getState().setItems([]);
      usePresenceStore.getState().setMembers([]);
      store.unobserve(refreshAnnotations);
      text.unobserve(onText);
      provider.awareness.off('change', refreshPeers);
      provider.off('status', onStatus);
      binding?.destroy();
      provider.destroy();
      doc.destroy();
    };
  }, [editor, monaco, filePath, enabled, projectId]);

  return {
    status,
    peers,
    annotations,
    annotationRanges,
    addAnnotation: (from, to, quoted, body) => apiRef.current.add(from, to, quoted, body),
    resolveAnnotation: (id) => apiRef.current.resolve(id),
    addReply: (id, text) => apiRef.current.reply(id, text),
  };
}
