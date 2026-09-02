/* scripts/sidebar-check.js — 驗證切換側欄分頁後操作列仍固定顯示 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('找不到 playwright，無法執行側欄操作列檢查。');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CHECK_PORT || 3135);
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
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    await sleep(900);

    const launchOpts = {};
    const custom = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
    if (custom && fs.existsSync(custom)) launchOpts.executablePath = custom;
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    for (const viewport of [
      { label: '桌機', width: 1024, height: 768, narrow: false },
      { label: '手機直向', width: 390, height: 844, narrow: true }
    ]) {
      const page = await context.newPage();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.click('#b-solo');
      await page.click('#b-solo-start');
      await page.waitForSelector('#s-game.active', { timeout: 3000 });
      if (viewport.narrow) await page.click('#b-open-sum');
      await sleep(180);

      const before = await page.$eval('#side-actions [data-act="quit"]', (button) => {
        const r = button.getBoundingClientRect();
        return { visible: r.width > 0 && r.height > 0, bottom: r.bottom };
      });
      await page.click('#tab-dex');
      const after = await page.$eval('#side-actions [data-act="quit"]', (button) => {
        const r = button.getBoundingClientRect();
        const side = document.getElementById('side').getBoundingClientRect();
        return {
          visible: r.width > 0 && r.height > 0,
          bottom: r.bottom,
          sideBottom: side.bottom,
          pane: button.closest('.side-pane') && button.closest('.side-pane').id
        };
      });

      ok(before.visible, viewport.label + '摘要分頁顯示離開按鈕', JSON.stringify(before));
      ok(after.visible, viewport.label + '切換圖鑑分頁後離開按鈕仍可見', JSON.stringify(after));
      ok(after.visible && after.bottom >= after.sideBottom - 12,
        viewport.label + '切換分頁後操作列仍固定在側欄底部', JSON.stringify(after));
      ok(!after.pane, viewport.label + '操作列不隸屬任何會切換隱藏的分頁', JSON.stringify(after));
      await page.close();
    }
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
