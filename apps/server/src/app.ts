/**
 * 应用装配（不监听端口）。
 *
 * 与 index.ts 分离的原因：这样测试可以在**临时端口**上真实启动一次服务，
 * 走完整的 HTTP/SSE 栈（包括 CORS 头、hijack 后的原始响应），
 * 而不是只测到业务函数。之前踩过的两个坑（CORS 头被 writeHead 覆盖、
 * 只有空白差异却生成 diff）都只有这种级别的测试才能挡住。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { createGateway, type GatewayEnv, type LlmGateway } from '@paperflow/llm';
import { createOrchestrator } from '@paperflow/agents';
import { createOriginChecker, type Env } from './env.js';
import { MemoryContextStore, MemorySessionStore } from './storage/memory.js';
import { ProjectStore } from './storage/projectStore.js';
import { ProjectRegistry, defaultPaperflowRoot } from './storage/projectRegistry.js';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { registerProjectRoutes } from './http/routes/project.js';
import { DEMO_DOCUMENT } from '@paperflow/context';
import { ChatService } from './services/chatService.js';
import { CompileService } from './services/compileService.js';
import { registerChatRoutes } from './http/routes/chat.js';
import { registerCompileRoutes } from './http/routes/compile.js';
import { TeamStore, defaultTeamFile } from './auth/teamStore.js';
import { attachCollabServer } from './realtime/collabServer.js';
import { attachRoomHub } from './realtime/roomHub.js';
import { SESSION_COOKIE, publicUser, registerAuthRoutes, sessionTokenOf } from './auth/authRoutes.js';
import { registerMetaRoutes } from './http/routes/meta.js';
import { registerContextRoutes } from './http/routes/context.js';

/** 首次启动自动创建的项目 id（也是唯一带演示文献库的项目）。 */
export const DEFAULT_SEED_PROJECT_ID = 'demo-project';

/** 单次上传上限（zip 与二进制文件）。够装下带图的整篇论文项目。 */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export interface BuiltServer {
  app: FastifyInstance;
  gateway: LlmGateway;
  sessions: MemorySessionStore;
  contexts: MemoryContextStore;
  compileService: CompileService;
  chatService: ChatService;
  projectStore: ProjectStore;
  registry: ProjectRegistry;
  defaultProjectId: string;
  /** 团队存储（测试要读同一个实例）。 */
  team: TeamStore;
  authMode: 'solo' | 'team';
  /** 实时协同服务句柄（关闭时落盘）。 */
  collab: { close: () => void };
  /** 群聊房间广播。 */
  roomHub: { broadcast: (projectId: string, payload: unknown, exceptClientId?: string) => void; close: () => void };
}

export interface BuildServerOptions {
  env: Env;
  /** 厂商密钥来源。默认 process.env；测试传 {} 以强制走本地回退路径。 */
  envSource?: GatewayEnv;
  /**
   * 共享知识落盘路径。
   * - 省略：使用默认位置（仓库根 .paperflow/context.json）
   * - `null`：纯内存（**测试必须用这个**，否则会读到开发者本机的真实数据，导致用例互相污染）
   */
  persistPath?: string | null;
  /** 强制指定编译引擎；测试用来分别覆盖"真引擎"与"近似排版"两条路径。 */
  compileEngine?: 'tectonic' | 'mock';
  /** 项目存储根目录；测试用临时目录，避免污染真实项目。 */
  projectsRoot?: string;
  /** 'team' 启用鉴权与邀请审批；默认 'solo'（保持单机体验）。 */
  authMode?: 'solo' | 'team';
  /** 是否用演示论文初始化空项目（默认是）。 */
  seedProject?: boolean;
}

export async function buildServer(options: BuildServerOptions): Promise<BuiltServer> {
  const { env } = options;
  const gateway = createGateway(options.envSource ?? process.env);
  const sessions = new MemorySessionStore(
    options.persistPath === undefined
      ? {}
      : { persistPath: options.persistPath ? options.persistPath.replace(/\.json$/, '-sessions.json') : null },
  );
  const contexts = new MemoryContextStore({
    ...(options.persistPath === undefined ? {} : { persistPath: options.persistPath }),
    // 只有种子项目继承演示文献库，其余项目从空开始
    seedProjectId: DEFAULT_SEED_PROJECT_ID,
  });
  const compileService = new CompileService({
    // 编译产物落盘（大 PDF 不塞进 JSON）
    pdfCachePath: (projectId) => projectStore.pdfCachePath(projectId),
    remoteUrl: env.LATEX_COMPILER_URL,
    tectonicPath: env.TECTONIC_BIN,
    forceEngine: options.compileEngine,
  });

  const orchestrator = createOrchestrator({
    gateway,
    // ★ 必须传入网关合并后的目录（含厂商声明 / 环境变量自定义的模型）。
    // 若省略，编排器会退回静态目录，于是出现"前端在 @ 菜单里推荐了 qwen-max，
    // 后端却认不出 @qwen-max"的错位——用户看到的就是"我 @ 了它却不回复"。
    catalog: gateway.catalog(),
    maxConcurrency: env.MAX_CONCURRENCY,
    crossReview: env.ENABLE_CROSS_REVIEW,
  });

  // 项目文件落在磁盘上：TeX 引擎需要真实文件才能解析 \input / .cls / 图片
  // ⚠️ 必须用**模块相对**的路径，不能用 process.cwd()：
  // 服务端由 npm workspaces 启动时 cwd 是 apps/server，用 cwd 会写出第二个 .paperflow，
  // 于是"注册表在这里、项目文件在那里"，项目列表与磁盘内容对不上。
  // （这个坑之前在 .env 的解析上已经踩过一次。）
  const paperflowRoot = options.projectsRoot ?? defaultPaperflowRoot();
  /*
   * 团队模式开关。
   *
   * 默认 `solo`：保持原来的单机体验（无登录、所有 API 直接可用）。
   * 部署给课题组时设 `AUTH_MODE=team`：除公开路由外都必须带会话，
   * 入组走"邀请链接 → 申请 → owner 审批"。
   */
  const authMode: 'solo' | 'team' = (options.authMode ?? (process.env.AUTH_MODE === 'team' ? 'team' : 'solo'));
  const team = new TeamStore(defaultTeamFile(paperflowRoot));
  const registry = new ProjectRegistry({ paperflowRoot });
  const projectStore = new ProjectStore({ root: join(paperflowRoot, 'projects') });

  /** 空项目初始化用的种子（演示论文）。 */
  const seedFiles = Object.fromEntries(
    Object.values(DEMO_DOCUMENT.files).map((f) => [f.path, f.content]),
  );

  // 首次启动：至少保证有一个项目，否则界面是空的
  registry.reconcile();
  if (registry.list().length === 0) {
    const meta = registry.create('PaperFlow 演示论文');
    if (options.seedProject !== false) projectStore.ensure(meta.id, seedFiles);
  }
  const defaultProjectId = registry.list()[0]?.id ?? DEFAULT_SEED_PROJECT_ID;

  const chatService = new ChatService({
    orchestrator,
    sessions,
    contexts,
    projectId: defaultProjectId,
    compiledText: (projectId) => compileService.compiledTextOf(projectId),
  });

  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // 上限要能装下"带图的真实 Overleaf 项目"。原来是 8MB，实测一个 12MB 的 zip
    // 直接撞上限被掐断（broken pipe），前端只能报"上传失败"。
    bodyLimit: MAX_UPLOAD_BYTES,
  });

  const roomHub = attachRoomHub(app.server, {
    team,
    authMode,
    log: (message, detail) => app.log.warn({ ...detail }, message),
  });


  /**
   * 原始二进制上传：zip 与其他二进制文件直接以字节流提交，不走 base64/JSON。
   * 好处是省掉 33% 的膨胀，也不用把几十 MB 的字符串塞进 JSON 解析器。
   */
  app.addContentTypeParser(
    ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_request, body, done) => done(null, body),
  );

  const isOriginAllowed = createOriginChecker({ corsOrigins: env.corsOrigins });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'paperflow-server',
    version: '0.1.0',
    providers: gateway.status(),
    hasRealProvider: gateway.hasRealProvider(),
    compileEngine: compileService.engine,
    maxConcurrency: env.MAX_CONCURRENCY,
    crossReview: env.ENABLE_CROSS_REVIEW,
  }));

  registerChatRoutes(app, chatService, { isOriginAllowed, roomHub });
  /*
   * 全局鉴权守卫。只拦 `/api/`，静态资源（Vite/生产构建产物）不受影响。
   * 公开路由：健康检查、鉴权入口本身。
   */
  const PUBLIC_PREFIXES = ['/api/health', '/api/auth/', '/api/me'];
  if (authMode === 'team') {
    app.addHook('onRequest', async (request, reply) => {
      const url = request.url.split('?')[0] ?? '';
      if (!url.startsWith('/api/')) return;
      if (PUBLIC_PREFIXES.some((prefix) => url === prefix || url.startsWith(prefix))) return;
      const user = team.userForSession(sessionTokenOf(request));
      if (!user) {
        return reply.code(401).send({ code: 'unauthorized', message: '需要登录：请使用邀请链接加入' });
      }
      (request as typeof request & { currentUser?: unknown }).currentUser = user;
    });
  }

  registerAuthRoutes(app, {
    team,
    authMode,
    markCollab: (projectId) => registry.setCollab(projectId, true),
  });

  /*
   * 实时协同（Yjs）：挂在同一个 HTTP server 的 /collab 路径下。
   * 团队模式下升级握手会校验会话 cookie，没有会话直接断开。
   */
  const collab = attachCollabServer(app.server, {
    store: projectStore,
    team,
    authMode,
    log: (message, detail) => app.log.warn({ ...detail }, message),
    stateDir: join(paperflowRoot, 'collab'),
  });

  // 首次启动（团队模式且还没有 owner）：生成认领链接，打印到控制台并落盘
  if (authMode === 'team' && !team.hasOwner()) {
    const invite = team.createOwnerClaimInvite();
    const path = join(paperflowRoot, 'team', 'OWNER-LINK.txt');
    mkdirSync(dirname(path), { recursive: true });
    const line = `/join/${invite.token}`;
    writeFileSync(path, `${line}\n`, 'utf8');
    app.log.warn(
      { ownerLink: line, savedTo: path },
      '团队模式首次启动：请用这个链接认领发起方身份（只显示一次）',
    );
  }

  registerCompileRoutes(app, compileService, { store: projectStore, defaultProjectId });
  registerMetaRoutes(app, { gateway, sessions, compileEngine: compileService.engine });
  registerContextRoutes(app, { contexts, defaultProjectId });
  registerProjectRoutes(app, { store: projectStore, registry, seed: seedFiles });

  return {
    app,
    gateway,
    sessions,
    contexts,
    compileService,
    chatService,
    projectStore,
    registry,
    defaultProjectId,
    // 暴露团队存储：测试需要读同一个实例（两个实例各自持有内存副本会互相看不见）
    team,
    authMode,
    collab,
    roomHub,
  };
}
