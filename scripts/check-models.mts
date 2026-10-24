#!/usr/bin/env node
/**
 * 厂商连通性自检：真实打一次最小请求，确认"Key + BaseURL + 模型名"三者都对。
 *
 * 为什么需要它：配置多厂商最难受的失败模式不是报错，而是**静默降级**——
 * Key 写错、模型名写错、跨地域调用，UI 上看起来"配好了"，实际回复来自本地回退。
 * 这个脚本把这三个变量逐个验证并打印出上游的原始错误。
 *
 * 用法：
 *   npm run check:models            # 每个已配置厂商只测第一个模型（省钱）
 *   npm run check:models -- --all   # 测全部模型（模型名批量核对时用）
 *
 * 退出码：0 = 全部通过（或没有配置任何厂商）；1 = 有厂商调用失败。
 */

import { existsSync, readFileSync } from 'node:fs';
import { buildProviders } from '@paperflow/llm';
import { envFileCandidates, loadDotEnv } from '../apps/server/src/env.js';

const dotEnv = loadDotEnv();

/**
 * 找出"写了 Key 但被注释掉"的行。
 *
 * 这是新手最容易踩的坑：.env.example 里的示例行本身就是注释（# KEY=sk-xxx），
 * 直接往里填值而不删掉行首的 `#`，文件看着"填好了"，程序读到的却是空。
 * 而且它**不报错**——只是静默降级到本地回退。所以这里主动检测并点名行号。
 */
/**
 * 扫描 .env 里的 `# KEY=值` 行，分两类：
 *  - 值是**真实密钥**（看着像真的）但被注释掉 → ⚠️ 用户填了却忘了删 `#`，必须点名；
 *  - 值还是**占位符**（sk-xxxx / sk-ant-... / 你的xxx）→ ℹ️ 提示"改成真 Key 并删掉 #"。
 *
 * 为什么值得单独做：这两类都**不会报错**，只会静默降级到本地回退，
 * 而 .env.example 里的示例行本身就以 `#` 开头，非常容易"填在注释里"。
 */
interface KeyLine {
  file: string;
  line: number;
  name: string;
  value: string;
}

function isPlaceholder(value: string): boolean {
  return (
    /^sk-x+$/i.test(value) ||
    value.includes('...') ||
    /xxxx/i.test(value) ||
    /你的/.test(value) ||
    /your[-_ ]/i.test(value)
  );
}

function scanKeyLines(): { real: KeyLine[]; placeholder: KeyLine[] } {
  const real: KeyLine[] = [];
  const placeholder: KeyLine[] = [];
  // 只关心 *_API_KEY：_MODELS 之类的示例注释是有意为之，不该被当成"忘了取消注释"
  const KEY_LINE = /^\s*#\s*([A-Z][A-Z0-9_]*_API_KEY)\s*=\s*(\S.*)?$/;

  for (const file of dotEnv.loaded) {
    if (!existsSync(file)) continue;
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((raw, idx) => {
        const m = KEY_LINE.exec(raw);
        if (!m) return;
        const value = (m[2] ?? '').trim();
        if (!value) return;
        const entry: KeyLine = { file, line: idx + 1, name: m[1]!, value };
        // 值不像占位符、且长度够长 → 判定为"真填了但被注释"
        if (!isPlaceholder(value) && value.length >= 12) real.push(entry);
        else placeholder.push(entry);
      });
  }
  return { real, placeholder };
}

const scanned = scanKeyLines();

/**
 * 直接问厂商"我这个账号能用哪些模型"（OpenAI 兼容的 GET /models）。
 *
 * 为什么需要：厂商会不断下线/改名模型，而默认值是写死在代码里的。
 * 猜模型名很不可靠——文档上写着可用的模型，账号里可能没有权限（实测撞到过
 * `Not found the model kimi-k3 or Permission denied`）。问接口才是唯一权威来源。
 */
async function discoverModels(provider: { id: string; label: string; baseUrl?: string }, apiKey: string): Promise<string[] | null> {
  if (!provider.baseUrl) return null;
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: { id?: string }[] };
    const ids = (payload.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return ids.length > 0 ? ids : null;
  } catch {
    return null; // 该厂商没实现 /models，或网络不通
  }
}

/** 从环境变量里取该厂商的 Key（用于探测）。 */
function apiKeyFor(env: NodeJS.ProcessEnv, providerId: string): string | undefined {
  const map: Record<string, string[]> = {
    deepseek: ['DEEPSEEK_API_KEY'],
    moonshot: ['MOONSHOT_API_KEY'],
    qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
  };
  for (const key of map[providerId] ?? []) {
    const value = env[key];
    if (value) return value;
  }
  return undefined;
}

console.log('PaperFlow 厂商自检');
console.log('='.repeat(72));
console.log('读取的配置文件：');
if (dotEnv.loaded.length === 0) {
  console.log('  （没有找到任何 .env —— 请创建 apps/server/.env）');
} else {
  for (const file of dotEnv.loaded) console.log(`  ✓ ${file}`);
}

if (scanned.real.length > 0) {
  console.log('');
  console.log('⚠️  这些行填了真实密钥，但**行首有 # 被注释掉了**，等于没配：');
  for (const hit of scanned.real) {
    console.log(`    ${hit.file}:${hit.line}   ${hit.name}`);
  }
  console.log('    → 删掉行首的 # 即可生效。');
} else if (scanned.placeholder.length > 0) {
  console.log('');
  console.log(`ℹ️  发现 ${scanned.placeholder.length} 行 Key 仍是"注释 + 占位符"状态，即尚未配置：`);
  for (const hit of scanned.placeholder.slice(0, 6)) {
    console.log(`    ${hit.file}:${hit.line}   ${hit.name} = ${hit.value.slice(0, 12)}…`);
  }
  console.log('    → 删掉行首的 #，并把占位符替换成真实 Key。');
}
console.log('='.repeat(72));

const testAll = process.argv.includes('--all');
const discoverOnly = process.argv.includes('--discover');
const providers = buildProviders(process.env).filter((p) => p.id !== 'mock');

/** 每个厂商真正需要的环境变量（本地推理不要 Key，要地址）。 */
function credentialHint(id: string): string {
  switch (id) {
    case 'qwen':
      return 'QWEN_API_KEY（或官方文档里的 DASHSCOPE_API_KEY）';
    case 'google':
      return 'GOOGLE_API_KEY（或 GEMINI_API_KEY）';
    case 'ollama':
      return 'OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 + OLLAMA_MODELS=模型名';
    default:
      return `${id.toUpperCase()}_API_KEY`;
  }
}

const configured = providers.filter((p) => p.isConfigured());
const unconfigured = providers.filter((p) => !p.isConfigured());

if (configured.length === 0) {
  console.log('没有检测到任何厂商 API Key —— 平台会使用本地回退引擎（功能完整，但不调用真实模型）。');
  console.log('');
  console.log('配置方法：cp apps/server/.env.example apps/server/.env，然后**删掉行首的 #** 并填入 Key：');
  console.log(`  （程序会查找这些位置：${envFileCandidates().join(' 、 ')}）`);
  for (const p of unconfigured) {
    console.log(`  ${p.label.padEnd(18)} ${credentialHint(p.id)}`);
  }
  process.exit(0);
}

// --discover：只列出各账号真实可用的模型，不做对话测试
if (discoverOnly) {
  for (const provider of providers) {
    const key = apiKeyFor(process.env, provider.id);
    if (!provider.isConfigured() || !key) {
      console.log(`· ${provider.label.padEnd(18)} 未配置 —— 跳过`);
      continue;
    }
    const discovered = await discoverModels({ id: provider.id, label: provider.label, baseUrl: (provider as { baseUrl?: string }).baseUrl }, key);
    if (discovered) {
      console.log(`✓ ${provider.label.padEnd(18)} 账号可用模型（${discovered.length}）:`);
      console.log(`    ${discovered.join(', ')}`);
      const configured = provider.models();
      const missing = configured.filter((m) => !discovered.includes(m));
      if (missing.length > 0) {
        // 注意：/models 往往**不列出别名**（例如 DeepSeek 不列 deepseek-chat，但它能正常调用）。
        // 所以这里只能提示"不在列表里"，不能断言"用不了"——要确认必须实测（check:models）。
        console.log(`    ℹ 默认配置中的这些不在上面的列表里：${missing.join(', ')}`);
        console.log('      （/models 通常不列别名，因此不一定不可用；要确认请直接跑 check:models）');
      }
    } else {
      console.log(`· ${provider.label.padEnd(18)} 该厂商未提供 /models 接口（无法自动发现）`);
    }
  }
  process.exit(0);
}

let failures = 0;

for (const provider of providers) {
  const mark = provider.isConfigured() ? '✓' : '·';
  const models = provider.models();
  const targets = provider.isConfigured() ? (testAll ? models : models.slice(0, 1)) : [];

  console.log(
    `${mark} ${provider.label.padEnd(18)} ${provider.isConfigured() ? `已配置 · ${models.length} 个模型` : '未配置 Key —— 跳过'}`,
  );
  if (provider.isConfigured() && models.length === 0) {
    console.log('    ⚠ 已配置 Key 但没有声明任何模型（用 <PROVIDER>_MODELS 指定，逗号分隔）');
  }

  for (const model of targets) {
    const startedAt = Date.now();
    let text = '';
    try {
      // 与线上同样的参数：适配器会自动处理"该模型只接受 temperature=1"这类限制
      const stream = provider.stream({
        model,
        messages: [
          { role: 'system', content: '你是测试探针，只回答一个词。' },
          { role: 'user', content: '回复：OK' },
        ],
        // 给足 token：思考模型（Kimi K2.6、DeepSeek R1 等）会先花掉一部分在推理上，
        // 之前用 16 个 token 会出现"调用成功但正文为空"的假象。
        maxTokens: 64,
        temperature: 0.4,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text') text += chunk.text;
        if (text.length > 60) break;
      }
      const ms = Date.now() - startedAt;
      const preview = text.trim();
      if (preview.length === 0) {
        // 调用成功但没有正文：多半是思考模型把预算用在了推理上，或该模型要求更长的输出上限
        console.log(`    ~ ${model.padEnd(26)} ${String(ms).padStart(5)}ms  调用成功但正文为空（思考模型？可加大 max_tokens 再看）`);
      } else {
        console.log(`    ✓ ${model.padEnd(26)} ${String(ms).padStart(5)}ms  ${JSON.stringify(preview.slice(0, 40))}`);
      }
    } catch (err) {
      failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`    ✗ ${model.padEnd(26)} 失败：${message.slice(0, 220)}`);
      // 提示必须精确，否则会把用户带偏：
      // 曾经因为看到 "invalid ... this model" 就断言"模型名不对"，
      // 而真实原因是"该模型只允许 temperature=1"——两个完全不同的修法。
      const looksLikeMissingModel =
        /model[_ ]?not[_ ]?found|no such model|model.*(does not exist|doesn't exist|not exist|unknown|unsupported)/i.test(
          message,
        ) && !/temperature|top_p|max_tokens|stream_options|parameter/i.test(message);
      const looksLikeParameterIssue = /temperature|top_p|stream_options|parameter/i.test(message);
      const looksLikeAuthIssue = /invalid_api_key|401|Incorrect API key/i.test(message);
      const looksLikeQuota = /429|rate limit|quota|arrears|overload|busy/i.test(message);

      if (looksLikeMissingModel) {
        console.log(`      ↳ 模型名不存在。用 ${provider.id.toUpperCase()}_MODELS=实际模型名 覆盖。`);
      } else if (looksLikeParameterIssue) {
        console.log('      ↳ 这是"参数不被该模型接受"，不是模型名问题。适配器会自动去掉该参数重试；');
        console.log('        自检脚本为了暴露真实错误没有走降级，因此在自检里看到它属于正常现象。');
      } else if (looksLikeAuthIssue) {
        console.log('      ↳ Key 或地域不匹配（DashScope 的 Key 与地域绑定，跨地域调用会 401）。');
      } else if (looksLikeQuota) {
        console.log('      ↳ 上游限流或过载，稍后重试即可（不是配置问题）。');
      }
    }
  }
}

console.log('='.repeat(72));
if (failures === 0) {
  console.log(`全部通过：${configured.length} 个厂商可用。现在启动 npm run dev，顶栏会显示「真实模型」。`);
  process.exit(0);
}
console.log(`${failures} 个模型调用失败，请按上面的提示修正 apps/server/.env。`);
process.exit(1);
