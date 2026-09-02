/* scripts/sync-check.js — 驗證地鼠本體與分數標記的出現／消失同步 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('找不到 playwright，無法執行地鼠同步檢查。');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CHECK_PORT || 3134);
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
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const result = await page.evaluate(() => {
      const snapshot = (moles) => ({
        board: { cols: 3, rows: 3, holes: 9 },
        moles,
        standings: []
      });
      const mole = { id: 42, hole: 0, type: 'mole', hp: 1, hpLeft: 1, spawnAt: 1000, expireAt: 3000 };
      const read = () => {
        const hole = document.querySelector('#board .hole');
        const slot = hole.querySelector('.mole-slot');
        const badge = hole.querySelector('.mole-badge');
        return {
          slotOpacity: slot.style.opacity,
          slotUp: slot.classList.contains('up'),
          badgeOn: badge.classList.contains('on'),
          badgeOpacity: getComputedStyle(badge).opacity
        };
      };
      const states = {};
      Board.setOptions({ reduceMotion: false });
      Board.draw(snapshot([mole]), 1000);
      states.risingStart = read();
      Board.draw(snapshot([mole]), 1050);
      states.rising = read();
      Board.draw(snapshot([mole]), 2999);
      states.sinkingEnd = read();
      Board.draw(snapshot([]), 3001);
      states.empty = read();
      return states;
    });

    const visible = (state) => state.slotOpacity !== '0';
    ok(!result.risingStart.badgeOn && !visible(result.risingStart),
      '地鼠剛開始升起時，分數標記保持隱藏', JSON.stringify(result.risingStart));
    ok(result.rising.badgeOn && visible(result.rising),
      '地鼠可見時，分數標記同步出現', JSON.stringify(result.rising));
    ok(!result.sinkingEnd.badgeOn && !visible(result.sinkingEnd),
      '地鼠縮回不可見時，分數標記同步消失', JSON.stringify(result.sinkingEnd));
    ok(!result.empty.badgeOn && !result.empty.slotUp && !visible(result.empty),
      '地洞清空後沒有殘留地鼠或分數標記', JSON.stringify(result.empty));
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
