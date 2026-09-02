/* scripts/invite-nick-check.js — 驗證被邀請者進房前可以設定玩家暱稱 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('找不到 playwright，無法執行邀請暱稱檢查。');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CHECK_PORT || 3136);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pass = 0;
let fail = 0;

function ok(condition, message, extra) {
  if (condition) {
    pass++;
    console.log('✓ ' + message);
    return;
  }
  fail++;
  console.error('✗ ' + message + (extra ? ' → ' + extra : ''));
}

async function main() {
  let server;
  let browser;
  let hostContext;
  let guestContext;
  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    await sleep(900);

    const launchOpts = {};
    const custom = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
    if (custom && fs.existsSync(custom)) launchOpts.executablePath = custom;
    browser = await chromium.launch(launchOpts);
    hostContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const host = await hostContext.newPage();
    await host.goto(BASE, { waitUntil: 'networkidle' });
    await host.click('#b-online');
    await host.fill('#lobby-nick', '房主測試');
    await host.dispatchEvent('#lobby-nick', 'change');
    await host.click('#b-create');
    await host.waitForSelector('#ov-wait:not([hidden])', { timeout: 5000 });
    await host.click('[data-act="invite"]');
    await host.selectOption('#inv-role', 'player');
    await host.click('#b-invite-make');
    await host.waitForFunction(() => document.getElementById('invite-url').value.length > 0, null, { timeout: 3000 });
    const inviteUrl = await host.$eval('#invite-url', (input) => input.value);
    ok(/[?&]invite=[a-f0-9]{24}/.test(inviteUrl), '產生可用的玩家邀請連結', inviteUrl);

    guestContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const guest = await guestContext.newPage();
    await guest.goto(BASE, { waitUntil: 'networkidle' });
    await guest.evaluate(() => localStorage.setItem('wam_nick', '裝置上的舊暱稱'));
    await guest.goto(inviteUrl, { waitUntil: 'networkidle' });
    await sleep(800);

    const entry = await guest.evaluate(() => ({
      screen: document.querySelector('.screen.active') && document.querySelector('.screen.active').id,
      nick: document.getElementById('lobby-nick').value,
      room: document.getElementById('join-code').value,
      intent: !!window.WAM.S.joinIntent
    }));
    ok(entry.screen === 's-lobby', '被邀請者先停在大廳設定暱稱', JSON.stringify(entry));
    ok(entry.nick === '裝置上的舊暱稱', '暱稱欄位保留目前名稱供修改', JSON.stringify(entry));
    ok(entry.room && entry.intent, '邀請房號與進房資訊仍保留', JSON.stringify(entry));

    if (entry.screen === 's-lobby') {
      await guest.fill('#lobby-nick', '被邀請的新暱稱');
      await guest.click('#b-join');
      await guest.waitForSelector('#s-game.active', { timeout: 5000 });
      const joined = await guest.evaluate(() => ({
        screen: document.querySelector('.screen.active') && document.querySelector('.screen.active').id,
        name: window.WAM.S.view && window.WAM.S.view.you && window.WAM.S.view.you.name
      }));
      ok(joined.screen === 's-game', '設定暱稱後可以加入邀請房間', JSON.stringify(joined));
      ok(joined.name === '被邀請的新暱稱', '房間使用被邀請者設定的新暱稱', JSON.stringify(joined));
    }
  } finally {
    if (guestContext) await guestContext.close().catch(() => {});
    if (hostContext) await hostContext.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
  }
}

main().then(() => {
  console.log('\n' + (fail ? '✗' : '✓') + ' 通過 ' + pass + ' / ' + (pass + fail) + ' 項');
  process.exit(fail ? 1 : 0);
}).catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
