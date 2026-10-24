/** 群聊阵容：显示 / 切换房间里的模型，并标注哪些模型尚未配置 Key（走 mock）。 */

import { Plus, RefreshCw, Users, X } from 'lucide-react';
import type { ModelDescriptor } from '@paperflow/core';
import { Avatar, Dot } from '@paperflow/ui';
import { useChatStore } from '@/stores/chatStore';
import { selectUsableModels } from '@/lib/modelSelection';

export function ModelRoster() {
  const catalog = useChatStore((s) => s.catalog);
  const backend = useChatStore((s) => s.backend);
  const participants = useChatStore((s) => s.thread.participants);
  const busy = useChatStore((s) => s.activeTurnIds.length > 0);
  const toggle = useChatStore((s) => s.toggleParticipant);
  const probeBackend = useChatStore((s) => s.probeBackend);

  // 只展示能真正回答的模型（见 lib/modelSelection.ts 的规则）
  const usable = selectUsableModels(catalog, backend);
  const inRoom = usable.filter((m) => participants.includes(m.id));
  const outRoom = usable.filter((m) => !participants.includes(m.id));
  const hiddenCount = catalog.length - usable.length;

  return (
    <div className="flex flex-col gap-1.5 border-b border-ink-800 bg-ink-900/70 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Users className="size-3 text-ink-500" />
        <span className="text-[10.5px] font-semibold tracking-wide text-ink-400 uppercase">
          阵容 {inRoom.length}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[10.5px] text-ink-500">
          {busy ? (
            <>
              <Dot accent="#4f8cff" pulse />
              正在协作
            </>
          ) : (
            '空闲'
          )}
          {/* 配好新 Key 后点一下即可把新模型拉进来，不用刷新页面 */}
          <button
            type="button"
            onClick={() => void probeBackend()}
            title="重新检测已配置的模型（在 apps/server/.env 里加了新 Key 后点这里）"
            className="ml-1 rounded p-0.5 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200"
          >
            <RefreshCw className="size-3" />
          </button>
        </span>
      </div>

      {usable.length === 0 && (
        <p className="rounded border border-accent-amber/30 bg-accent-amber/10 px-2 py-1 text-[10.5px] leading-snug text-accent-amber">
          没有检测到可用的模型。请在 <span className="font-mono">apps/server/.env</span> 中配置厂商 Key
          （<span className="font-mono">npm run check:models</span> 可自检），然后点右上角刷新。
        </p>
      )}

      <div className="flex flex-wrap gap-1">
        {inRoom.map((model) => (
          <button
            key={model.id}
            type="button"
            onClick={() => toggle(model.id)}
            title={`${model.label}\n上下文 ${(model.contextWindow / 1000).toFixed(0)}K\n擅长：${model.strengths.join('、')}\n${
              model.available ? '已配置 API Key' : '未配置 Key —— 当前由本地 mock 引擎代答'
            }\n点击移出房间`}
            className="group flex items-center gap-1.5 rounded-full border py-[2px] pr-1.5 pl-[3px] text-[10.5px] transition-colors hover:brightness-125"
            style={{ borderColor: `${model.accent}44`, background: `${model.accent}12` }}
          >
            <Avatar initials={model.initials} accent={model.accent} size={16} />
            <span className="font-medium" style={{ color: model.accent }}>
              {model.family}
            </span>
            {!model.available && <span className="text-[9px] text-ink-500">mock</span>}
            <X className="size-2.5 text-ink-500 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}

        {outRoom.map((model) => (
          <button
            key={model.id}
            type="button"
            onClick={() => toggle(model.id)}
            title={`把 ${model.label} 加入房间`}
            className="flex items-center gap-1 rounded-full border border-dashed border-ink-700 px-1.5 py-[2px] text-[10.5px] text-ink-500 transition-colors hover:border-ink-500 hover:text-ink-300"
          >
            <Plus className="size-2.5" />
            {model.family}
          </button>
        ))}
      </div>

      {hiddenCount > 0 && (
        <p className="text-[10px] leading-snug text-ink-600">
          另有 {hiddenCount} 个模型未配置 Key，已从 @ 菜单隐藏（在「模型与后端设置」里可见）
        </p>
      )}
    </div>
  );
}

/** @提及菜单与输入框里使用的行内模型标记。 */
export function modelBadge(model: ModelDescriptor) {
  return { initials: model.initials, accent: model.accent, label: model.label };
}
