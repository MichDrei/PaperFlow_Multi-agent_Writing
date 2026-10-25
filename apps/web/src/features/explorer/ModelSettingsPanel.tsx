import { useSessionStore } from '@/stores/sessionStore';
import { apiUrl } from '@/lib/backend';

/**
 * 内置厂商预设。
 *
 * 用户手里通常**只有一串 Key**，不该被要求知道 Base URL。
 * 这里把地址、常用模型名都预置好，选中厂商后只需要粘 Key。
 * 全部按 OpenAI 兼容协议对接（所以能统一走自定义 provider 那条路）。
 */
const VENDOR_PRESETS = [
  { id: 'stepfun', label: '阶跃星辰 StepFun', baseUrl: 'https://api.stepfun.com/v1', models: '', hint: 'https://platform.stepfun.com/interface-key' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: '', hint: 'https://bigmodel.cn/usercenter/apikeys' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: '', hint: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', models: '', hint: 'https://platform.minimaxi.com/user-center/basic-information/interface-key' },
  { id: 'baichuan', label: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1', models: '', hint: 'https://platform.baichuan-ai.com/console/apikey' },
  { id: 'mimo', label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', models: '', hint: 'https://platform.xiaomimimo.com/#/console/api-keys' },
  { id: 'openrouter', label: 'OpenRouter（聚合）', baseUrl: 'https://openrouter.ai/api/v1', models: '', hint: 'https://openrouter.ai/keys' },
  { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', models: '', hint: '本地安装后无需 Key，随便填' },
  { id: 'custom', label: '其他 / 中转站（自己填地址）', baseUrl: '', models: '', hint: '' },
] as const;


import { useEffect, useState } from 'react';
/**
 * 模型与后端设置面板。
 *
 * 原型阶段这里如实展示"当前跑在什么模式"：后端是本地 mock 还是真实编排服务，
 * 编译是浏览器端 MockCompiler 还是远端 TeX 服务。避免用户误以为已经接了真模型。
 */

import { Cpu, Server, Settings2, Terminal, Zap } from 'lucide-react';
import { Avatar, Pill } from '@paperflow/ui';
import { useChatStore } from '@/stores/chatStore';
import { selectUsableModels } from '@/lib/modelSelection';

const envBase = import.meta.env.VITE_API_BASE as string | undefined;
const envCompiler = import.meta.env.VITE_COMPILER_URL as string | undefined;


/** 在界面里直接填 Key：不用改文件、不用记环境变量名。 */
function KeyForm({ scope = 'public' }: { scope?: 'public' | 'mine' }) {
  /** 只有发起方可以改公用模型配置（成员只能看）。 */
  const isOwner = useSessionStore((s) => s.me?.isOwner ?? s.mode !== 'team');
  const [providers, setProviders] = useState<{ id: string; label: string; hint: string; configured: boolean }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState({ label: '', baseUrl: '', apiKey: '', models: '' });
  const [found, setFound] = useState(0);

  const load = () =>
    fetch(apiUrl('/api/keys'))
      .then((r) => r.json())
      .then((d: { providers: typeof providers }) => setProviders(d.providers ?? []))
      .catch(() => {});

  useEffect(() => {
    void load();
  }, []);

  const save = async (env: string) => {
    setBusy(true);
    try {
      await fetch(apiUrl('/api/keys'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env, value }),
      });
      setSaved(true);
      setEditing(null);
      setValue('');
      setTimeout(() => setSaved(false), 4000);
    } finally {
      setBusy(false);
    }
  };

  const saveCustom = async () => {
    setBusy(true);
    try {
      // 预设里已经带了 baseUrl 和模型名，用户只需要填 Key
      const preset = VENDOR_PRESETS.find((v) => v.label === custom.label);
      const endpoint = scope === 'mine' ? '/api/my/providers' : '/api/providers/custom';
      const res = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: custom.label,
          baseUrl: custom.baseUrl || preset?.baseUrl || '',
          models: custom.models || preset?.models || '',
          apiKey: custom.apiKey,
        }),
      });
      const data = (await res.json()) as { discovered?: number; models?: string[]; discoveryError?: string };
      setFound(data.discovered ?? data.models?.length ?? 0);
      if (data.discoveryError) {
        // 让用户知道为什么没拿到模型（之前静默返回 0，很难排查）
        window.alert(data.discoveryError);
      }
      setAdding(false);
      setCustom({ label: '', baseUrl: '', apiKey: '', models: '' });
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } finally {
      setBusy(false);
    }
  };

  if (scope === 'public' && !isOwner) {
    return (
      <section className="rounded-md border border-ink-800 bg-ink-850/60 p-2">
        <h3 className="text-[11px] font-medium text-ink-300">公用模型由发起方配置</h3>
        <p className="mt-1 text-[10px] leading-snug text-ink-500">
          你可以在群聊里 @ 这些模型使用；要添加自己的 Key，请让发起方开通个人模型（开发中）。
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-1.5 rounded-md border border-ink-750 bg-ink-850/60 p-2">
      <h3 className="text-[11px] font-medium text-ink-300">在这里粘贴 API Key</h3>
      <p className="text-[10px] leading-snug text-ink-500">
        粘贴后点「保存」，服务会自动重启并生效——不需要改任何文件。
      </p>
      {providers.map((p) => (
        <div key={p.id} className="rounded border border-ink-800 px-1.5 py-1">
          <div className="flex items-center gap-1.5">
            <span className="flex-1 truncate text-[11px] text-ink-200">{p.label}</span>
            {p.configured ? (
              <span className="text-[10px] text-emerald-400">已配置</span>
            ) : (
              <span className="text-[10px] text-ink-600">未配置</span>
            )}
            <button
              type="button"
              onClick={() => {
                setEditing(editing === p.id ? null : p.id);
                setValue('');
              }}
              className="rounded px-1 text-[10px] text-brand-300 hover:bg-brand-500/15"
            >
              {editing === p.id ? '取消' : p.configured ? '更换' : '填入'}
            </button>
          </div>
          {editing === p.id && (
            <div className="mt-1 flex items-center gap-1">
              <input
                type="password"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="粘贴 Key（sk-…）"
                className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-100 placeholder:text-ink-600 focus:border-brand-600/60 focus:outline-none"
              />
              <button
                type="button"
                disabled={busy || !value.trim()}
                onClick={() => void save(`${{ deepseek: 'DEEPSEEK_API_KEY', qwen: 'QWEN_API_KEY', moonshot: 'MOONSHOT_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_API_KEY' }[p.id] ?? ''}`)}
                className="rounded bg-brand-600 px-1.5 py-0.5 text-[10px] text-white disabled:opacity-40"
              >
                保存
              </button>
            </div>
          )}
        </div>
      ))}
      {saved && <p className="text-[10px] text-emerald-400">已保存，服务正在重启（约 2 秒）…</p>}

      {/* 添加厂商：先选厂商（地址/模型名已预置），只需要粘 Key */}
      {adding ? (
        <div className="space-y-1 rounded border border-brand-600/40 bg-ink-900/60 p-1.5">
          <select
            value={custom.label}
            onChange={(e) => {
              const preset = VENDOR_PRESETS.find((v) => v.label === e.target.value);
              setCustom({
                label: preset?.label ?? '',
                baseUrl: preset?.baseUrl ?? '',
                apiKey: custom.apiKey,
                // 关键：**不要**预填模型名。留空才会去厂商的 /models 拉清单
                //（之前预填了 step-2，既过时又让"自动获取"被跳过）
                models: '',
              });
            }}
            className="w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-100"
          >
            <option value="">选择厂商…</option>
            {VENDOR_PRESETS.map((v) => (
              <option key={v.id} value={v.label}>
                {v.label}
              </option>
            ))}
          </select>

          {custom.label && (
            <>
              <input
                type="password"
                autoFocus
                value={custom.apiKey}
                onChange={(e) => setCustom({ ...custom, apiKey: e.target.value })}
                placeholder="粘贴这个厂商的 API Key"
                className="w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-100 placeholder:text-ink-600"
              />
              <input
                value={custom.models}
                onChange={(e) => setCustom({ ...custom, models: e.target.value })}
                placeholder="模型名（留空 = 自动从厂商获取，推荐）"
                className="w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-100 placeholder:text-ink-600"
              />
              <input
                value={custom.baseUrl}
                onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })}
                placeholder="Base URL（已自动填好，通常不用改）"
                className="w-full rounded border border-ink-750 bg-ink-850 px-1.5 py-0.5 font-mono text-[10px] text-ink-400 placeholder:text-ink-600"
              />
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={busy || !custom.apiKey.trim()}
                  onClick={() => void saveCustom()}
                  className="rounded bg-brand-600 px-1.5 py-0.5 text-[10px] text-white disabled:opacity-40"
                >
                  保存并启用
                </button>
                <button type="button" onClick={() => setAdding(false)} className="text-[10px] text-ink-500 hover:text-ink-200">
                  取消
                </button>
                {found && <span className="text-[10px] text-emerald-400">已发现 {found} 个模型</span>}
                {VENDOR_PRESETS.find((v) => v.label === custom.label)?.hint && (
                  <a
                    href={VENDOR_PRESETS.find((v) => v.label === custom.label)?.hint}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-[10px] text-brand-300 hover:underline"
                  >
                    去哪里拿 Key ↗
                  </a>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full rounded border border-dashed border-ink-700 px-1.5 py-1 text-[10.5px] text-ink-400 hover:border-brand-600/60 hover:text-brand-300"
        >
          ＋ 添加其他厂商 / 中转站
        </button>
      )}
    </section>
  );
}

export function ModelSettingsPanel() {
  const catalog = useChatStore((s) => s.catalog);
  const participants = useChatStore((s) => s.thread.participants);
  const toggle = useChatStore((s) => s.toggleParticipant);
  const backend = useChatStore((s) => s.backend);

  const realProviders = backend.providers.filter((p) => p.id !== 'mock');
  const usable = selectUsableModels(catalog, backend);
  const usableIds = new Set(usable.map((m) => m.id));
  const unusable = catalog.filter((m) => !usableIds.has(m.id));
  const backendPill = (() => {
    if (backend.mode === 'browser-mock') return { label: '浏览器内 mock', color: '#f5b544' };
    if (backend.status === 'offline') return { label: '离线', color: '#f4636c' };
    if (backend.status === 'unknown') return { label: '检测中', color: '#74829a' };
    return backend.hasRealProvider
      ? { label: 'HTTP / SSE · 已接入真实模型', color: '#2dd4bf' }
      : { label: 'HTTP / SSE · 仅本地回退', color: '#f5b544' };
  })();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Settings2 className="size-3 text-ink-500" />
        <span className="text-[10.5px] font-semibold tracking-wide text-ink-400 uppercase">模型与后端</span>
      </div>

      {/* 最显眼的位置放"粘贴 Key"，新手第一眼就能完成配置 */}
      <div className="px-2.5 pb-1.5">
        <KeyForm scope="public" />
        {/* 我的模型：每人自己一份，只在私聊可见 */}
        <div className="mt-1.5">
          <KeyForm scope="mine" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        <div className="space-y-1.5 rounded-md border border-ink-800 bg-ink-925/70 p-2">
          <div className="flex items-center gap-1.5">
            <Server className="size-3 text-brand-400" />
            <span className="text-[11px] text-ink-200">编排后端</span>
            <Pill accent={backendPill.color} className="ml-auto">
              {backendPill.label}
            </Pill>
          </div>
          <p className="text-[10.5px] leading-snug text-ink-500">
            {backend.mode === 'http' ? (
              <>
                已连接 <span className="font-mono text-ink-300">{envBase}</span>
                {backend.status === 'offline' && (
                  <span className="text-accent-rose"> · 连接失败：{backend.error}</span>
                )}
              </>
            ) : (
              <>
                未设置 <span className="font-mono text-ink-300">VITE_API_BASE</span>，所有回复由浏览器内的本地引擎生成。
              </>
            )}
          </p>

          {backend.mode === 'http' && realProviders.length > 0 && (
            <ul className="mt-1 space-y-[3px] border-t border-ink-800 pt-1.5">
              {realProviders.map((provider) => (
                <li key={provider.id} className="flex items-center gap-1.5 text-[10px]">
                  <span
                    className={`size-1.5 rounded-full ${provider.configured ? 'bg-accent-teal' : 'bg-ink-600'}`}
                  />
                  <span className="text-ink-300">{provider.label}</span>
                  <span className="ml-auto font-mono text-ink-600">
                    {provider.configured ? `${provider.models.length} 个模型` : '未配置 Key'}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-1.5 pt-1">
            <Terminal className="size-3 text-accent-violet" />
            <span className="text-[11px] text-ink-200">LaTeX 编译</span>
            <Pill accent={envCompiler ? '#2dd4bf' : '#f5b544'} className="ml-auto">
              {envCompiler ? '远端 TeX 服务' : '浏览器内 mock'}
            </Pill>
          </div>
          <p className="text-[10.5px] leading-snug text-ink-500">
            {envCompiler ? (
              <span className="font-mono text-ink-300">{envCompiler}</span>
            ) : (
              <>MockCompiler 把源码粗排成真实 PDF，用于打通「编辑 → 编译 → 预览 → 定位」链路。</>
            )}
          </p>
        </div>


        <div className="mt-2">
          <div className="mb-1 flex items-center gap-1.5 px-0.5">
            <Cpu className="size-3 text-accent-teal" />
            <span className="text-[10.5px] font-semibold tracking-wide text-ink-400 uppercase">
              可用模型 {usable.length}
            </span>
            <span className="ml-auto text-[9.5px] text-ink-600">会出现在 @ 菜单里</span>
          </div>
          {usable.length === 0 && (
            <p className="rounded border border-accent-amber/30 bg-accent-amber/10 px-2 py-1.5 text-[10.5px] leading-snug text-accent-amber">
              还没有可用模型。请在 <span className="font-mono">apps/server/.env</span> 里配置厂商 Key，
              运行 <span className="font-mono">npm run check:models</span> 自检，然后回到阵容处点刷新。
            </p>
          )}
          <ul className="space-y-1">
            {usable.map((m) => {
              const inRoom = participants.includes(m.id);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
                      inRoom ? 'border-ink-700 bg-ink-850/60' : 'border-ink-800 bg-transparent opacity-70'
                    }`}
                  >
                    <Avatar initials={m.initials} accent={m.accent} size={20} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-ink-100">{m.label}</span>
                      <span className="block truncate font-mono text-[9.5px] text-ink-500">
                        {m.provider} · {(m.contextWindow / 1000).toFixed(0)}K
                      </span>
                    </span>
                    <span
                      className="shrink-0 rounded px-1 py-[1px] text-[9.5px]"
                      style={{ background: `${m.accent}18`, color: m.accent }}
                    >
                      {inRoom ? '在房间' : '未启用'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {unusable.length > 0 && (
            <>
              <div className="mt-3 mb-1 flex items-center gap-1.5 px-0.5">
                <Cpu className="size-3 text-ink-600" />
                <span className="text-[10.5px] font-semibold tracking-wide text-ink-500 uppercase">
                  未配置 {unusable.length}
                </span>
                <span className="ml-auto text-[9.5px] text-ink-600">配置 Key 后自动出现</span>
              </div>
              <ul className="space-y-1">
                {unusable.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 rounded-md border border-ink-850 px-2 py-1 opacity-55">
                    <Avatar initials={m.initials} accent={m.accent} size={18} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-ink-300">{m.label}</span>
                      <span className="block truncate font-mono text-[9.5px] text-ink-600">
                        {m.provider}
                        {m.provider === 'qwen' ? ' · QWEN_API_KEY' : m.provider === 'deepseek' ? ' · DEEPSEEK_API_KEY' : ` · ${m.provider.toUpperCase()}_API_KEY`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
