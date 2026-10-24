/**
 * "@ 菜单里到底该出现哪些模型"的规则测试。
 *
 * 产品要求（用户明确提出）：只显示**真正配了 Key、能回答**的模型；
 * 没配置的模型不得出现在 @ 菜单与阵容里，配了新 Key 后自动出现。
 *
 * 这里有三种边界状态，判断错了界面会变空或变死，所以必须钉住。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_MODEL_CATALOG, type ModelDescriptor } from '@paperflow/core';
import { defaultRoom, selectUsableModels, syncRoom } from '../apps/web/src/lib/modelSelection.js';

const model = (id: string, available: boolean): ModelDescriptor => ({
  ...DEFAULT_MODEL_CATALOG[0]!,
  id,
  label: id,
  available,
});

const catalog = [
  model('claude-sonnet-4', false),
  model('deepseek-chat', true),
  model('gpt-4o', false),
  model('qwen-plus', true),
  model('deepseek-reasoner', true),
  model('kimi-k2', false),
];

test('已连后端时：只保留真正可用的模型，未配置的一律不出现', () => {
  const usable = selectUsableModels(catalog, { mode: 'http', status: 'online' });
  assert.deepEqual(
    usable.map((m) => m.id),
    ['deepseek-chat', 'qwen-plus', 'deepseek-reasoner'],
  );
});

test('浏览器内 mock 模式：本地引擎可代答任意模型，因此全部保留', () => {
  const usable = selectUsableModels(catalog, { mode: 'browser-mock', status: 'online' });
  assert.equal(usable.length, catalog.length, '否则无后端时界面会变成空的、无法使用');
});

test('后端尚未探测完：先不过滤，避免界面闪一下空阵容', () => {
  const usable = selectUsableModels(catalog, { mode: 'http', status: 'unknown' });
  assert.equal(usable.length, catalog.length);
});

test('显式配置的后端连不上：如实返回空列表而不假装有模型', () => {
  const usable = selectUsableModels(catalog, { mode: 'http', status: 'offline' });
  assert.deepEqual(usable, []);
});

test('阵容自动跟随可用模型（用户没手动改过时）', () => {
  const usable = selectUsableModels(catalog, { mode: 'http', status: 'online' });

  // 从"旧的静态阵容"切到"只有 DS/Qwen 可用" —— 这正是加了 Key 之后的场景
  const synced = syncRoom(['claude-sonnet-4', 'gpt-4o', 'gemini-2.5-pro', 'deepseek-chat'], usable, false);
  assert.deepEqual(synced, ['deepseek-chat', 'qwen-plus', 'deepseek-reasoner'], '未配置的模型应被剔除');

  // 新增一个厂商后，阵容自动跟上
  const withClaude = [...catalog.map((m) => (m.id === 'claude-sonnet-4' ? { ...m, available: true } : m))];
  const usable2 = selectUsableModels(withClaude, { mode: 'http', status: 'online' });
  const synced2 = syncRoom(synced, usable2, false);
  assert.ok(synced2.includes('claude-sonnet-4'), '新配好的厂商应自动进入默认阵容');
  assert.equal(synced2.length, 4, `默认阵容最多 ${4} 个`);
});

test('用户手动调整过阵容时，保留其选择，仅剔除已不可用的', () => {
  const usable = selectUsableModels(catalog, { mode: 'http', status: 'online' });

  // 用户手动选了 deepseek-chat + kimi-k2；kimi 没有 Key → 只保留 deepseek-chat
  const kept = syncRoom(['deepseek-chat', 'kimi-k2'], usable, true);
  assert.deepEqual(kept, ['deepseek-chat']);

  // 用户选的全都不可用了 → 退回最小默认阵容，避免房间空着
  const fallback = syncRoom(['kimi-k2'], usable, true);
  assert.deepEqual(fallback, ['deepseek-chat', 'qwen-plus']);
});

test('defaultRoom：按目录顺序取前 N 个可用模型', () => {
  const usable = selectUsableModels(catalog, { mode: 'http', status: 'online' });
  assert.deepEqual(defaultRoom(usable, 2), ['deepseek-chat', 'qwen-plus']);
});
