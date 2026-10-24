/**
 * 团队模式的路由：入组申请、审批、成员、邀请、会话。
 *
 * 鉴权模型（刻意做得很轻）：
 *   1. 发起方（owner）生成邀请链接 → 发给组员
 *   2. 组员点开链接 → 填显示名 → 变成一条**待审批申请**
 *   3. owner 在界面上同意/拒绝
 *   4. 同意后系统签发会话（HttpOnly Cookie），组员页面轮询到通过即进入应用
 *
 * 没有邮箱、没有密码——对"课题组内部、私有部署"这个场景，这是最省事且够安全的：
 * 能拿到邀请链接的人才有入口，最终还要 owner 点同意。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { TeamStore, User } from './teamStore.js';

export const SESSION_COOKIE = 'pf_session';

export const joinSchema = z.object({
  token: z.string().min(8).max(200),
  displayName: z.string().min(1).max(40),
});

export const inviteSchema = z.object({
  role: z.enum(['owner', 'editor', 'commenter', 'viewer']).default('editor'),
  /** 为哪个项目发邀请（批准后该项目切协作）。 */
  projectId: z.string().min(1).max(128).optional(),
  expiresInDays: z.number().int().positive().max(365).nullable().optional(),
  maxUses: z.number().int().positive().max(500).nullable().optional(),
});

export const decisionSchema = z.object({
  approve: z.boolean(),
  role: z.enum(['owner', 'editor', 'commenter', 'viewer']).optional(),
});

/**
 * 从请求里取会话 cookie。
 *
 * 这里手写解析而不是用 `cookie` 包：`cookie@1.x` 把 `parse`/`serialize` 换成了
 * `parseSetCookie`/`stringifySetCookie`，API 不兼容；而我们要的只是"取一个键"。
 */
export function sessionTokenOf(request: FastifyRequest): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/** 当前请求的用户（未登录返回 undefined）。 */
export function currentUser(request: FastifyRequest, team: TeamStore): User | undefined {
  const user = (request as FastifyRequest & { currentUser?: User }).currentUser;
  if (user) return user;
  return team.userForSession(sessionTokenOf(request));
}

/** 会话 cookie：HttpOnly + SameSite=Lax，内网 http 也能用（不强制 Secure）。 */
function sessionCookie(token: string, maxAge = 30 * 86_400): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header('set-cookie', sessionCookie(token));
}

export interface AuthRouteOptions {
  team: TeamStore;
  /** 批准加入后把对应项目切成协作模式。 */
  markCollab?: (projectId: string) => void;
  /** 'team' 时启用鉴权；'solo' 时全部放行（保持单机体验不变）。 */
  authMode: 'solo' | 'team';
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { team, authMode } = options;

  /** 公共状态：前端据此决定显示登录页还是主界面。 */
  app.get('/api/auth/state', async (request) => {
    const me = currentUser(request, team);
    // 首次启动且没有 owner 时，生成认领链接（写入控制台与文件，由部署者保管）
    let claimRequired = false;
    if (authMode === 'team' && !team.hasOwner()) {
      claimRequired = true;
    }
    return {
      mode: authMode,
      hasOwner: team.hasOwner(),
      claimRequired,
      me: me ? publicUser(me) : null,
    };
  });

  app.get('/api/me', async (request, reply) => {
    const me = currentUser(request, team);
    if (!me) {
      if (authMode === 'team') return reply.code(401).send({ code: 'unauthorized', message: '需要登录' });
      return { user: null, mode: authMode };
    }
    return { user: publicUser(me), mode: authMode };
  });

  /** 提交入组申请（或凭认领链接直接成为 owner）。 */
  app.post('/api/auth/join', async (request, reply) => {
    const parsed = joinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '需要邀请 token 与显示名' });
    }
    const result = team.submitJoin({ inviteToken: parsed.data.token, displayName: parsed.data.displayName });
    if (result.kind === 'error') {
      return reply.code(400).send({ code: 'invite_invalid', message: result.message });
    }
    if (result.kind === 'user') {
      setSessionCookie(reply, result.session.token);
      return reply.code(201).send({ status: 'approved', user: publicUser(result.user) });
    }
    return reply.code(202).send({
      status: 'pending',
      requestId: result.request.id,
      message: '申请已提交，等待发起方同意',
    });
  });

  /** 申请人轮询：通过后自动拿到会话 cookie。 */
  app.get<{ Params: { id: string } }>('/api/auth/request/:id', async (request, reply) => {
    const found = team.findRequest(request.params.id);
    if (!found) return reply.code(404).send({ code: 'not_found', message: '申请不存在' });
    if (found.status === 'approved' && found.userId) {
      // 审批时已签发会话；这里按 userId 找出最新会话，实现"点开就进来了"
      const session = team.listSessions().filter((s) => s.userId === found.userId).at(-1);
      if (session) {
        setSessionCookie(reply, session.token);
        return { status: 'approved', user: publicUser(team.findUser(found.userId)!) };
      }
      return { status: 'approved', user: publicUser(team.findUser(found.userId)!) };
    }
    return { status: found.status };
  });

  /**
   * 一次性"恢复登录"链接。
   *
   * 用途：用户误退出了、或换了浏览器，但账号还在——没有密码体系的情况下，
   * 由管理员从服务端签发一条会话，用链接点一下就回到登录态。
   * 会话本身有效期沿用 30 天，链接泄露的风险等同于登录态泄露。
   */
  app.get<{ Querystring: { token?: string } }>('/api/auth/resume', async (request, reply) => {
    const token = request.query.token;
    if (!token) return reply.code(400).send({ code: 'bad_request', message: '缺少 token' });
    const session = team.listSessions().find((s) => s.token === token);
    if (!session) return reply.code(404).send({ code: 'not_found', message: '链接无效或已失效' });
    setSessionCookie(reply, session.token);
    return reply.redirect('/');
  });

  app.post('/api/auth/logout', async (request, reply) => {
    team.destroySession(sessionTokenOf(request));
    reply.header('set-cookie', sessionCookie('', 0));
    return { ok: true };
  });

  /* ── 成员管理 ─────────────────────────────────────────────── */

  /**
   * 成员名册：给"@ 某人"用。
   * 与 `/api/team/members` 的区别：那个只给 owner（带管理语义），
   * 这个对所有已登录成员开放——否则普通成员根本 @ 不到人。
   */
  app.get('/api/team/roster', async (request, reply) => {
    const me = currentUser(request, team);
    if (authMode === 'team' && !me) {
      return reply.code(401).send({ code: 'unauthorized', message: '需要登录' });
    }
    return {
      members: team.listUsers().map((u) => ({
        id: u.id,
        displayName: u.displayName,
        color: u.color,
        isOwner: u.isOwner,
      })),
    };
  });

  app.get('/api/team/members', async (request, reply) => {
    if (!requireOwner(request, reply, team, authMode)) return;
    // 传 project 就只返回本项目成员（发起方始终包含）
    const projectId = (request.query as { project?: string }).project;
    return { members: team.listUsers(projectId || undefined).map(publicUser) };
  });

  app.patch<{ Params: { id: string } }>('/api/team/members/:id', async (request, reply) => {
    if (!requireOwner(request, reply, team, authMode)) return;
    // 角色/转交 owner 的细粒度控制留到项目级权限那一轮；这里先只支持移除
    return reply.code(501).send({ code: 'not_implemented', message: '成员角色调整暂未开放' });
  });

  app.delete<{ Params: { id: string } }>('/api/team/members/:id', async (request, reply) => {
    if (!requireOwner(request, reply, team, authMode)) return;
    if (!team.removeUser(request.params.id)) {
      return reply.code(404).send({ code: 'not_found', message: '成员不存在' });
    }
    return { ok: true };
  });

  /* ── 邀请 ─────────────────────────────────────────────────── */

  app.get('/api/team/invites', async (request, reply) => {
    if (!requireOwner(request, reply, team, authMode)) return;
    return { invites: team.listInvites() };
  });

  app.post('/api/team/invites', async (request, reply) => {
    if (!requireOwner(request, reply, team, authMode)) return;
    const parsed = inviteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '请求体不合法' });
    }
    const me = currentUser(request, team)!;
    const invite = team.createInvite({
      role: parsed.data.role,
      createdBy: me.id,
      projectId: parsed.data.projectId,
      maxUses: parsed.data.maxUses ?? null,
      expiresInDays: parsed.data.expiresInDays ?? null,
    });
    return reply.code(201).send({ invite });
  });

  app.delete<{ Params: { token: string } }>('/api/team/invites/:token', async (request, reply) => {
    if (!requireOwner(request, reply, team, authMode)) return;
    if (!team.revokeInvite(request.params.token)) {
      return reply.code(404).send({ code: 'not_found', message: '邀请不存在' });
    }
    return { ok: true };
  });

  /* ── 入组审批 ─────────────────────────────────────────────── */

  app.get('/api/team/requests', async (request, reply) => {
    if (!requireOwner(request, reply, team, authMode)) return;
    const status = (request.query as { status?: string }).status;
    const allowed = ['pending', 'approved', 'rejected'] as const;
    const filter = allowed.includes(status as (typeof allowed)[number])
      ? (status as (typeof allowed)[number])
      : undefined;
    return { requests: team.listRequests(filter) };
  });

  app.post<{ Params: { id: string } }>('/api/team/requests/:id/decision', async (request, reply) => {
    if (!requireOwner(request, reply, team, authMode)) return;
    const parsed = decisionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '需要 approve 字段' });
    }
    const me = currentUser(request, team)!;
    const updated = team.decideRequest(request.params.id, parsed.data.approve, me.id, parsed.data.role);
    // 只有真的有人被批准进来，项目才算进入协作模式
    if (updated?.status === 'approved' && updated.projectId) {
      options.markCollab?.(updated.projectId);
    }
    if (!updated) {
      return reply.code(409).send({ code: 'already_decided', message: '该申请已处理过' });
    }
    return { request: updated };
  });
}

/** owner 才能做的操作；非 owner 直接 403。 */
function requireOwner(request: FastifyRequest, reply: FastifyReply, team: TeamStore, mode: 'solo' | 'team'): boolean {
  if (mode !== 'team') return true;
  const me = currentUser(request, team);
  if (!me) {
    void reply.code(401).send({ code: 'unauthorized', message: '需要登录' });
    return false;
  }
  if (!me.isOwner) {
    void reply.code(403).send({ code: 'forbidden', message: '只有发起方可以执行该操作' });
    return false;
  }
  return true;
}

/** 对外暴露的用户字段（不泄漏会话等内部信息）。 */
export function publicUser(user: User): {
  id: string;
  displayName: string;
  color: string;
  isOwner: boolean;
  createdAt: string;
} {
  return {
    id: user.id,
    displayName: user.displayName,
    color: user.color,
    isOwner: user.isOwner,
    createdAt: user.createdAt,
  };
}
