/* scripts/leave-check.js — 驗證線上對局的離開確認流程 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('找不到 playwright，無法執行離開流程檢查。');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CHECK_PORT || 3132);
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
  let context;
  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), ROUND_MS: '90000', COUNTDOWN_MS: '100' }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    await sleep(900);

    const launchOpts = {};
    const custom = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
    if (custom && fs.existsSync(custom)) launchOpts.executablePath = custom;
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('#b-online');
    await page.fill('#lobby-nick', '離開測試');
    await page.dispatchEvent('#lobby-nick', 'change');
    await page.click('#b-create');
    await page.waitForSelector('#ov-wait:not([hidden])', { timeout: 5000 });
    await page.click('[data-act="ready"]');
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-act="start"]');
      return button && !button.disabled;
    }, null, { timeout: 5000 });
    await page.click('[data-act="start"]');
    await page.waitForFunction(() => window.WAM.S.view && window.WAM.S.view.phase === 'playing', null, { timeout: 5000 });

    let nativeDialog = false;
    page.on('dialog', async (dialog) => {
      nativeDialog = true;
      await dialog.accept();
    });
    await page.click('#b-quit');
    const customDialog = await page.$eval('#confirm-modal', (element) => !element.hidden).catch(() => false);
    ok(!nativeDialog, '離開確認不使用瀏覽器原生視窗');
    ok(customDialog, '離開時顯示遊戲內確認視窗');
    if (customDialog) await page.click('#b-confirm-ok');
    await page.waitForFunction(() => document.querySelector('#s-home').classList.contains('active'), null, { timeout: 500 });
    ok(await page.$eval('#s-home', (element) => element.classList.contains('active')), '按下確認後立即回到主選單');
    /* 單機打到一半離開也要問一句，不然一個誤觸就沒了 */
    await page.click('#b-solo');
    await page.waitForSelector('#s-solo.active', { timeout: 3000 });
    await page.click('#b-solo-start');
    await page.waitForFunction(() => window.WAM.S.match && window.WAM.S.match.phase === 'playing', null, { timeout: 8000 });
    await page.click('#b-quit');
    const soloAsk = await page.$eval('#confirm-modal', (element) => !element.hidden).catch(() => false);
    ok(soloAsk, '單機打到一半離開也會先確認');
    if (soloAsk) {
      await page.click('#b-confirm-cancel');
      ok(await page.$eval('#s-game', (element) => element.classList.contains('active')), '按取消會留在對局裡');
      await page.click('#b-quit');
      await page.click('#b-confirm-ok');
    }
    await page.waitForFunction(() => document.querySelector('#s-home').classList.contains('active'), null, { timeout: 1000 });
    ok(await page.$eval('#s-home', (element) => element.classList.contains('active')), '單機確認後回到主選單');

    ok(errors.length === 0, '離開流程沒有主控台錯誤', errors.slice(0, 3).join(' | '));
  } finally {
    if (context) await context.close().catch(() => {});
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
