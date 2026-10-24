/**
 * UI 冒烟测试：用真实浏览器验证「编辑 → 选区 → @群聊 → diff → 应用」这条主链路。
 *
 * 用法：
 *   node scripts/verify-ui.mjs [url]
 *
 * 退出码：0 = 全链路通过；1 = 有步骤失败或控制台出现错误。
 * 产物：artifacts/*.png（各阶段截图）、artifacts/verify-ui.json（结构化报告）。
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5273';
// 产物前缀：区分「浏览器内 mock」与「真实后端」两轮验证，避免互相覆盖。
const tag = process.env.VERIFY_TAG ?? 'ui';
const outDir = path.resolve('artifacts');
const steps = [];
const consoleErrors = [];
const consoleNoise = [];
let bodyDump = '';

// 允许"后端探测失败"：只跑前端（npm run dev:web）时，自动探测 /api 会得到 500/502，
// 浏览器会在控制台打一条资源加载失败日志——这是预期行为，不是应用错误。
// 默认仍然严格（任何控制台错误都判失败），只有显式开关才放宽，避免掩盖真问题（比如 CORS 头丢失）。
const allowProbeFailure = process.env.ALLOW_BACKEND_PROBE_FAILURE === '1';
const PROBE_PATTERN = /\/api\//;

const record = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });

page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const url = msg.location()?.url ?? '';
  const entry = url ? `${msg.text()} [${url}]` : msg.text();
  if (allowProbeFailure && PROBE_PATTERN.test(url)) consoleNoise.push(entry);
  else consoleErrors.push(entry);
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  record('页面加载', true, url);

  await page.waitForSelector('.monaco-editor', { timeout: 30_000 });
  record('Monaco 编辑器挂载', true);

  // 等待首次编译产出 canvas（MockCompiler 是纯前端编译，毫秒级）
  await page.waitForSelector('canvas', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outDir, `${tag}-01-initial.png`) });
  record('PDF 预览渲染', true, 'canvas 已出现');

  const modelChips = await page.locator('text=/阵容/').count();
  record('群聊阵容渲染', modelChips > 0, `找到 ${modelChips} 个阵容标识`);

  // —— 选区 → 浮动工具栏 ——
  // 选中一段真正的正文段落（而不是 \begin{document} 这类命令块），
  // 这样"改写 → diff"才有可对比的语义内容。
  const line = page.locator('.view-line').filter({ hasText: 'bottlenecked by the autoregressive' }).first();
  await line.click({ position: { x: 60, y: 8 } });
  await page.keyboard.down('Shift');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Shift');

  const toolbar = page.locator('[data-testid="selection-toolbar"]');
  await toolbar.waitFor({ timeout: 8000 });
  const toolbarText = (await toolbar.innerText()).replace(/\s+/g, ' ');
  record('选区浮动工具栏出现', true, toolbarText.slice(0, 60));
  await page.screenshot({ path: path.join(outDir, `${tag}-02-selection.png`) });

  // —— 一键交给群聊做"压缩" ——
  await toolbar.getByRole('button', { name: '压缩' }).click();

  // 真实模型未必每次都给出可应用的改写（常见：它其实把原文抄了一遍，或认为无需修改）。
  // 因此这里接受两种合法结果：出现 diff 卡片，或出现"本轮没有生成可应用的 diff"的系统说明。
  // 浏览器内 mock 模式是确定性的，必须出 diff（下面的断言会区分）。
  const diffOrNote = await Promise.race([
    page
      .waitForSelector('text=/待裁决/', { timeout: 45_000 })
      .then(() => 'diff')
      .catch(() => null),
    page
      .waitForSelector('text=/没有生成可应用的 diff/', { timeout: 45_000 })
      .then(() => 'note')
      .catch(() => null),
  ]);

  const isMockMode = /浏览器内 mock/.test(await page.locator('body').innerText());
  if (isMockMode) {
    if (diffOrNote !== 'diff') throw new Error('浏览器内 mock 模式下必须产出 diff 卡片');
    record('模型返回 diff 提议', true, '出现「待裁决」diff 卡片（mock 模式，确定性）');
  } else {
    record(
      '选段改写流程完成',
      diffOrNote !== null,
      diffOrNote === 'diff' ? '真实模型给出了可应用的 diff' : '真实模型未给出可应用改动，已明确提示（合法结果）',
    );
  }

  // 等所有模型流式结束
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(outDir, `${tag}-03-groupchat.png`) });

  const applyButton = page.getByRole('button', { name: /应用选中|全部应用/ }).first();
  if (await applyButton.count()) {
    await applyButton.click();
    await page.waitForSelector('text=/已写入编辑器/', { timeout: 10_000 });
    record('diff 应用回编辑器', true);
  } else {
    record('diff 应用回编辑器', true, '本轮无 diff 可应用，跳过');
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, `${tag}-04-applied.png`) });

  // —— 手动 @ 提及 + 发送 ——
  const composer = page.locator('#pf-composer');
  await composer.click();
  // 注意：@ 菜单只列"真正配了 Key 的模型"，所以这里不能再用 @cl（Claude 未配置时不会出现）。
  // 先读出菜单里第一个候选的族名，再据此输入前缀，保证在任何配置下都成立。
  await composer.fill('@');
  await page.waitForSelector('text=/选择模型/', { timeout: 5000 });
  const firstCandidate = (await page.locator('text=/选择模型/').first().locator('xpath=../..').innerText())
    .split('\n')
    .find((l) => /^(DeepSeek|Qwen|Claude|GPT|Gemini|Kimi|Moonshot)/i.test(l.trim()));
  const prefix = (firstCandidate ?? 'deepseek').trim().slice(0, 3).toLowerCase();
  await composer.fill(`@${prefix}`);
  await page.waitForSelector('text=/选择模型/', { timeout: 5000 });
  record('@ 提及候选菜单', true, `输入 @${prefix} 后弹出候选（首个可用模型：${(firstCandidate ?? '?').trim()}）`);
  await page.screenshot({ path: path.join(outDir, `${tag}-05-mention.png`) });

  // Enter 确认候选 → 应插入完整模型 id 而不是发送消息
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const inserted = await composer.inputValue();
  // 插入的必须是完整模型 id（而不是只插了前缀），否则后端无法路由
  record('@ 候选插入完整模型 id', /@[a-z0-9][a-z0-9._-]{3,}\s/.test(inserted), inserted.trim());

  await composer.fill('@all 请评审 Introduction 的论证强度');
  await page.keyboard.press('Enter');

  // 轮询等待"至少两个模型开口"而不是固定 sleep：
  // 现在房间里可能有思考模型或限流较紧的厂商（Kimi 3 RPM），固定超时必然不稳。
  let bubbleCount = 0;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    bubbleCount = await page.locator('text=/DeepSeek|Qwen|Claude|GPT|Gemini|Kimi/').count();
    if (bubbleCount >= 2) break;
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: path.join(outDir, `${tag}-06-mention-sent.png`) });
  record('多模型并行回复', bubbleCount >= 2, `匹配到 ${bubbleCount} 处模型名`);

  // —— 共享知识面板：添加参考资料 ——
  await page.locator('button[title*="共享知识"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, `${tag}-07-context.png`) });
  record('共享知识面板', true);

  // 回归：曾经这里的"添加"只写进浏览器内存，从未 POST 到后端——
  // 界面里看得见，模型却读不到。所以必须断言后端真的收到了。
  const marker = `E2E-${Date.now().toString(36)}`;
  await page.getByRole('button', { name: /添加参考资料/ }).click();
  await page.getByPlaceholder(/标题（例如/).fill(`冒烟测试资料 ${marker}`);
  await page.getByPlaceholder(/粘贴正文/).fill(
    `这段资料由冒烟测试添加，唯一标记 ${marker}。内部编号 UI-TEST-42。`,
  );
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.waitForTimeout(1200);

  const panelText = await page.locator('body').innerText();
  record('资料出现在面板列表里', panelText.includes(marker), `标记 ${marker}`);
  await page.screenshot({ path: path.join(outDir, `${tag}-08-reference.png`) });

  // 直接问后端：确认它真的落库了（而不是只改了前端 state）
  let serverHasIt = false;
  const backendMode = /浏览器内 mock/.test(panelText);
  if (!backendMode) {
    const res = await page.request.get(`${url}/api/context`);
    const body = await res.json();
    serverHasIt = (body.references ?? []).some((r) => r.title.includes(marker));
    record('后端确实收到了这份资料', serverHasIt, 'GET /api/context');
  } else {
    record('后端确实收到了这份资料', true, '（浏览器内 mock 模式，跳过）');
  }
} catch (err) {
  record('异常中断', false, err instanceof Error ? err.message : String(err));
  // 失败时抓一份页面文本，方便定位是"没渲染"还是"渲染了但不符合预期"。
  try {
    bodyDump = (await page.locator('body').innerText()).slice(0, 6000);
    await page.screenshot({ path: path.join(outDir, `${tag}-99-failure.png`) });
  } catch {
    bodyDump = '(无法读取页面文本)';
  }
} finally {
  await browser.close();
}

const failed = steps.filter((s) => !s.ok);
const report = {
  url,
  mode: process.env.VITE_API_BASE ? 'http-backend' : 'browser-mock',
  steps,
  consoleErrors,
  consoleNoise,
  ok: failed.length === 0 && consoleErrors.length === 0,
  bodyDump,
};
await writeFile(path.join(outDir, `${tag}-report.json`), JSON.stringify(report, null, 2), 'utf8');

console.log('\n--- 控制台错误 ---');
console.log(consoleErrors.length === 0 ? '(无)' : consoleErrors.join('\n'));
if (consoleNoise.length > 0) {
  console.log(`--- 预期的后端探测失败（已忽略）: ${consoleNoise.length} 条 ---`);
}
console.log(`\n结果：${report.ok ? '通过' : '未通过'}（${steps.length - failed.length}/${steps.length} 步成功）`);

process.exit(report.ok ? 0 : 1);
