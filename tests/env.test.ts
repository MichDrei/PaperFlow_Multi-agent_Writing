/**
 * .env 加载的回归测试。
 *
 * 这里钉住的是一个真实踩过的 bug：`loadDotEnv` 曾用 `process.cwd()` 解析路径，
 * 而 `npm run dev:server`（npm workspaces 把 cwd 设为 apps/server）与
 * `npm run check:models`（cwd 是仓库根）的 cwd 不同 ——
 * 于是出现"服务端明明连上了、自检却说没配 Key"的错位，且完全不报错。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { envFileCandidates, loadDotEnv } from '../apps/server/src/env.js';

test('env 文件查找位置基于模块自身，而不是 process.cwd()（回归）', () => {
  const candidates = envFileCandidates();

  // 主位置必须是 apps/server/.env —— README 让用户放这里
  assert.ok(
    candidates.some((p) => p === resolve(candidates[0]!, '../.env') && p.endsWith('/apps/server/.env')),
    `候选列表里应包含 apps/server/.env，实际：${candidates.join(' , ')}`,
  );

  // 关键断言：换 cwd 不应改变**模块相对**的那两个候选（它们必须排在最前，优先级最高）。
  // 第三个候选是 `resolve(process.cwd(), '.env')`，按设计就该随 cwd 变，不参与比较。
  const moduleRelative = candidates.slice(0, 2);
  const originalCwd = process.cwd();
  try {
    process.chdir('/');
    assert.deepEqual(
      envFileCandidates().slice(0, 2),
      moduleRelative,
      'cwd 变化影响了 apps/server/.env 的解析结果 —— 这正是导致"服务端读到、自检说没配"的 bug',
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test('loadDotEnv：忽略注释、去掉引号、真实环境变量优先于文件', () => {
  const dir = mkdtempSync(join(process.cwd(), '.cache', 'env-test-'));
  const file = join(dir, '.env');
  writeFileSync(
    file,
    ['# 这是注释', 'PF_TEST_A=from-file', 'PF_TEST_B="带引号的值"', "PF_TEST_C='单引号'", '', 'PF_TEST_D=  '].join('\n'),
    'utf8',
  );

  process.env.PF_TEST_A = 'from-shell'; // 已存在的环境变量必须优先
  try {
    const result = loadDotEnv([file]);
    assert.deepEqual(result.loaded, [file]);
    assert.deepEqual(result.searched, []);
    assert.equal(process.env.PF_TEST_A, 'from-shell', '文件不应覆盖已存在的环境变量');
    assert.equal(process.env.PF_TEST_B, '带引号的值', '双引号应被去掉');
    assert.equal(process.env.PF_TEST_C, '单引号', '单引号应被去掉');
    assert.equal(process.env.PF_TEST_D, undefined, '空值不应写入');
  } finally {
    delete process.env.PF_TEST_A;
    delete process.env.PF_TEST_B;
    delete process.env.PF_TEST_C;
    delete process.env.PF_TEST_D;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDotEnv：文件不存在时如实报告查找过的路径（用于给出可执行提示）', () => {
  const missing = resolve(process.cwd(), '.cache', 'definitely-not-here.env');
  const result = loadDotEnv([missing]);

  assert.deepEqual(result.loaded, []);
  assert.deepEqual(result.searched, [missing]);
});
