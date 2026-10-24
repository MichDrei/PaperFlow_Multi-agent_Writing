/** POST /api/compile —— LaTeX 编译（默认 MockCompiler，可切到远端 TeX 服务）。 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CompileService } from '../../services/compileService.js';
import type { ProjectStore } from '../../storage/projectStore.js';
import { compileRequestSchema, locateSchema } from '../schemas.js';

export interface CompileRouteOptions {
  store: ProjectStore;
  /** 未指定项目时用的默认项目（保持 /api/compile 的向后兼容）。 */
  defaultProjectId: string;
}

export function registerCompileRoutes(
  app: FastifyInstance,
  service: CompileService,
  options?: CompileRouteOptions,
): void {
  // 两种入口指向同一段逻辑：/api/compile（默认项目）与 /api/projects/:id/compile（指定项目）
  const handler = async (request: FastifyRequest, reply: FastifyReply, projectId: string): Promise<unknown> => {
    const parsed = compileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '请求体不合法', detail: parsed.error.flatten() });
    }

    try {
      // 关键：把**整个项目**交给编译器。
      // 过去只发当前打开的那个文件，于是 \input 的子文件、.cls、.bib、图片全都解析不到，
      // 用户会看到一堆"File not found"——而 Overleaf 上传的项目本来就是多文件的。
      const compileRequest = { ...parsed.data };
      if (options) {
        const manifest = options.store.manifest(projectId);
        const mainPath = compileRequest.mainPath ?? manifest.rootPath;
        const stored = options.store.readAll(projectId);
        const mainFile = stored.find((f) => f.path === mainPath);
        // 请求里的 content 是"编辑器里尚未保存的改动"；为空则用磁盘上的版本。
        // （早期版本无条件信任请求内容，客户端没打开主文件时就会编译出一个空文档。）
        /*
         * 只有"当前打开的就是主文档"时才信任客户端传来的内容。
         *
         * 之前无条件用 `compileRequest.content`：用户在看 refs.bib / sections/xxx.tex 时
         * 点编译，那段内容会被当成主文档去排版，于是必然报错
         * （实测：ICRA 开着 refs.bib 点编译就红了一片）。
         */
        const fromMainDocument =
          !compileRequest.fileId ||
          compileRequest.fileId === mainPath ||
          compileRequest.fileId === manifest.rootPath;
        if (!fromMainDocument || !compileRequest.content || compileRequest.content.trim() === '') {
          if (!mainFile) {
            return reply.code(400).send({
              code: 'main_not_found',
              message: `找不到主文档：${mainPath}。请先在文件树里指定主文档。`,
            });
          }
          compileRequest.content = mainFile.content;
        }
        compileRequest.auxFiles = [
          ...stored.filter((f) => f.path !== mainPath),
          ...(compileRequest.auxFiles ?? []),
        ];
        compileRequest.mainPath = mainPath;
      }
      // 让编译服务知道这是哪个项目：SyncTeX 索引要按项目缓存，否则会串项目
      compileRequest.projectId = projectId;
      const result = await service.compile(compileRequest);
      return reply.send({ ...result, engine: service.engine });
    } catch (err) {
      request.log.error({ err }, 'compile failed');
      return reply.code(500).send({
        code: 'compile_failed',
        message: err instanceof Error ? err.message : '编译失败',
      });
    }
  };

  /*
   * 兼容入口 `/api/compile`：**优先用请求体里的 projectId**。
   *
   * 之前这里固定用默认项目：前端如果把项目只放在 body 里（没有走
   * `/api/projects/:id/compile`），SZTU 的主文档就会被拿到 demo 项目里编译，
   * 于是报 `SZTUthesis.cls not found`——而直接调项目接口却完全正常。
   */
  app.post('/api/compile', async (request, reply) => {
    const body = (request.body ?? {}) as { projectId?: string };
    const projectId = body.projectId?.trim() || options?.defaultProjectId || 'default';
    return handler(request, reply, projectId);
  });

  /**
   * 取编译产物 PDF。
   *
   * 大 PDF（毕设那种几百 MB 的）不能塞进 JSON：base64 后超过 V8 字符串上限，
   * 整个编译接口会 500 `Invalid string length`。所以改成落盘 + 走这个路由读文件。
   */
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/pdf', async (request, reply) => {
    if (!options) return reply.code(404).send({ code: 'not_found', message: '未启用项目存储' });
    const file = options.store.pdfCachePath(request.params.projectId);
    if (!existsSync(file)) {
      return reply.code(404).send({ code: 'not_found', message: '还没有编译产物' });
    }
    const bytes = await readFile(file);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Cache-Control', 'no-cache')
      .header('Content-Length', String(bytes.byteLength))
      .send(bytes);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/compile', async (request, reply) =>
    handler(request, reply, request.params.projectId),
  );

  /**
   * PDF 坐标 → 源码位置（SyncTeX 反向搜索）。
   *
   * 坐标由前端从点击位置换算成 bp（1/72 英寸，原点在页面左下角）。
   * 相比"按选中的文字去源码里搜"，它不依赖文本层给出的词是否准确——实测那条路
   * 会因为 pdf.js 把相邻词放进不同 span 而定位到错误的词（点 wrench 却跳到 the）。
   */
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/locate', async (request, reply) => {
    const parsed = locateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '需要 page/x/y/pageHeight' });
    }
    if (!service.hasSyncTeX(request.params.projectId)) {
      return reply.send({ ok: false, reason: 'no-synctex' });
    }
    const hit = service.locate(
      request.params.projectId,
      parsed.data.page,
      parsed.data.x,
      parsed.data.y,
      parsed.data.pageHeight,
    );
    return reply.send(hit ? { ok: true, ...hit } : { ok: false, reason: 'not-found' });
  });
}
