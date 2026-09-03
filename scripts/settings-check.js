/*
 * scripts/settings-check.js — 確認單機選項建立線上房間時沒有遺失
 *
 * 這支刻意走真的瀏覽器操作，因為問題發生在單機設定頁到 room:create
 * 的邊界，不是單純 Rules.createMatch 的參數問題。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.log('找不到 playwright，略過設定傳遞檢查。');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SETTINGS_CHECK_PORT || 3132);
const BASE = 'http://127.0.0.1:' + PORT + '/';

function assert(ok, message, extra) {
  if (ok) return;
  throw new Error(message + (extra ? ' → ' + extra : ''));
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(BASE + 'health');
      if (res.ok) return;
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('測試伺服器沒有在期限內啟動');
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ROUND_MS: '60000',
      COUNTDOWN_MS: '0'
    }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  let browser;
  try {
    await waitForHealth();
    browser = await chromium.launch({});
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('#b-solo');
    await page.click('#opt-round [data-v="90"]');
    await page.click('#opt-ai [data-v="hard"]');
    await page.click('#opt-board [data-v="6x6"]');
    await page.click('#s-solo [data-back="s-home"]');
    await page.click('#b-online');
    await page.click('#b-create');
    await page.waitForFunction(() => window.WAM.S.view && window.WAM.S.view.phase === 'lobby');

    const lobby = await page.evaluate(() => ({
      roundSec: window.WAM.S.view.roundSec,
      pace: window.WAM.S.view.pace,
      board: window.WAM.S.view.board,
      holes: window.WAM.S.view.boards.find((b) => b.key === window.WAM.S.view.board).holes
    }));
    assert(lobby.roundSec === 90, '單機選的 90 秒沒有帶到房間', JSON.stringify(lobby));
    assert(lobby.pace === 'hard', '單機選的困難難度沒有帶到房間', JSON.stringify(lobby));
    assert(lobby.board === '6x6' && lobby.holes === 36,
      '單機選的 6×6 盤面沒有帶到房間', JSON.stringify(lobby));

    await page.click('#ov-wait [data-act="ready"]');
    await page.waitForFunction(() => window.WAM.S.view.you.ready === true);
    await page.click('#ov-wait [data-act="start"]');
    await page.waitForFunction(() => window.WAM.S.view.phase === 'playing');

    const match = await page.evaluate(() => ({
      roundMs: window.WAM.S.match.endAt - window.WAM.S.match.startAt,
      pace: window.WAM.S.match.pace,
      board: window.WAM.S.match.board,
      holes: window.WAM.S.match.holes
    }));
    assert(match.roundMs === 90000, '真正對局沒有使用房間的 90 秒', JSON.stringify(match));
    assert(match.pace === 'hard', '真正對局沒有使用房間的困難難度', JSON.stringify(match));
    assert(match.board === '6x6' && match.holes === 36,
      '真正對局沒有使用房間的 6×6 盤面', JSON.stringify(match));
    assert(errors.length === 0, '設定傳遞流程產生瀏覽器錯誤', errors.join(' | '));

    console.log('✓ 單機設定建立房間時正確帶入 90 秒／困難／6×6');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error('✗ ' + err.message);
  process.exitCode = 1;
});
