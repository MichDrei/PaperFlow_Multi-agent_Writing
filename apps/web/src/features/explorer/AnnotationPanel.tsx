/**
 * 批注面板（左侧，和"项目文件/大纲"同级）。
 *
 * 设计约束（来自实际使用反馈）：
 * 1. **不再挂在编辑器右上角**：那里常驻、挡正文、很突兀；批注是次要信息，
 *    应该像群聊一样待在侧边，需要时再看。
 * 2. **只有作者能删**：之前任何人（包括被 @ 的人）都能点 × 把整条批注删掉，
 *    这是权限 bug。
 * 3. **点击跳转**：点一条批注，编辑器滚到对应段落并选中，方便对照修改。
 */

import { MessageSquareText, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAnnotationStore } from '@/stores/annotationStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useComposerStore } from '@/stores/composerStore';

export function AnnotationPanel() {
  const items = useAnnotationStore((s) => s.items);
  const requestJump = useAnnotationStore((s) => s.requestJump);
  const removeHandler = useAnnotationStore((s) => s.removeHandler);
  const setDraftAndFocus = useComposerStore((s) => s.setDraftAndFocus);
  const replyHandler = useAnnotationStore((s) => s.replyHandler);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const me = useSessionStore((s) => s.me);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-ink-850 px-3 py-2">
        <MessageSquareText className="size-3.5 text-accent-amber" />
        <span className="text-[11.5px] font-medium text-ink-200">批注</span>
        <span className="ml-auto rounded bg-ink-850 px-1.5 py-0.5 text-[10px] text-ink-400">{items.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {items.length === 0 ? (
          <p className="px-1 text-[11px] leading-relaxed text-ink-600">
            还没有批注。
            <br />
            在正文里选中一段文字 → 悬浮工具条点「批注」。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((item) => {
              const mine = me?.id === item.authorId;
              return (
                <li key={item.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => requestJump(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') requestJump(item.id);
                    }}
                    className="group cursor-pointer rounded-md border border-ink-750 bg-ink-850/70 px-2 py-1.5 transition-colors hover:border-accent-amber/50 hover:bg-ink-850"
                    title="点击跳到正文对应位置"
                  >
                    <div className="flex items-center gap-1 text-[10px]">
                      <span className="size-1.5 rounded-full" style={{ background: item.color }} />
                      <span style={{ color: item.color }}>{item.authorName}</span>
                      <span className="text-ink-600">
                        {new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {/* 只有作者本人能删 */}
                      {mine && removeHandler && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeHandler(item.id);
                          }}
                          className="ml-auto text-ink-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent-red"
                          title="删除这条批注（仅作者可删）"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </div>
                    <div className="mt-1 text-[11.5px] leading-snug text-ink-100">{item.body}</div>
                    <div className="mt-0.5 truncate text-[10px] text-ink-600">「{item.quoted}」</div>
                    {(item.replies?.length ?? 0) > 0 && (
                      <ul className="mt-1 space-y-0.5 border-l border-ink-750 pl-2">
                        {item.replies!.map((reply) => (
                          <li key={reply.id} className="text-[10.5px] leading-snug text-ink-300">
                            <span style={{ color: reply.color }}>{reply.authorName}</span>：{reply.text}
                          </li>
                        ))}
                      </ul>
                    )}
                    {replyHandler && (
                      <div className="mt-1">
                        {replyFor === item.id ? (
                          <div className="flex items-center gap-1">
                            <input
                              autoFocus
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && replyText.trim()) {
                                  replyHandler(item.id, replyText.trim());
                                  setReplyText('');
                                  setReplyFor(null);
                                }
                                if (e.key === 'Escape') setReplyFor(null);
                              }}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="回复…（Enter 发送）"
                              className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-850 px-1.5 py-0.5 text-[10.5px] text-ink-100 placeholder:text-ink-600 focus:border-brand-600/60 focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (replyText.trim()) {
                                  replyHandler(item.id, replyText.trim());
                                  setReplyText('');
                                  setReplyFor(null);
                                }
                              }}
                              className="text-ink-400 hover:text-brand-300"
                              title="发送回复"
                            >
                              <Send className="size-3" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReplyFor(item.id);
                              setReplyText('');
                            }}
                            className="text-[10px] text-ink-500 hover:text-brand-300"
                          >
                            回复
                          </button>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        /*
                         * 必须把**批注内容本身**也带上：
                         * 只放原文的话，agent 只知道"这段话是什么"，不知道"别人对它的意见是什么"。
                         */
                        setDraftAndFocus(
                          `关于这条批注（${item.authorName}：${item.body}）\n` +
                            `「${item.quoted}」\n` +
                            '我的问题：',
                        );
                      }}
                      className="mt-1 flex items-center gap-1 rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-brand-500/60 hover:text-brand-300"
                      title="把这段原文带到群聊输入框，可直接 @ 模型讨论"
                    >
                      <MessageSquareText className="size-2.5" />
                      去群聊讨论
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
