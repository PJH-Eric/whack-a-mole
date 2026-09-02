/* scripts/reconnect-check.js — 驗證斷線重連與房主離開後的接手流程
 *
 * 這兩件事在真的對戰裡很常發生，但只用單一用戶端測不出來：
 *   1. 手機切網路／進電梯 → socket 斷掉 → 回來以後要自己接回同一間房，還能繼續敲。
 *   2. 房主打完就走 → 房主身分要轉給留下來的人，他要能把房間拉回準備狀態再開一局。
 * 所以這裡開兩個瀏覽器 context，真的用 setOffline 拔網路來測。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('找不到 playwright，無法執行重連檢查。');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CHECK_PORT || 3137);
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

/* 用力敲幾下：只挑壞地鼠，確認分數真的會動 */
async function whackAWhile(page, times) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => {
      const match = window.WAM.S.match;
      if (!match || match.phase !== 'playing') return;
      const target = (match.moles || []).filter((m) => m.side === 'bad')[0];
      if (!target) return;
      const cell = document.querySelector('#board .hole[data-hole="' + target.hole + '"]');
      if (cell) cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await sleep(220);
  }
}

function myScore() {
  const match = window.WAM.S.match;
  const view = window.WAM.S.view;
  if (!match || !view) return 0;
  const me = match.standings.filter((p) => p.id === view.you.id)[0];
  return me ? me.score : 0;
}

async function main() {
  let server;
  let browser;
  const contexts = [];
  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), ROUND_MS: '20000', COUNTDOWN_MS: '600' }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    await sleep(900);

    const launchOpts = {};
    const custom = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
    if (custom && fs.existsSync(custom)) launchOpts.executablePath = custom;
    browser = await chromium.launch(launchOpts);

    const open = async () => {
      const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
      const page = await context.newPage();
      const errors = [];
      /* 拔網路的那一段一定會噴 WebSocket 連不上，那是我們自己造成的，不算錯 */
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        if (message.text().indexOf('ERR_INTERNET_DISCONNECTED') >= 0) return;
        if (message.text().indexOf('ERR_NETWORK_CHANGED') >= 0) return;
        errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('dialog', async (dialog) => { errors.push('原生對話框：' + dialog.message()); await dialog.accept(); });
      contexts.push(context);
      return { context, page, errors };
    };

    const host = await open();
    const guest = await open();

    /* ---- 房主開房、對手用房號進來 ---- */
    await host.page.goto(BASE, { waitUntil: 'networkidle' });
    await host.page.click('#b-online');
    await host.page.waitForSelector('#conn-dot.ok', { timeout: 10000 });
    await host.page.fill('#lobby-nick', '房主');
    await host.page.dispatchEvent('#lobby-nick', 'change');
    await host.page.click('#b-create');
    await host.page.waitForFunction(() => window.WAM.S.view && window.WAM.S.view.code, null, { timeout: 8000 });
    const code = await host.page.evaluate(() => window.WAM.S.view.code);

    await guest.page.goto(BASE, { waitUntil: 'networkidle' });
    await guest.page.click('#b-online');
    await guest.page.waitForSelector('#conn-dot.ok', { timeout: 10000 });
    await guest.page.fill('#lobby-nick', '對手');
    await guest.page.dispatchEvent('#lobby-nick', 'change');
    await guest.page.fill('#join-code', code);
    await guest.page.click('#b-join');
    await guest.page.waitForFunction(() => window.WAM.S.view && window.WAM.S.view.code, null, { timeout: 8000 });

    await host.page.click('#ov-wait-btns [data-act="ready"]');
    await guest.page.click('#ov-wait-btns [data-act="ready"]');
    await sleep(400);
    await host.page.click('#ov-wait-btns [data-act="start"]');
    await guest.page.waitForFunction(() => window.WAM.S.view.phase === 'playing', null, { timeout: 8000 });

    /* ---- 對手斷線再回來 ---- */
    await guest.context.setOffline(true);
    await sleep(1800);
    ok(!(await guest.page.evaluate(() => window.Online.isConnected())), '拔掉網路後前端知道自己斷線了');
    await guest.context.setOffline(false);
    await sleep(4000);

    const back = await guest.page.evaluate(() => ({
      code: window.WAM.S.view && window.WAM.S.view.code,
      screen: window.WAM.S.screen,
      canWhack: !!(window.WAM.S.view && window.WAM.S.view.you.can.whack)
    }));
    ok(back.code === code && back.screen === 's-game', '網路回來以後自己接回同一間房', JSON.stringify(back));
    ok(back.canWhack, '重連後還是可以敲地鼠', String(back.canWhack));

    const before = await guest.page.evaluate(myScore);
    await whackAWhile(guest.page, 20);
    const after = await guest.page.evaluate(myScore);
    ok(after > before, '重連後敲到地鼠有拿到分數', before + ' → ' + after);

    /* ---- 房主打完就走，剩下的人接手 ---- */
    await host.page.waitForFunction(() => window.WAM.S.view.phase === 'over', null, { timeout: 45000 });
    await sleep(700);
    await host.page.click('#ov-result-btns [data-act="quit"]');
    await sleep(1600);

    const heir = await guest.page.evaluate(() => ({
      host: !!window.WAM.S.view.you.host,
      canReset: !!window.WAM.S.view.you.can.reset
    }));
    ok(heir.host, '房主離開後房主身分轉給留下來的人');
    ok(heir.canReset, '接手的人可以把房間拉回準備狀態');

    await guest.page.click('#ov-result-btns [data-act="reset"]');
    await sleep(1200);
    const lobby = await guest.page.evaluate(() => ({
      phase: window.WAM.S.view.phase,
      wait: !document.getElementById('ov-wait').hidden,
      summary: document.getElementById('rank-list').innerText,
      clock: document.getElementById('hud-clock').textContent
    }));
    ok(lobby.phase === 'lobby' && lobby.wait, '真的回到準備畫面', JSON.stringify(lobby));
    ok(lobby.summary.indexOf('對手') >= 0, '準備畫面的摘要列得出留下來的人', lobby.summary.replace(/\n/g, ' / '));
    ok(lobby.clock === String(await guest.page.evaluate(() => window.WAM.S.view.roundSec)),
      '準備畫面的 HUD 秒數＝這一局的長度', lobby.clock);

    await guest.page.click('#ov-wait-btns [data-act="ready"]');
    await sleep(300);
    await guest.page.click('#ov-wait-btns [data-act="start"]');
    await guest.page.waitForFunction(() => window.WAM.S.view.phase === 'playing', null, { timeout: 8000 });
    ok(true, '接手的人可以自己開下一局');

    const errors = [].concat(host.errors, guest.errors);
    ok(errors.length === 0, '整段重連與接手流程沒有主控台錯誤', errors.slice(0, 3).join(' | '));
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
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
