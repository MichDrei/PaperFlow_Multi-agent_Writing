/**
 * 群聊输入框：@提及自动补全 + 选区附件 + 意图选择。
 *
 * 交互细节都对齐 Cursor / Slack 的习惯：
 * - 输入 @ 弹出模型候选，↑↓ 选择、Enter/Tab 确认、Esc 关闭；
 * - Enter 发送、Shift+Enter 换行、⌘/Ctrl+Enter 强制发送；
 * - 编辑器里的选区会自动变成一枚可移除的上下文附件。
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AtSign, CornerDownLeft, Loader2, Quote, Reply, Send, Square, X } from 'lucide-react';
import {
  activeMentionQuery,
  filterCatalog,
  type EditIntent,
  type ModelDescriptor,
} from '@paperflow/core';
import { Avatar, Button, IconButton } from '@paperflow/ui';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { selectUsableModels } from '@/lib/modelSelection';
import { useComposerStore } from '@/stores/composerStore';
import { apiUrl } from '@/lib/backend';
import { INTENT_ACTIONS } from '@/lib/intent';

export function Composer() {
  const draft = useComposerStore((s) => s.draft);
  // @ 候选只列本项目的成员（单人项目里就只有自己）
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const setDraft = useComposerStore((s) => s.setDraft);
  const focusToken = useComposerStore((s) => s.focusToken);

  const send = useChatStore((s) => s.send);
  const cancel = useChatStore((s) => s.cancel);
  const busy = useChatStore((s) => s.activeTurnIds.length > 0);
  const catalog = useChatStore((s) => s.catalog);
  const backend = useChatStore((s) => s.backend);
  const participants = useChatStore((s) => s.thread.participants);

  // @ 菜单只列"真正能回答"的模型：没配 Key 的模型点它只会得到本地回退回复，
  // 出现在候选里纯属噪音。它们在「模型与后端设置」面板里作为待配置项展示。
  const usable = useMemo(() => selectUsableModels(catalog, backend), [catalog, backend]);

  const selection = useWorkspaceStore((s) => s.selection);
  const setSelection = useWorkspaceStore((s) => s.setSelection);
  const quoted = useComposerStore((s) => s.quoted);
  const clearQuote = useComposerStore((s) => s.clearQuote);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [intent, setIntent] = useState<EditIntent | 'auto'>('auto');
  /** 团队成员：@ 的候选里除了模型也要有人（否则打 @李 补不出"李四"）。 */
  const [members, setMembers] = useState<{ id: string; displayName: string; color: string }[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const memberMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    return members.filter((m) => !q || m.displayName.toLowerCase().includes(q)).slice(0, 5);
  }, [mention, members]);

  const candidates = useMemo<ModelDescriptor[]>(() => {
    /*
     * 只列**阵容里**的模型。
     *
     * 之前把"可用的全部模型"都列出来，导致把 kimi/qwen 从阵容移出后，
     * @ 菜单里仍然能点到它们——阵容就形同虚设了。
     * 阵容 = 这个房间在场的 AI；不在阵容里就不该被 @。
     */
    const list = usable.filter((m) => participants.includes(m.id));
    // 兜底：阵容为空（或还没加载）时列出全部可用模型，避免 @ 菜单完全空掉
    const pool = list.length > 0 ? list : usable;
    return mention ? filterCatalog(pool, mention.query) : pool;
  }, [usable, participants, mention]);

  useEffect(() => {
    if (focusToken > 0) textareaRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    setHighlight(0);
  }, [mention?.query]);

  useEffect(() => {
    if (!mention || membersLoaded) return;
    setMembersLoaded(true);
    void fetch(apiUrl(`/api/team/roster${activeProjectId ? `?project=${encodeURIComponent(activeProjectId)}` : ''}`))
      .then((r) => r.json())
      .then((d: { members?: { id: string; displayName: string; color: string }[] }) => setMembers(d.members ?? []))
      .catch(() => setMembers([]));
  }, [mention, membersLoaded]);

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  };

  useEffect(resize, [draft]);

  const updateValue = (value: string, caret: number | null) => {
    setDraft(value);
    const pos = caret ?? value.length;
    setMention(activeMentionQuery(value, pos));
  };

  /** 插入 `@某成员`（和模型补全共用同一段文本替换逻辑）。 */
  const insertMemberName = (name: string) => {
    const el = textareaRef.current;
    if (!el || !mention) return;
    const caret = el.selectionStart;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(caret);
    setDraft(`${before}@${name} ${after}`);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = `${before}@${name} `.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const insertMention = (model: ModelDescriptor) => {
    const el = textareaRef.current;
    if (!el || !mention) return;
    const caret = el.selectionStart;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(caret);
    const next = `${before}@${model.id} ${after}`;
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = before.length + model.id.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const doSend = () => {
    if (!draft.trim() || busy) return;
    const payload = draft;
    setDraft('');
    setMention(null);
    setIntent('auto');
    void send(payload, intent === 'auto' ? {} : { intent });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(candidates[highlight]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  return (
    <div className="relative shrink-0 border-t border-ink-800 bg-ink-900 px-2.5 pt-2 pb-2.5">
      {mention && (candidates.length > 0 || memberMatches.length > 0) && (
        <div className="pf-enter absolute bottom-full left-2.5 z-40 mb-1.5 w-[320px] overflow-hidden rounded-lg border border-ink-700 bg-ink-850 shadow-2xl shadow-black/50">
          <div className="flex items-center gap-1.5 border-b border-ink-750 px-2.5 py-1.5">
            <AtSign className="size-3 text-brand-400" />
            <span className="text-[10.5px] text-ink-400">
              选择模型{mention.query ? `：匹配 “${mention.query}”` : ''}
            </span>
            <span className="ml-auto text-[10px] text-ink-600">↑↓ 选择 · Enter 确认</span>
          </div>
          {memberMatches.length > 0 && (
            <div className="border-b border-ink-750 py-1">
              <div className="px-2.5 pb-0.5 text-[9.5px] tracking-wide text-ink-600">成员</div>
              {memberMatches.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMemberName(m.displayName);
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-ink-800"
                >
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: m.color }} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-100">@{m.displayName}</span>
                  <span className="text-[9.5px] text-ink-600">成员</span>
                </button>
              ))}
            </div>
          )}
          <ul className="max-h-64 overflow-auto py-1">
            {candidates.map((model, idx) => {
              const inRoom = participants.includes(model.id);
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertMention(model);
                    }}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                      idx === highlight ? 'bg-brand-500/15' : 'hover:bg-ink-800'
                    }`}
                  >
                    <Avatar initials={model.initials} accent={model.accent} size={20} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-medium text-ink-100">{model.label}</span>
                      <span className="block truncate text-[10px] text-ink-500">{model.strengths.join(' · ')}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-ink-500">
                      {(model.contextWindow / 1000).toFixed(0)}K
                    </span>
                    {model.capabilities.includes('vision') && (
                      <span
                        className="shrink-0 rounded bg-accent-violet/15 px-1 text-[9px] text-accent-violet"
                        title="支持图像输入：可以 @ 它直接看 PDF 页面图"
                      >
                        可看图
                      </span>
                    )}
                    {!inRoom && <span className="shrink-0 text-[9px] text-ink-600">房外</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {quoted && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded-md border border-accent-teal/40 bg-accent-teal/10 px-2 py-1.5">
          <Reply className="mt-[1px] size-3 shrink-0 text-accent-teal" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10.5px] text-accent-teal">
              <span className="font-medium">
                {quoted.modelId ? `已引用 @${quoted.modelId} 的回答` : '已引用一条消息'}
              </span>
              <span className="text-ink-500">下一个模型会直接读到它</span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-ink-400">{quoted.preview}…</p>
          </div>
          <IconButton size="xs" title="取消引用" icon={<X className="size-3" />} onClick={clearQuote} />
        </div>
      )}

      {selection && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded-md border border-brand-600/35 bg-brand-500/8 px-2 py-1.5">
          <Quote className="mt-[1px] size-3 shrink-0 text-brand-400" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10.5px] text-brand-300">
              <span className="font-medium">已附加选区</span>
              <span className="font-mono text-ink-400">
                {selection.fileId.replace('file-', '')} L{selection.start.line}–{selection.end.line}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 font-mono text-[10.5px] leading-snug text-ink-400">
              {selection.text.replace(/\s+/g, ' ').slice(0, 180)}
            </p>
          </div>
          <IconButton
            size="xs"
            title="移除选区"
            icon={<X className="size-3" />}
            onClick={() => setSelection(null)}
          />
        </div>
      )}

      <div className="rounded-lg border border-ink-700 bg-ink-925 focus-within:border-brand-600/60">
        <textarea
          id="pf-composer"
          ref={textareaRef}
          value={draft}
          onChange={(e) => updateValue(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={() => window.setTimeout(() => setMention(null), 120)}
          rows={1}
          placeholder="输入指令，@ 指定模型（例：@claude 压缩这段，@gpt-4o 审一下逻辑）"
          className="max-h-[200px] w-full resize-none bg-transparent px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-100 outline-none placeholder:text-ink-600"
        />

        {/*
          底部工具条：左右两组各自 shrink-0，中间留白。
          之前是 `flex items-center` + 一堆不定宽的元素，面板一窄就整体换行，
          出现"发送给 4 个模型"被挤到第二行、与意图按钮错位的情况。
        */}
        <div className="flex items-center gap-1.5 border-t border-ink-800 px-2 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {INTENT_ACTIONS.slice(0, 4).map((action) => (
              <button
                key={action.intent}
                type="button"
                title={action.hint}
                onClick={() => setIntent(intent === action.intent ? 'auto' : action.intent)}
                className={`shrink-0 rounded px-1.5 py-[2px] text-[10.5px] whitespace-nowrap transition-colors ${
                  intent === action.intent
                    ? 'bg-brand-500/20 text-brand-300'
                    : 'text-ink-500 hover:bg-ink-800 hover:text-ink-300'
                }`}
              >
                {action.label}
              </button>
            ))}
          </div>

          {/* 提示只在足够宽时出现，避免和发送按钮抢位置 */}
          <span className="hidden shrink-0 items-center gap-1 text-[10px] whitespace-nowrap text-ink-600 xl:flex">
            <CornerDownLeft className="size-2.5" />
            Enter 发送
          </span>

          <div className="flex shrink-0 items-center">
            {busy ? (
              <Button size="xs" variant="danger" icon={<Square className="size-3" />} onClick={cancel}>
                停止
              </Button>
            ) : (
              <Button
                size="xs"
                variant="primary"
                /* 去掉图标 + min-w-max：中文按字断行，只有强制最小宽度才保证单行 */
                className="min-w-max shrink-0 whitespace-nowrap"
                onClick={doSend}
                disabled={!draft.trim()}
              >
                发送
              </Button>
            )}
          </div>
        </div>
      </div>

      {busy && (
        <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-ink-500">
          <Loader2 className="size-3 animate-spin text-brand-400" />
          多个模型正在并行生成，可随时停止。
        </div>
      )}
    </div>
  );
}
