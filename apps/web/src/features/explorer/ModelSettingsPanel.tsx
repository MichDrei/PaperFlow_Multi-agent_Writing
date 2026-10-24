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

        <div className="mt-2 rounded-md border border-ink-800 bg-ink-925/70 p-2">
          <div className="mb-1 flex items-center gap-1.5">
            <Zap className="size-3 text-accent-amber" />
            <span className="text-[11px] text-ink-200">接入真实模型</span>
          </div>
          <pre className="overflow-x-auto rounded bg-ink-950 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-400">
{`# apps/server/.env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
DEEPSEEK_API_KEY=...

# apps/web/.env.local
VITE_API_BASE=http://127.0.0.1:8787`}
          </pre>
          <p className="mt-1 text-[10.5px] leading-snug text-ink-500">
            配置后重启 <span className="font-mono">npm run dev</span>，顶栏模式会自动切换到真实模型。
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
