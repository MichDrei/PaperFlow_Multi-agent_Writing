/** GET /api/models、GET /api/sessions —— 元信息查询。 */

import type { FastifyInstance } from 'fastify';
import type { LlmGateway } from '@paperflow/llm';
import type { SessionStore } from '../../storage/memory.js';

export function registerMetaRoutes(
  app: FastifyInstance,
  deps: { gateway: LlmGateway; sessions: SessionStore; compileEngine: string },
): void {
  app.get<{ Querystring: { channel?: 'room' | 'private' } }>('/api/models', async (request) => {
    const me = (request as { currentUser?: { id: string } }).currentUser;
    const channel = request.query.channel ?? 'room';
    /*
     * 公私分离：私有厂商的 id 形如 `<provider>__<userId>`（见 keys.ts 的加载逻辑）。
     * - 公聊：只列公用模型
     * - 私聊：公用 + 自己的
     * 这样别人的 Key 永远不会出现在你的 `@` 菜单里。
     */
    const isMine = (modelId: string) => {
      const suffix = modelId.includes('__') ? modelId.split('__').pop() : undefined;
      return Boolean(suffix && me?.id && suffix === me.id);
    };
    const isPrivateProvider = (modelId: string) => modelId.includes('__');
    const models = deps.gateway.catalog().filter((m) => {
      if (!isPrivateProvider(m.id)) return true;
      if (channel === 'room') return false;
      return isMine(m.id);
    });
    return {
      models,
      providers: deps.gateway.status(),
      hasRealProvider: deps.gateway.hasRealProvider(),
      compileEngine: deps.compileEngine,
    };
  });

  /** 清空某个线程的服务端历史。前端点"清空会话"时必须调用，
   * 否则界面看着空了、模型却还记着旧上下文（会造成"它怎么还在说上一轮的事"）。 */
  app.delete<{ Params: { threadId: string } }>('/api/sessions/:threadId', async (request) => {
    deps.sessions.clear(request.params.threadId);
    return { ok: true };
  });

  app.get('/api/sessions', async () => ({
    sessions: deps.sessions.list().map((s) => ({
      threadId: s.threadId,
      messages: s.messages.length,
      updatedAt: s.updatedAt,
    })),
  }));
}
