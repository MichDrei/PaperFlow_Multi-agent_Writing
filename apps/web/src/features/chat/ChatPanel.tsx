/**
 * 右侧多模型群聊面板：阵容 + 消息流 + 输入框。
 *
 * 一条线程里混排"人"和"多个模型"的发言，并允许模型之间交叉点评，
 * 这是本产品区别于普通 Chat 的核心：协作发生在同一个上下文里。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Eraser, MessagesSquare, Radio, Sparkles } from 'lucide-react';
import { Button, EmptyState, IconButton, Pill } from '@paperflow/ui';
import { useChatStore } from '@/stores/chatStore';
import { useComposerStore } from '@/stores/composerStore';
import { MessageBubble } from './MessageBubble';
import { useSessionStore } from '@/stores/sessionStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { ModelRoster } from './ModelRoster';
import { Composer } from './Composer';

const SUGGESTIONS = [
  { label: '评审 Introduction', prompt: '@all 审一下 Introduction 的论证强度' },
  { label: '压缩摘要', prompt: '@claude 把摘要压缩 30%，保留全部数值' },
  { label: '核对术语', prompt: '@gemini 检查全文术语是否与术语表一致' },
  { label: '补引用', prompt: '@gpt-4o 找出缺少 \\cite 的强结论句' },
];

export function ChatPanel() {
  const messages = useChatStore((s) => s.thread.messages);
  const myName = useSessionStore((s) => s.me?.displayName);
  /** 群聊筛选：默认全部；@我 / 只看成员 / 只看 Agent。 */
  const [filter, setFilter] = useState<'all' | 'mention' | 'human' | 'agent'>('all');
  const [search, setSearch] = useState('');
  const channel = useChatStore((s) => s.channel);
  const setChannel = useChatStore((s) => s.setChannel);
  /** 项目是否已进入协作（有人被批准加入后为 true）。 */
  const collabProject = useWorkspaceStore((s) => {
    const meta = s.projects.find((p) => p.id === s.activeProjectId);
    return Boolean(meta?.collab);
  });
  // 单人项目只允许私聊：一旦从协作切回单人，自动落回私聊
  useEffect(() => {
    if (!collabProject && channel === 'room') setChannel('private');
  }, [collabProject, channel, setChannel]);
  const unreadMentions = useChatStore((s) => s.unreadMentions);
  const clearUnread = useChatStore((s) => s.clearUnread);
  const remoteTyping = useChatStore((s) => s.remoteTyping);
  const presence = usePresenceStore((s) => s.members);
  const activeTurns = useChatStore((s) => s.activeTurnIds);
  const lastError = useChatStore((s) => s.lastError);
  const clearThread = useChatStore((s) => s.clearThread);
  const clearError = useChatStore((s) => s.clearError);
  const catalog = useChatStore((s) => s.catalog);
  const setDraftAndFocus = useComposerStore((s) => s.setDraftAndFocus);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const streamingCount = useMemo(() => messages.filter((m) => m.status === 'streaming').length, [messages]);

  // 新的增量到达时，仅当用户仍停留在底部附近才自动滚动（不打断向上翻阅）。
  const tail = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const tailLength = tail?.text.length ?? 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, tailLength, activeTurns.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const visible = messages.filter((message) => {
    // 通道过滤：私聊只在"私聊"里显示，公聊只在"公聊"里显示
    if ((message.channel ?? 'room') !== channel) return false;
    // 关键词搜索（不区分大小写，匹配正文与发言人）
    const q = search.trim().toLowerCase();
    if (q) {
      const author =
        message.author.kind === 'model'
          ? message.author.modelId
          : message.author.kind === 'user'
            ? (message.author.name ?? '')
            : message.author.label;
      const haystack = `${message.text} ${author}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filter === 'all') return true;
    const isAgent = message.author.kind === 'model' || message.author.kind === 'system';
    if (filter === 'agent') return isAgent;
    if (filter === 'human') return message.author.kind === 'user';
    // @我：消息里出现了我的名字（大小写不敏感，容错空格）
    if (!myName) return false;
    return new RegExp(`@\\s*${myName}`).test(message.text);
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-900">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-ink-800 px-2.5">
        <MessagesSquare className="size-3.5 text-brand-400" />
        <span className="text-[11px] font-semibold tracking-wide text-ink-200 uppercase">多模型群聊</span>
        {activeTurns.length > 0 ? (
          <Pill accent="#4f8cff">
            <Radio className="size-2.5" />
            {streamingCount} 个模型正在生成
          </Pill>
        ) : (
          <span className="text-[10.5px] text-ink-500">{catalog.filter((m) => m.inRoom).length} 个模型待命</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            size="xs"
            title="清空会话"
            icon={<Eraser className="size-3" />}
            onClick={clearThread}
          />
        </div>
      </header>

      <ModelRoster />

      <div className="flex items-center gap-1.5 border-b border-ink-850 px-2 py-1">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索消息…"
          className="min-w-0 flex-1 rounded border border-ink-750 bg-ink-850 px-1.5 py-0.5 text-[10.5px] text-ink-100 placeholder:text-ink-600 focus:border-brand-600/60 focus:outline-none"
        />
        {search && (
          <button type="button" onClick={() => setSearch('')} className="text-[10px] text-ink-500 hover:text-ink-200">
            清除
          </button>
        )}
      </div>

      {collabProject && presence.length > 0 && (
        <div className="flex items-center gap-1.5 border-b border-ink-850 px-3 py-1">
          <span className="text-[9.5px] text-ink-600">在线</span>
          {presence.map((member) => (
            <span key={member.id} className="flex items-center gap-1 text-[10px] text-ink-400" title={member.name}>
              <span className="size-1.5 rounded-full" style={{ background: member.color }} />
              {member.name}
              {member.self && <span className="text-ink-600">(你)</span>}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-ink-850 px-2 py-1">
        <button
          type="button"
          onClick={() => collabProject && setChannel('room')}
          disabled={!collabProject}
          className={`rounded px-1.5 py-0.5 text-[10.5px] ${
            !collabProject
              ? 'cursor-not-allowed text-ink-600 opacity-50'
              : channel === 'room'
                ? 'bg-brand-500/20 text-brand-300'
                : 'text-ink-500 hover:text-ink-200'
          }`}
          title={collabProject ? '公聊：全组可见，用服务器配置的模型' : '这个项目还是单人模式：邀请成员并有人加入后才会开启公聊'}
        >
          公聊
        </button>
        <button
          type="button"
          onClick={() => setChannel('private')}
          className={`rounded px-1.5 py-0.5 text-[10.5px] ${
            channel === 'private' ? 'bg-accent-purple/20 text-accent-purple' : 'text-ink-500 hover:text-ink-200'
          }`}
          title="私聊：只有你自己能看到，不会广播给别人"
        >
          私聊
        </button>
        <span className="mx-1 h-3 w-px bg-ink-750" />
      </div>
      <div className="flex items-center gap-1 border-b border-ink-850 px-2 py-1">
        {(
          [
            ['all', '全部'],
            ['mention', '@我'],
            ['human', '只看成员'],
            ['agent', '只看 Agent'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setFilter(key);
              if (key === 'mention') clearUnread();
            }}
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              filter === key
                ? 'bg-brand-500/20 text-brand-300'
                : 'text-ink-500 hover:bg-ink-850 hover:text-ink-200'
            }`}
          >
            {label}
            {key === 'mention' && unreadMentions > 0 && (
              <span className="ml-1 rounded-full bg-accent-red px-1 text-[9px] text-white">{unreadMentions}</span>
            )}
          </button>
        ))}
      </div>

      {Object.keys(remoteTyping).length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1 text-[10.5px] text-ink-400">
          <span className="flex gap-0.5">
            <span className="size-1 animate-pulse rounded-full bg-brand-400" />
            <span className="size-1 animate-pulse rounded-full bg-brand-400 [animation-delay:150ms]" />
            <span className="size-1 animate-pulse rounded-full bg-brand-400 [animation-delay:300ms]" />
          </span>
          {Object.keys(remoteTyping).join('、')} 正在回答…
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-2">
        {visible.length === 0 ? (
          <EmptyState
            icon={<Bot className="size-7" />}
            title="把多个模型拉进同一个房间"
            hint="在左侧选中一段 LaTeX，然后点浮动工具栏的「压缩 / 润色 / 改写 / 评审」，或在下方直接 @ 某个模型。"
          />
        ) : (
          visible.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>

      {messages.length === 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => setDraftAndFocus(s.prompt)}
              className="flex items-center gap-1 rounded-full border border-ink-750 bg-ink-850 px-2 py-[3px] text-[10.5px] text-ink-300 transition-colors hover:border-brand-600/50 hover:text-brand-300"
            >
              <Sparkles className="size-2.5 text-brand-400" />
              {s.label}
            </button>
          ))}
        </div>
      )}

      {lastError && (
        <div className="mx-2.5 mb-1.5 flex items-center gap-2 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-2 py-1.5 text-[11px] text-accent-rose">
          <span className="flex-1">{lastError}</span>
          <Button size="xs" variant="ghost" onClick={clearError}>
            知道了
          </Button>
        </div>
      )}

      <Composer />
    </div>
  );
}
