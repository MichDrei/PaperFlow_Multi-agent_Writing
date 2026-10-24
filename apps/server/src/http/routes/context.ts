/**
 * 共享知识上下文的路由。
 *
 * 参考资料（reference）是"把外部材料喂给模型"的唯一入口：
 * 文本在这里落库，随后由 packages/context 的 BM25 检索按相关性注入每一轮对话。
 * PDF 的文本提取放在**浏览器端**（pdf.js）完成——这样服务端不必解析二进制，
 * 也避免大文件上传；上传的是已经提取好的纯文本。
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { parseBibtex } from '@paperflow/context';
import type { ReferenceDocument } from '@paperflow/core';
import type { ContextStore } from '../../storage/memory.js';
import { addReferenceSchema, importBibtexSchema } from '../schemas.js';

export interface ContextRouteOptions {
  contexts: ContextStore;
  /** 未指定项目时的默认值（向后兼容）。 */
  defaultProjectId?: string;
}

/**
 * 共享知识按项目隔离：每个项目有自己的文献 / 术语 / 参考资料。
 * 不能共用一份——ICRA 的术语表和 RAL 的参考文献混在一起会让模型串味。
 */
export function registerContextRoutes(app: FastifyInstance, options: ContextRouteOptions): void {
  const { contexts } = options;
  const projectOf = (query: { project?: string }): string =>
    query.project?.trim() || options.defaultProjectId || 'demo-project';

  app.get<{ Querystring: { project?: string } }>('/api/context', async (request) => {
    const context = contexts.sharedContext(projectOf(request.query));
    return {
      citations: context.citations,
      terminology: context.terminology,
      figures: context.figures,
      // 列表里不重复回传全文，避免响应体过大；正文按需通过 /api/context/references/:id 取
      references: context.references.map(({ text, pageImages, ...meta }) => ({
        ...meta,
        hasText: text.length > 0,
        imageCount: pageImages?.length ?? 0,
      })),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { project?: string } }>(
    '/api/context/references/:id',
    async (request, reply) => {
      const reference = contexts
        .sharedContext(projectOf(request.query))
        .references.find((r) => r.id === request.params.id);
      if (!reference) return reply.code(404).send({ code: 'not_found', message: '参考资料不存在' });
      return reference;
    },
  );

  app.post<{ Querystring: { project?: string } }>('/api/context/references', async (request, reply) => {
    const projectId = projectOf(request.query);
    const parsed = addReferenceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '请求体不合法', detail: parsed.error.flatten() });
    }

    const { title, text, kind, source, tags, pageImages, pageCount } = parsed.data;
    const reference: ReferenceDocument = {
      id: randomUUID(),
      title: title.trim() || '未命名资料',
      kind,
      text,
      source,
      tags: tags ?? [],
      addedAt: new Date().toISOString(),
      charCount: text.length,
      ...(pageImages && pageImages.length > 0 ? { pageImages, pageCount } : {}),
    };
    contexts.addReference(projectId, reference);
    return reply.code(201).send({ reference: { ...reference, text: undefined, hasText: true } });
  });

  /**
   * 导入 BibTeX：解析成结构化文献条目并按 key 合并（同 key 覆盖）。
   * 与"参考资料"分开：文献条目用于生成 \cite{}，参考资料是可检索的正文。
   */
  app.post<{ Querystring: { project?: string } }>('/api/context/citations', async (request, reply) => {
    const projectId = projectOf(request.query);
    const parsed = importBibtexSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'bad_request', message: '请求体不合法', detail: parsed.error.flatten() });
    }

    const incoming = parseBibtex(parsed.data.bibtex);
    if (incoming.length === 0) {
      return reply.code(400).send({ code: 'no_entries', message: '没有解析出任何 BibTeX 条目，请检查文件格式' });
    }

    const context = contexts.sharedContext(projectId);
    const merged = new Map(context.citations.map((c) => [c.key, c]));
    let added = 0;
    for (const citation of incoming) {
      if (!merged.has(citation.key)) added += 1;
      merged.set(citation.key, citation);
    }
    contexts.saveSharedContext(projectId, { ...context, citations: [...merged.values()] });

    return { added, total: merged.size, citations: [...merged.values()] };
  });

  app.delete<{ Params: { id: string }; Querystring: { project?: string } }>(
    '/api/context/references/:id',
    async (request, reply) => {
      const removed = contexts.removeReference(projectOf(request.query), request.params.id);
      if (!removed) return reply.code(404).send({ code: 'not_found', message: '参考资料不存在' });
      return { ok: true };
    },
  );
}
