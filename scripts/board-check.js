/* scripts/board-check.js — 驗證各裝置顯示的盤面列欄符合玩家選項 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('找不到 playwright，無法執行盤面檢查。');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CHECK_PORT || 3133);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const VIEWPORTS = [
  { label: '平板直向', width: 768, height: 1024 },
  { label: '平板橫向', width: 1024, height: 768 },
  { label: '桌機', width: 1440, height: 900 },
  { label: '手機直向', width: 390, height: 844 },
  { label: '手機橫向', width: 844, height: 390 },
  { label: '小手機', width: 360, height: 640 }
];

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
  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), COUNTDOWN_MS: '100' }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    await sleep(900);

    const launchOpts = {};
    const custom = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
    if (custom && fs.existsSync(custom)) launchOpts.executablePath = custom;
    browser = await chromium.launch(launchOpts);

    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.click('#b-solo');
      await sleep(120);
      const keys = await page.$$eval('#opt-board .pickcard', (cards) => cards.map((card) => card.dataset.v));

      for (const key of keys) {
        await page.click('#opt-board [data-v="' + key + '"]');
        await page.click('#b-solo-start');
        const actual = await page.evaluate(() => {
          const selected = Rules.boardOf(window.WAM.S.match.board);
          const grid = Board.grid();
          return {
            selected: { cols: selected.cols, rows: selected.rows, holes: selected.holes },
            actual: grid && { cols: grid.cols, rows: grid.rows, holes: grid.holes },
            domHoles: document.querySelectorAll('#board .hole').length
          };
        });
        ok(actual.actual && actual.actual.cols === actual.selected.cols
          && actual.actual.rows === actual.selected.rows
          && actual.actual.holes === actual.selected.holes
          && actual.domHoles === actual.selected.holes,
        viewport.label + ' ' + key + ' 實際盤面符合選項', JSON.stringify(actual));
        /* 單機打到一半按離開會先問一句，確認後才回首頁 */
        await page.click('#b-quit');
        if (await page.$eval('#confirm-modal', (e) => !e.hidden)) await page.click('#b-confirm-ok');
        await page.click('#b-solo');
        await sleep(80);
      }
      await context.close();
    }
  } finally {
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
