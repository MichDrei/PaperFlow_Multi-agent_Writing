/**
 * 环境变量解析与校验。
 *
 * 原则：**缺少 API Key 不是错误**——服务应当照常启动并降级到 Mock 提供方，
 * 否则新克隆仓库的人连页面都打不开。真正的错误只有"端口被占用"这类。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** 本模块所在目录（apps/server/src）——用它定位 .env，而不是用 process.cwd()。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface DotEnvResult {
  /** 实际加载到的文件（按优先级）。 */
  loaded: string[];
  /** 查找过但不存在的路径：出错时据此告诉用户"应该放到哪里"。 */
  searched: string[];
}

/**
 * .env 的查找位置。
 *
 * ⚠️ 必须用**模块自身位置**解析，不能用 process.cwd()：
 * `npm run dev:server`（npm workspaces 会把 cwd 设为 apps/server）与
 * `npm run check:models`（cwd 是仓库根）的 cwd 不一样，
 * 用 cwd 会造成"服务端读到了、自检却说没配"这种极难排查的错位。
 */
export function envFileCandidates(): string[] {
  const list = [
    resolve(MODULE_DIR, '../.env'), // apps/server/.env   ← 主位置
    resolve(MODULE_DIR, '../../../.env'), // 仓库根 .env        ← 备用
    resolve(process.cwd(), '.env'), // 兜底：从任意目录运行
  ];
  return [...new Set(list)];
}

/**
 * 极简 .env 加载器（零依赖）。
 *
 * 为什么不用 `node --env-file`：在 `--watch` 模式下，即使文件不存在，
 * Node 也会尝试 watch 它并抛 ENOENT。自己读文件反而更稳，也便于支持多路径查找。
 * 已存在的环境变量优先级更高（容器/CI 覆盖 .env）。
 */
export function loadDotEnv(candidates: string[] = envFileCandidates()): DotEnvResult {
  const loaded: string[] = [];
  const searched: string[] = [];

  for (const path of candidates) {
    if (!existsSync(path)) {
      searched.push(path);
      continue;
    }
    const content = readFileSync(path, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // 跳过空值：`PORT=` 若被写成空串，zod 会 coerce 成 0（随机端口）；
      // `SOME_KEY=` 也没有任何意义。留空即视为"没配"。
      if (value === '') continue;
      if (process.env[key] === undefined) process.env[key] = value;
    }
    loaded.push(path);
  }

  return { loaded, searched };
}

const schema = z.object({
  // 允许 0：交给操作系统分配临时端口（测试与容器编排都会用到）
  PORT: z.coerce.number().int().nonnegative().default(8787),
  HOST: z.string().default('127.0.0.1'),
  /** 允许的前端来源，逗号分隔；默认放开本地开发端口。 */
  CORS_ORIGINS: z.string().default('http://127.0.0.1:5273,http://localhost:5273'),
  /** 单回合最多并发几个模型。 */
  MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
  /** 是否启用第二轮交叉评审。 */
  ENABLE_CROSS_REVIEW: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_MODELS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODELS: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_BASE_URL: z.string().optional(),
  GOOGLE_MODELS: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().optional(),
  DEEPSEEK_MODELS: z.string().optional(),
  MOONSHOT_API_KEY: z.string().optional(),
  MOONSHOT_BASE_URL: z.string().optional(),
  MOONSHOT_MODELS: z.string().optional(),
  /** 阿里云百炼（DashScope）。QWEN_API_KEY 与官方文档里的 DASHSCOPE_API_KEY 等价。 */
  QWEN_API_KEY: z.string().optional(),
  DASHSCOPE_API_KEY: z.string().optional(),
  QWEN_BASE_URL: z.string().optional(),
  QWEN_MODELS: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().optional(),
  OPENROUTER_MODELS: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
  OLLAMA_MODELS: z.string().optional(),
  APP_URL: z.string().optional(),

  /** 远端 TeX 编译服务；不设置则使用本地引擎。 */
  LATEX_COMPILER_URL: z.string().optional(),
  /** Tectonic 二进制路径；不设置则自动探测 .tectonic/bin/tectonic 与 PATH。 */
  TECTONIC_BIN: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof schema> & { corsOrigins: string[]; envFiles: string[]; envFilesSearched: string[] };

/**
 * 来源校验：显式白名单之外，开发环境下额外放行本机任意端口。
 * 这样 `vite --port 5274` 这类临时端口不需要改配置，而生产环境仍然严格。
 */
export function createOriginChecker(env: Pick<Env, 'corsOrigins'> & { nodeEnv?: string }) {
  const isDev = (env.nodeEnv ?? process.env.NODE_ENV ?? 'development') !== 'production';
  return (origin: string | undefined): boolean => {
    if (!origin) return false;
    if (env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) return true;
    if (!isDev) return false;
    try {
      const url = new URL(origin);
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    } catch {
      return false;
    }
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const dotEnv = loadDotEnv();
  const parsed = schema.parse(source);
  return {
    ...parsed,
    envFiles: dotEnv.loaded,
    envFilesSearched: dotEnv.searched,
    corsOrigins: parsed.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
