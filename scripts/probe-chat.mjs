#!/usr/bin/env node
/**
 * 在真实浏览器里发一条消息，把聊天面板的文本打印出来。
 *
 * 用途：排查"我在输入框里发了消息，但看起来没有模型回复"这类问题。
 * 它会区分三种情况并把证据打出来：
 *   1. 消息根本没发出去（输入框没清空 / 没有用户气泡）；
 *   2. 发出去了，但后端没回（只有用户气泡）；
 *   3. 后端回了，但内容是"本地回退回复"（说明服务端没读到 API Key）。
 *
 * 用法：
 *   node scripts/probe-chat.mjs [url] [消息内容]
 *   node scripts/probe-chat.mjs http://127.0.0.1:5273 "你好，请回复 OK"
 *
 * 需要先跑过 `npx playwright install chromium`（verify:ui 用同一套环境）。
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5273';
const message = process.argv[3] ?? '你好，请简短回复 OK';
const outDir = path.resolve('artifacts');

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

// 记录浏览器实际发出的 /api 请求与响应状态——这是判断"请求有没有到后端"的关键证据
const apiCalls = [];
page.on('response', (res) => {
  const u = new URL(res.url());
  if (u.pathname.startsWith('/api')) apiCalls.push(`${res.status()} ${u.pathname}`);
});

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForSelector('#pf-composer', { timeout: 30_000 });
  await page.waitForTimeout(1500); // 等后端探测完成

  const badge = await page
    .locator('header span')
    .filter({ hasText: /Mock|模型|无 Key|离线|检测/ })
    .first()
    .innerText()
    .catch(() => '(未识别)');
  console.log(`模式徽标：${badge.trim()}`);

  await page.locator('#pf-composer').click();
  await page.locator('#pf-composer').fill(message);
  await page.keyboard.press('Enter');

  // 等待：先等到出现回复，再等到"正在生成/正在思考"消失（或最多 60 秒）
  const started = Date.now();
  let sawReply = false;
  let settled = false;
  while (Date.now() - started < 60_000) {
    await page.waitForTimeout(600);
    const body = await page.locator('body').innerText();
    const chat = body.slice(Math.max(0, body.indexOf('多模型群聊')));
    if (!sawReply && /本地回退回复|正在思考|↑|↓/.test(chat)) sawReply = true;
    const busy = /正在生成|正在思考|正在协作/.test(chat);
    if (sawReply && !busy) {
      settled = true;
      break;
    }
  }
  console.log(`流式生成已结束：${settled ? '是' : '否（超时）'}`);

  await page.screenshot({ path: path.join(outDir, 'probe-chat.png') });

  const body = await page.locator('body').innerText();
  const chatStart = body.indexOf('多模型群聊');
  // 只截取消息区（跳过阵容列表），否则真正的回复会被挤出窗口
  const chatText = chatStart >= 0 ? body.slice(chatStart).split('\n').slice(0, 200).join('\n') : body.slice(0, 2000);

  console.log(`\n浏览器发出的 /api 请求：\n${apiCalls.length ? apiCalls.map((c) => `  ${c}`).join('\n') : '  （无）'}`);
  console.log(`\n是否出现回复：${sawReply ? '是' : '否'}`);
  console.log('\n--- 聊天面板文本 ---');
  console.log(chatText);
  console.log('\n--- 控制台错误 ---');
  console.log(consoleErrors.length ? consoleErrors.join('\n') : '(无)');
  console.log(`\n截图：${path.join(outDir, 'probe-chat.png')}`);
} finally {
  await browser.close();
}
