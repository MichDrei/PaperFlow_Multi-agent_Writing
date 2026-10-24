/**
 * 团队模式鉴权的端到端验证（不启动真实端口，用 Fastify 的 inject）。
 *
 * 覆盖：认领 owner → 生成邀请 → 组员申请 → owner 审批 → 组员拿到会话 → 未登录被拦。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../apps/server/src/env';
import { buildServer } from '../apps/server/src/app';


const root = mkdtempSync(join(tmpdir(), 'pf-auth-'));
const env = loadEnv({
  PORT: '0',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  CORS_ORIGINS: 'http://127.0.0.1:5273',
  MAX_CONCURRENCY: '4',
  ENABLE_CROSS_REVIEW: 'true',
} as NodeJS.ProcessEnv);

const built = await buildServer({ env, envSource: {}, projectsRoot: root, authMode: 'team', persistPath: null });
const app = built.app;

/** 取 set-cookie 里的 pf_session 值。 */
function cookieOf(res: { headers: Record<string, unknown> }): string | undefined {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  const match = value?.match(/pf_session=([^;]+)/);
  return match?.[1];
}

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
}

try {
  // 1. 首次启动：应提示需要认领 owner
  const state = await app.inject({ method: 'GET', url: '/api/auth/state' });
  const stateBody = state.json() as { mode: string; hasOwner: boolean; claimRequired: boolean };
  check('首次启动 claimRequired=true', stateBody.claimRequired === true && stateBody.hasOwner === false, JSON.stringify(stateBody));

  // 2. 未登录访问业务接口 → 401
  const blocked = await app.inject({ method: 'GET', url: '/api/projects' });
  check('未登录访问 /api/projects 被拦(401)', blocked.statusCode === 401, String(blocked.statusCode));

  // 3. 健康检查必须公开
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  check('健康检查公开可访问', health.statusCode === 200, String(health.statusCode));

  // 4. 用引导链接认领 owner（真实部署时这个 token 在控制台/OWNER-LINK.txt）
  // 注意：必须用 app 内部同一个 store 实例
  const claim = built.team.listInvites().find((i) => i.autoApprove)!;
  const joinOwner = await app.inject({
    method: 'POST',
    url: '/api/auth/join',
    payload: { token: claim.token, displayName: '张振源' },
  });
  const ownerCookie = cookieOf(joinOwner);
  check('认领链接直接成为 owner(201)', joinOwner.statusCode === 201 && Boolean(ownerCookie), String(joinOwner.statusCode));

  // 5. 带会话访问 /api/me
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `pf_session=${ownerCookie}` } });
  const meBody = me.json() as { user: { displayName: string; isOwner: boolean } | null };
  check('/api/me 返回 owner 身份', meBody.user?.isOwner === true && meBody.user?.displayName === '张振源');

  // 6. owner 生成邀请链接
  const inviteRes = await app.inject({
    method: 'POST',
    url: '/api/team/invites',
    headers: { cookie: `pf_session=${ownerCookie}` },
    payload: { role: 'editor' },
  });
  const invite = (inviteRes.json() as { invite?: { token: string; role: string } }).invite;
  check('owner 生成邀请(201)', inviteRes.statusCode === 201 && invite?.role === 'editor');

  // 7. 组员申请（不带会话）→ 202 pending
  const joinMember = await app.inject({
    method: 'POST',
    url: '/api/auth/join',
    payload: { token: invite!.token, displayName: '李四' },
  });
  const pending = joinMember.json() as { status: string; requestId: string };
  check('组员申请进入待审批(202 pending)', joinMember.statusCode === 202 && pending.status === 'pending', String(joinMember.statusCode));

  // 8. 组员此时访问业务接口仍被拦
  const blocked2 = await app.inject({ method: 'GET', url: '/api/projects' });
  check('待审批期间仍被拦', blocked2.statusCode === 401, String(blocked2.statusCode));

  // 9. owner 查看待审批列表
  const list = await app.inject({ method: 'GET', url: '/api/team/requests?status=pending', headers: { cookie: `pf_session=${ownerCookie}` } });
  const requests = (list.json() as { requests: { id: string }[] }).requests;
  check('owner 能看到待审批申请', requests.some((r) => r.id === pending.requestId), JSON.stringify(requests.map((r) => r.id)));

  // 10. 非 owner 不能审批
  const fakeCookie = `pf_session=bogus`;
  const forbidden = await app.inject({
    method: 'POST',
    url: `/api/team/requests/${pending.requestId}/decision`,
    headers: { cookie: fakeCookie },
    payload: { approve: true },
  });
  check('伪造会话不能审批(401/403)', forbidden.statusCode === 401 || forbidden.statusCode === 403, String(forbidden.statusCode));

  // 11. owner 同意
  const decide = await app.inject({
    method: 'POST',
    url: `/api/team/requests/${pending.requestId}/decision`,
    headers: { cookie: `pf_session=${ownerCookie}` },
    payload: { approve: true },
  });
  check('owner 审批通过(200)', decide.statusCode === 200, String(decide.statusCode));

  // 12. 组员轮询拿到会话
  const poll = await app.inject({ method: 'GET', url: `/api/auth/request/${pending.requestId}` });
  const pollBody = poll.json() as { status: string; user?: { displayName: string } };
  const memberCookie = cookieOf(poll);
  check('组员轮询到 approved 并拿到会话', pollBody.status === 'approved' && Boolean(memberCookie));

  // 13. 组员现在可以访问业务接口
  const allowed = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: `pf_session=${memberCookie}` } });
  check('审批后组员可访问 /api/projects', allowed.statusCode === 200, String(allowed.statusCode));

  // 14. 组员不能生成邀请（非 owner）
  const memberInvite = await app.inject({
    method: 'POST',
    url: '/api/team/invites',
    headers: { cookie: `pf_session=${memberCookie}` },
    payload: { role: 'editor' },
  });
  check('普通成员不能生成邀请(403)', memberInvite.statusCode === 403, String(memberInvite.statusCode));

  // 15. 邀请可撤销
  const revoke = await app.inject({
    method: 'DELETE',
    url: `/api/team/invites/${invite!.token}`,
    headers: { cookie: `pf_session=${ownerCookie}` },
  });
  check('owner 可撤销邀请', revoke.statusCode === 200, String(revoke.statusCode));

  // 16. 撤销后的邀请不能再申请
  const afterRevoke = await app.inject({
    method: 'POST',
    url: '/api/auth/join',
    payload: { token: invite!.token, displayName: '王五' },
  });
  check('撤销后的邀请被拒绝(400)', afterRevoke.statusCode === 400, String(afterRevoke.statusCode));
} finally {
  await built.app.close();
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok || !c.detail ? '' : `  → ${c.detail}`}`);
}
console.log(`\n  ${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
