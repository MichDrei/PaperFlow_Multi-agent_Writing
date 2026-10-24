/** GET /api/models、GET /api/sessions —— 元信息查询。 */

import type { FastifyInstance } from 'fastify';
import type { LlmGateway } from '@paperflow/llm';
import type { SessionStore } from '../../storage/memory.js';

export function registerMetaRoutes(
  app: FastifyInstance,
  deps: { gateway: LlmGateway; sessions: SessionStore; compileEngine: string },
): void {
  app.get('/api/models', async () => ({
    // catalog() 会把厂商声明/环境变量覆盖的模型一并合并进来，
    // 因此 `QWEN_MODELS=qwen3.8-max` 会立刻出现在前端阵容里。
    models: deps.gateway.catalog(),
    providers: deps.gateway.status(),
    hasRealProvider: deps.gateway.hasRealProvider(),
    compileEngine: deps.compileEngine,
  }));

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
