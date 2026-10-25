/**
 * 项目注册表：多项目并列（ICRA / RAL / IROS …），彼此完全独立。
 *
 * 隔离边界一定要清楚，否则"互不干扰"就是空话：
 * - **文件**：各自落在 `.paperflow/projects/<id>/`，互不可见；
 * - **编译**：编译请求带项目 id，只读该项目的文件；
 * - **共享知识**（文献 / 术语 / 参考资料）：按项目 id 分别保存；
 * - **对话历史**：线程 id 就是项目 id，所以换项目就换了一条独立的会话。
 *
 * 元信息（显示名、创建时间）存在 `.paperflow/projects.json`；
 * 项目的"主文档"存在项目目录内的 `.paperflow-root`，跟着项目走。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function defaultPaperflowRoot(): string {
  return resolve(MODULE_DIR, '../../../../.paperflow');
}

export interface ProjectMeta {
  id: string;
  /** 显示名，例如 "ICRA 2026" / "RAL journal"。 */
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 是否已进入协作（有人被批准加入后置 true）。 */
  collab?: boolean;
  /** 创建者（用户 id）。老项目没有这个字段。 */
  ownerId?: string;
  /** 参与该项目的成员 id（被批准加入时写入）。 */
  members?: string[];

}

/** 把任意名字转成可安全用作目录名的 id。 */
export function slugifyProjectId(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    // 只保留 ASCII：目录名会按同样的规则清洗，若 id 里保留中文，两者就不一致；
    // 更糟的是不同中文名可能清洗进同一个目录（`sztu-毕设` 与 `sztu-论文` → 同名的 `sztu-__`）。
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || `project-${Date.now().toString(36)}`;
}

export class ProjectRegistry {
  /** `.paperflow` 目录。 */
  readonly root: string;

  private readonly registryFile: string;

  constructor(options: { paperflowRoot?: string } = {}) {
    this.root = options.paperflowRoot ?? defaultPaperflowRoot();
    this.registryFile = join(this.root, 'projects.json');
  }

  get projectsRoot(): string {
    return join(this.root, 'projects');
  }

  private readAll(): ProjectMeta[] {
    if (!existsSync(this.registryFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.registryFile, 'utf8')) as ProjectMeta[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // 注册表损坏不应让服务起不来：当作空表，用户仍能新建项目
      return [];
    }
  }

  private writeAll(list: ProjectMeta[]): void {
    mkdirSync(this.root, { recursive: true });
    const temporary = `${this.registryFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(list, null, 2), 'utf8');
    // 原子替换，避免进程中途退出留下半个 JSON
    writeFileSync(this.registryFile, readFileSync(temporary));
    rmSync(temporary, { force: true });
  }

  list(): ProjectMeta[] {
    return this.readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): ProjectMeta | undefined {
    return this.readAll().find((p) => p.id === id);
  }

  /** 新建项目；同名时自动加后缀，不覆盖已有项目。 */
  create(name: string): ProjectMeta {
    const list = this.readAll();
    const base = slugifyProjectId(name);
    let id = base;
    let suffix = 2;
    while (list.some((p) => p.id === id) || existsSync(join(this.projectsRoot, id))) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    const now = new Date().toISOString();
    const meta: ProjectMeta = { id, name: name.trim() || id, createdAt: now, updatedAt: now };
    list.push(meta);
    this.writeAll(list);
    // 刻意**不**在这里建目录：ProjectStore.ensure(seed) 只在目录不存在时才播种，
    // 预先建空目录会让"新建项目 + 种子文件"静默失效（实测表现为新项目 0 个文件）。
    return meta;
  }

  rename(id: string, name: string): ProjectMeta | undefined {
    const list = this.readAll();
    const meta = list.find((p) => p.id === id);
    if (!meta) return undefined;
    meta.name = name.trim() || meta.name;
    meta.updatedAt = new Date().toISOString();
    this.writeAll(list);
    return meta;
  }

  touch(id: string): void {
    const list = this.readAll();
    const meta = list.find((p) => p.id === id);
    if (!meta) return;
    meta.updatedAt = new Date().toISOString();
    this.writeAll(list);
  }

  /** 删除项目：注册表与磁盘文件一起清掉。 */
  remove(id: string): boolean {
    const list = this.readAll();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    this.writeAll(next);
    rmSync(join(this.projectsRoot, id), { recursive: true, force: true });
    return true;
  }

  /**
   * 启动时把磁盘上"有目录但不在注册表里"的项目补登记。
   * 这样即使用户直接往 `.paperflow/projects/` 里拷了一个项目，也能在界面上看到。
   */
  /** 某人是否能看见这个项目：创建者、或已被加入。 */
  canAccess(meta: ProjectMeta, userId: string | undefined): boolean {
    if (!userId) return false;
    if (meta.ownerId === userId) return true;
    if (meta.members?.includes(userId)) return true;
    // 老项目没有归属信息：只有发起方可见，避免成员看到别人的全部项目
    return meta.ownerId === undefined ? false : false;
  }

  /** 把某个用户加进项目的成员列表。 */
  addMember(id: string, userId: string): void {
    const list = this.readAll();
    const meta = list.find((p) => p.id === id);
    if (!meta) return;
    meta.members = [...new Set([...(meta.members ?? []), userId])];
    meta.collab = true;
    meta.updatedAt = new Date().toISOString();
    this.writeAll(list);
  }

  /** 记录创建者。 */
  setOwner(id: string, ownerId: string): void {
    const list = this.readAll();
    const meta = list.find((p) => p.id === id);
    if (!meta) return;
    meta.ownerId = ownerId;
    this.writeAll(list);
  }

  /** 把项目标记为协作（邀请被批准时调用）。 */
  setCollab(id: string, collab = true): void {
    const list = this.readAll();
    const meta = list.find((p) => p.id === id);
    if (!meta) return;
    meta.collab = collab;
    meta.updatedAt = new Date().toISOString();
    this.writeAll(list);
  }

  reconcile(): ProjectMeta[] {
    mkdirSync(this.projectsRoot, { recursive: true });
    const list = this.readAll();
    for (const entry of readdirSync(this.projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || list.some((p) => p.id === entry.name)) continue;
      // 保留目录（编译产物缓存等）不是项目，别扫进来
      if (entry.name === 'pdf-cache') continue;
      const now = new Date().toISOString();
      list.push({ id: entry.name, name: entry.name, createdAt: now, updatedAt: now });
    }
    this.writeAll(list);
    return this.list();
  }
}
