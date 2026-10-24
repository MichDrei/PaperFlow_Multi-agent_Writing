/**
 * 单条消息。三类作者：用户 / 模型 / 系统旁白。
 *
 * 模型消息支持"流式尾部光标"，并在结尾展示真实用量；
 * 若该消息附带了编辑提议，直接在气泡下方内联 Diff 卡片。
 */

import { memo } from 'react';
import { AtSign, CornerDownRight, Quote, Reply, Sparkles, Terminal } from 'lucide-react';
import { AGENT_PROFILES, type ChatMessage } from '@paperflow/core';
import { Avatar, Dot } from '@paperflow/ui';
import { Markdown } from '@/lib/markdown';
import { useChatStore } from '@/stores/chatStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useComposerStore } from '@/stores/composerStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { DiffCard } from './DiffCard';

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * 把正文里的 `@某人` 渲染成胶囊。
 *
 * 做法：转成 markdown 行内代码（`` `@李四` ``），复用 `.pf-prose code` 的样式。
 * 比手工拼 HTML 稳：Markdown 渲染器会自动转义，也不会破坏原有格式。
 */
function withMentionChips(text: string): string {
  return text.replace(/(^|\s)@([\w\u4e00-\u9fa5.-]+)/g, (_m: string, lead: string, name: string) => `${lead}\`@${name}\``);
}

export const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const catalog = useChatStore((s) => s.catalog);
  const appendMention = useComposerStore((s) => s.appendMention);
  const quoteAnswer = useComposerStore((s) => s.quoteAnswer);
  const reveal = useWorkspaceStore((s) => s.reveal);

  if (message.author.kind === 'system') {
    return (
      <div className="pf-enter flex items-center gap-2 px-3 py-1">
        <span className="h-px flex-1 bg-ink-800" />
        <span className="flex items-center gap-1.5 text-[10.5px] text-ink-500">
          <Terminal className="size-3" />
          <span className="font-medium text-ink-400">{message.author.label}</span>
          {message.text}
        </span>
        <span className="h-px flex-1 bg-ink-800" />
      </div>
    );
  }

  if (message.author.kind === 'user') {
    /*
     * 像微信群聊那样区分左右：
     * · 自己的发言 → 右对齐（不显示名字，自己认得）
     * · 别人的发言 → 左对齐 + 气泡上方显示发送者名字
     * 之前所有 user 消息都右对齐，导致"只看成员"时别人的话全挤在右边。
     */
    const remote = message.author.remote === true;
    const authorName = message.author.name;
    // 这条消息是否 @ 了我：是的话整条气泡加描边 + "@你" 徽标
    const myName = useSessionStore.getState().me?.displayName;
    const mentionedMe = Boolean(myName && new RegExp(`@\\s*${myName}`).test(message.text));
    return (
      <div
        className={`pf-enter flex flex-col gap-1 px-3 py-1.5 ${remote ? 'items-start' : 'items-end'}`}
      >
        {remote && authorName && (
          <span className="pl-1 text-[10.5px] text-ink-500">{authorName}</span>
        )}
        {/* 人的消息也能"引用"：引用后下一个模型会读到这条原文（微信群聊式） */}
        <button
          type="button"
          title="引用这条消息：下一个模型能直接读到它"
          onClick={() =>
            quoteAnswer({
              messageId: message.id,
              modelId: undefined,
              preview: message.text.replace(/\s+/g, ' ').slice(0, 80),
            })
          }
          className="flex items-center gap-0.5 rounded px-1 py-[2px] text-[10px] text-ink-600 hover:bg-brand-500/15 hover:text-brand-300"
        >
          <Reply className="size-2.5" />
          引用
        </button>
        {mentionedMe && remote && (
          <span className="rounded-full bg-accent-amber/20 px-1.5 py-0.5 text-[9.5px] text-accent-amber">@你</span>
        )}
        <div
          className={`max-w-[86%] rounded-2xl px-3 py-2 ${
            remote
              ? `rounded-bl-sm border ${mentionedMe ? 'border-accent-amber/60 bg-accent-amber/10' : 'border-ink-700 bg-ink-850'}`
              : 'rounded-br-sm border border-brand-600/40 bg-brand-500/12'
          }`}
        >
          <Markdown text={withMentionChips(message.text)} className="pf-prose text-ink-100" />
        </div>
        {message.selection && (
          <button
            type="button"
            onClick={() => reveal(message.selection!.start.line)}
            title="跳转到该选区"
            className="flex max-w-[86%] items-center gap-1 rounded-md border border-ink-750 bg-ink-900 px-1.5 py-0.5 text-[10.5px] text-ink-400 hover:border-ink-600 hover:text-ink-200"
          >
            <Quote className="size-2.5" />
            附带选区 L{message.selection.start.line}–{message.selection.end.line} ·{' '}
            {message.selection.text.replace(/\s+/g, ' ').slice(0, 46)}
            {message.selection.text.length > 46 ? '…' : ''}
          </button>
        )}
        <span className="pr-1 text-[10px] text-ink-600">{timeOf(message.createdAt)}</span>
      </div>
    );
  }

  const author = message.author;
  const model = catalog.find((m) => m.id === author.modelId);
  const profile = AGENT_PROFILES[author.role];
  const accent = model?.accent ?? '#64748b';
  const streaming = message.status === 'streaming';

  return (
    <div className="pf-enter group flex gap-2.5 px-3 py-2 hover:bg-ink-900/40">
      <Avatar
        initials={model?.initials ?? '??'}
        accent={accent}
        size={26}
        ring
        title={model?.label ?? author.modelId}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold" style={{ color: accent }}>
            {model?.label ?? author.modelId}
          </span>
          <span
            className="rounded px-1 py-[1px] text-[9.5px] font-medium"
            style={{ background: `${profile.accent}1f`, color: profile.accent }}
          >
            {profile.label}
          </span>
          {message.replyToId && (
            <span className="flex items-center gap-0.5 text-[10px] text-ink-500">
              <CornerDownRight className="size-2.5" />
              回复上文
            </span>
          )}
          {streaming && <Dot accent={accent} pulse />}
          {message.status === 'error' && <span className="text-[10px] text-accent-rose">生成失败</span>}
          {message.status === 'done' && !message.text.trim() && (
            <span className="text-[10px] text-accent-amber">空回复</span>
          )}
          <span className="ml-auto flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              title={`在输入框 @${model?.family ?? author.modelId} 继续追问`}
              onClick={() => appendMention(author.modelId)}
              className="flex items-center gap-0.5 rounded px-1 py-[2px] text-[10px] text-ink-400 hover:bg-ink-800 hover:text-ink-200"
            >
              <AtSign className="size-2.5" />
              追问
            </button>
            <button
              type="button"
              title="引用这条回答：下一个模型会直接读到它，不需要你复制粘贴"
              onClick={() =>
                quoteAnswer({
                  messageId: message.id,
                  modelId: author.modelId,
                  preview: message.text.replace(/\s+/g, ' ').slice(0, 80),
                })
              }
              className="flex items-center gap-0.5 rounded px-1 py-[2px] text-[10px] text-ink-400 hover:bg-brand-500/15 hover:text-brand-300"
            >
              <Reply className="size-2.5" />
              引用
            </button>
          </span>
        </div>

        <div className={streaming ? 'pf-caret' : undefined}>
          {message.text ? (
            <Markdown text={withMentionChips(message.text)} />
          ) : message.status === 'error' ? (
            // 之前这里会一直显示"正在思考…"，把真正的失败原因藏起来，
            // 让人误以为"模型没回复"。失败就要说清失败在哪。
            <div className="my-1 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-2 py-1.5 text-[11px] leading-relaxed text-accent-rose">
              <span className="font-medium">该模型本轮未返回内容。</span>
              {message.error && <span className="ml-1 opacity-90">{message.error}</span>}
            </div>
          ) : (
            <span className="flex items-center gap-1.5 py-1 text-[11px] text-ink-500">
              <Sparkles className="size-3 animate-pulse text-brand-400" />
              正在思考…
            </span>
          )}
        </div>

        {message.proposalId && <DiffCard proposalId={message.proposalId} />}

        <div className="mt-1 flex items-center gap-2 text-[10px] text-ink-600">
          <span>{timeOf(message.createdAt)}</span>
          {message.usage && (
            <span className="font-mono">
              ↑{message.usage.promptTokens} ↓{message.usage.completionTokens}
              {message.usage.latencyMs ? ` · ${(message.usage.latencyMs / 1000).toFixed(1)}s` : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
