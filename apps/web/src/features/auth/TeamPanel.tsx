/**
 * 团队面板（仅发起方可见）：待审批申请、成员、邀请链接。
 *
 * 这是"私有部署 + 我审批"这个模型的操作台：
 * 组员点链接申请 → 这里出现一条待审批 → 点同意。
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, UserPlus, Users, X } from 'lucide-react';
import { apiUrl } from '@/lib/backend';
import { useSessionStore, type SessionUser } from '@/stores/sessionStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

interface JoinRequest {
  id: string;
  displayName: string;
  role: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

interface Invite {
  token: string;
  role: string;
  used: number;
  maxUses: number | null;
  revoked: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  owner: '发起方',
  editor: '可编辑',
  commenter: '仅批注',
  viewer: '只读',
};

export function TeamPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useSessionStore((s) => s.me);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const [members, setMembers] = useState<SessionUser[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** 接口失败提示（尤其是会话失效），不能静默什么都不发生。 */
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, r, i] = await Promise.all([
      // 只拉"本项目"的成员：单人项目里就不会再看到全组的人
      fetch(apiUrl(`/api/team/members${activeProjectId ? `?project=${encodeURIComponent(activeProjectId)}` : ''}`))
        .then((x) => x.json())
        .catch(() => ({ members: [] })),
      fetch(apiUrl('/api/team/requests?status=pending')).then((x) => x.json()).catch(() => ({ requests: [] })),
      fetch(apiUrl('/api/team/invites')).then((x) => x.json()).catch(() => ({ invites: [] })),
    ]);
    const members = (m as { members?: SessionUser[] }).members ?? [];
    setMembers(members);
    setRequests((r as { requests: JoinRequest[] }).requests ?? []);
    setInvites((i as { invites: Invite[] }).invites ?? []);
    /*
     * 会话失效时必须说出来。
     * 之前这里静默失败：面板显示"0 人"、点"生成邀请"毫无反应，
     * 用户完全无法判断是没权限还是网络坏了（实测就卡在这里）。
     */
    setError(members.length === 0 ? '读取成员失败：登录可能已失效，请让发起方重新发一条邀请链接后重新加入' : null);
  }, [activeProjectId]);

  useEffect(() => {
    if (!open || !me?.isOwner) return;
    void load();
    // 打开期间轮询：组员点了邀请链接申请后，owner 不刷新页面也能看到"待审批"
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [open, me?.isOwner, load]);

  if (!open) return null;

  const decide = async (id: string, approve: boolean) => {
    setBusy(true);
    try {
      await fetch(apiUrl(`/api/team/requests/${id}/decision`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const createInvite = async () => {
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/team/invites'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 带上项目：这条邀请被批准后，该项目才切成协作模式
        body: JSON.stringify({ role: 'editor', projectId: activeProjectId }),
      });
      const data = (await res.json()) as { invite?: Invite };
      if (data.invite) {
        await load();
        await copy(`${window.location.origin}/?join=${data.invite.token}`);
      } else {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(`生成失败：${body.message ?? `HTTP ${res.status}`}（登录可能已失效）`);
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied(null), 2500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="w-full max-w-[560px] rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-brand-400" />
            <span className="text-[13.5px] font-semibold text-ink-100">团队成员</span>
            <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">{members.length} 人</span>
          </div>
          <button type="button" onClick={onClose} className="text-ink-500 hover:text-ink-200">
            <X className="size-4" />
          </button>
        </div>

        {/* 待审批 */}
        <section className="mb-4">
          <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-400">
            待审批 {requests.length > 0 && <span className="text-accent-amber">（{requests.length}）</span>}
          </h3>
          {requests.length === 0 ? (
            <p className="text-[11.5px] text-ink-600">暂无申请。把邀请链接发给组员，他们打开后就会出现在这里。</p>
          ) : (
            <ul className="space-y-1.5">
              {requests.map((r) => (
                <li key={r.id} className="flex items-center gap-2 rounded-md border border-ink-750 bg-ink-850 px-2.5 py-1.5">
                  <span className="flex-1 truncate text-[12.5px] text-ink-100">{r.displayName}</span>
                  <span className="text-[10px] text-ink-500">{ROLE_LABEL[r.role] ?? r.role}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(r.id, true)}
                    className="flex items-center gap-1 rounded border border-accent-teal/50 bg-accent-teal/10 px-1.5 py-0.5 text-[10.5px] text-accent-teal hover:bg-accent-teal/20"
                  >
                    <Check className="size-3" /> 同意
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(r.id, false)}
                    className="rounded border border-ink-700 px-1.5 py-0.5 text-[10.5px] text-ink-300 hover:border-accent-red/50 hover:text-accent-red"
                  >
                    拒绝
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 成员 */}
        <section className="mb-4">
          <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-400">成员</h3>
          <ul className="space-y-1">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-[12.5px] text-ink-200">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: m.color }} />
                <span className="flex-1 truncate">{m.displayName}</span>
                {m.isOwner && <span className="text-[10px] text-brand-400">发起方</span>}
                {m.id === me?.id && <span className="text-[10px] text-ink-500">你</span>}
              </li>
            ))}
          </ul>
        </section>

        {/* 邀请 */}
        <section>
          <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-400">邀请链接</h3>
          <button
            type="button"
            onClick={() => void createInvite()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-ink-700 px-2 py-1.5 text-[12px] text-ink-200 hover:border-brand-600/60 hover:text-brand-300 disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />}
            生成邀请链接（自动复制）
          </button>
          {error && (
            <p className="mt-1.5 rounded border border-accent-amber/40 bg-accent-amber/10 px-2 py-1 text-[11px] leading-snug text-accent-amber">
              {error}
            </p>
          )}
          {copied && (
            <p className="mt-1.5 flex items-center gap-1 text-[11px] text-accent-teal">
              <Copy className="size-3" /> 已复制：{copied}
            </p>
          )}
          {invites.filter((i) => !i.revoked).length > 0 && (
            <ul className="mt-2 space-y-1">
              {invites
                .filter((i) => !i.revoked)
                .slice(0, 5)
                .map((i) => (
                  <li key={i.token} className="flex items-center gap-2 text-[10.5px] text-ink-500">
                    <span className="truncate">…{i.token.slice(-10)}</span>
                    <span className="text-ink-600">
                      已用 {i.used}
                      {i.maxUses ? `/${i.maxUses}` : ''} 次
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
