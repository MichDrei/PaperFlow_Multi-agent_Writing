/**
 * 模型可选性判定：决定"哪些模型应该出现在 @ 菜单和阵容里"。
 *
 * 产品规则（用户明确要求）：**只显示真正能回答的模型**。
 * 没有配置 Key 的模型一旦出现在 @ 菜单里，点它只会拿到本地回退回复，
 * 既浪费注意力也误导判断——所以它们只在「模型与后端设置」面板里作为待配置项出现。
 *
 * 抽成纯函数的原因：这里有三种边界状态（未探测完 / 浏览器内 mock / 后端离线），
 * 判断错了会直接让界面变成空的或死的，必须有测试钉住。
 */

import type { ModelDescriptor, ModelId } from '@paperflow/core';

export interface BackendLike {
  mode: 'browser-mock' | 'http';
  status: 'unknown' | 'online' | 'offline';
}

/** 默认阵容大小：一次并行调用 4 个模型已经是成本与信息量的平衡点。 */
export const DEFAULT_ROOM_SIZE = 4;

export function selectUsableModels(catalog: ModelDescriptor[], backend: BackendLike): ModelDescriptor[] {
  // 浏览器内 mock：不存在"已配置厂商"这回事，本地引擎可以代答目录里的任意模型。
  if (backend.mode === 'browser-mock') return catalog;

  // 还没探测完后端：先不做过滤，避免界面闪一下"空阵容 / 空菜单"。
  // （探测在挂载后立刻进行，通常 10ms 内完成。）
  if (backend.status === 'unknown') return catalog;

  // 显式配置了后端地址但连不上：没有任何模型能回答，如实返回空列表。
  if (backend.status === 'offline') return [];

  // 已连上后端：只保留厂商 Key 真正可用的模型。
  return catalog.filter((model) => model.available);
}

/** 未被用户手动调整过的默认阵容：取最前面几个可用模型。 */
export function defaultRoom(usable: ModelDescriptor[], size = DEFAULT_ROOM_SIZE): ModelId[] {
  return usable.slice(0, size).map((m) => m.id);
}

/**
 * 让阵容跟随可用模型变化：
 * - 用户没手动调整过 → 直接用新的默认阵容（"我加了 Key，阵容自动跟上"）；
 * - 用户调整过 → 保留他选的，只剔除已不可用的；若全被剔除则退回一个最小默认阵容。
 */
export function syncRoom(
  current: ModelId[],
  usable: ModelDescriptor[],
  roomTouchedByUser: boolean,
): ModelId[] {
  if (!roomTouchedByUser) return defaultRoom(usable);

  const usableIds = new Set(usable.map((m) => m.id));
  const kept = current.filter((id) => usableIds.has(id));
  return kept.length > 0 ? kept : defaultRoom(usable, 2);
}
