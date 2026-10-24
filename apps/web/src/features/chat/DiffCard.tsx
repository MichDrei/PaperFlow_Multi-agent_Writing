/**
 * Diff 卡片：模型提议的编辑以"逐 hunk 可裁决"的形式呈现。
 *
 * 这是本产品最重要的产品决策：**模型永远不能直接改用户的论文**。
 * 它只能提交 EditProposal，人在这里决定接受哪一块。所以这张卡片不是"展示"，
 * 而是唯一的写入口。
 */

import { useEffect, useState } from 'react';
import { Check, CheckCheck, Crosshair, FileDiff, Undo2, Wand2, X } from 'lucide-react';
import { summarizeHunks, type ProposalStatus } from '@paperflow/core';
import { Avatar, Button, Pill } from '@paperflow/ui';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { INTENT_LABEL } from '@/lib/intent';

const STATUS_META: Record<ProposalStatus, { label: string; color: string }> = {
  pending: { label: '待裁决', color: '#f5b544' },
  accepted: { label: '已全部应用', color: '#2dd4bf' },
  partial: { label: '部分应用', color: '#4f8cff' },
  rejected: { label: '已拒绝', color: '#74829a' },
  stale: { label: '已过期', color: '#f4636c' },
};

export function DiffCard({ proposalId }: { proposalId: string }) {
  const record = useChatStore((s) => s.proposals[proposalId]);
  const catalog = useChatStore((s) => s.catalog);
  const applyProposal = useChatStore((s) => s.applyProposal);
  const setDecision = useChatStore((s) => s.setProposalDecision);
  const dismissProposal = useChatStore((s) => s.dismissProposal);
  const reveal = useWorkspaceStore((s) => s.reveal);

  const hunks = record?.hunks ?? [];
  const [accepted, setAccepted] = useState<Set<string> | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    setAccepted(null);
    setApplied(false);
  }, [proposalId]);

  if (!record) return null;

  const { proposal, status, staleReason } = record;
  const model = catalog.find((m) => m.id === proposal.modelId);
  const selected = accepted ?? new Set(hunks.map((h) => h.id));
  const summary = summarizeHunks(hunks);
  const meta = STATUS_META[status];
  const locked = status === 'accepted' || status === 'partial' || applied;

  const toggle = (hunkId: string) => {
    const next = new Set(selected);
    if (next.has(hunkId)) next.delete(hunkId);
    else next.add(hunkId);
    setAccepted(next);
  };

  const commit = (ids: string[]) => {
    const ok = applyProposal(proposal.id, ids);
    if (ok) setApplied(true);
  };

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-ink-700 bg-ink-925">
      <header className="flex items-center gap-2 border-b border-ink-750 bg-ink-850/70 px-2.5 py-1.5">
        <FileDiff className="size-3.5 shrink-0 text-brand-400" />
        <span className="truncate font-mono text-[11px] text-ink-200">
          {proposal.fileId.replace('file-', '')} · L{proposal.range.startLine}–{proposal.range.endLine}
        </span>
        <span className="flex items-center gap-1 font-mono text-[10.5px]">
          <span className="text-accent-teal">+{summary.added}</span>
          <span className="text-accent-rose">−{summary.removed}</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {model && <Avatar initials={model.initials} accent={model.accent} size={16} title={model.label} />}
          <Pill accent={meta.color}>{meta.label}</Pill>
        </span>
      </header>

      <div className="max-h-72 overflow-auto">
        {hunks.map((hunk) => {
          const isOn = selected.has(hunk.id);
          return (
            <div key={hunk.id} className="border-b border-ink-850 last:border-b-0">
              <label className="flex cursor-pointer items-center gap-2 bg-ink-900/60 px-2.5 py-1 hover:bg-ink-850">
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={locked}
                  onChange={() => toggle(hunk.id)}
                  className="size-3 accent-[#4f8cff]"
                />
                <span className="font-mono text-[10.5px] text-ink-500">{hunk.header}</span>
                {locked && (
                  <span className="ml-auto text-[10px] text-ink-500">
                    {record.acceptedHunkIds.includes(hunk.id) ? '已应用' : '已跳过'}
                  </span>
                )}
              </label>
              <div className="font-mono text-[11px] leading-[1.55]">
                {hunk.lines.map((line, idx) => (
                  <div
                    key={idx}
                    className={
                      line.kind === 'add'
                        ? 'flex gap-2 bg-accent-teal/10 px-2.5 text-accent-teal'
                        : line.kind === 'del'
                          ? 'flex gap-2 bg-accent-rose/10 px-2.5 text-accent-rose/90'
                          : 'flex gap-2 px-2.5 text-ink-400'
                    }
                  >
                    <span className="w-3 shrink-0 select-none opacity-70">
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                    </span>
                    <span className="whitespace-pre-wrap">{line.text || '\u00a0'}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-ink-750 bg-ink-850/60 px-2.5 py-1.5">
        <p className="mb-1.5 text-[11px] leading-relaxed text-ink-400">
          <Wand2 className="mr-1 inline size-3 text-brand-400" />
          意图：{INTENT_LABEL[proposal.intent]} · {proposal.rationale}
        </p>

        {staleReason && (
          <p className="mb-1.5 rounded border border-accent-rose/40 bg-accent-rose/10 px-2 py-1 text-[11px] text-accent-rose">
            {staleReason}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {!locked ? (
            <>
              <Button
                size="xs"
                variant="primary"
                icon={<CheckCheck className="size-3" />}
                onClick={() => commit([...selected])}
                disabled={selected.size === 0}
              >
                应用选中 {selected.size}/{hunks.length} 块
              </Button>
              <Button
                size="xs"
                variant="outline"
                icon={<Check className="size-3" />}
                onClick={() => {
                  setAccepted(new Set(hunks.map((h) => h.id)));
                  commit(hunks.map((h) => h.id));
                }}
              >
                全部应用
              </Button>
              <Button
                size="xs"
                variant="ghost"
                icon={<X className="size-3" />}
                onClick={() => {
                  setDecision(proposal.id, [], 'rejected');
                  dismissProposal(proposal.id);
                }}
              >
                拒绝
              </Button>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1 text-[11px] text-accent-teal">
                <Check className="size-3" />
                已写入编辑器（{record.acceptedHunkIds.length} 块）
              </span>
              <Button
                size="xs"
                variant="ghost"
                icon={<Undo2 className="size-3" />}
                onClick={() => {
                  // 简化处理：撤销依赖编辑器自带的 Ctrl+Z，这里只做提示定位。
                  reveal(proposal.range.startLine);
                }}
              >
                定位改动
              </Button>
            </>
          )}
          <Button
            size="xs"
            variant="ghost"
            icon={<Crosshair className="size-3" />}
            onClick={() => reveal(proposal.range.startLine)}
            className="ml-auto"
          >
            在编辑器中定位
          </Button>
        </div>
      </div>
    </div>
  );
}
