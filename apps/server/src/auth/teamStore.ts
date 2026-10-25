/**
 * 团队模式的存储层：用户、会话、邀请、入组申请。
 *
 * 为什么用 JSON 文件而不是数据库：
 * 目标场景是**一个课题组自建**（十几个人、几个项目），
 * 这个量级用 SQLite 属于杀鸡用牛刀，而引入原生依赖在 WSL/Windows 上装起来
 * 反而容易失败。所以沿用项目里已有的落盘风格：内存 Map + 原子写（写临时文件再 rename），
 * 进程重启不丢数据。
 *
 * 将来要上多实例/公网时，只需把这四个 Map 换成一张表——接口保持不变。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export type MemberRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface User {
  id: string;
  displayName: string;
  /** 头像/光标颜色，按 id 派生，保证同一用户始终一致。 */
  color: string;
  /** 全局身份：owner 只有一个，可以审批入组申请、生成邀请。 */
  isOwner: boolean;
  createdAt: string;
  /** 参与过哪些项目（被批准加入时写入）。 */
  joinedProjects?: string[];
}

export interface Session {
  token: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface Invite {
  token: string;
  /** 这条邀请是为哪个项目发的；批准后把该项目切成协作模式。 */
  projectId?: string;
  role: MemberRole;
  createdBy: string;
  createdAt: string;
  /** 过期时间（ISO）。null 表示永不过期（内部团队常用）。 */
  expiresAt: string | null;
  /** 已用次数上限；null 表示不限。 */
  maxUses: number | null;
  used: number;
  revoked: boolean;
  /** 完成申请的**自动审批**：仅用于"认领 owner"的引导链接。 */
  autoApprove: boolean;
}

export interface JoinRequest {
  id: string;
  inviteToken: string;
  displayName: string;
  role: MemberRole;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** 通过后创建的用户 id。 */
  userId?: string;
  /** 申请对应的项目（批准后切成协作模式）。 */
  projectId?: string;
}

interface TeamData {
  users: User[];
  sessions: Session[];
  invites: Invite[];
  requests: JoinRequest[];
}

const SESSION_TTL_DAYS = 30;
/*
 * 光标配色。
 *
 * 原先按 `hash(id) % 8` 取色：只有 8 种颜色，人一多就**撞色**
 * （实测发起人和第三位协作者拿到同一个红橙色，根本认不出谁是谁）。
 * 现在改成"取当前用得最少的那个颜色"，前 8 个人一定各不相同。
 */
const COLORS = [
  '#4f9cf9', // 蓝
  '#f59e0b', // 橙
  '#22c55e', // 绿
  '#a855f7', // 紫
  '#06b6d4', // 青
  '#ec4899', // 玫红
  '#eab308', // 黄
  '#ef4444', // 红
  '#14b8a6', // 蓝绿
  '#8b5cf6', // 靛紫
  '#f97316', // 橘
  '#84cc16', // 黄绿
];

/** 选一个当前用得最少的颜色（同色最少 → 尽量不撞）。 */
function pickColor(used: string[]): string {
  const counts = new Map<string, number>(COLORS.map((c) => [c, 0]));
  for (const color of used) counts.set(color, (counts.get(color) ?? 0) + 1);
  let best = COLORS[0]!;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of COLORS) {
    const count = counts.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export class TeamStore {
  private readonly file: string;
  private data: TeamData;

  constructor(file: string) {
    this.file = file;
    this.data = this.load();
    // 修复历史数据里的"撞色"：早期按 hash 取色，人会撞到同一颜色
    if (this.dedupeColors()) this.save();
  }

  /** 把重复的颜色重新分配（只动有冲突的后来者）。返回是否发生过修改。 */
  private dedupeColors(): boolean {
    const seen = new Set<string>();
    let changed = false;
    for (const user of [...this.data.users].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (!seen.has(user.color)) {
        seen.add(user.color);
        continue;
      }
      user.color = pickColor([...seen]);
      seen.add(user.color);
      changed = true;
    }
    return changed;
  }

  /** 数据文件路径（测试与文档都用得上）。 */
  get path(): string {
    return this.file;
  }

  private load(): TeamData {
    if (!existsSync(this.file)) {
      return { users: [], sessions: [], invites: [], requests: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<TeamData>;
      return {
        users: parsed.users ?? [],
        sessions: parsed.sessions ?? [],
        invites: parsed.invites ?? [],
        requests: parsed.requests ?? [],
      };
    } catch {
      // 文件损坏时不要静默覆盖用户数据：备份后从空状态开始
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, backup);
      } catch {
        /* 备份失败就算了 */
      }
      return { users: [], sessions: [], invites: [], requests: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /* ── 引导：没有 owner 时生成"认领链接" ───────────────────────── */

  hasOwner(): boolean {
    return this.data.users.some((u) => u.isOwner);
  }

  /**
   * 生成 owner 认领链接（只在还没有 owner 时有效）。
   *
   * 这解决了"邀请链接需要 owner 审批，但 owner 还不存在"的先有鸡还是先有蛋问题：
   * 认领链接自带 autoApprove，点开填名字即成为 owner。
   */
  createOwnerClaimInvite(): Invite {
    const invite: Invite = {
      token: newToken(),
      role: 'owner',
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      maxUses: 1,
      used: 0,
      revoked: false,
      autoApprove: true,
    };
    this.data.invites.push(invite);
    this.save();
    return invite;
  }

  /* ── 邀请 ─────────────────────────────────────────────────── */

  createInvite(input: { role: MemberRole; createdBy: string; maxUses?: number | null; expiresInDays?: number | null; projectId?: string }): Invite {
    const expiresInDays = input.expiresInDays ?? null;
    const invite: Invite = {
      token: newToken(),
      role: input.role,
      createdBy: input.createdBy,
      projectId: input.projectId,
      createdAt: new Date().toISOString(),
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null,
      maxUses: input.maxUses ?? null,
      used: 0,
      revoked: false,
      autoApprove: false,
    };
    this.data.invites.push(invite);
    this.save();
    return invite;
  }

  findInvite(token: string): Invite | undefined {
    return this.data.invites.find((i) => i.token === token);
  }

  /** 邀请是否还能用（未撤销、未过期、未超次数）。 */
  inviteUsable(invite: Invite): { ok: boolean; reason?: string } {
    if (invite.revoked) return { ok: false, reason: '邀请已被撤销' };
    if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) return { ok: false, reason: '邀请已过期' };
    if (invite.maxUses !== null && invite.used >= invite.maxUses) return { ok: false, reason: '邀请使用次数已用尽' };
    return { ok: true };
  }

  listInvites(): Invite[] {
    return [...this.data.invites].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  revokeInvite(token: string): boolean {
    const invite = this.findInvite(token);
    if (!invite) return false;
    invite.revoked = true;
    this.save();
    return true;
  }

  /* ── 入组申请 ─────────────────────────────────────────────── */

  /** 提交申请：自动审批的邀请直接建号，其余进入待审批列表。 */
  submitJoin(input: {
    inviteToken: string;
    displayName: string;
  }): { kind: 'user'; user: User; session: Session } | { kind: 'pending'; request: JoinRequest } | { kind: 'error'; message: string } {
    const invite = this.findInvite(input.inviteToken);
    if (!invite) return { kind: 'error', message: '邀请链接无效' };
    const usable = this.inviteUsable(invite);
    if (!usable.ok) return { kind: 'error', message: usable.reason ?? '邀请不可用' };

    const displayName = input.displayName.trim().slice(0, 40) || '匿名';
    /*
     * 重名直接拒绝：邀请链接被重复打开会创建多个同名用户
     * （实测出现过三个"李四"，成员列表、@ 候选、项目归属全乱）。
     */
    if (this.data.users.some((u) => u.displayName === displayName)) {
      return { kind: 'error', message: '这个名字已被占用，请换一个名字（或让发起方确认账号）' };
    }
    invite.used += 1;

    if (invite.autoApprove) {
      const user = this.createUser(displayName, invite.role === 'owner');
      const session = this.createSession(user.id);
      this.save();
      return { kind: 'user', user, session };
    }

    const request: JoinRequest = {
      id: randomUUID(),
      inviteToken: invite.token,
      projectId: invite.projectId,
      displayName,
      role: invite.role,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.data.requests.push(request);
    this.save();
    return { kind: 'pending', request };
  }

  findRequest(id: string): JoinRequest | undefined {
    return this.data.requests.find((r) => r.id === id);
  }

  listRequests(status?: JoinRequest['status']): JoinRequest[] {
    return this.data.requests
      .filter((r) => !status || r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 审批。通过时创建用户并签发会话返回给调用方（前端轮询用）。 */
  /** 最近一次批准创建出来的用户 id（route 用它把成员加进项目，避免按显示名找错人）。 */
  lastApprovedUserId: string | undefined;

  decideRequest(id: string, approve: boolean, decidedBy: string, role?: MemberRole): JoinRequest | undefined {
    const request = this.findRequest(id);
    if (!request || request.status !== 'pending') return undefined;
    request.status = approve ? 'approved' : 'rejected';
    request.decidedAt = new Date().toISOString();
    request.decidedBy = decidedBy;
    if (approve) {
      const user = this.createUser(request.displayName, role === 'owner');
      // 记下"他加入了哪个项目"，成员列表据此按项目过滤
      if (request.projectId) user.joinedProjects = [request.projectId];
      // 记录这次真正创建的用户，route 用它加项目成员（显示名重复时不会认错）
      this.lastApprovedUserId = user.id;
      request.userId = user.id;
      request.role = role ?? request.role;
      // 通过后立刻签发会话：申请人的页面轮询到 approved 时可直接拿到 token
      this.createSession(user.id);
    }
    this.save();
    return request;
  }

  /* ── 用户与会话 ───────────────────────────────────────────── */

  /** 给新用户挑一个尽量不撞的颜色。 */
  private nextColor(): string {
    return pickColor(this.data.users.map((u) => u.color));
  }

  private createUser(displayName: string, isOwner: boolean): User {
    const user: User = {
      id: randomUUID(),
      displayName,
      color: this.nextColor(),
      isOwner,
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    return user;
  }

  /**
   * 给**已有用户**签发一条新会话（找回账号用）。
   *
   * 场景：成员清了浏览器缓存 / 换了电脑，而邀请链接是"创建新用户"的，
   * 重名又被拒——没有这个入口他就永远进不来了。
   */
  issueSession(userId: string): Session {
    const user = this.data.users.find((u) => u.id === userId);
    if (!user) throw new Error('用户不存在');
    const session = this.createSession(userId);
    this.save();
    return session;
  }

  private createSession(userId: string): Session {
    const now = new Date().toISOString();
    const session: Session = { token: newToken(), userId, createdAt: now, lastSeenAt: now };
    this.data.sessions.push(session);
    return session;
  }

  findUser(id: string): User | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  /**
   * 成员列表。
   *
   * 传 `projectId` 时只返回"和这个项目有关的人"：发起方（全局管理员）
   * + 通过该项目邀请加入的人。不传则返回全组（管理用途）。
   */
  listUsers(projectId?: string): User[] {
    const all = [...this.data.users].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!projectId) return all;
    return all.filter((u) => u.isOwner || (u.joinedProjects ?? []).includes(projectId));
  }

  /** 用会话 token 换用户；顺便刷新 lastSeenAt（用于"谁在线"的粗粒度展示）。 */
  userForSession(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const session = this.data.sessions.find((s) => s.token === token);
    if (!session) return undefined;
    const ageDays = (Date.now() - Date.parse(session.createdAt)) / 86_400_000;
    if (ageDays > SESSION_TTL_DAYS) return undefined;
    session.lastSeenAt = new Date().toISOString();
    return this.findUser(session.userId);
  }

  destroySession(token: string | undefined): void {
    if (!token) return;
    this.data.sessions = this.data.sessions.filter((s) => s.token !== token);
    this.save();
  }

  /** 移除成员（同时作废其会话）。最后一个 owner 不能删。 */
  removeUser(id: string): boolean {
    const user = this.findUser(id);
    if (!user) return false;
    if (user.isOwner && this.data.users.filter((u) => u.isOwner).length <= 1) return false;
    this.data.users = this.data.users.filter((u) => u.id !== id);
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== id);
    this.save();
    return true;
  }

  /** 全部会话（测试用：审批通过后取 token）。 */
  listSessions(): Session[] {
    return [...this.data.sessions];
  }
}

/** 团队数据默认落盘位置：`.paperflow/team/team.json`。 */
export function defaultTeamFile(paperflowRoot: string): string {
  return join(paperflowRoot, 'team', 'team.json');
}
