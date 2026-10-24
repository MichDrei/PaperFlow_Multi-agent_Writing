/**
 * apps/server 启动入口。
 *
 * 职责边界（很重要，别让它膨胀）：
 * - 保管 API Key（永不下发到浏览器）；
 * - 把群聊请求交给 packages/agents 编排，并以 SSE 回流事件；
 * - 提供编译入口；
 * - 维护会话历史。
 * 它**不**做 LaTeX 排版（那是 services/latex-compiler 的事），也不做业务策略（在 packages/agents）。
 *
 * 装配逻辑在 app.ts，这里只负责监听与优雅退出。
 */

import { buildServer } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();
/*
 * 可选的部署参数（都通过环境变量传，便于 docker run / systemd 配置）：
 *   AUTH_MODE=team       启用团队鉴权与邀请审批
 *   PROJECTS_ROOT=/data  项目与团队数据落盘位置（容器里挂卷）
 */
const { app, gateway, compileService } = await buildServer({
  env,
  projectsRoot: process.env.PROJECTS_ROOT?.trim() || undefined,
  authMode: process.env.AUTH_MODE === 'team' ? 'team' : undefined,
});

const close = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void close('SIGINT'));
process.on('SIGTERM', () => void close('SIGTERM'));

try {
  app.log.info(
    env.envFiles.length > 0
      ? `已读取配置文件：${env.envFiles.join(', ')}`
      : `未找到 .env（查找过：${env.envFilesSearched.join(', ')}）—— 将使用本地回退引擎`,
  );
  await app.listen({ port: env.PORT, host: env.HOST });
  const real = gateway.status().filter((p) => p.configured && p.id !== 'mock');
  app.log.info(
    real.length > 0
      ? `已配置真实厂商：${real.map((p) => p.label).join(', ')}`
      : '未检测到任何 API Key —— 将使用本地 Mock 提供方（事件流与真实调用完全一致）',
  );
  app.log.info(`LaTeX 引擎：${compileService.engine}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
