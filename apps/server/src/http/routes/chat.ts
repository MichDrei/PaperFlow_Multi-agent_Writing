/** POST /api/chat —— 多模型群聊的唯一入口（SSE 流式）。 */

import type { FastifyInstance } from 'fastify';
import type { ChatTurnRequest } from '@paperflow/core';
import type { ChatService } from '../../services/chatService.js';
import { openSse } from '../sse.js';
import { chatTurnSchema } from '../schemas.js';

export interface ChatRouteOptions {
  /** 判断请求来源是否允许（用于 SSE 这种绕开 Fastify 序列化的响应）。 */
  isOriginAllowed: (origin: string | undefined) => boolean;
  /** 群聊广播（可选） */
  roomHub?: { broadcast: (projectId: string, payload: unknown, exceptClientId?: string) => void };
}

export function registerChatRoutes(
  app: FastifyInstance,
  service: ChatService,
  options: ChatRouteOptions,
): void {
  const roomHub = options.roomHub;
  /**
   * 仅供"只对人说话"的消息：广播到房间，**不触发任何模型**。
   *
   * 前端识别到 `@` 后面不是模型时走这里——用户想跟同事沟通，
   * 模型不该插嘴（之前任何 @ 都会被当成叫模型，实测就被它抢答了）。
   */
  app.post('/api/room/message', async (request, reply) => {
    const body = request.body as {
      projectId?: string;
      /** 与 /api/chat 一致的线程 id（缺省退回项目 id）。 */
      threadId?: string;
      clientId?: string;
      messageId?: string;
      text?: string;
      mentions?: string[];
      authorName?: string;
    };
    if (!body?.text?.trim()) {
      return reply.code(400).send({ code: 'bad_request', message: '消息不能为空' });
    }
    const user = (request as { currentUser?: { displayName?: string } }).currentUser;
    // 这里必须落进会话历史：否则后续 agent 完全不知道成员之间聊过什么
    service.recordHumanMessage(
      body.threadId ?? body.projectId ?? 'default',
      body.text,
      user?.displayName ?? body.authorName,
      body.projectId,
    );

    roomHub?.broadcast(
      body.projectId ?? '',
      {
        type: 'chat.user',
        clientMessageId: body.messageId,
        messageId: body.messageId,
        text: body.text,
        mentions: body.mentions ?? [],
        authorName: user?.displayName ?? body.authorName,
        projectId: body.projectId,
      },
      body.clientId,
    );
    return reply.code(204).send();
  });

  app.post('/api/chat', async (request, reply) => {
    const parsed = chatTurnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'bad_request',
        message: '请求体不合法',
        detail: parsed.error.flatten(),
      });
    }

    const body = parsed.data as ChatTurnRequest;
    const controller = new AbortController();

    // 接管响应：绕过 Fastify 的序列化，直接写 SSE。
    // 注意：hijack 之后 Fastify（含 @fastify/cors）不会再往响应上写头，
    // 因此 CORS 头必须在这里手动补上，否则浏览器会拦掉整个流。
    reply.hijack();
    const origin = request.headers.origin;
    if (options.isOriginAllowed(origin)) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin!);
      reply.raw.setHeader('Vary', 'Origin');
    }
    const channel = openSse(reply.raw);

    /*
     * 群聊广播：用户发言 + agent 的流式事件都发给同项目的其他连接。
     * `clientId` 用于**排除发起者自己**（他有 SSE，避免同一条消息出现两次）。
     */
    const clientId = (body as { clientId?: string }).clientId;
    const isPrivate = body.channel === 'private';
    if (!isPrivate) roomHub?.broadcast(
      body.projectId ?? '',
      {
        type: 'chat.user',
        clientMessageId: body.clientMessageId,
        messageId: body.clientMessageId,
        text: body.prompt,
        projectId: body.projectId,
      },
      clientId,
    );

    // 客户端断开（关闭标签页、点停止）时立刻取消上游模型调用，避免白烧 token。
    const onClose = () => {
      controller.abort();
      channel.close();
    };
    reply.raw.on('close', onClose);

    try {
      for await (const event of service.handle(body, controller.signal)) {
        if (channel.closed) break;
        channel.send(event);
        // agent 的回复也进房间（同样排除发起者）
        if (!isPrivate) roomHub?.broadcast(body.projectId ?? '', { type: 'chat.agent', event }, clientId);
      }
    } catch (err) {
      channel.send({
        type: 'message.error',
        messageId: 'server',
        code: 'server_error',
        message: err instanceof Error ? err.message : '服务端异常',
      });
      channel.send({ type: 'turn.end', turnId: 'unknown', status: 'error' });
    } finally {
      reply.raw.off('close', onClose);
      channel.close();
    }
    return reply;
  });
}
