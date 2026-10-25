/**
 * 模型 Key 的配置接口。
 *
 * 目标：让新手**不用碰文件**——在界面里粘贴 Key，保存后服务自动重启，
 * 模型立刻可用。原来只能手改 .env，很多人卡在这一步。
 */
import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync, utimesSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', env: 'DEEPSEEK_API_KEY', hint: 'https://platform.deepseek.com/api_keys' },
  { id: 'qwen', label: 'Qwen（阿里百炼）', env: 'QWEN_API_KEY', hint: 'https://bailian.console.aliyun.com/' },
  { id: 'moonshot', label: 'Moonshot（Kimi）', env: 'MOONSHOT_API_KEY', hint: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', hint: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic（Claude）', env: 'ANTHROPIC_API_KEY', hint: 'https://console.anthropic.com/settings/keys' },
  { id: 'google', label: 'Google（Gemini）', env: 'GOOGLE_API_KEY', hint: 'https://aistudio.google.com/apikey' },
] as const;

/** 服务端启动时就会读这个文件；改完 touch 一下让 tsx watch 重启。 */
/*
 * 路径基于**模块位置**而不是 process.cwd()：
 * dev 时 cwd 是 apps/server，拼 'apps/server/.env' 会变成
 * apps/server/apps/server/.env（实测 500：ENOENT）。
 */
const APP_DIR = resolve(import.meta.dirname, '../../..');
const ENV_PATH = resolve(APP_DIR, '.env');
/** 自定义厂商 / 中转站：单独存一份 JSON，Key 与 .env 同级保密。 */
/**
 * 自定义厂商存在**数据目录**里（不是代码目录）。
 * 测试会用自己的临时 PROJECTS_ROOT，这样就不会读到开发机上的真实配置，
 * 否则"未配置任何厂商"这类断言会被本地文件干扰。
 */
/**
 * 自定义厂商配置文件路径。
 *
 * 做成**函数**而不是常量：模块加载时求值会读到错的 PROJECTS_ROOT
 *（测试要临时改数据目录，常量方式下改不动，导致读到开发机的真实配置）。
 */
export function customPath(): string {
  return resolve(process.env.PROJECTS_ROOT ?? resolve(APP_DIR, '../../.paperflow'), 'providers.json');
}
const RELOAD_MARKER = resolve(process.cwd(), 'apps/server/src/.reload-key-marker');

/** 只有发起方（实例 owner）能改公用 Key；成员只读。 */
function requireOwnerOnly(request: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, authMode: string): boolean {
  const me = (request as { currentUser?: { isOwner?: boolean } }).currentUser;
  // 单人模式（无登录）允许本机改
  if (authMode !== 'team') return true;
  if (me?.isOwner) return true;
  reply.code(403).send({ code: 'forbidden', message: '只有发起方可以修改公用模型配置' });
  return false;
}

export function registerKeyRoutes(
  app: FastifyInstance,
  options: { authMode?: string } = {},
): void {
  app.get('/api/keys', async () => ({
    envPath: ENV_PATH,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      hint: p.hint,
      configured: Boolean(process.env[p.env]?.trim()),
    })),
  }));

  app.post<{ Body: { env?: string; value?: string } }>('/api/keys', async (request, reply) => {
    if (!requireOwnerOnly(request, reply, options.authMode ?? 'solo')) return;
    const { env: keyEnv, value } = request.body ?? {};
    const provider = PROVIDERS.find((p) => p.env === keyEnv);
    if (!provider) return reply.code(400).send({ code: 'bad_request', message: '未知的厂商' });
    const trimmed = (value ?? '').trim();
    if (!trimmed) return reply.code(400).send({ code: 'bad_request', message: 'Key 不能为空' });

    // 1. 写进 .env（保留其他行，只替换/追加这一项）
    const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
    const pattern = new RegExp(`^\\s*${provider.env}\\s*=`);
    const index = lines.findIndex((line) => pattern.test(line));
    const entry = `${provider.env}=${trimmed}`;
    if (index >= 0) lines[index] = entry;
    else lines.push(entry);
    writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });

    // 2. 当前进程也生效（不必等重启就能校验）
    process.env[provider.env] = trimmed;

    // 3. 触发重启：模型注册表是在启动时构建的，重新加载后新 Key 才真正生效
    try {
      writeFileSync(RELOAD_MARKER, String(Date.now()));
      const now = new Date();
      utimesSync(RELOAD_MARKER, now, now);
    } catch {
      /* 触发失败也不影响已写入的 .env */
    }
    return { ok: true, restarting: true };
  });
}


/** 某个用户的私有厂商配置路径。 */
export function userProvidersPath(userId: string): string {
  const dir = resolve(process.env.PROJECTS_ROOT ?? resolve(APP_DIR, '../../.paperflow'), 'providers');
  return resolve(dir, `${userId}.json`);
}

/** 读取某个用户的私有厂商（不存在就返回空数组）。 */
export function readUserProviders(userId: string): { id: string; label: string; baseUrl: string; apiKey: string; models: string[] }[] {
  try {
    const raw = readFileSync(userProvidersPath(userId), 'utf8');
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? (list as { id: string; label: string; baseUrl: string; apiKey: string; models: string[] }[]) : [];
  } catch {
    return [];
  }
}

/**
 * 启动时加载所有厂商：公用（providers.json）+ 每个用户的私有（providers/*.json）。
 *
 * 私有厂商会带上 `ownerId`，`/api/models` 据此按用户过滤：
 * 公聊只列公用的，私聊列公用 + 自己的。
 */
export function loadCustomProviders(): void {
  const list: { id: string; label: string; baseUrl: string; apiKey: string; models: string[]; ownerId?: string }[] = [];
  try {
    const raw = readFileSync(customPath(), 'utf8');
    const parsed = JSON.parse(raw) as typeof list;
    if (Array.isArray(parsed)) list.push(...parsed);
  } catch {
    /* 没有公用配置 */
  }
  try {
    const dir = resolve(process.env.PROJECTS_ROOT ?? resolve(APP_DIR, '../../.paperflow'), 'providers');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const userId = file.replace(/\.json$/, '');
      try {
        const parsed = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as typeof list;
        if (Array.isArray(parsed)) {
          // 私有用 用户 id 区分，避免与公用 id 冲突
          list.push(...parsed.map((item) => ({ ...item, id: `${item.id}__${userId}`, ownerId: userId })));
        }
      } catch {
        /* 单个用户配置坏了不影响其他人 */
      }
    }
  } catch {
    /* 没有私有目录 */
  }
  if (list.length) process.env.PAPERFLOW_CUSTOM_PROVIDERS = JSON.stringify(list);
  else delete process.env.PAPERFLOW_CUSTOM_PROVIDERS;
}

/** 追加自定义厂商相关路由。 */
export function registerCustomProviderRoutes(
  app: FastifyInstance,
  options: { authMode?: string } = {},
): void {
  app.get('/api/providers/custom', async () => {
    try {
      const list = JSON.parse(readFileSync(customPath(), 'utf8')) as { id: string; label: string; baseUrl: string; models: string[] }[];
      // 永远不回传 Key
      return { providers: list.map(({ id, label, baseUrl, models }) => ({ id, label, baseUrl, models })) };
    } catch {
      return { providers: [] };
    }
  });

  app.post<{ Body: { label?: string; baseUrl?: string; apiKey?: string; models?: string } }>(
    '/api/providers/custom',
    async (request, reply) => {
      if (!requireOwnerOnly(request, reply, options.authMode ?? 'solo')) return;
      const { label, baseUrl, apiKey, models } = request.body ?? {};
      const cleanLabel = (label ?? '').trim();
      const cleanBase = (baseUrl ?? '').trim().replace(/\/$/, '');
      const cleanKey = (apiKey ?? '').trim();
      if (!cleanLabel || !cleanBase || !cleanKey) {
        return reply.code(400).send({ code: 'bad_request', message: '名称、Base URL、Key 都要填' });
      }
      if (!/^https?:\/\//.test(cleanBase)) {
        return reply.code(400).send({ code: 'bad_request', message: 'Base URL 需要以 http(s):// 开头' });
      }
      const id = cleanLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `custom-${Date.now()}`;
      let modelList = (models ?? '')
        .split(/[,，\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      /*
       * 模型名不必让用户填：直接问厂商的 `/models` 接口要清单。
       * 硬编码预设一定会过时（用户实测：预设里的 step-2 早已升级到 step-5）。
       */
      let discovered = 0;
      let discoveryError: string | undefined;
      if (modelList.length === 0) {
        try {
          const res = await fetch(`${cleanBase}/models`, {
            headers: { Authorization: `Bearer ${cleanKey}` },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const data = (await res.json()) as { data?: { id?: string }[] };
            modelList = (data.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
            discovered = modelList.length;
          } else if (res.status === 401) {
            discoveryError = 'API Key 无效（401）。请确认 Key 没写错、没过期、没被吊销。';
          } else {
            discoveryError = `厂商拒绝访问（HTTP ${res.status}），可以手动填模型名。`;
          }
        } catch {
          discoveryError = '连不上厂商 /models 接口，可以手动填模型名。';
        }
      }

      let list: { id: string; label: string; baseUrl: string; apiKey: string; models: string[] }[] = [];
      try {
        list = JSON.parse(readFileSync(customPath(), 'utf8'));
      } catch {
        list = [];
      }
      const entry = { id, label: cleanLabel, baseUrl: cleanBase, apiKey: cleanKey, models: modelList };
      list = [...list.filter((p) => p.id !== id), entry];
      writeFileSync(customPath(), JSON.stringify(list, null, 2), { mode: 0o600 });
      process.env.PAPERFLOW_CUSTOM_PROVIDERS = JSON.stringify(list);
      try {
        writeFileSync(RELOAD_MARKER, String(Date.now()));
        const now = new Date();
        utimesSync(RELOAD_MARKER, now, now);
      } catch {
        /* ignore */
      }
      return { ok: true, id, restarting: true, models: modelList, discovered, discoveryError };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/providers/custom/:id', async (request, reply) => {
    if (!requireOwnerOnly(request, reply, options.authMode ?? 'solo')) return;
    let list: { id: string }[] = [];
    try {
      list = JSON.parse(readFileSync(customPath(), 'utf8'));
    } catch {
      return reply.code(404).send({ code: 'not_found', message: '没有自定义厂商' });
    }
    const next = list.filter((p) => p.id !== request.params.id);
    writeFileSync(customPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
    if (next.length) process.env.PAPERFLOW_CUSTOM_PROVIDERS = JSON.stringify(next);
    else delete process.env.PAPERFLOW_CUSTOM_PROVIDERS;
    try {
      writeFileSync(RELOAD_MARKER, String(Date.now()));
    } catch {
      /* ignore */
    }
    return { ok: true };
  });
}


/** 当前用户 id（单人模式返回 null）。 */
function currentUserId(request: unknown): string | null {
  const me = (request as { currentUser?: { id?: string } }).currentUser;
  return me?.id ?? null;
}

/** 我的私有模型：每个用户只能读写自己那份。 */
export function registerMyProviderRoutes(app: FastifyInstance, options: { authMode?: string } = {}): void {
  const needsLogin = (request: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean => {
    if ((options.authMode ?? 'solo') !== 'team') return true;
    if (currentUserId(request)) return true;
    reply.code(401).send({ code: 'unauthorized', message: '需要登录' });
    return false;
  };

  app.get('/api/my/providers', async (request, reply) => {
    if (!needsLogin(request, reply)) return;
    const userId = currentUserId(request);
    if (!userId) return { providers: [] };
    // 不回传 Key
    return {
      providers: readUserProviders(userId).map(({ id, label, baseUrl, models }) => ({ id, label, baseUrl, models })),
    };
  });

  app.post<{ Body: { label?: string; baseUrl?: string; apiKey?: string; models?: string } }>(
    '/api/my/providers',
    async (request, reply) => {
      if (!needsLogin(request, reply)) return;
      const userId = currentUserId(request);
      if (!userId) return reply.code(400).send({ code: 'bad_request', message: '单人模式请在公用配置里添加' });
      const { label, baseUrl, apiKey, models } = request.body ?? {};
      const cleanLabel = (label ?? '').trim();
      const cleanBase = (baseUrl ?? '').trim().replace(/\/$/, '');
      const cleanKey = (apiKey ?? '').trim();
      if (!cleanLabel || !cleanBase || !cleanKey) {
        return reply.code(400).send({ code: 'bad_request', message: '名称、Base URL、Key 都要填' });
      }
      let modelList = (models ?? '')
        .split(/[,，\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      let discoveryError: string | undefined;
      if (modelList.length === 0) {
        try {
          const res = await fetch(`${cleanBase}/models`, {
            headers: { Authorization: `Bearer ${cleanKey}` },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const data = (await res.json()) as { data?: { id?: string }[] };
            modelList = (data.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
          } else if (res.status === 401) {
            discoveryError = 'API Key 无效（401）';
          } else {
            discoveryError = `厂商拒绝访问（HTTP ${res.status}）`;
          }
        } catch {
          discoveryError = '连不上厂商 /models 接口';
        }
      }

      const id = cleanLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `p-${Date.now()}`;
      const list = readUserProviders(userId);
      const entry = { id, label: cleanLabel, baseUrl: cleanBase, apiKey: cleanKey, models: modelList };
      const next = [...list.filter((p) => p.id !== id), entry];
      const path = userProvidersPath(userId);
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
      loadCustomProviders();
      try {
        writeFileSync(RELOAD_MARKER, String(Date.now()));
        const now = new Date();
        utimesSync(RELOAD_MARKER, now, now);
      } catch {
        /* ignore */
      }
      return { ok: true, id, models: modelList, discovered: modelList.length, discoveryError, restarting: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/my/providers/:id', async (request, reply) => {
    if (!needsLogin(request, reply)) return;
    const userId = currentUserId(request);
    if (!userId) return reply.code(400).send({ code: 'bad_request', message: '未登录' });
    const next = readUserProviders(userId).filter((p) => p.id !== request.params.id);
    writeFileSync(userProvidersPath(userId), JSON.stringify(next, null, 2), { mode: 0o600 });
    loadCustomProviders();
    try {
      writeFileSync(RELOAD_MARKER, String(Date.now()));
    } catch {
      /* ignore */
    }
    return { ok: true };
  });
}
