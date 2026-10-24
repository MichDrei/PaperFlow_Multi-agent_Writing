/**
 * 项目文件管理路由（对应 Overleaf 左侧文件树的那一套操作）。
 *
 * 设计取舍：上传/导入统一走 **JSON + base64**，而不是 multipart。
 * 理由：全站已有统一的 JSON 契约与校验（zod），再加一套 multipart 解析会引入
 * `@fastify/multipart`、临时文件、字段顺序等额外复杂度；而 zip 也不过几 MB，
 * base64 膨胀 33% 完全可以接受。真正的大文件上传将来可以单独做直传。
 */

import type { FastifyInstance } from 'fastify';
import { readFileSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ProjectStore } from '../../storage/projectStore.js';
import type { ProjectRegistry } from '../../storage/projectRegistry.js';
import {
  createFolderSchema,
  createProjectSchema,
  importPathSchema,
  renameProjectSchema,
  deleteEntrySchema,
  importZipSchema,
  readEntrySchema,
  renameEntrySchema,
  setRootSchema,
  writeFileSchema,
} from '../schemas.js';

export interface ProjectRouteOptions {
  store: ProjectStore;
  registry: ProjectRegistry;
  /** 空项目初始化用的种子文件（演示论文）。 */
  seed?: Record<string, string>;
}

export function registerProjectRoutes(app: FastifyInstance, options: ProjectRouteOptions): void {
  const { store, registry, seed } = options;

  /** 取出路径参数里的项目 id，并确认它真的存在。 */
  const projectIdOf = (params: { projectId: string }): string => params.projectId;

  // ── 项目列表 / 新建 / 重命名 / 删除 ───────────────────────────
  app.get('/api/projects', async () => ({ projects: registry.reconcile() }));

  /**
   * 从 zip 新建项目（原子）：`POST /api/projects/import?name=ICRA`，body 为原始 zip 字节。
   *
   * 为什么单独开一个路由而不是塞进 JSON：真实项目几十 MB，base64 膨胀 33% 后
   * 很容易撞上 body 上限；而且"创建项目 + 导入"要么都成功、要么都不留痕，
   * 不能出现一个导入失败的空项目。
   */
  app.post<{ Querystring: { name?: string } }>('/api/projects/import', async (request, reply) => {
    const raw = (request.body ?? Buffer.alloc(0)) as Buffer;
    if (!Buffer.isBuffer(raw) || raw.byteLength === 0) {
      return reply.code(400).send({ code: 'bad_request', message: '请求体应为 zip 文件字节' });
    }
    const name = (request.query.name ?? '').trim() || '导入的项目';
    const meta = registry.create(name);
    try {
      const result = await store.importZipBuffer(meta.id, raw, { replace: true });
      if (result.rootPath) store.setRootPath(meta.id, result.rootPath);
      return reply.code(201).send({ project: meta, ...result, manifest: store.manifest(meta.id) });
    } catch (err) {
      registry.remove(meta.id); // 回滚：不要留下一个空的坏项目
      return reply.code(400).send({ code: 'import_failed', message: messageOf(err) });
    }
  });

  /**
   * 从**服务器本地路径**导入（目录或 zip）。
   *
   * 为什么要有它：毕设项目常有几百 MB 图片，走 HTTP 上传会撞 body 上限。
   * 服务端本来就能读到同一台机器上的文件（WSL 里 `/mnt/f/...` 就是 Windows 的 F 盘），
   * 直接读盘没有上限压力、也不占内存。
   */
  app.post('/api/projects/import-path', async (request, reply) => {
    const parsed = importPathSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '需要 name 与 path' });
    }
    const { name, path: sourcePath, replace } = parsed.data;
    if (!existsSync(sourcePath)) {
      return reply.code(400).send({ code: 'not_found', message: `路径不存在：${sourcePath}` });
    }
    const stat = statSync(sourcePath);
    const meta = registry.create(name || basename(sourcePath));
    try {
      const result = stat.isDirectory()
        ? await store.importDirectory(meta.id, sourcePath, { replace })
        : /\.zip$/i.test(sourcePath)
          ? {
              ...(await store.importZipBuffer(meta.id, readFileSync(sourcePath), { replace })),
              bytes: readFileSync(sourcePath).byteLength,
            }
          : (() => {
              throw new Error('只支持目录或 .zip 文件');
            })();
      if (result.rootPath) store.setRootPath(meta.id, result.rootPath);
      return reply.code(201).send({ project: meta, ...result, manifest: store.manifest(meta.id) });
    } catch (err) {
      registry.remove(meta.id); // 失败不留空项目
      return reply.code(400).send({ code: 'import_failed', message: messageOf(err) });
    }
  });

  app.post('/api/projects', async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '请提供项目名' });
    }
    const meta = registry.create(parsed.data.name);

    // 直接在新建时导入 zip：这就是"上传一个 IROS 的压缩包，项目管理里就多一个项目"
    if (parsed.data.zipBase64) {
      try {
        const result = await store.importZip(meta.id, parsed.data.zipBase64, { replace: true });
        if (result.rootPath) store.setRootPath(meta.id, result.rootPath);
      } catch (err) {
        registry.remove(meta.id);
        return reply.code(400).send({ code: 'import_failed', message: messageOf(err) });
      }
    } else if (parsed.data.seed && seed) {
      store.ensure(meta.id, seed);
    }

    return reply.code(201).send({ project: meta, manifest: store.manifest(meta.id) });
  });

  app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    const parsed = renameProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'bad_request', message: '请提供新名称' });
    const meta = registry.rename(request.params.projectId, parsed.data.name);
    if (!meta) return reply.code(404).send({ code: 'not_found', message: '项目不存在' });
    return { project: meta };
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    const id = request.params.projectId;
    // 至少留一个项目，否则界面会变成空壳
    if (registry.list().length <= 1) {
      return reply.code(400).send({ code: 'last_project', message: '至少要保留一个项目' });
    }
    const removed = registry.remove(id);
    if (!removed) return reply.code(404).send({ code: 'not_found', message: '项目不存在' });
    return { ok: true };
  });

  // 清单：文件树靠它渲染
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/manifest', async (request) => {
    const projectId = projectIdOf(request.params);
    store.ensure(projectId, seed);
    registry.touch(projectId);
    return store.manifest(projectId);
  });

  // 单个文件正文（编辑器打开文件时读）
  app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>(
    '/api/projects/:projectId/file',
    async (request, reply) => {
    const projectId = projectIdOf(request.params);
    const parsed = readEntrySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: 'bad_request', message: '缺少 path' });
    try {
      return store.read(projectId, parsed.data.path);
    } catch (err) {
      return reply.code(404).send({ code: 'not_found', message: messageOf(err) });
    }
    },
  );

  // 创建 / 保存文件
  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/file', async (request, reply) => {
    const projectId = projectIdOf(request.params);
    const parsed = writeFileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '请求体不合法', detail: parsed.error.flatten() });
    }
    try {
      const entry = store.write(projectId, parsed.data.path, parsed.data.content, parsed.data.encoding);
      return reply.code(201).send({ file: entry, manifest: store.manifest(projectId) });
    } catch (err) {
      return reply.code(400).send({ code: 'write_failed', message: messageOf(err) });
    }
  });

  // 新建文件夹
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/folder', async (request, reply) => {
    const projectId = projectIdOf(request.params);
    const parsed = createFolderSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'bad_request', message: '请求体不合法' });
    try {
      store.createFolder(projectId, parsed.data.path);
      return reply.code(201).send({ manifest: store.manifest(projectId) });
    } catch (err) {
      return reply.code(400).send({ code: 'mkdir_failed', message: messageOf(err) });
    }
  });

  // 重命名 / 移动（拖动文件到别的文件夹也用这个）
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/rename', async (request, reply) => {
    const projectId = projectIdOf(request.params);
    const parsed = renameEntrySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'bad_request', message: '请求体不合法' });
    try {
      store.rename(projectId, parsed.data.from, parsed.data.to);
      return reply.send({ manifest: store.manifest(projectId) });
    } catch (err) {
      return reply.code(400).send({ code: 'rename_failed', message: messageOf(err) });
    }
  });

  // 删除文件或目录
  app.delete<{ Params: { projectId: string }; Querystring: { path?: string } }>(
    '/api/projects/:projectId/entry',
    async (request, reply) => {
    const projectId = projectIdOf(request.params);
    const parsed = deleteEntrySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: 'bad_request', message: '缺少 path' });
    try {
      store.remove(projectId, parsed.data.path);
      return reply.send({ manifest: store.manifest(projectId) });
    } catch (err) {
      return reply.code(404).send({ code: 'not_found', message: messageOf(err) });
    }
    },
  );

  // 设置主文档（编译入口）——对应 Overleaf 的 "Set as main document"
  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/root', async (request, reply) => {
    const projectId = projectIdOf(request.params);
    const parsed = setRootSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'bad_request', message: '请求体不合法' });
    store.ensure(projectId);
    store.setRootPath(projectId, parsed.data.path);
    return reply.send({ rootPath: parsed.data.path });
  });

  // 导入 zip（Overleaf 导出的项目直接拖进来）
  app.post<{ Params: { projectId: string }; Querystring: { replace?: string } }>(
    '/api/projects/:projectId/import',
    async (request, reply) => {
      const projectId = projectIdOf(request.params);
      // 两种形态都收：原始 zip 字节（推荐）或 JSON { zipBase64 }
      let buffer: Buffer;
      let replace = request.query.replace === '1';
      if (Buffer.isBuffer(request.body)) {
        buffer = request.body;
      } else {
        const parsed = importZipSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ code: 'bad_request', message: '请求体应为 zip 文件字节' });
        }
        buffer = Buffer.from(parsed.data.zipBase64, 'base64');
        replace = parsed.data.replace ?? replace;
      }
      try {
        const result = await store.importZipBuffer(projectId, buffer, { replace });
        if (result.rootPath) store.setRootPath(projectId, result.rootPath);
        return reply.send({ ...result, manifest: store.manifest(projectId) });
      } catch (err) {
        return reply.code(400).send({ code: 'import_failed', message: messageOf(err) });
      }
    },
  );

  /**
   * 原始字节上传单个文件（图片等大文件走这里）。
   * 路径由 query 指定，编码由扩展名推断——与服务端的 kindForPath 规则一致。
   */
  app.put<{ Params: { projectId: string }; Querystring: { path?: string } }>(
    '/api/projects/:projectId/raw',
    async (request, reply) => {
      const projectId = projectIdOf(request.params);
      const path = request.query.path?.trim();
      if (!path) return reply.code(400).send({ code: 'bad_request', message: '缺少 path' });
      const raw = (request.body ?? Buffer.alloc(0)) as Buffer;
      if (!Buffer.isBuffer(raw)) {
        return reply.code(400).send({ code: 'bad_request', message: '请求体应为文件字节' });
      }
      try {
        const entry = store.writeRaw(projectId, path, raw);
        return reply.code(201).send({ file: entry, manifest: store.manifest(projectId) });
      } catch (err) {
        return reply.code(400).send({ code: 'write_failed', message: messageOf(err) });
      }
    },
  );

  // 导出整包（base64，前端拼成下载链接）
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/export', async (request, reply) => {
    const projectId = projectIdOf(request.params);
    try {
      const buffer = await store.exportZip(projectId);
      return reply.send({ filename: `${projectId}.zip`, zipBase64: buffer.toString('base64') });
    } catch (err) {
      return reply.code(500).send({ code: 'export_failed', message: messageOf(err) });
    }
  });

}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
