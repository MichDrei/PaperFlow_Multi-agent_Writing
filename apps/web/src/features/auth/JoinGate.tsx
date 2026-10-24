/**
 * 入组页：邀请链接 → 填名字 → 提交申请 → 等待发起方同意。
 *
 * 刻意没有邮箱和密码：目标场景是课题组内部自建，能拿到链接的人才有入口，
 * 最终还要 owner 点"同意"——两道门足够，且省掉邮件服务。
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck, UserRoundCheck, XCircle } from 'lucide-react';
import { apiUrl } from '@/lib/backend';
import { useSessionStore } from '@/stores/sessionStore';

/** 从 URL 里取邀请 token：支持 `?join=xxx` 与 `/join/xxx` 两种写法。 */
function tokenFromLocation(): string {
  const query = new URLSearchParams(window.location.search).get('join');
  if (query) return query;
  const match = window.location.pathname.match(/^\/join\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? '';
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'pending'; requestId: string }
  | { kind: 'error'; message: string };

export function JoinGate() {
  const token = useRef(tokenFromLocation()).current;
  const refresh = useSessionStore((s) => s.refresh);
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // 待审批时每 3 秒问一次；通过后服务端会下发会话 cookie，刷新即可进入应用
  useEffect(() => {
    if (phase.kind !== 'pending') return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(apiUrl(`/api/auth/request/${phase.requestId}`));
        const data = (await res.json()) as { status: string };
        if (data.status === 'approved') {
          await refresh();
          window.location.href = '/';
        } else if (data.status === 'rejected') {
          setPhase({ kind: 'error', message: '发起方拒绝了这次申请' });
        }
      } catch {
        /* 网络抖动就继续轮询 */
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [phase, refresh]);

  const submit = async () => {
    if (!name.trim()) return;
    setPhase({ kind: 'submitting' });
    try {
      const res = await fetch(apiUrl('/api/auth/join'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, displayName: name.trim() }),
      });
      const data = (await res.json()) as { status?: string; requestId?: string; message?: string; user?: unknown };
      if (!res.ok) {
        setPhase({ kind: 'error', message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      if (data.status === 'approved') {
        await refresh();
        window.location.href = '/';
        return;
      }
      setPhase({ kind: 'pending', requestId: data.requestId! });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : '提交失败' });
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-ink-950 px-6">
      <div className="w-full max-w-[420px] rounded-xl border border-ink-750 bg-ink-900/70 p-7 shadow-2xl">
        <div className="mb-6 flex items-center gap-2">
          <ShieldCheck className="size-5 text-brand-400" />
          <span className="text-[15px] font-semibold text-ink-100">PaperFlow 团队空间</span>
        </div>

        {!token && (
          <div className="space-y-3 text-[12.5px] leading-relaxed text-ink-300">
            <p className="flex items-center gap-1.5 text-accent-amber">
              <XCircle className="size-4" /> 需要邀请链接
            </p>
            <p>请联系项目发起方生成一条邀请链接（形如 <code className="rounded bg-ink-800 px-1">/?join=…</code>），打开它即可申请加入。</p>
          </div>
        )}

        {token && phase.kind !== 'pending' && (
          <>
            <p className="mb-4 text-[12.5px] leading-relaxed text-ink-400">
              填一个组内能认出来的名字。提交后会进入「待审批」，由发起方同意即可进入。
            </p>
            <label className="mb-1.5 block text-[11px] text-ink-400" htmlFor="display-name">
              显示名称
            </label>
            <input
              id="display-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="例如：张振源"
              maxLength={40}
              className="w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] text-ink-100 placeholder:text-ink-600 focus:border-brand-600/70 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={phase.kind === 'submitting' || !name.trim()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-3 py-2 text-[13px] font-medium text-white transition hover:bg-brand-500 disabled:opacity-40"
            >
              {phase.kind === 'submitting' ? <Loader2 className="size-4 animate-spin" /> : <UserRoundCheck className="size-4" />}
              申请加入
            </button>
            {phase.kind === 'error' && (
              <p className="mt-3 text-[12px] leading-snug text-accent-red">{phase.message}</p>
            )}
          </>
        )}

        {phase.kind === 'pending' && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-[13px] text-ink-100">
              <Loader2 className="size-4 animate-spin text-brand-400" />
              申请已提交，等待发起方同意…
            </p>
            <p className="text-[12px] leading-relaxed text-ink-400">
              这个页面会自动检测审批结果，通过后直接进入工作区，不用手动刷新。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
