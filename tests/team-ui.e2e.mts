/**
 * 团队协作 P0 的浏览器端验证：
 * owner 认领 → 生成邀请 → 组员申请 → owner 审批 → 组员进入应用。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadEnv } from '../apps/server/src/env';
import { buildServer } from '../apps/server/src/app';

/*
 * 服务由**脚本自己启动**（端口 8801，前端 Vite 5289 已代理到它）。
 * 这样脚本能直接拿到认领 token，不会因为"链接一次性用掉"而锁死自己。
 */
const root = mkdtempSync(join(process.cwd(), '.cache', 'team-ui-'));
const env = loadEnv({ PORT: '8801', HOST: '127.0.0.1', LOG_LEVEL: 'error', CORS_ORIGINS: 'http://127.0.0.1:5289', MAX_CONCURRENCY: '4', ENABLE_CROSS_REVIEW: 'true' });
const built = await buildServer({ env, envSource: {}, projectsRoot: root, authMode: 'team', persistPath: null, compileEngine: 'mock' });
await built.app.listen({ port: 8801, host: '127.0.0.1' });
const claim = built.team.createOwnerClaimInvite();
const OWNER_LINK = `/join/${claim.token}`;
const BASE = 'http://127.0.0.1:5289';

const browser = await chromium.launch();
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// ── 未登录：应只看到入组页 ─────────────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const text = await page.evaluate(() => document.body.innerText);
  check('未登录只显示入组页', text.includes('需要邀请链接') && !text.includes('项目文件'), text.slice(0, 60));
  const status = await page.evaluate(() => fetch('/api/projects').then((r) => r.status));
  check('未登录调用业务接口被拦(401)', status === 401, String(status));
  await ctx.close();
}

// ── owner 认领 ────────────────────────────────────────
const ownerCtx = await browser.newContext();
const owner = await ownerCtx.newPage();
await owner.goto(BASE + OWNER_LINK, { waitUntil: 'load' });
await owner.waitForTimeout(2500);
await owner.fill('#display-name', '张振源');
await owner.click('text=申请加入');
await owner.waitForTimeout(4000);
const ownerText = await owner.evaluate(() => document.body.innerText);
check('owner 认领后进入应用', ownerText.includes('项目文件'), ownerText.slice(0, 80));
check('TopBar 显示 owner 名字', ownerText.includes('张振源'));

// owner 能拿到自己的会话
const me = await owner.evaluate(() => fetch('/api/me').then((r) => r.json()));
check('owner 会话有效且是发起方', me?.user?.isOwner === true, JSON.stringify(me?.user ?? null));

// ── 生成邀请（直接调接口拿完整 token）────────────────
const invite = await owner.evaluate(() =>
  fetch('/api/team/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'editor' }),
  }).then((r) => r.json()),
);
const token = invite?.invite?.token;
check('owner 生成邀请成功', Boolean(token), JSON.stringify(invite).slice(0, 120));

// ── 团队面板能打开并展示成员 ──────────────────────────
await owner.click('text=团队');
await owner.waitForTimeout(1500);
const panelText = await owner.evaluate(() => document.body.innerText);
check('团队面板可打开', panelText.includes('团队成员'));
check('面板里能看到待审批区域', panelText.includes('待审批'));

// ── 组员申请 ─────────────────────────────────────────
const memberCtx = await browser.newContext();
const member = await memberCtx.newPage();
await member.goto(`${BASE}/?join=${token}`, { waitUntil: 'load' });
await member.waitForTimeout(2500);
await member.fill('#display-name', '李四');
await member.click('text=申请加入');
await member.waitForTimeout(3000);
const memberText = await member.evaluate(() => document.body.innerText);
check('组员提交后进入待审批状态', memberText.includes('等待发起方同意'), memberText.slice(0, 60));
const memberBlocked = await member.evaluate(() => fetch('/api/projects').then((r) => r.status));
check('待审批期间组员仍被拦(401)', memberBlocked === 401, String(memberBlocked));

// ── owner 审批 ────────────────────────────────────────
const pending = await owner.evaluate(() =>
  fetch('/api/team/requests?status=pending').then((r) => r.json()),
);
const requestId = pending?.requests?.[0]?.id;
check('owner 能看到待审批申请', Boolean(requestId), JSON.stringify(pending).slice(0, 120));

// 审批：走接口更稳定（UI 里"同意"按钮的存在性单独断言）
// 面板每 4s 轮询一次，等一下让它拉到新申请
await owner.waitForTimeout(5000);
const approveBtnCount = await owner.locator('button:has-text("同意")').count();
check('面板里有"同意"按钮', approveBtnCount > 0, String(approveBtnCount));
const decided = await owner.evaluate(
  (id) =>
    fetch(`/api/team/requests/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    }).then((r) => r.json()),
  requestId,
);
check('owner 审批通过', decided?.request?.status === 'approved', JSON.stringify(decided).slice(0, 100));

// ── 组员轮询后自动进入 ────────────────────────────────
await member.waitForTimeout(16000);
const memberAfter = await member.evaluate(() => document.body.innerText);
check('审批后组员自动进入应用', memberAfter.includes('项目文件'), memberAfter.slice(0, 80));
check('组员 TopBar 显示自己名字', memberAfter.includes('李四'));

const memberMe = await member.evaluate(() => fetch('/api/me').then((r) => r.json()));
check('组员会话有效且非 owner', memberMe?.user?.displayName === '李四' && memberMe?.user?.isOwner === false, JSON.stringify(memberMe?.user ?? null));

// 组员没有"团队"管理入口
check('普通成员看不到团队管理按钮', !(await member.evaluate(() => document.body.innerText)).includes('团队\n'));

await owner.screenshot({ path: 'artifacts/team-owner.png' });
await member.screenshot({ path: 'artifacts/team-member.png' });
await browser.close();
await built.app.close();
rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : `  → ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
