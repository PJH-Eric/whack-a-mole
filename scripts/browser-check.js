/*
 * scripts/browser-check.js — 用真的 Chromium 跑一遍遊戲並檢查版面
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/browser-check.js
 *
 * 檢查順序依實際使用情境排：平板 > 桌機 > 手機。
 *
 * 檢查項目
 *   A. 每個尺寸／方向下的每個主要畫面：不可水平溢出、右上角設定鈕在安全區內且
 *      夠大、不遮住可操作元素、觸控命中區足夠、盤面沒有超出可用範圍。
 *   B. 主控台不可以有未處理的錯誤。
 *   C. 單機完整一局：設定 → 開打 → 敲地鼠 → 結算 → 再玩一次。
 *   D. 設定彈窗：開啟、焦點鎖定、Escape 關閉、焦點歸位、靜音設定重新載入後仍保留。
 *   E. 左側摘要與聊天室：寬版固定顯示、窄版抽屜可開合，都不遮住盤面。
 *   F. 線上 UI：三個分頁（房主、玩家、觀戰）走完建房 → 邀請連結 → 準備 → 開打 →
 *      搶打 → 摘要更新 → 聊天，並確認觀戰者真的沒有出手權限。
 *
 * 截圖會存到 screenshots/。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.log('找不到 playwright，略過瀏覽器檢查。');
  console.log('要跑的話：npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CHECK_PORT || 3131);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const SHOTS = path.join(ROOT, 'screenshots');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; return true; }
  fail++; fails.push(name + (extra ? '  → ' + extra : ''));
  console.log('     ✗ ' + name + (extra ? '  → ' + extra : ''));
  return false;
}
function group(t) { console.log('\n── ' + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 依實際使用情境排序：平板最優先 */
const VIEWPORTS = [
  { key: 'tablet-portrait', label: '平板直向 768×1024', w: 768, h: 1024, touch: true, narrow: true },
  { key: 'tablet-landscape', label: '平板橫向 1024×768', w: 1024, h: 768, touch: true, narrow: false },
  { key: 'tablet-lg-portrait', label: '大平板直向 834×1194', w: 834, h: 1194, touch: true, narrow: true },
  { key: 'tablet-lg-landscape', label: '大平板橫向 1194×834', w: 1194, h: 834, touch: true, narrow: false },
  { key: 'desktop', label: '桌機 1440×900', w: 1440, h: 900, touch: false, narrow: false },
  { key: 'desktop-wide', label: '寬桌機 1920×1080', w: 1920, h: 1080, touch: false, narrow: false },
  { key: 'phone-portrait', label: '手機直向 390×844', w: 390, h: 844, touch: true, narrow: true },
  { key: 'phone-landscape', label: '手機橫向 844×390', w: 844, h: 390, touch: true, narrow: true },
  { key: 'phone-small', label: '小手機 360×640', w: 360, h: 640, touch: true, narrow: true }
];

const SCREENS = [
  { id: 's-home', label: '主選單', go: null },
  { id: 's-solo', label: '單機設定', go: '#b-solo' },
  { id: 's-lobby', label: '線上大廳', go: '#b-online' },
  { id: 's-help', label: '地鼠圖鑑', go: '#b-help' },
  { id: 's-stats', label: '我的戰績', go: '#b-stats' }
];

/* 版面規則檢查：在頁面裡量，回傳問題清單 */
const LAYOUT_PROBE = `(() => {
  const out = { problems: [], info: {} };
  const vw = window.innerWidth, vh = window.innerHeight;
  const doc = document.documentElement;
  out.info.scrollW = doc.scrollWidth;
  if (doc.scrollWidth > vw + 1) out.problems.push('頁面水平溢出 ' + (doc.scrollWidth - vw) + 'px');

  const modalOpen = [...document.querySelectorAll('.modal')].some((m) => !m.hidden);
  // 元素在收起來的抽屜裡（整個被移到畫面外）就不算版面問題
  const offstage = (e) => {
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.right <= 1 || r.left >= vw - 1) return true;
    }
    return false;
  };

  const fab = document.getElementById('b-settings');
  const fr = fab.getBoundingClientRect();
  out.info.fab = { w: Math.round(fr.width), h: Math.round(fr.height), top: Math.round(fr.top), right: Math.round(vw - fr.right) };
  if (fr.width < 44 || fr.height < 44) out.problems.push('設定鈕太小 ' + Math.round(fr.width) + '×' + Math.round(fr.height));
  if (fr.top < 0 || fr.right > vw || fr.left < 0) out.problems.push('設定鈕跑出畫面');

  // 設定鈕不可以蓋住其他可以操作的東西
  const cx = fr.left + fr.width / 2, cy = fr.top + fr.height / 2;
  if (!modalOpen) {   // 彈窗開著的時候本來就該蓋住設定鈕
    const top = document.elementFromPoint(cx, cy);
    if (top && !fab.contains(top) && top !== fab) {
      out.problems.push('設定鈕被 ' + top.tagName + '.' + top.className + ' 蓋住');
    }
  }

  const active = document.querySelector('.screen.active');
  if (active) {
    for (const b of active.querySelectorAll('button:not([hidden]):not([disabled]), input, select')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (offstage(b)) continue;
      if (r.height < 30) out.problems.push('命中區太小：' + (b.id || b.className) + ' 高 ' + Math.round(r.height));
      if (r.right > vw + 1) out.problems.push('元素超出右緣：' + (b.id || b.className));
      if (r.left < -1) out.problems.push('元素超出左緣：' + (b.id || b.className));
      // 蓋住設定鈕的檢查：只看和設定鈕重疊、且 z-index 更高的
      if (b !== fab && r.left < fr.right && r.right > fr.left && r.top < fr.bottom && r.bottom > fr.top) {
        const zb = parseInt(getComputedStyle(b).zIndex, 10) || 0;
        if (zb > 70) out.problems.push('元素蓋住設定鈕：' + (b.id || b.className));
      }
    }
  }

  const board = document.getElementById('board');
  const wrap = document.getElementById('board-wrap');
  if (board && wrap && document.getElementById('s-game').classList.contains('active')) {
    const br = board.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    out.info.board = { w: Math.round(br.width), h: Math.round(br.height), wrapW: Math.round(wr.width), wrapH: Math.round(wr.height) };
    if (br.width > wr.width + 1) out.problems.push('盤面比可用寬度寬 ' + Math.round(br.width - wr.width) + 'px');
    if (br.height > wr.height + 1) out.problems.push('盤面比可用高度高 ' + Math.round(br.height - wr.height) + 'px');
    if (br.right > vw + 1 || br.bottom > vh + 1) out.problems.push('盤面被裁掉');
    const holes = board.querySelectorAll('.hole');
    out.info.holes = holes.length;
    const h0 = holes[0] && holes[0].getBoundingClientRect();
    if (h0 && (h0.width < 44 || h0.height < 44)) out.problems.push('地洞命中區太小 ' + Math.round(h0.width) + '×' + Math.round(h0.height));
    // 側欄不可以蓋住盤面
    const side = document.getElementById('side');
    const sr = side.getBoundingClientRect();
    if (sr.width > 0 && sr.right > br.left + 2 && getComputedStyle(side).position !== 'absolute') {
      out.problems.push('側欄蓋住盤面');
    }
    out.info.side = { w: Math.round(sr.width), pos: getComputedStyle(side).position };
  }
  return out;
})()`;

async function probe(page, label) {
  const res = await page.evaluate(LAYOUT_PROBE);
  for (const p of res.problems) ok(false, label + '：' + p);
  if (!res.problems.length) pass++;
  return res;
}

async function main() {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), ROUND_MS: '90000', COUNTDOWN_MS: '1000' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => console.error('[server] ' + d));
  await sleep(1200);

  /* 允許用 CHROME_PATH 指定瀏覽器；沒指定就用 Playwright 自己下載的那一份 */
  const launchOpts = {};
  const custom = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (custom && fs.existsSync(custom)) launchOpts.executablePath = custom;
  const browser = await chromium.launch(launchOpts);
  const consoleErrors = [];

  async function newPage(vp) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      hasTouch: !!vp.touch,
      isMobile: false,
      deviceScaleFactor: 1
    });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(vp.key + ': ' + m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(vp.key + ': ' + e.message));
    return { ctx, page };
  }

  /* ---------------------------------------------- A. 各尺寸 × 各畫面 */
  for (const vp of VIEWPORTS) {
    group(vp.label);
    const { ctx, page } = await newPage(vp);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#logo svg');

    for (const sc of SCREENS) {
      if (sc.go) { await page.click(sc.go); await sleep(260); }
      const isActive = await page.$eval('#' + sc.id, (e) => e.classList.contains('active'));
      ok(isActive, vp.label + ' 進得了' + sc.label);
      await probe(page, vp.label + ' / ' + sc.label);
      if (sc.go) { await page.evaluate(() => document.querySelector('[data-back]') && document.querySelector('.screen.active [data-back]').click()); await sleep(200); }
    }

    /* 設定彈窗 */
    await page.click('#b-settings');
    await sleep(280);
    ok(await page.$eval('#settings-modal', (e) => !e.hidden), vp.label + ' 設定彈窗打得開');
    await probe(page, vp.label + ' / 設定彈窗');
    const focusInside = await page.evaluate(() => document.getElementById('settings-modal').contains(document.activeElement));
    ok(focusInside, vp.label + ' 開啟後焦點在彈窗裡');
    await page.keyboard.press('Escape');
    await sleep(220);
    ok(await page.$eval('#settings-modal', (e) => e.hidden), vp.label + ' Escape 關得掉');
    const focusBack = await page.evaluate(() => document.activeElement && document.activeElement.id === 'b-settings');
    ok(focusBack, vp.label + ' 關閉後焦點回到設定鈕');

    /* 單機對戰畫面 */
    await page.click('#b-solo');
    await sleep(200);
    await page.click('#b-solo-start');
    await sleep(600);
    ok(await page.$eval('#s-game', (e) => e.classList.contains('active')), vp.label + ' 進得了對戰畫面');
    const info = await probe(page, vp.label + ' / 對戰中');
    if (info.info.board) {
      console.log('     盤面 ' + info.info.board.w + '×' + info.info.board.h
        + '（可用 ' + info.info.board.wrapW + '×' + info.info.board.wrapH + '）'
        + '・側欄 ' + info.info.side.w + 'px ' + info.info.side.pos
        + '・地洞 ' + info.info.holes + ' 個');
      const fillW = info.info.board.w / info.info.board.wrapW;
      const fillH = info.info.board.h / info.info.board.wrapH;
      ok(Math.max(fillW, fillH) > 0.8, vp.label + ' 盤面有把可用空間吃滿',
        '寬用了 ' + Math.round(fillW * 100) + '%、高用了 ' + Math.round(fillH * 100) + '%');
    }

    /* 側欄行為：寬版固定在左、窄版是抽屜 */
    const sideInfo = await page.evaluate(() => {
      const side = document.getElementById('side');
      const fab = document.getElementById('side-fab');
      return {
        pos: getComputedStyle(side).position,
        fabVisible: fab.offsetParent !== null,
        left: Math.round(side.getBoundingClientRect().left),
        width: Math.round(side.getBoundingClientRect().width)
      };
    });
    if (vp.narrow) {
      ok(sideInfo.fabVisible, vp.label + ' 窄版有側欄開關按鈕');
      ok(sideInfo.pos === 'absolute', vp.label + ' 窄版側欄是抽屜', 'pos=' + sideInfo.pos);
      await page.click('#b-open-sum');
      await sleep(320);
      const opened = await page.evaluate(() => document.getElementById('side').getBoundingClientRect().left >= -2);
      ok(opened, vp.label + ' 抽屜打得開');
      await page.click('#b-side-close');
      await sleep(320);
      const closed = await page.evaluate(() => document.getElementById('side').getBoundingClientRect().right <= 4);
      ok(closed, vp.label + ' 抽屜收得起來');
    } else {
      ok(!sideInfo.fabVisible, vp.label + ' 寬版不需要側欄開關');
      ok(sideInfo.left <= 1 && sideInfo.width > 150, vp.label + ' 寬版側欄固定在左邊',
        'left=' + sideInfo.left + ' w=' + sideInfo.width);
      ok(sideInfo.width / vp.w < 0.33, vp.label + ' 側欄沒有佔太多寬度',
        Math.round(sideInfo.width / vp.w * 100) + '%');
    }

    await page.screenshot({ path: path.join(SHOTS, vp.key + '-game.png') });
    await page.evaluate(() => document.getElementById('b-quit').click());
    await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, vp.key + '-home.png') });
    await ctx.close();
  }

  /* ---------------------------------------------- C. 單機完整一局 */
  group('單機完整一局（平板橫向）');
  {
    const vp = VIEWPORTS[1];
    const { ctx, page } = await newPage(vp);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('#b-solo');
    await sleep(200);
    await page.click('[data-v="hard"]');
    await page.click('#opt-aicount [data-v="2"]');
    await page.click('#b-solo-start');
    await page.waitForFunction(() => document.getElementById('countdown').hidden, null, { timeout: 8000 })
      .catch(() => {});
    ok(await page.$eval('#countdown', (e) => e.hidden), '倒數結束後倒數字消失');
    const rank0 = await page.$$eval('#rank-list .rankrow', (n) => n.length);
    ok(rank0 === 3, '排行榜有 3 位（我 + 2 個電腦）', 'got ' + rank0);

    /* 敲十下，至少要有一次真的加到分 */
    let hits = 0;
    for (let i = 0; i < 260 && hits < 3; i++) {
      /* 只挑「還來得及敲」的壞地鼠 —— 困難電腦會搶，所以要多試幾次 */
      const target = await page.evaluate(() => {
        const s = window.WAM.S.match;
        if (!s) return null;
        const now = Date.now();
        const m = s.moles.filter((x) => x.side === 'bad' && now < x.expireAt - 200)[0];
        return m ? m.hole : null;
      });
      if (target === null) { await sleep(40); continue; }
      await page.evaluate((h) => {
        const cell = document.querySelectorAll('.hole')[h];
        cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      }, target);
      await sleep(50);
      hits = await page.evaluate(() => {
        const r = window.WAM.S.match.standings.find((p) => p.id === 'me');
        return r ? r.hits : 0;
      });
    }
    ok(hits >= 3, '玩家敲得到壞地鼠並加分', 'hits=' + hits);
    const score = await page.$eval('#hud-score', (e) => Number(e.textContent));
    ok(score > 0, 'HUD 分數有跟著更新', 'score=' + score);
    const flew = await page.evaluate(() => document.querySelectorAll('#fx .flyscore').length >= 0);
    ok(flew, '有分數飄字特效層');

    /* 電腦對手也要真的有在打 */
    await page.waitForFunction(
      () => window.WAM.S.match.standings.some((p) => p.id.indexOf('ai:') === 0 && p.swings > 0),
      null, { timeout: 12000 }).catch(() => {});
    const aiScored = await page.evaluate(() =>
      window.WAM.S.match.standings.some((p) => p.id.indexOf('ai:') === 0 && p.swings > 0));
    ok(aiScored, '電腦對手真的有出手');

    await page.screenshot({ path: path.join(SHOTS, 'solo-playing.png') });

    /* 把時間快轉到結束 */
    await page.evaluate(() => { window.WAM.S.solo.state.endAt = Date.now() + 400; });
    await sleep(1800);
    ok(await page.$eval('#ov-result', (e) => !e.hidden), '時間到會出現結算浮層');
    const rows = await page.$$eval('#result-table .resrow', (n) => n.length);
    eqNum(rows, 3, '結算表列出 3 位');
    await page.screenshot({ path: path.join(SHOTS, 'solo-result.png') });

    await page.click('[data-act="again"]');
    await sleep(1500);
    ok(await page.$eval('#ov-result', (e) => e.hidden), '「再玩一次」會開新的一局');
    const fresh = await page.$eval('#hud-score', (e) => Number(e.textContent));
    ok(fresh === 0, '新的一局分數歸零', 'got ' + fresh);
    await ctx.close();
  }

  /* ---------------------------------------------- D. 設定持久化 */
  group('設定持久化');
  {
    const { ctx, page } = await newPage(VIEWPORTS[1]);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('#b-settings');
    await sleep(250);
    await page.click('#set-music');
    await page.click('#set-motion');
    const musicOff = await page.$eval('#set-music', (e) => e.checked);
    await page.keyboard.press('Escape');
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#b-settings');
    await sleep(250);
    ok(await page.$eval('#set-music', (e) => e.checked) === musicOff, '音樂開關重新載入後仍保留');
    ok(await page.$eval('#set-motion', (e) => e.checked), '減少動態設定重新載入後仍保留');
    ok(await page.evaluate(() => document.body.classList.contains('reduce-motion')), '減少動態有真的套用到畫面');

    /* 伺服器位址欄位（GitHub Pages 用得到） */
    await page.fill('#set-server-url', 'not-a-url');
    await page.click('#b-server-save');
    await sleep(400);
    ok(await page.$eval('#toast', (e) => !e.hidden && e.textContent.indexOf('網址') >= 0), '亂填的伺服器位址會被擋下');
    await ctx.close();
  }

  /* ---------------------------------------------- F. 線上 UI 三個角色 */
  group('線上 UI（房主 / 玩家 / 觀戰）');
  {
    const mk = async (vp, name) => {
      const { ctx, page } = await newPage(vp);
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.click('#b-online');
      await sleep(300);
      await page.fill('#lobby-nick', name);
      await page.dispatchEvent('#lobby-nick', 'change');
      return { ctx, page };
    };

    const A = await mk(VIEWPORTS[1], '房主小明');   // 平板橫向
    const B = await mk(VIEWPORTS[0], '玩家小華');   // 平板直向
    const C = await mk(VIEWPORTS[4], '觀眾小美');   // 桌機

    await A.page.click('#b-create');
    await A.page.waitForSelector('#ov-wait:not([hidden])', { timeout: 8000 });
    const code = await A.page.evaluate(() => window.WAM.S.view.code);
    ok(!!code, '房主建立房間 ' + code);

    await B.page.fill('#join-code', code);
    await B.page.click('#b-join');
    await B.page.waitForSelector('#ov-wait:not([hidden])', { timeout: 8000 });
    ok(await B.page.evaluate(() => window.WAM.S.view.you.role) === 'player', '第二個人以玩家身分進來');

    /* 房主產生觀戰邀請連結，第三個人用連結進來 */
    await A.page.click('[data-act="invite"]');
    await sleep(300);
    await A.page.selectOption('#inv-role', 'spectator');
    await A.page.click('#b-invite-make');
    await sleep(600);
    const inviteUrl = await A.page.$eval('#invite-url', (e) => e.value);
    ok(/[?&]invite=[a-f0-9]{24}/.test(inviteUrl), '邀請連結格式正確', inviteUrl);
    await A.page.click('#b-invite-done');

    await C.page.goto(inviteUrl, { waitUntil: 'networkidle' });
    await C.page.waitForSelector('#ov-wait:not([hidden])', { timeout: 10000 });
    ok(await C.page.evaluate(() => window.WAM.S.view.you.role) === 'spectator', '邀請連結進來的是觀戰身分');

    /* 房主加一個電腦對手 */
    await A.page.click('[data-addai="normal"]');
    await sleep(500);
    ok(await A.page.evaluate(() => window.WAM.S.view.ai.length) === 1, '房主加得了電腦對手');
    ok(await B.page.evaluate(() => !window.WAM.S.view.you.can.manageAi), '非房主看不到管理電腦對手的權限');

    /* 準備 → 開打 */
    await A.page.click('[data-act="ready"]');
    await B.page.click('[data-act="ready"]');
    await sleep(600);
    ok(await A.page.evaluate(() => window.WAM.S.view.you.can.start), '全員準備後房主的開始鍵可以按');
    await A.page.screenshot({ path: path.join(SHOTS, 'online-room.png') });
    await A.page.click('[data-act="start"]');
    await sleep(2200);
    ok(await A.page.evaluate(() => window.WAM.S.view.phase) === 'playing', '進入對戰');
    ok(await C.page.evaluate(() => window.WAM.S.view.phase) === 'playing', '觀戰者也同步到對戰中');
    ok(await C.page.evaluate(() => window.WAM.S.match.moles !== undefined), '觀戰者看得到盤面');
    ok(await C.page.evaluate(() => !window.WAM.S.view.you.can.whack), '觀戰者沒有出手權限');

    /* 兩個人搶同一隻 */
    let raced = false;
    for (let i = 0; i < 120 && !raced; i++) {
      const target = await A.page.evaluate(() => {
        const s = window.WAM.S.match;
        const now = window.WAM.srvNow();
        const m = s && s.moles.filter((x) => x.side === 'bad' && x.hpLeft === 1 && now < x.expireAt - 250)[0];
        return m ? { hole: m.hole, id: m.id } : null;
      });
      if (!target) { await sleep(40); continue; }
      const tap = (p) => p.evaluate((h) => {
        document.querySelectorAll('.hole')[h].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      }, target.hole);
      await Promise.all([tap(A.page), tap(B.page)]);
      await sleep(260);
      const scores = await A.page.evaluate(() => window.WAM.S.match.standings.map((p) => ({ id: p.id, s: p.score, sw: p.swings })));
      if (scores.some((x) => x.s > 0)) raced = true;
    }
    ok(raced, '兩個玩家搶打之後有人拿到分數');
    ok(await C.page.evaluate(() => window.WAM.S.match.standings.some((p) => p.score !== 0)),
      '觀戰者的即時排行也跟著更新');
    await A.page.screenshot({ path: path.join(SHOTS, 'online-playing.png') });

    /* 聊天室（窄版要先把左側抽屜拉出來） */
    await B.page.evaluate(() => {
      const fab = document.getElementById('b-open-chat');
      if (fab.offsetParent !== null) fab.click();
    });
    await sleep(350);
    await B.page.click('#tab-chat');
    await B.page.fill('#chat-input', '這隻黃金鼠是我的');
    await B.page.click('#b-chat-send');
    await sleep(700);
    const gotChat = await A.page.evaluate(() =>
      [...document.querySelectorAll('#chat-log .msg')].some((n) => n.textContent.indexOf('黃金鼠') >= 0));
    ok(gotChat, '聊天訊息傳到房主的聊天室');
    const unread = await A.page.$eval('#chat-unread2', (e) => !e.hidden)
      || await A.page.$eval('#chat-unread', (e) => !e.hidden);
    ok(unread, '沒開著聊天分頁時會顯示未讀數');
    await A.page.evaluate(() => {
      const fab = document.getElementById('b-open-chat');
      if (fab.offsetParent !== null) fab.click();
      document.getElementById('tab-chat').click();
    });
    await sleep(300);
    ok(await A.page.$eval('#chat-unread', (e) => e.hidden), '看過之後未讀數消失');

    /* 摘要要真的反映線上狀態 */
    const sum = await A.page.$eval('#sum-room', (e) => e.textContent);
    ok(sum.indexOf(code) >= 0, '左側摘要顯示房號');
    ok(sum.indexOf('房主') >= 0, '左側摘要顯示自己的身分');

    for (const x of [A, B, C]) await x.ctx.close();
  }

  await browser.close();
  server.kill();
  await sleep(300);

  group('主控台');
  const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED/.test(e));
  ok(realErrors.length === 0, '沒有未處理的主控台錯誤', realErrors.slice(0, 5).join(' | '));

  console.log('\n' + '='.repeat(46));
  if (fail) {
    console.log('失敗 ' + fail + ' 項：');
    fails.forEach((f) => console.log('  ✗ ' + f));
  }
  console.log((fail ? '✗ ' : '✓ ') + '通過 ' + pass + ' / ' + (pass + fail) + ' 項');
  console.log('截圖：' + SHOTS);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
}

function eqNum(a, b, name) { return ok(a === b, name, 'got ' + a + ' want ' + b); }

main().catch((err) => {
  console.error('\n✗ 瀏覽器檢查中斷：', err && err.stack ? err.stack : err);
  process.exit(1);
});
