/*
 * scripts/online-check.js — 線上流程實測
 *
 * 這支不是模擬，是真的把 server.js 跑起來、開好幾個 socket.io 用戶端進去，
 * 驗證「共用盤面、搶打先得分」以及房間、觀戰、邀請、聊天、斷線重連。
 *
 *   node scripts/online-check.js
 *
 * 為了跑得快，這裡把一局縮短成幾秒（用環境變數覆蓋），規則本身不變。
 */
'use strict';

process.env.ROUND_MS = process.env.ROUND_MS || '14000';
process.env.COUNTDOWN_MS = process.env.COUNTDOWN_MS || '300';
process.env.GAME_ALLOWED_ORIGIN = '*';
process.env.PORT = process.env.PORT || '0';

const { io: ioClient } = require('socket.io-client');
const { server } = require('../server.js');
const Rules = require('../public/js/rules.js');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('   ✓ ' + name); return true; }
  fail++; fails.push(name + (extra ? '  → ' + extra : ''));
  console.log('   ✗ ' + name + (extra ? '  → ' + extra : ''));
  return false;
}
function eq(a, b, name) { return ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function group(t) { console.log('\n── ' + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 用戶端包裝 */

let base = '';

function makeClient(name, clientId) {
  const sock = ioClient(base, { transports: ['websocket'], reconnection: false, timeout: 8000 });
  const c = {
    name, clientId, sock,
    view: null, chat: [], errors: [], events: [], moles: new Map(), closed: null, left: false
  };
  sock.on('room:sync', (v) => { c.view = v; });
  sock.on('room:events', (p) => {
    const evs = p.events || [];
    c.events.push(...evs);
    /* 用事件流即時維護場上地鼠：同步包一秒才來一次，拿它去搶打一定是舊資料 */
    for (const ev of evs) {
      if (ev.k === 'spawn') c.moles.set(ev.mole.id, Object.assign({}, ev.mole));
      else if (ev.k === 'escape') c.moles.delete(ev.moleId);
      else if (ev.k === 'hit') {
        if (ev.killed) c.moles.delete(ev.moleId);
        else if (c.moles.has(ev.moleId)) c.moles.get(ev.moleId).hpLeft = ev.hpLeft;
      } else if (ev.k === 'end') c.moles.clear();
    }
  });
  sock.on('room:chat', (p) => { c.chat.push(p.message); });
  sock.on('room:error', (p) => { c.errors.push(p); });
  sock.on('room:closed', (p) => { c.closed = p; });
  sock.on('room:left', () => { c.left = true; });

  c.emit = (evt, payload) => new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'timeout' }); } }, 6000);
    sock.emit(evt, payload || {}, (res) => {
      if (done) return;
      done = true; clearTimeout(timer); resolve(res);
    });
  });
  c.send = (evt, payload) => sock.emit(evt, payload || {});
  c.close = () => new Promise((r) => { sock.close(); setTimeout(r, 60); });

  c.ready = new Promise((resolve, reject) => {
    sock.on('connect', async () => {
      const res = await c.emit('hello', { clientId, name });
      c.hello = res;
      resolve(c);
    });
    sock.on('connect_error', reject);
  });
  return c;
}

/** 等到某個條件成立，最多等 ms 毫秒 */
async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) {
    if (fn()) return true;
    await sleep(30);
  }
  console.log('     （等 ' + (label || '') + ' 逾時）');
  return false;
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  base = 'http://127.0.0.1:' + port;
  console.log('伺服器已啟動：' + base + '（一局 ' + process.env.ROUND_MS + 'ms）');

  group('健康檢查與 API');
  {
    const res = await fetch(base + '/health');
    const body = await res.json();
    ok(res.ok && body.ok, '/health 回 200 且 ok');
    eq(body.service, 'whack-a-mole', '/health 標示服務名稱');
    ok(typeof body.uptimeSec === 'number', '/health 有 uptime（免費方案冷啟動時看得出來）');
    const rooms = await (await fetch(base + '/api/rooms')).json();
    ok(Array.isArray(rooms.rooms), '/api/rooms 回房間陣列');
    const front = await fetch(base + '/');
    ok(front.ok && (await front.text()).indexOf('打地鼠') >= 0, '靜態前端送得出來');
  }

  group('建房、加入與座位上限');
  const clients = [];
  for (let i = 0; i < 6; i++) clients.push(makeClient('玩家' + (i + 1), 'client000000' + i));
  await Promise.all(clients.map((c) => c.ready));
  ok(clients.every((c) => c.hello && c.hello.ok), '6 個用戶端都完成 hello 交握');
  ok(clients[0].hello.serverTime > 0, 'hello 有回傳 serverTime（前端用來校時）');

  const host = clients[0];
  const created = await host.emit('room:create', { name: host.name, roomName: '測試地鼠田' });
  ok(created.ok && created.code, '房主建立房間：' + created.code);
  const code = created.code;

  for (let i = 1; i <= 4; i++) {
    const r = await clients[i].emit('room:join', { code, name: clients[i].name });
    eq(r.role, 'player', clients[i].name + ' 以玩家身分加入');
  }
  const sixth = await clients[5].emit('room:join', { code, name: clients[5].name });
  eq(sixth.role, 'spectator', '第 6 個人自動變成觀戰');
  eq(sixth.downgraded, true, '而且有明白告知是因為席位滿了');

  await until(() => host.view && host.view.members.length === 6, 3000, '房間同步');
  eq(host.view.seatsFree, 0, '5 個座位滿了');
  eq(host.view.members.filter((m) => m.role === 'player').length, 5, '5 位玩家');
  eq(host.view.you.can.start, false, '還有人沒準備，開始鍵是關的');
  ok(!!host.view.you.startBlockedBy, '而且說得出是誰還沒準備');

  group('邀請連結（觀戰、撤銷、過期）');
  {
    const bad = await clients[5].emit('room:invite', { role: 'player' });
    ok(!bad.ok, '非房主不能產生邀請連結');
    const inv = await host.emit('room:invite', { role: 'spectator', ttlMinutes: 10, maxUses: 1 });
    ok(inv.ok && inv.token, '房主產生觀戰邀請');

    const guest = makeClient('觀眾', 'guest0000001');
    await guest.ready;
    const chk = await guest.emit('invite:check', { code, token: inv.token });
    ok(chk.ok, '加入前先驗證邀請有效');
    eq(chk.role, 'spectator', '邀請指定的身分是觀戰');
    const j = await guest.emit('room:join', { code, token: inv.token, name: '觀眾' });
    eq(j.role, 'spectator', '用邀請進來就是觀戰身分');

    const guest2 = makeClient('觀眾2', 'guest0000002');
    await guest2.ready;
    const chk2 = await guest2.emit('invite:check', { code, token: inv.token });
    eq(chk2.code, 'used', '只能用一次的邀請，第二次就失效');
    await guest2.close();

    const inv2 = await host.emit('room:invite', { role: 'player', ttlMinutes: 10, maxUses: 5 });
    host.send('room:revokeInvite', { token: inv2.token });
    await sleep(150);
    const chk3 = await guest.emit('invite:check', { code, token: inv2.token });
    eq(chk3.code, 'revoked', '撤銷後的邀請會明白說是被撤銷');
    const chk4 = await guest.emit('invite:check', { code, token: 'ffffffffffffffffffffffff' });
    eq(chk4.code, 'badinvite', '亂填的邀請無效');
    await guest.close();
  }

  group('聊天室');
  {
    clients[1].send('room:chat', { text: '大家好，我要搶黃金鼠' });
    await until(() => clients[3].chat.some((m) => m.text.indexOf('黃金鼠') >= 0), 3000, '聊天送達');
    ok(clients[3].chat.some((m) => m.text.indexOf('黃金鼠') >= 0), '訊息廣播給房內所有人');
    ok(clients[5].chat.some((m) => m.text.indexOf('黃金鼠') >= 0), '觀戰者也收得到聊天');

    clients[1].errors.length = 0;
    clients[1].send('room:chat', { text: '連發測試' });
    await sleep(250);
    ok(clients[1].errors.some((e) => e.code === 'rate'), '連發會被擋下（防洗版）');

    host.send('room:mute', { targetId: clients[1].clientId, seconds: 30 });
    await sleep(250);
    clients[1].errors.length = 0;
    clients[1].send('room:chat', { text: '我被禁言了嗎' });
    await sleep(250);
    ok(clients[1].errors.some((e) => e.code === 'muted'), '被禁言的人不能發言');
  }

  group('房主設定盤面大小');
  {
    const notHost = clients[1];
    notHost.errors.length = 0;
    notHost.send('room:setBoard', { board: '6x4' });
    await sleep(220);
    ok(notHost.errors.some((e) => e.code === 'perm'), '非房主不能改盤面大小');
    eq(host.view.board, '4x3', '被擋下來之後盤面沒變');

    host.errors.length = 0;
    host.send('room:setBoard', { board: '9x9' });
    await sleep(220);
    ok(host.errors.some((e) => e.code === 'badboard'), '不存在的盤面被伺服器擋下來');

    ok(host.view.boards && host.view.boards.length >= 3, '房間投影帶著可選盤面清單');
    ok(host.view.you.can.setBoard, '房主在準備階段可以改盤面');

    host.send('room:setBoard', { board: '6x4' });
    await until(() => host.view.board === '6x4', 2000, '盤面改成 6x4');
    eq(host.view.board, '6x4', '房主改得動盤面');
    eq(notHost.view.board, '6x4', '其他人也同步看到新盤面');
    ok(notHost.view.chat.some((m) => (m.text || '').indexOf('6') >= 0 || (m.text || '').indexOf('盤面') >= 0),
      '改盤面會在聊天室留下系統訊息');
  }

  group('開始對局');
  {
    /* 讓其中一位改成觀戰，空出來的位子加一個困難電腦，驗證 AI 座位 */
    clients[4].send('room:stand');
    await until(() => host.view.seatsFree === 1, 2000, '空出座位');
    host.send('room:addAi', { level: 'hard' });
    await until(() => host.view.ai.length === 1, 2000, '加入 AI');
    eq(host.view.ai.length, 1, '房間裡有 1 個電腦對手');
    eq(host.view.seatsFree, 0, '電腦對手也佔一個座位');

    const notHost = clients[1];
    notHost.errors.length = 0;
    notHost.send('room:addAi', { level: 'easy' });
    await sleep(200);
    ok(notHost.errors.some((e) => e.code === 'perm'), '非房主不能加電腦對手');

    for (let i = 0; i <= 3; i++) clients[i].send('room:ready', { ready: true });
    await until(() => host.view.you.can.start, 3000, '全員準備');
    ok(host.view.you.can.start, '全員準備後房主可以開始');

    host.send('room:start');
    await until(() => host.view.phase === 'countdown' || host.view.phase === 'playing', 3000, '開賽');
    ok(['countdown', 'playing'].indexOf(host.view.phase) >= 0, '進入開賽倒數');
    await until(() => host.view.phase === 'playing', 4000, '倒數結束');
    eq(host.view.phase, 'playing', '倒數結束後開打');
    ok(host.view.match && host.view.match.seed, '對局有種子，可重播');
    eq(host.view.match.holes, 24, '開局用的是房主選的 24 洞盤面');
    eq(host.view.match.board, '6x4', '快照帶著盤面 key');
    host.errors.length = 0;
    host.send('room:setBoard', { board: '4x3' });
    await sleep(220);
    ok(host.errors.some((e) => e.code === 'phase'), '對局進行中不能改盤面');
    eq(host.view.board, '6x4', '進行中盤面保持不變');
  }

  group('搶打先得分（共用盤面的核心）');
  {
    await until(() => host.events.some((e) => e.k === 'spawn'), 3000, '地鼠冒出');
    ok(host.events.filter((e) => e.k === 'spawn').length > 0, '所有人都收到地鼠冒出的事件');
    ok(clients[5].events.filter((e) => e.k === 'spawn').length > 0, '觀戰者也看得到盤面事件');

    /* 觀戰者不能出手 */
    clients[5].errors.length = 0;
    clients[5].send('room:whack', { hole: 0 });
    await sleep(250);
    ok(clients[5].errors.some((e) => e.code === 'role'), '觀戰者敲不了地鼠');

    /* 兩個玩家同時敲同一隻壞地鼠，只有一個人拿得到分 */
    let raced = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 9000 && !raced) {
      const now = Date.now();
      const target = [...host.moles.values()].filter(
        (m) => m.side === 'bad' && m.hpLeft === 1 && now < m.expireAt - 250
      )[0];
      if (!target) { await sleep(25); continue; }
      const before = host.events.length;
      clients[0].send('room:whack', { hole: target.hole, moleId: target.id });
      clients[1].send('room:whack', { hole: target.hole, moleId: target.id });
      await sleep(200);
      const fresh = host.events.slice(before);
      const hits = fresh.filter((e) => e.k === 'hit' && e.moleId === target.id);
      const misses = fresh.filter((e) => e.k === 'miss');
      if (hits.length >= 1) {
        raced = true;
        eq(hits.length, 1, '同一隻地鼠只判給一個人');
        ok(hits[0].gain > 0, '搶到的人拿到正分（' + hits[0].gain + ' 分）');
        ok(misses.length >= 1, '慢一步的人被判成空槌，沒有拿到分數');
        const loser = hits[0].by === clients[0].clientId ? clients[1] : clients[0];
        ok(misses.some((e) => e.by === loser.clientId), '沒搶到的人收到的是 miss 而不是 hit');
      }
    }
    ok(raced, '有成功測到兩人搶同一隻地鼠的情形');
  }

  group('斷線重連保留座位與分數');
  {
    const victim = clients[2];
    /* 先讓他敲一下，確定有分數可以保留 */
    for (let i = 0; i < 60; i++) {
      const t = [...host.moles.values()].filter((m) => m.side === 'bad')[0];
      if (t) { victim.send('room:whack', { hole: t.hole, moleId: t.id }); await sleep(70); }
      const row = (host.view.match.standings || []).find((p) => p.id === victim.clientId);
      if (row && row.swings > 0) break;
      await sleep(40);
    }
    /* 完整狀態一秒才同步一次，所以要先等一份新的再讀，不然拿到的是舊分數 */
    await sleep(1300);
    const rowBefore = host.view.match.standings.find((p) => p.id === victim.clientId);
    ok(!!rowBefore, '斷線前排行榜裡有他（' + (rowBefore ? rowBefore.score : '?') + ' 分）');

    victim.sock.close();
    await until(() => {
      const m = host.view.members.find((x) => x.id === victim.clientId);
      return m && !m.connected;
    }, 3000, '標記斷線');
    const m1 = host.view.members.find((x) => x.id === victim.clientId);
    ok(m1 && !m1.connected, '伺服器標記為斷線，座位先保留');
    eq(m1.role, 'player', '座位沒有被馬上收走');

    const back = makeClient(victim.name, victim.clientId);
    await back.ready;
    const rejoin = await back.emit('room:join', { code, name: victim.name });
    ok(rejoin.ok && rejoin.reconnected, '用同一個 clientId 回到原本的座位');
    eq(rejoin.role, 'player', '回來還是玩家身分');
    await until(() => back.view && back.view.match, 3000, '重連同步');
    const rowAfter = back.view.match.standings.find((p) => p.id === victim.clientId);
    ok(!!rowAfter && rowAfter.score === rowBefore.score, '分數在斷線期間沒有被清掉');
    clients[2] = back;
  }

  group('結算');
  {
    await until(() => host.view.phase === 'over', 20000, '時間到');
    eq(host.view.phase, 'over', '時間到自動結算');
    const st = host.view.match.standings;
    eq(st.length, 5, '5 位參賽者（4 位玩家 + 1 個電腦）都在排行榜上');
    ok(st[0].rank === 1, '排名從 1 開始');
    ok(st.every((p, i) => i === 0 || st[i - 1].score >= p.score), '排行榜依分數由高到低');
    const ai = st.find((p) => p.id.indexOf('ai:') === 0);
    ok(ai && ai.score > 0, '伺服器端的電腦對手真的有得分（' + (ai ? ai.score : 0) + ' 分）');
    ok(st.some((p) => p.swings > 0), '有人真的出過手');
    ok(host.view.match.spawned > 5, '這一局冒出過 ' + host.view.match.spawned + ' 隻地鼠');

    /* 觀戰者也拿得到完整結算 */
    ok(clients[5].view && clients[5].view.match && clients[5].view.match.standings.length === 5,
      '觀戰者看得到完整結算');

    /* 結算後可以下場、可以再來一局 */
    await until(() => clients[5].view.you.can.sit === false || clients[5].view.you.can.sit === true, 1000);
    ok(host.view.you.can.rematch, '玩家可以投票再來一局');
    ok(host.view.you.can.reset, '房主可以把房間拉回準備階段');

    host.send('room:reset');
    await until(() => host.view.phase === 'lobby', 3000, '回到大廳');
    eq(host.view.phase, 'lobby', '房主把房間拉回準備階段');
    eq(host.view.you.ready, false, '所有人的準備狀態重置');
  }

  group('大廳列表與離開');
  {
    const lobby = makeClient('逛大廳的人', 'lobby0000001');
    await lobby.ready;
    const rooms = await new Promise((resolve) => {
      lobby.sock.once('lobby:rooms', resolve);
      lobby.send('lobby:subscribe');
    });
    ok(rooms.rooms.some((r) => r.code === code), '公開房間出現在大廳列表');
    const row = rooms.rooms.find((r) => r.code === code);
    ok(row.players + row.ai <= row.seats, '列表上的人數不會超過座位上限');
    await lobby.close();

    host.send('room:leave');
    await until(() => host.left, 3000, '離開房間');
    ok(host.left, '房主離開房間');
    await until(() => clients[1].view && clients[1].view.hostId === clients[1].clientId
      || (clients[1].view && clients[1].view.hostId !== host.clientId), 3000, '房主轉移');
    ok(clients[1].view.hostId !== host.clientId, '房主身分轉移給其他人');
  }

  for (const c of clients) await c.close();
  await sleep(200);

  console.log('\n' + '='.repeat(46));
  if (fail) {
    console.log('失敗 ' + fail + ' 項：');
    fails.forEach((f) => console.log('  ✗ ' + f));
  }
  console.log((fail ? '✗ ' : '✓ ') + '通過 ' + pass + ' / ' + (pass + fail) + ' 項');
  console.log('='.repeat(46));
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n✗ 線上流程實測中斷：', err && err.stack ? err.stack : err);
  try { server.close(); } catch (e) {}
  process.exit(1);
});
