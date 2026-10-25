/**
 * 群聊状态：模型阵容、消息线程、流式事件归并、提议（diff）生命周期。
 *
 * 关键设计：UI 只消费 StreamEvent，不关心背后是 mock 还是真实模型。
 * 所有事件都经过 reduceEvent 归并到消息列表，因此"并发多个模型同时流式输出"
 * 天然被支持——每个 messageId 独立累积。
 */

import { create } from 'zustand';
import {
  DEFAULT_MODEL_CATALOG,
  type ChatMessage,
  type ChatTurnRequest,
  type DiffHunk,
  type EditProposal,
  type ModelDescriptor,
  type ModelId,
  type ProposalStatus,
  type Selection,
  type StreamEvent,
  type Thread,
} from '@paperflow/core';
import { API_BASE, createTransport, type ChatTransport } from '@/transport';
import { inferIntent } from '@/lib/intent';
import { useComposerStore } from './composerStore';
import { apiUrl, setBackendMode } from '@/lib/backend';
import { selectUsableModels, syncRoom, type BackendLike } from '@/lib/modelSelection';
import { useWorkspaceStore } from './workspaceStore';
import { useSessionStore } from './sessionStore';

export interface ProposalRecord {
  proposal: EditProposal;
  hunks: DiffHunk[];
  status: ProposalStatus;
  acceptedHunkIds: string[];
  /** 应用时发生版本漂移则置为 stale。 */
  staleReason?: string;
}

/** 后端连通性与真实可用性——UI 必须如实展示"现在到底是谁在回答"。 */
export interface BackendState {
  mode: 'browser-mock' | 'http';
  status: 'unknown' | 'online' | 'offline';
  hasRealProvider: boolean;
  compileEngine?: string;
  providers: { id: string; label: string; configured: boolean; models: string[] }[];
  error?: string;
}

interface ChatState {
  catalog: ModelDescriptor[];
  thread: Thread;
  proposals: Record<string, ProposalRecord>;
  activeTurnIds: string[];
  lastError?: string;
  backend: BackendState;
  /** 用户是否手动调整过阵容。没调整过时，阵容会跟随"可用模型"自动更新。 */
  roomTouched: boolean;
  transport: ChatTransport;

  probeBackend: () => Promise<void>;

  send: (prompt: string, options?: { selection?: Selection | null; intent?: ReturnType<typeof inferIntent> }) => Promise<void>;
  cancel: () => void;
  toggleParticipant: (modelId: ModelId) => void;
  setProposalDecision: (proposalId: string, acceptedHunkIds: string[], status: ProposalStatus) => void;
  applyProposal: (proposalId: string, acceptedHunkIds: string[]) => boolean;
  dismissProposal: (proposalId: string) => void;
  clearThread: () => void;
  /** 切换项目：换一条独立线程（历史互不干扰），并清掉本地消息。 */
  resetForProject: (projectId: string) => void;
  clearError: () => void;
  /** 群聊房间连接（不属于消息数据，单独放） */
  roomSocket: WebSocket | null;
  /** 远端 agent 正在回答（modelId → 开始时间），用于"xx 正在回答…"提示。 */
  remoteTyping: Record<string, number>;
  /** 提到我但我还没看的消息数（群聊头部红点）。 */
  unreadMentions: number;
  /** 当前通道：公聊（房间）或私聊（只有自己）。 */
  channel: 'room' | 'private';
  setChannel: (channel: 'room' | 'private') => void;
  /** 私聊消息（只存在本机，不落服务器）。 */
  privateMessages: ChatMessage[];
  /** 私聊会话列表（像 ChatGPT 的多条对话，避免上下文互相污染）。 */
  privateThreads: { id: string; title: string; createdAt: string }[];
  activePrivateThread: string;
  newPrivateThread: () => void;
  selectPrivateThread: (id: string) => void;
  clearUnread: () => void;
  /** 连接群聊房间：接收其他成员与 agent 的广播。 */
  connectRoom: () => void;
}

const initialThread: Thread = {
  id: 'thread-main',
  title: '论文协作群聊',
  messages: [],
  participants: DEFAULT_MODEL_CATALOG.filter((m) => m.inRoom).map((m) => m.id),
  leadModelId: 'claude-sonnet-4',
  createdAt: new Date().toISOString(),
};

/**
 * 单事件归并。抽成纯函数便于单测与回放（未来做"会话重放"时直接复用）。
 */
export function reduceEvent(state: ChatState, event: StreamEvent): Partial<ChatState> {
  const patchMessage = (messageId: string, fn: (m: ChatMessage) => ChatMessage): Partial<ChatState> => ({
    thread: {
      ...state.thread,
      messages: state.thread.messages.map((m) => (m.id === messageId ? fn(m) : m)),
    },
  });

  switch (event.type) {
    case 'turn.start':
      return { activeTurnIds: [...new Set([...state.activeTurnIds, event.turnId])], lastError: undefined };

    case 'message.start': {
      const message: ChatMessage = {
        id: event.messageId,
        threadId: state.thread.id,
        author: { kind: 'model', modelId: event.modelId, role: event.role },
        channel: activeChannel,
        privateThread: activeChannel === 'private' ? activePrivateThread : undefined,
        text: '',
        createdAt: new Date().toISOString(),
        status: 'streaming',
        replyToId: event.replyToId,
      };
      return { thread: { ...state.thread, messages: [...state.thread.messages, message] } };
    }

    case 'message.delta':
      return patchMessage(event.messageId, (m) => ({ ...m, text: m.text + event.text }));

    case 'proposal': {
      const record: ProposalRecord = {
        proposal: event.proposal,
        hunks: event.hunks,
        status: 'pending',
        acceptedHunkIds: event.hunks.map((h) => h.id),
      };
      const messagePatch = patchMessage(event.messageId, (m) => ({ ...m, proposalId: event.proposal.id }));
      return {
        ...messagePatch,
        proposals: { ...state.proposals, [event.proposal.id]: record },
      };
    }

    case 'message.end': {
      const patched = patchMessage(event.messageId, (m) => ({ ...m, status: 'done', usage: event.usage }));
      /*
       * 私聊的首轮回答结束后，用模型给会话起标题。
       * 之前的"截取首句"会得到"我是谁"这种毫无信息量的名字。
       */
      if (activeChannel === 'private') {
        const first = state.thread.messages.find(
          (m) =>
            (m.channel ?? 'room') === 'private' &&
            (m.privateThread ?? 'p-default') === activePrivateThread &&
            m.author.kind === 'user',
        );
        const answered = state.thread.messages.filter(
          (m) => (m.channel ?? 'room') === 'private' && (m.privateThread ?? 'p-default') === activePrivateThread && m.author.kind === 'model',
        ).length;
        if (first && first.author.kind === 'user' && answered <= 1) {
          const modelId = state.thread.messages.find(
            (m) => (m.channel ?? 'room') === 'private' && (m.privateThread ?? 'p-default') === activePrivateThread && m.author.kind === 'model',
          );
          const mid = modelId?.author.kind === 'model' ? modelId.author.modelId : undefined;
          if (mid) {
            void generateTitle(first.text, mid).then((title) => {
              if (!title) return;
              useChatStore.setState((current) => ({
                privateThreads: current.privateThreads.map((t) =>
                  t.id === activePrivateThread ? { ...t, title } : t,
                ),
              }));
            });
          }
        }
      }
      return patched;
    }

    case 'message.error':
      return patchMessage(event.messageId, (m) => ({ ...m, status: 'error', error: event.message }));

    case 'system': {
      const message: ChatMessage = {
        id: `sys-${Date.now()}-${state.thread.messages.length}`,
        threadId: state.thread.id,
        author: { kind: 'system', label: event.label },
        text: event.text,
        createdAt: new Date().toISOString(),
        status: 'done',
      };
      return { thread: { ...state.thread, messages: [...state.thread.messages, message] } };
    }

    case 'turn.end':
      return {
        activeTurnIds: state.activeTurnIds.filter((id) => id !== event.turnId),
        lastError: event.status === 'error' ? '本轮生成失败，请检查后端配置或网络。' : state.lastError,
      };

    default:
      return {};
  }
}

/** 每个页面一个随机 id：用来告诉服务端"这条广播别发回给我"（我有 SSE）。 */
const CLIENT_ID = Math.random().toString(36).slice(2, 10);

/**
 * 当前发送通道。`reduceEvent` 是纯函数、拿不到 store，
 * 所以用这个模块级变量把"这条消息属于哪个通道"带进去。
 */
let activeChannel: 'room' | 'private' = 'room';
/** 当前私聊会话 id：给新消息打标，用于多私聊对话隔离。 */
let activePrivateThread = 'p-default';

/** 私聊消息的本地存储键：私聊历史只存在这台机器上，不落服务器。 */
const PRIVATE_STORE_KEY = 'pf.privateMessages.v1';
/** 私聊会话列表（含当前会话）：刷新后仍保留多条对话。 */
const PRIVATE_THREADS_KEY = 'pf.privateThreads.v1';

interface PrivateThreadMeta {
  id: string;
  title: string;
  createdAt: string;
}

function loadPrivateThreads(): { threads: PrivateThreadMeta[]; active: string } {
  try {
    const raw = localStorage.getItem(PRIVATE_THREADS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { threads?: PrivateThreadMeta[]; active?: string };
      if (parsed.threads?.length) {
        return { threads: parsed.threads, active: parsed.active ?? parsed.threads[0]!.id };
      }
    }
  } catch {
    /* 解析失败就当没有 */
  }
  return { threads: [{ id: 'p-default', title: '默认对话', createdAt: new Date().toISOString() }], active: 'p-default' };
}

/** 读取本地保存的私聊消息（解析失败就当没有）。 */
function loadPrivateMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(PRIVATE_STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(parsed) ? parsed.filter((m) => m.channel === 'private') : [];
  } catch {
    return [];
  }
}

/**
 * 让模型给私聊会话起个短标题。
 *
 * 关键：用 `channel: 'private'` + 空 history + 独立线程 id——
 * 这样不广播、不写服务器历史、也不进入任何会话的上下文，
 * 纯粹借一次模型调用来"概括主题"。
 */
async function generateTitle(text: string, modelId: string): Promise<string | null> {
  try {
    const res = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: `title-${Date.now().toString(36)}`,
        prompt: `用不超过 10 个字概括下面这段对话的主题，只输出标题本身，不要引号、不要解释：\n\n${text.slice(0, 400)}`,
        participants: [modelId],
        clientId: `title-${Date.now().toString(36)}`,
        clientMessageId: `t-${Date.now().toString(36)}`,
        channel: 'private',
        history: [],
      }),
    });
    const dec = new TextDecoder();
    let buf = '';
    let out = '';
    if (!res.body) return null;
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value;
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5)) as { type: string; text?: string };
          if (event.type === 'message.delta' && event.text) out += event.text;
        } catch {
          /* 忽略半包 */
        }
      }
    }
    const clean = out.replace(/["“”'\n]/g, ' ').replace(/\s+/g, ' ').trim();
    return clean.slice(0, 16) || null;
  } catch {
    return null;
  }
}

export const useChatStore = create<ChatState>()((set, get) => {
  const bundle = createTransport({
    getContext: () => useWorkspaceStore.getState().context,
    getDocumentContent: () => useWorkspaceStore.getState().activeFile().content,
  });
  const transport = bundle.transport;

  return {
    catalog: DEFAULT_MODEL_CATALOG,
    thread: { ...initialThread, messages: loadPrivateMessages() },
    roomSocket: null,
    remoteTyping: {},
    unreadMentions: 0,
    channel: 'room',
    privateMessages: [],
    privateThreads: loadPrivateThreads().threads,
    activePrivateThread: loadPrivateThreads().active,
    newPrivateThread: () =>
      set((state) => {
        const id = `p-${Date.now().toString(36)}`;
        const createdAt = new Date().toISOString();
        return {
          privateThreads: [{ id, title: `对话 ${state.privateThreads.length + 1}`, createdAt }, ...state.privateThreads],
          activePrivateThread: id,
        };
      }),
    selectPrivateThread: (id) => set({ activePrivateThread: id }),
    setChannel: (channel) => {
      set({ channel });
      // 换通道后模型列表不一样（私聊多出"我的模型"），要重新拉一次
      void get().probeBackend();
    },
    proposals: {},
    activeTurnIds: [],
    roomTouched: false,
    backend: {
      // 始终先按"可能连得上后端"启动，由 probeBackend() 在挂载时确认。
      mode: transport.kind === 'http' ? 'http' : 'browser-mock',
      status: transport.kind === 'http' ? 'unknown' : 'online',
      hasRealProvider: false,
      providers: [],
    },
    transport,

    /**
     * 探测后端：拿到真实的"哪个厂商配好了 Key"，并同步模型目录的可用性。
     * 没有这一步，界面就只能猜——而"猜"会让用户以为自己在用真模型。
     */
    probeBackend: async () => {
      if (get().transport.kind !== 'http') return;
      try {
        // 按通道拉模型：公聊只列公用，私聊列公用 + 我的
        const res = await fetch(`${API_BASE}/api/models?channel=${get().channel}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as {
          models: ModelDescriptor[];
          providers: BackendState['providers'];
          hasRealProvider: boolean;
          compileEngine: string;
        };
        setBackendMode('http');
        set((state) => {
          const backend: BackendLike = { mode: 'http', status: 'online' };
          const usable = selectUsableModels(payload.models, backend);
          return {
            catalog: payload.models,
            backend: {
              mode: 'http',
              status: 'online',
              hasRealProvider: payload.hasRealProvider,
              compileEngine: payload.compileEngine,
              providers: payload.providers,
            },
            thread: {
              ...state.thread,
              // 阵容跟随可用模型：配了新 Key（或删了旧 Key）后自动对齐
              participants: syncRoom(state.thread.participants, usable, state.roomTouched),
            },
          };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '无法连接编排服务';
        // 没有显式配置 API_BASE 时，"后端没起来"是完全正常的：静默退回浏览器内 mock，
        // 而不是给用户报一个他无法理解的"后端离线"。这正是零配置 `npm run dev:web` 的场景。
        if (bundle.autoDetect) {
          setBackendMode('browser-mock');
          set({
            transport: bundle.mockFallback,
            backend: { mode: 'browser-mock', status: 'online', hasRealProvider: false, providers: [] },
          });
          return;
        }
        setBackendMode('browser-mock');
        set((state) => ({ backend: { ...state.backend, status: 'offline', error: message } }));
      }
    },

    /**
   * 连接群聊房间：其他用户的发言、以及 agent 的回复，都以广播形式进来。
   *
   * 发起者自己走 SSE（不带 clientId 参数），所以不会重复。
   */
  clearUnread: () => set({ unreadMentions: 0 }),

  connectRoom: () => {
    const projectId = useWorkspaceStore.getState().activeProjectId;
    if (!projectId) return;
    const existing = get().roomSocket;
    if (existing) existing.close();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/room?project=${encodeURIComponent(projectId)}&client=${CLIENT_ID}`,
    );
    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as
          | { type: 'chat.user'; messageId: string; text: string; authorName?: string }
          | { type: 'chat.agent'; event: StreamEvent };
        if (payload.type === 'chat.agent') {
          const event = payload.event;
          /*
           * 通道必须来自**广播本身**。
           * 之前用的是本机当前通道：赵六在公聊唤起的回答，会被正在看私聊的人
           * 打上 private 标签（跑到私聊里），而公聊里看不到这条回答。
           */
          activeChannel = (payload as { channel?: 'room' | 'private' }).channel ?? 'room';
          const patch = reduceEvent(get(), event);
          set(patch as ChatState);
          // "xx 正在回答…"：开始回答时登记，结束时清除
          if (event.type === 'message.start') {
            const modelId = event.modelId;
            set((state) => ({ remoteTyping: { ...state.remoteTyping, [modelId]: Date.now() } }));
          } else if (event.type === 'message.end') {
            // 这条消息属于哪个模型：从消息列表里查
            const finished = get().thread.messages.find((m) => m.id === event.messageId);
            const modelId = finished?.author.kind === 'model' ? finished.author.modelId : undefined;
            if (modelId) {
              set((state) => {
                const next = { ...state.remoteTyping };
                delete next[modelId];
                return { remoteTyping: next };
              });
            }
          }
          return;
        }
        if (payload.type === 'chat.user') {
          const state = get();
          if (state.thread.messages.some((m) => m.id === payload.messageId)) return;
          const message: ChatMessage = {
            id: payload.messageId,
            threadId: state.thread.id,
            // remote=true：别人的发言 → 左对齐、显示名字（像微信群聊）
            author: { kind: 'user', name: payload.authorName, remote: true },
            text: payload.text,
            createdAt: new Date().toISOString(),
            status: 'done',
          };
          const myName = useSessionStore.getState().me?.displayName;
          const mentionsMe = Boolean(myName && new RegExp(`@\\s*${myName}`).test(payload.text));
          set({
            thread: { ...state.thread, messages: [...state.thread.messages, message] },
            unreadMentions: mentionsMe ? state.unreadMentions + 1 : state.unreadMentions,
          });
        }
      } catch {
        /* 广播不是关键路径：解析失败就忽略这一条 */
      }
    };
    set({ roomSocket: ws });
  },

  send: async (prompt, options) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      // 记录本次发送的通道：私聊不广播、不落公共历史
      activeChannel = get().channel;
      activePrivateThread = get().activePrivateThread;
      /*
       * 首条消息自动命名会话：默认的"对话 2"毫无信息量，
       * 用这句话的前 18 个字当标题，历史列表才看得懂。
       */
      if (activeChannel === 'private') {
        const hasAny = get().thread.messages.some(
          (m) => (m.channel ?? 'room') === 'private' && (m.privateThread ?? 'p-default') === activePrivateThread,
        );
        if (!hasAny) {
          const placeholder =
            trimmed
              .replace(/\s+/g, ' ')
              // 去掉"帮我/请/能不能"这类口头禅，剩下的更像标题
              .replace(/^(帮我|帮忙|请|麻烦|能不能|可以|我想|我要)+/g, '')
              .replace(/[，。！？,.!?]/g, ' ')
              .trim()
              .slice(0, 16) || '新对话';
          set((state) => ({
            privateThreads: state.privateThreads.map((t) =>
              t.id === activePrivateThread && /^(对话 \d+|默认对话)$/.test(t.title) ? { ...t, title: placeholder } : t,
            ),
          }));
        }
      }

      /*
       * 「@ 人」和「@ 模型」要分开。
       *
       * 之前任何 `@xxx` 都会被当成叫模型：用户想跟"李四"说话，结果模型跳出来回答。
       * 现在的规则很简单、也符合直觉：
       *   - `@` 后面是已知的模型（id 或显示名）→ 叫模型回答
       *   - `@` 后面**不是任何模型** → 当成 @ 人类成员，只广播到房间，**不触发任何 AI**
       *   - 两者都有 → 模型照常回答（人那边只是被提到）
       */
      const mentionNames = [...trimmed.matchAll(/@([\w\u4e00-\u9fa5.-]+)/g)].map((m) => m[1]!.toLowerCase());
      const modelAliases = new Set(
        get().catalog.flatMap((m) => [m.id.toLowerCase(), (m.label ?? '').toLowerCase()]).filter(Boolean),
      );
      const mentionsModel = mentionNames.some((name) => modelAliases.has(name));
      const humanMentions = mentionNames.filter((name) => !modelAliases.has(name));
      /** `@all` / `@全体` / `@所有模型` / `@all-ai`：叫房间里所有模型。 */
      const mentionsAllAI = mentionNames.some((n) => ['all', 'all-ai', '全体', '全体模型', '所有模型'].includes(n));
      /*
       * 只有这两种情况才叫模型：
       *   1. 显式 @ 了某个模型，或 @all（叫全体）
       *   2. 工具栏的"评审/压缩/润色"等动作（带 intent，本来就是让 AI 干活）
       * 其余一律只发给人 —— 用户不 @ 任何模型时，AI 不应该自己跳出来。
       */
      const shouldAskModel = Boolean(options?.intent) || mentionsModel || mentionsAllAI;

      if (!shouldAskModel) {
        // 只是叫人：把这条消息发给房间成员，不调用任何模型
        const workspaceState = useWorkspaceStore.getState();
        const message: ChatMessage = {
          id: `user-${Date.now()}`,
          threadId: get().thread.id,
          author: { kind: 'user' },
          text: trimmed,
          createdAt: new Date().toISOString(),
          status: 'done',
        };
        set((state) => ({ thread: { ...state.thread, messages: [...state.thread.messages, message] } }));
        void fetch(apiUrl('/api/room/message'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: workspaceState.activeProjectId,
            // 必须和 /api/chat 用的是同一个线程，否则人说的话进不了模型的历史
            threadId: get().thread.id,
            clientId: CLIENT_ID,
            messageId: message.id,
            text: trimmed,
            mentions: humanMentions,
            authorName: useSessionStore.getState().me?.displayName,
          }),
        }).catch(() => undefined);
        return;
      }

      const workspace = useWorkspaceStore.getState();
      const selection = options?.selection !== undefined ? options.selection : workspace.selection;
      const activeFile = workspace.activeFile();
      // 项目主文档：论文正文用它。用户问"解析一下项目里的文章"时，
      // 应该给出整篇论文，而不是恰好开着的那个标签页。
      const mainFile = workspace.document.files[workspace.rootPath] ?? activeFile;
      const intent = options?.intent ?? inferIntent(trimmed);

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        threadId: get().thread.id,
        author: { kind: 'user', name: useSessionStore.getState().me?.displayName },
      channel: activeChannel,
        text: trimmed,
        createdAt: new Date().toISOString(),
        status: 'done',
        mentions: get().catalog
          .filter((m) => trimmed.includes(`@${m.id}`) || trimmed.includes(`@${m.family}`))
          .map((m) => ({ raw: `@${m.id}`, modelId: m.id })),
        selection: selection ?? undefined,
      };

      set((state) => ({ thread: { ...state.thread, messages: [...state.thread.messages, userMessage] } }));

      const quoted = useComposerStore.getState().quoted;
      const request: ChatTurnRequest = {
        threadId: get().thread.id,
        projectId: useWorkspaceStore.getState().activeProjectId || undefined,
        prompt: trimmed,
        ...(quoted ? { quotedMessageId: quoted.messageId } : {}),
        selection: selection ?? undefined,
        intent,
        participants: get().thread.participants,
        clientMessageId: userMessage.id,
        clientId: CLIENT_ID,
        channel: activeChannel,
        /*
         * 私聊的消息不落服务器，所以历史要前端自己带过去，
         * 否则模型看不到之前（尤其是别的 agent）说了什么，引用也会失效。
         */
        history:
          activeChannel === 'private'
            ? get()
                .thread.messages.filter((m) => (m.channel ?? 'room') === 'private' && m.text.trim())
                .slice(-40)
                .map((m) =>
                  m.author.kind === 'model'
                    ? { authorKind: 'model' as const, name: m.author.modelId, text: m.text }
                    : { authorKind: 'user' as const, name: m.author.kind === 'user' ? m.author.name : undefined, text: m.text },
                )
            : undefined,
        document: { fileId: activeFile.id, content: activeFile.content, version: activeFile.version },
        mainFile: {
          fileId: mainFile.id,
          path: mainFile.path,
          content: mainFile.content,
          version: mainFile.version,
        },
      };

      if (quoted) useComposerStore.getState().clearQuote();

      const wasPrivate = activeChannel === 'private';
      const threadKey = activePrivateThread;

      await get().transport.send(request, (event) => {
        set((state) => reduceEvent(state, event));
      });

      /*
       * 私聊第一轮结束后，用模型起标题（放这里而不是 reducer：
       * reducer 必须是纯函数，之前放里面没有生效）。
       */
      if (wasPrivate) {
        const msgs = get().thread.messages.filter(
          (m) => (m.channel ?? 'room') === 'private' && (m.privateThread ?? 'p-default') === threadKey,
        );
        const firstUser = msgs.find((m) => m.author.kind === 'user');
        const firstModel = msgs.find((m) => m.author.kind === 'model');
        const alreadyNamed = get().privateThreads.find((t) => t.id === threadKey)?.title;
        const autoNamed = !alreadyNamed || /^(对话 \d+|默认对话|.*\u2026?)$/.test(alreadyNamed) || alreadyNamed.length >= 14;
        if (firstUser?.author.kind === 'user' && firstModel?.author.kind === 'model' && autoNamed) {
          const title = await generateTitle(firstUser.text, firstModel.author.modelId);
          if (title) {
            set((state) => ({
              privateThreads: state.privateThreads.map((t) =>
                t.id === threadKey ? { ...t, title } : t,
              ),
            }));
          }
        }
      }
    },

    cancel: () => {
      for (const turnId of get().activeTurnIds) get().transport.cancel(turnId);
      set({ activeTurnIds: [] });
    },

    toggleParticipant: (modelId) =>
      set((state) => {
        const isIn = state.thread.participants.includes(modelId);
        const participants = isIn
          ? state.thread.participants.filter((id) => id !== modelId)
          : [...state.thread.participants, modelId];
        return {
          // 标记为"用户已经手动选过阵容"，之后不再自动覆盖他的选择
          roomTouched: true,
          thread: { ...state.thread, participants },
          catalog: state.catalog.map((m) => (m.id === modelId ? { ...m, inRoom: !isIn } : m)),
        };
      }),

    setProposalDecision: (proposalId, acceptedHunkIds, status) =>
      set((state) => {
        const record = state.proposals[proposalId];
        if (!record) return state;
        return {
          proposals: {
            ...state.proposals,
            [proposalId]: { ...record, acceptedHunkIds, status },
          },
        };
      }),

    applyProposal: (proposalId, acceptedHunkIds) => {
      const record = get().proposals[proposalId];
      if (!record) return false;

      const ok = useWorkspaceStore.getState().applyProposal(record.proposal, record.hunks, acceptedHunkIds);
      if (!ok) {
        set((state) => ({
          proposals: {
            ...state.proposals,
            [proposalId]: {
              ...record,
              status: 'stale',
              staleReason: '文档在该提议生成后已被修改，diff 已过期。请让模型基于当前版本重新生成。',
            },
          },
        }));
        return false;
      }

      const total = record.hunks.length;
      const accepted = acceptedHunkIds.length;
      const status: ProposalStatus = accepted === 0 ? 'rejected' : accepted === total ? 'accepted' : 'partial';
      set((state) => ({
        proposals: { ...state.proposals, [proposalId]: { ...record, acceptedHunkIds, status } },
        lastError: undefined,
      }));
      return true;
    },

    dismissProposal: (proposalId) => {
      const record = get().proposals[proposalId];
      if (!record) return;
      useWorkspaceStore.getState().setHighlightRange(null);
      set((state) => ({
        proposals: { ...state.proposals, [proposalId]: { ...record, status: 'rejected' } },
      }));
    },

    resetForProject: (projectId) =>
      set((state) => ({
        // 线程 id 用项目 id：服务端会话按 threadId 存，于是各项目的历史天然隔离
        thread: { ...state.thread, id: projectId, title: projectId, messages: [] },
        proposals: {},
        activeTurnIds: [],
        lastError: undefined,
      })),

    clearThread: () => {
      const threadId = get().thread.id;
      // 必须同时清服务端历史：否则界面空了、模型还记着旧上下文，
      // 会出现"它怎么还在说我已经删掉的那段对话"。
      void fetch(apiUrl(`/api/sessions/${encodeURIComponent(threadId)}`), { method: 'DELETE' }).catch(
        () => undefined,
      );
      set((state) => ({
        thread: { ...state.thread, messages: [], createdAt: new Date().toISOString() },
        proposals: {},
        activeTurnIds: [],
        lastError: undefined,
      }));
    },

    clearError: () => set({ lastError: undefined }),
  };
});

/*
 * 私聊消息落本地：只在浏览器里保存，服务器从不收到这条历史。
 * 公聊消息不存本地（它本来就在服务器上，换设备也能看到）。
 */
useChatStore.subscribe((state) => {
  try {
    const priv = state.thread.messages.filter((m) => m.channel === 'private').slice(-200);
    localStorage.setItem(PRIVATE_STORE_KEY, JSON.stringify(priv));
    localStorage.setItem(
      PRIVATE_THREADS_KEY,
      JSON.stringify({ threads: state.privateThreads, active: state.activePrivateThread }),
    );
  } catch {
    /* 存储满了/被禁用就跳过，不影响聊天 */
  }
});
