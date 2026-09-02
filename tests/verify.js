/*
 * tests/verify.js — 規則、AI、房間與設定解析的單元測試
 *
 * 不需要啟動伺服器，也不需要瀏覽器：
 *   node tests/verify.js
 *
 * 這裡驗的是「規則說了算」的部分。線上流程（真的開 socket 對打）
 * 由 scripts/online-check.js 負責。
 */
'use strict';

const path = require('path');
const Module = require('module');

const Rules = require('../public/js/rules.js');
const AI = require('../public/js/ai.js');
const RNG = require('../public/js/rng.js');
const { RoomStore, sanitizeName, sanitizeText, DISCONNECT_GRACE_MS } = require('../lib/rooms.js');

let pass = 0, fail = 0;
const fails = [];

function ok(cond, name, extra) {
  if (cond) { pass++; return true; }
  fail++;
  fails.push(name + (extra ? '  → ' + extra : ''));
  return false;
}
function eq(a, b, name) { return ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function near(a, b, tol, name) { return ok(Math.abs(a - b) <= tol, name, 'got ' + a + ' want ~' + b); }
function group(title) { console.log('\n── ' + title); }

const T0 = 1700000000000;

/* ============================================================ 圖鑑 */
group('地鼠圖鑑');

eq(Rules.MOLE_ORDER.length, 11, '共 11 種地鼠');
eq(Rules.BAD_TYPES.length, 7, '壞人 7 種');
eq(Rules.GOOD_TYPES.length, 4, '好人 4 種');
ok(Rules.BAD_TYPES.every((k) => Rules.typeOf(k).points > 0), '壞人分數都是正的');
ok(Rules.GOOD_TYPES.every((k) => Rules.typeOf(k).points < 0), '好人分數都是負的');
ok(new Set(Rules.MOLE_ORDER.map((k) => Rules.typeOf(k).points)).size === 11, '11 種分數各不相同');
ok(Rules.MOLE_ORDER.every((k) => Rules.typeOf(k).label && Rules.typeOf(k).hint), '每種都有名字與說明');
ok(Rules.MOLE_ORDER.some((k) => Rules.typeOf(k).hp > 1), '有需要敲多下的地鼠');
for (let s = 1; s <= 3; s++) {
  const w = Rules.weightsFor(s);
  ok(w.length >= 4, '第 ' + s + ' 階段至少有 4 種地鼠', 'got ' + w.length);
  ok(w.some((x) => Rules.typeOf(x.key).side === 'good'), '第 ' + s + ' 階段一定有好人');
  ok(w.some((x) => Rules.typeOf(x.key).side === 'bad'), '第 ' + s + ' 階段一定有壞人');
}
ok(Rules.weightsFor(3).length > Rules.weightsFor(1).length, '愈後面的階段種類愈多');

/* ============================================================ 階段 */
group('階段節奏');

eq(Rules.stageAt(0).no, 1, '0 秒是第 1 階段');
/* 階段切點是「一局的三分之一、三分之二」，不是寫死的 30/60 秒 ——
   這樣 60 秒或 75 秒的局也走得完三個階段。 */
for (const sec of Rules.ROUND_SECONDS) {
  const ms = sec * 1000;
  eq(Rules.stageAt(0, ms).no, 1, sec + ' 秒局：開頭是第 1 階段');
  eq(Rules.stageAt(ms / 3 - 1, ms).no, 1, sec + ' 秒局：三分之一前還在第 1 階段');
  eq(Rules.stageAt(ms / 3, ms).no, 2, sec + ' 秒局：三分之一進第 2 階段');
  eq(Rules.stageAt(ms * 2 / 3 - 1, ms).no, 2, sec + ' 秒局：三分之二前還在第 2 階段');
  eq(Rules.stageAt(ms * 2 / 3, ms).no, 3, sec + ' 秒局：三分之二進第 3 階段');
  eq(Rules.stageAt(ms - 1, ms).no, 3, sec + ' 秒局：結束前是第 3 階段');
}
eq(Rules.stageAt(30000, 90000).no, 2, '90 秒局的 30 秒仍然是第 2 階段（和舊版一致）');
eq(Rules.stageAt(60000, 90000).no, 3, '90 秒局的 60 秒仍然是第 3 階段（和舊版一致）');
ok(Rules.STAGES[2].spawnMs < Rules.STAGES[1].spawnMs, '愈後面冒得愈快');
ok(Rules.STAGES[2].maxUp > Rules.STAGES[0].maxUp, '愈後面同時出現的愈多');
ok(Rules.STAGES[2].upScale < Rules.STAGES[0].upScale, '愈後面停留愈短');

/* 一局長度 */
eq(Rules.ROUND_SECONDS.join(','), '60,75,90', '一局長度可以選 60／75／90 秒');
eq(Rules.ROUND_MS, 60000, '預設一局 60 秒');
eq(Rules.roundMsOf(75), 75000, '75 秒換算成毫秒');
eq(Rules.roundMsOf(12), 60000, '不在清單裡的長度收斂回預設');
eq(Rules.roundMsOf(undefined), 60000, '沒給長度就是預設');
eq(Rules.roundSecOf(90000), 90, '毫秒換回秒數');
eq(Rules.roundSecOf(123456), 123, '毫秒換秒只是顯示用，不做收斂（伺服器可以自訂長度）');
eq(Rules.roundSecOf(0), 60, '換不出秒數才回到預設');
{
  const st = Rules.createMatch({ seed: 'r', players: [{ id: 'a', name: 'A' }], now: T0, roundMs: 75000 });
  eq(st.endAt - st.startAt, 75000, '對局真的用了指定的長度');
  eq(Rules.snapshot(st, T0).remainMs, 75000, '快照的剩餘時間跟著長度走');
}

/* ============================================================ 計分 */
group('計分規則');

eq(Rules.scoreHit({ type: 'mole', combo: 0, killed: true }).gain, 10, '小土鼠 +10');
eq(Rules.scoreHit({ type: 'bunny', combo: 0, killed: true }).gain, -20, '小兔子 -20');
eq(Rules.hitUnit('helmet'), 22, '鐵盔鼠每下 22（44 / 2 下）');
eq(Rules.scoreHit({ type: 'helmet', combo: 0, killed: false }).gain, 22, '鐵盔鼠第一下 22');
eq(Rules.scoreHit({ type: 'helmet', combo: 0, killed: true }).gain, 44, '鐵盔鼠尾刀多拿一份');
eq(Rules.comboMultiplier(0), 1, '0 連擊沒有加成');
eq(Rules.comboMultiplier(4), 1, '4 連擊還沒到門檻');
near(Rules.comboMultiplier(5), 1.1, 1e-9, '5 連擊 +10%');
near(Rules.comboMultiplier(25), 1.5, 1e-9, '25 連擊 +50%');
near(Rules.comboMultiplier(80), 1.5, 1e-9, '連擊加成上限 +50%');
eq(Rules.scoreHit({ type: 'mole', combo: 10, killed: true }).gain, 12, '10 連擊的小土鼠 +12');
eq(Rules.scoreHit({ type: 'mole', combo: 0, killed: true, buffed: true }).gain, 20, '彩虹加倍 +20');
eq(Rules.scoreHit({ type: 'bunny', combo: 30, killed: true, buffed: true }).gain, -20,
  '好人不吃連擊也不吃加倍，扣分固定');

/* ============================================================ 對局流程 */
group('對局流程');

function newMatch(players, opts) {
  return Rules.createMatch(Object.assign({
    seed: 'TEST', players, now: T0, countdownMs: 0
  }, opts || {}));
}

const st1 = newMatch([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
eq(Rules.phaseOf(st1, T0), 'playing', '倒數 0 就直接開打');
eq(Rules.phaseOf(newMatch([{ id: 'a', name: 'A' }], { countdownMs: 3000 }), T0), 'countdown', '有倒數時是 countdown');
eq(Rules.phaseOf(st1, T0 + Rules.ROUND_MS), 'over', '時間到就是 over');
eq(st1.holes, 12, '12 個地洞');

/* 決定性：同一個種子跑兩次，冒出來的地鼠序列完全一樣 */
function spawnSeq(seed) {
  const st = newMatch([{ id: 'a', name: 'A' }], { seed });
  const rng = RNG.createRng('spawn:' + seed);
  const out = [];
  for (let t = T0; t < T0 + 20000; t += 50) {
    for (const ev of Rules.tick(st, t, rng)) {
      if (ev.k === 'spawn') out.push(ev.mole.hole + ':' + ev.mole.type + ':' + (ev.mole.spawnAt - T0));
    }
  }
  return out;
}
const seqA = spawnSeq('SEEDX'), seqB = spawnSeq('SEEDX'), seqC = spawnSeq('SEEDY');
ok(seqA.length > 15, '20 秒內至少冒出 15 隻', 'got ' + seqA.length);
eq(seqA.join('|'), seqB.join('|'), '同種子重播一模一樣');
ok(seqA.join('|') !== seqC.join('|'), '不同種子會長出不同的地鼠序列');

/* 同時最多幾隻，不能超過該階段上限 */
{
  const st = newMatch([{ id: 'a', name: 'A' }]);
  const rng = RNG.createRng('cap');
  let worst = 0;
  for (let t = T0; t < T0 + Rules.ROUND_MS; t += 50) {
    Rules.tick(st, t, rng);
    const cap = Rules.stageAt(t - T0).maxUp;
    worst = Math.max(worst, st.moles.length - cap);
  }
  ok(worst <= 0, '同時出現的地鼠沒有超過階段上限', 'over by ' + worst);
}

/* 一個地洞同時只會有一隻 */
{
  const st = newMatch([{ id: 'a', name: 'A' }]);
  const rng = RNG.createRng('holes');
  let dup = false;
  for (let t = T0; t < T0 + Rules.ROUND_MS; t += 50) {
    Rules.tick(st, t, rng);
    const seen = new Set();
    for (const m of st.moles) { if (seen.has(m.hole)) dup = true; seen.add(m.hole); }
  }
  ok(!dup, '同一個地洞不會同時擠兩隻地鼠');
}

/* ============================================================ 搶打判定 */
group('共用盤面・搶打先得分');

function forceMole(st, hole, type, now, upMs) {
  const t = Rules.typeOf(type);
  const m = {
    id: st.nextMoleId++, hole, type, side: t.side, hp: t.hp, hpLeft: t.hp,
    spawnAt: now, expireAt: now + (upMs || 3000), upMs: upMs || 3000, stage: 1
  };
  st.moles.push(m);
  return m;
}

{
  const st = newMatch([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const m = forceMole(st, 3, 'mole', T0);
  const r1 = Rules.whack(st, 'a', { hole: 3, moleId: m.id }, T0 + 10);
  const r2 = Rules.whack(st, 'b', { hole: 3, moleId: m.id }, T0 + 11);
  ok(r1.ok && r1.event.k === 'hit', 'A 先敲到，判定為命中');
  eq(r1.event.gain, 10, 'A 拿到 10 分');
  ok(r2.ok && r2.event.k === 'miss', 'B 慢一步只敲到空氣');
  eq(st.players.b.score, 0, 'B 沒有拿到分數');
  eq(st.moles.length, 0, '地鼠被打掉了');
}

{
  /* 多血地鼠：兩個人分食，尾刀的人多拿一份 */
  const st = newMatch([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const m = forceMole(st, 5, 'helmet', T0);
  const r1 = Rules.whack(st, 'a', { hole: 5, moleId: m.id }, T0 + 10);
  eq(r1.event.gain, 22, 'A 敲第一下拿 22');
  eq(r1.event.killed, false, '第一下還沒倒');
  eq(r1.event.hpLeft, 1, '剩 1 下');
  const r2 = Rules.whack(st, 'b', { hole: 5, moleId: m.id }, T0 + 20);
  eq(r2.event.killed, true, 'B 補上尾刀');
  eq(r2.event.gain, 44, '尾刀 22 + 22 的獎勵');
  eq(st.moles.length, 0, '倒了就消失');
}

{
  /* 過期的地鼠敲不到；敲空不扣分也不斷連擊 */
  const st = newMatch([{ id: 'a', name: 'A' }]);
  const first = forceMole(st, 0, 'mole', T0);
  Rules.whack(st, 'a', { hole: 0, moleId: first.id }, T0 + 5);
  eq(st.players.a.combo, 1, '敲中壞人連擊 +1');

  /* 把下一次自動冒出的時間推到很後面，這一段才不會有新地鼠混進來 */
  st.nextSpawnAt = T0 + 9999999;
  const m = forceMole(st, 1, 'mole', T0, 500);
  const evs = Rules.tick(st, T0 + 600, RNG.createRng('x'));
  ok(evs.some((e) => e.k === 'escape' && e.moleId === m.id), '停留時間到就溜走');
  eq(st.escaped, 1, '逃走數 +1');

  const r = Rules.whack(st, 'a', { hole: 1 }, T0 + 700);
  eq(r.event.k, 'miss', '地鼠溜了之後只敲得到空氣');
  eq(st.players.a.score, 10, '空槌不扣分');
  eq(st.players.a.combo, 1, '空槌不會打斷連擊');
  eq(st.players.a.swings, 2, '空槌仍然算一次出手');
}

{
  /* 敲到好人：扣分且連擊歸零 */
  const st = newMatch([{ id: 'a', name: 'A' }]);
  for (let i = 0; i < 6; i++) {
    const m = forceMole(st, i, 'mole', T0);
    Rules.whack(st, 'a', { hole: i, moleId: m.id }, T0 + i);
  }
  eq(st.players.a.combo, 6, '連 6 下');
  const before = st.players.a.score;
  const g = forceMole(st, 9, 'farmer', T0);
  const r = Rules.whack(st, 'a', { hole: 9, moleId: g.id }, T0 + 50);
  eq(r.event.gain, -35, '農夫爺爺 -35');
  eq(st.players.a.score, before - 35, '真的扣掉了');
  eq(st.players.a.combo, 0, '連擊歸零');
  eq(st.players.a.bestCombo, 6, '最佳連擊有留下來');
}

{
  /* 彩虹鼠：之後 6 秒內正分加倍，好人不受影響 */
  const st = newMatch([{ id: 'a', name: 'A' }]);
  const rb = forceMole(st, 0, 'rainbow', T0);
  Rules.whack(st, 'a', { hole: 0, moleId: rb.id }, T0);
  ok(st.players.a.buffUntil === T0 + Rules.BUFF_MS, '加倍狀態開始');
  const m1 = forceMole(st, 2, 'mole', T0 + 1000);
  const r1 = Rules.whack(st, 'a', { hole: 2, moleId: m1.id }, T0 + 1000);
  ok(r1.event.buffed, '加倍期間的命中標記為 buffed');
  const m2 = forceMole(st, 4, 'mole', T0 + 9000);
  const r2 = Rules.whack(st, 'a', { hole: 4, moleId: m2.id }, T0 + 9000);
  ok(!r2.event.buffed, '過了 6 秒就沒有加倍了');
}

{
  /* 不在這一局裡的人不能敲；時間到之後也不能敲 */
  const st = newMatch([{ id: 'a', name: 'A' }]);
  forceMole(st, 0, 'mole', T0);
  const r1 = Rules.whack(st, 'ghost', { hole: 0 }, T0);
  eq(r1.code, 'notplayer', '不是玩家的人被擋下');
  const r2 = Rules.whack(st, 'a', { hole: 0 }, T0 + Rules.ROUND_MS + 1000);
  eq(r2.code, 'phase', '時間到之後不能再敲');
  const r3 = Rules.whack(st, 'a', { hole: 99 }, T0);
  eq(r3.code, 'badhole', '不存在的地洞被擋下');
}

/* ============================================================ 結算 */
group('結算與排名');

{
  const st = newMatch([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
  const ma = forceMole(st, 0, 'golden', T0);
  Rules.whack(st, 'a', { hole: 0, moleId: ma.id }, T0);
  const mb = forceMole(st, 1, 'mole', T0);
  Rules.whack(st, 'b', { hole: 1, moleId: mb.id }, T0);
  Rules.finish(st, T0 + Rules.ROUND_MS);
  const rank = Rules.standings(st);
  eq(rank[0].id, 'a', '黃金鼠讓 A 拿第一');
  eq(rank[0].rank, 1, '第一名 rank = 1');
  eq(rank[2].id, 'c', '沒得分的排最後');
  eq(st.winner, 'a', 'winner 是 A');
  eq(st.draw, false, '不是平手');
}

{
  const st = newMatch([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const ma = forceMole(st, 0, 'mole', T0);
  Rules.whack(st, 'a', { hole: 0, moleId: ma.id }, T0);
  const mb = forceMole(st, 1, 'mole', T0);
  Rules.whack(st, 'b', { hole: 1, moleId: mb.id }, T0);
  Rules.finish(st, T0 + Rules.ROUND_MS);
  ok(st.draw, '同分是平手');
  eq(st.winner, null, '平手沒有單一贏家');
  eq(Rules.standings(st)[1].rank, 1, '同分兩個人都是第 1 名');
}

{
  /* tick 到時間就會自己結束並送出 end 事件 */
  const st = newMatch([{ id: 'a', name: 'A' }]);
  const rng = RNG.createRng('end');
  let ended = false;
  for (let t = T0; t < T0 + Rules.ROUND_MS + 1000; t += 100) {
    if (Rules.tick(st, t, rng).some((e) => e.k === 'end')) ended = true;
  }
  ok(ended, '時間到會送出 end 事件');
  ok(st.over, '狀態標記為結束');
  eq(st.moles.length, 0, '結束後盤面清空');
}

/* ============================================================ AI */
group('電腦對手難度分級');

eq(AI.ORDER.join(','), 'rookie,easy,normal,hard', '四段難度，最低是超級新手');
ok(AI.levelOf('rookie').reactionMs > AI.levelOf('easy').reactionMs, '超級新手反應比簡單還慢');
ok(AI.levelOf('rookie').goodMistake > AI.levelOf('easy').goodMistake, '超級新手更常誤敲好人');
ok(AI.levelOf('easy').reactionMs > AI.levelOf('normal').reactionMs, '簡單反應比普通慢');
ok(AI.levelOf('normal').reactionMs > AI.levelOf('hard').reactionMs, '普通反應比困難慢');
ok(AI.levelOf('easy').goodMistake > AI.levelOf('hard').goodMistake, '簡單比較常誤敲好人');
ok(AI.levelOf('easy').moveMs > AI.levelOf('hard').moveMs, '簡單移動槌子比較慢');
eq(AI.gridDistance(0, 3, 4), 3, '同一列跨 3 格');
eq(AI.gridDistance(0, 11, 4), 3, '對角距離用切比雪夫算');
eq(AI.gridDistance(-1, 5, 4), 0, '第一槌沒有移動成本');

function simSolo(level, seed) {
  const st = newMatch([{ id: 'a', name: level, ai: level }], { seed });
  const rng = RNG.createRng('spawn:' + seed);
  const brain = AI.createBrain(level, level + seed);
  for (let t = T0; t <= T0 + Rules.ROUND_MS + 100; t += 25) {
    Rules.tick(st, t, rng);
    if (st.over) break;
    const aim = brain.step(Rules.snapshot(st, t), t);
    if (aim) Rules.whack(st, 'a', aim, t);
  }
  return Rules.standings(st)[0];
}

const avg = {};
for (const lv of AI.ORDER) {
  let score = 0, good = 0, acc = 0;
  const N = 5;
  for (let i = 0; i < N; i++) {
    const r = simSolo(lv, 'AI' + i);
    score += r.score; good += r.goodHits; acc += r.accuracy;
  }
  avg[lv] = { score: score / N, good: good / N, acc: acc / N };
  console.log('   ' + AI.levelOf(lv).label + '：平均 ' + Math.round(avg[lv].score)
    + ' 分、誤敲好人 ' + avg[lv].good.toFixed(1) + ' 次、命中率 ' + Math.round(avg[lv].acc * 100) + '%');
}
ok(avg.easy.score > avg.rookie.score, '簡單比超級新手高分');
ok(avg.normal.score > avg.easy.score * 1.4, '普通明顯比簡單高分');
ok(avg.hard.score > avg.normal.score * 1.2, '困難明顯比普通高分');
ok(avg.easy.good > avg.hard.good, '簡單比困難更常誤敲好人');
ok(avg.hard.acc > avg.easy.acc, '困難的命中率比較高');
ok(avg.rookie.score > 0, '連超級新手都不會被扣到負分（小朋友玩得下去）');

/* ============================================================ 房間 */
group('房間、座位與觀戰');

function newRoom(opts) {
  const store = new RoomStore({});
  const res = store.create('host00000001', Object.assign({ name: '房主', now: T0 }, opts || {}));
  return { store, room: res.room };
}

{
  const { room } = newRoom();
  eq(room.code.length, 5, '房號 5 碼');
  ok(!/[01OI]/.test(room.code), '房號不含容易看錯的 0 O 1 I');
  eq(room.players().length, 1, '開房的人自動入座');
  eq(room.seatsFree(), 4, '5 個座位剩 4 個');
  eq(room.hostId, 'host00000001', '開房的人是房主');
}

{
  /* 座位上限 5：第 6 個人自動轉觀戰，而且要明講 */
  const { room } = newRoom();
  for (let i = 2; i <= 5; i++) {
    const r = room.join('player0000' + i, { name: 'P' + i, now: T0 });
    eq(r.member.role, 'player', '第 ' + i + ' 個人坐得下');
  }
  eq(room.seatsFree(), 0, '5 人滿座');
  const six = room.join('player00006', { name: 'P6', now: T0 });
  eq(six.member.role, 'spectator', '第 6 個人變成觀戰');
  eq(six.downgraded, true, '有回報「被降級成觀戰」，不是默默處理');
  eq(room.spectators().length, 1, '觀戰名單有 1 人');
  const sit = room.becomePlayer('player00006');
  eq(sit.ok, false, '滿座時不能硬坐下');
  eq(sit.code, 'full', '原因是滿座');
}

{
  /* AI 也佔座位 */
  const { room } = newRoom();
  eq(room.addAi('host00000001', 'hard').ok, true, '房主可以加電腦對手');
  eq(room.addAi('player00002', 'hard').ok, false, '非房主不能加');
  eq(room.seatsFree(), 3, '電腦對手也佔一個座位');
  room.addAi('host00000001', 'easy');
  room.addAi('host00000001', 'normal');
  room.addAi('host00000001', 'easy');
  eq(room.seatsFree(), 0, '4 個電腦 + 房主剛好滿座');
  eq(room.addAi('host00000001', 'easy').code, 'full', '滿了就加不進去');
}

{
  /* 準備 → 開始 → 對戰中加入只能觀戰 */
  const { room } = newRoom();
  eq(room.start('host00000001', T0).ok, false, '沒準備不能開始');
  room.setReady('host00000001', true);
  eq(room.canStart().ok, true, '準備好就能開始');
  eq(room.start('player00002', T0).code, 'perm', '非房主不能開始');
  eq(room.start('host00000001', T0, { countdownMs: 0 }).ok, true, '房主開始這一局');
  room.step(T0 + 10);
  eq(room.phase, 'playing', '進入對戰');
  const late = room.join('player00009', { name: '晚到', now: T0 + 1000 });
  eq(late.member.role, 'spectator', '對戰中加入的人先觀戰');
  eq(late.waiting, true, '有回報「下一局才能下場」');
  const w = room.whack('player00009', { hole: 0 }, T0 + 1200);
  eq(w.code, 'role', '觀戰者不能敲地鼠');
  const v = room.viewFor('player00009', T0 + 1200);
  eq(v.you.can.whack, false, '觀戰者的 whack 權限是關的');
  eq(v.match.moles !== undefined, true, '觀戰者看得到盤面（打地鼠沒有隱藏資訊）');
}

{
  /* 一局跑完：伺服器端 AI 真的有出手 */
  const { room } = newRoom();
  room.addAi('host00000001', 'hard');
  room.setReady('host00000001', true);
  room.start('host00000001', T0, { countdownMs: 0 });
  let events = 0, hits = 0;
  for (let t = T0; t < T0 + Rules.ROUND_MS + 500; t += 50) {
    for (const ev of room.step(t).events) { events++; if (ev.k === 'hit') hits++; }
  }
  eq(room.phase, 'over', '時間到房間進入結算');
  ok(events > 100, '一局有上百個事件', 'got ' + events);
  ok(hits > 20, '伺服器端 AI 真的有敲到地鼠', 'got ' + hits);
  const rank = Rules.standings(room.state);
  ok(rank.find((r) => r.id.indexOf('ai:') === 0).score > 0, '電腦對手拿到分數');
}

{
  /* 斷線保留座位，太久沒回來才釋出 */
  const { store, room } = newRoom();
  room.join('player00002', { name: 'P2', now: T0 });
  room.disconnect('player00002', T0);
  eq(room.members.size, 2, '剛斷線時座位還留著');
  store.sweep(T0 + 30000);
  eq(room.members.size, 2, '30 秒還在寬限期內');
  store.sweep(T0 + 90000);
  eq(room.members.size, 1, '超過一分鐘就釋出座位');
  eq(room.seatsFree(), 4, '座位真的還回來了');
}

{
  /* 房主離開，房主身分會轉移 */
  const { room } = newRoom();
  room.join('player00002', { name: 'P2', now: T0 + 1 });
  room.leave('host00000001', T0 + 2);
  eq(room.hostId, 'player00002', '房主離開後由最早進來的人接手');
  eq(room.viewFor('player00002', T0 + 3).you.host, true, '新房主拿到房主權限');
}

/* ============================================================ 邀請 */
group('邀請連結');

{
  const { room } = newRoom();
  eq(room.createInvite('player00002', { now: T0 }).code, 'perm', '非房主不能發邀請');
  const iv = room.createInvite('host00000001', { now: T0, role: 'spectator', ttlMs: 60000, maxUses: 2 });
  ok(iv.ok && iv.invite.token.length === 24, '產生 24 碼 token');
  eq(room.checkInvite(iv.invite.token, T0).ok, true, '剛產生就能用');
  eq(room.checkInvite('deadbeef', T0).code, 'badinvite', '亂填的 token 無效');
  eq(room.checkInvite(iv.invite.token, T0 + 61000).code, 'expired', '過期會說是過期');

  const j1 = room.join('guest000001', { name: 'G1', token: iv.invite.token, now: T0 });
  eq(j1.member.role, 'spectator', '觀戰用的邀請進來就是觀戰');
  room.join('guest000002', { name: 'G2', token: iv.invite.token, now: T0 });
  eq(room.checkInvite(iv.invite.token, T0).code, 'used', '用滿 2 次就不能再用');

  const iv2 = room.createInvite('host00000001', { now: T0, role: 'player' });
  eq(room.revokeInvite('host00000001', iv2.invite.token).ok, true, '房主可以撤銷');
  eq(room.checkInvite(iv2.invite.token, T0).code, 'revoked', '撤銷後會說是被撤銷');
}

{
  /* 私人房一定要邀請才進得去 */
  const { room } = newRoom({ private: true });
  eq(room.join('stranger001', { name: 'X', now: T0 }).code, 'private', '沒有邀請進不了私人房');
  const iv = room.createInvite('host00000001', { now: T0, role: 'player' });
  eq(room.join('stranger001', { name: 'X', token: iv.invite.token, now: T0 }).ok, true, '有邀請就進得去');
}

/* ============================================================ 聊天 */
group('聊天室與文字清洗');

{
  const { room } = newRoom();
  room.join('player00002', { name: 'P2', now: T0 });
  eq(room.say('player00002', 'hi', T0).ok, true, '可以說話');
  eq(room.say('player00002', 'again', T0 + 100).code, 'rate', '連發會被擋（防洗版）');
  eq(room.say('player00002', 'ok', T0 + 2000).ok, true, '等一下就可以再說');
  eq(room.say('player00002', '   ', T0 + 5000).code, 'empty', '空訊息被擋');
  eq(room.mute('player00002', 'host00000001', 60, T0).code, 'perm', '一般人不能禁言');
  eq(room.mute('host00000001', 'host00000001', 60, T0).code, 'self', '房主不能禁言自己');
  eq(room.mute('host00000001', 'player00002', 60, T0).ok, true, '房主可以禁言');
  eq(room.say('player00002', 'hello', T0 + 8000).code, 'muted', '禁言中不能說話');
  eq(room.say('player00002', 'hello', T0 + 70000).ok, true, '禁言時間到就恢復');
}

eq(sanitizeName('  阿明  ', '玩家'), '阿明', '前後空白會清掉');
eq(sanitizeName('', '玩家'), '玩家', '空名字用預設值');
eq(sanitizeName('一二三四五六七八九十十一十二十三'), '一二三四五六七八九十十一', '名字限制 12 字');
eq(sanitizeName('阿​明'), '阿明', '零寬字元會被清掉');
eq(sanitizeName('阿明'), '阿明', '控制字元會被清掉');
eq(sanitizeText('a'.repeat(300), 120).length, 120, '聊天訊息限制 120 字');

/* ============================================================ 盤面大小 */
group('盤面大小（可設定的幾乘幾）');

{
  ok(Rules.BOARDS.length >= 3, '至少提供 3 種盤面大小');
  ok(Rules.BOARDS.every((b) => b.cols * b.rows === b.holes), '每種盤面的 cols×rows 等於洞數');
  ok(new Set(Rules.BOARDS.map((b) => b.key)).size === Rules.BOARDS.length, '盤面 key 不重複');
  eq(Rules.boardOf(Rules.DEFAULT_BOARD).holes, 12, '預設盤面是 12 洞');
  eq(Rules.boardOf('4x3').key, '4x3', 'boardOf 認得合法 key');
  eq(Rules.boardOf('999x999').key, Rules.DEFAULT_BOARD, '不認得的盤面收斂回預設，不丟例外');
  eq(Rules.boardOf(undefined).key, Rules.DEFAULT_BOARD, '沒給盤面就是預設');
  ok(Rules.BOARDS.some((b) => b.holes > 12), '有比預設更多洞的選項');

  const big = Rules.createMatch({ seed: 's1', players: [{ id: 'a', name: 'A' }], now: T0, board: '6x6' });
  eq(big.holes, 36, '6×6 開出 36 個洞');
  eq(big.cols, 6, '6×6 的 cols');
  eq(big.rows, 6, '6×6 的 rows');
  eq(Rules.snapshot(big, T0).board, '6x6', '快照帶著盤面 key，前端才知道要排幾格');
  eq(Rules.snapshot(big, T0).holes, 36, '快照帶著洞數');

  const def = Rules.createMatch({ seed: 's1', players: [{ id: 'a', name: 'A' }], now: T0 });
  eq(def.holes, 12, '不指定盤面時維持 12 洞');

  /* 節奏縮放：在預設盤面上必須是恆等的，否則既有難度會被悄悄改掉 */
  const st = { no: 3, fromMs: 0, label: 'x', spawnMs: 430, jitter: 150, maxUp: 6, upScale: 0.82 };
  eq(Rules.scaleStage(st, 12), st, '12 洞盤面上節奏縮放是恆等的（既有難度不變）');
  const s24 = Rules.scaleStage(st, 24);
  ok(s24.maxUp > st.maxUp, '洞變兩倍時同時在場的地鼠也變多');
  ok(s24.spawnMs < st.spawnMs, '洞變兩倍時冒得更快');
  eq(s24.maxUp, 12, '24 洞的同時上限是 12');
  ok(Rules.scaleStage(st, 24).spawnMs >= 150, '冒出間隔有下限，不會變成 0');

  /* 大盤面真的跑得完一局，而且地鼠只會出現在合法的洞裡 */
  {
    const state = Rules.createMatch({ seed: 'big', players: [{ id: 'me', name: '我' }], now: T0, board: '6x6' });
    const rng = RNG.createRng('spawn:big');
    let t = T0, seen = 0, maxConcurrent = 0, badHole = false;
    while (t < state.endAt + 100) {
      t += 50;
      Rules.tick(state, t, rng);
      state.moles.forEach((m) => { if (!(m.hole >= 0 && m.hole < 36)) badHole = true; });
      maxConcurrent = Math.max(maxConcurrent, state.moles.length);
      seen = state.spawned;
    }
    ok(!badHole, '大盤面的地鼠都待在 0..35 的合法洞裡');
    ok(seen > 100, '大盤面一局冒得出夠多地鼠', 'got ' + seen);
    ok(maxConcurrent > 6, '大盤面同時在場的地鼠比小盤面多', 'got ' + maxConcurrent);
    ok(maxConcurrent <= 24, '同時在場的地鼠不會超過洞數', 'got ' + maxConcurrent);
    ok(state.over, '大盤面一樣會正常結束');
  }
}

/* ============================================================ 難度節奏 */
group('難度分級（地鼠冒多快、停多久）');

{
  eq(Rules.PACE_ORDER.join(','), 'rookie,easy,normal,hard', '四段難度，最低是超級新手');
  eq(Rules.paceOf(Rules.DEFAULT_PACE).key, 'normal', '預設難度是普通');
  eq(Rules.paceOf('亂填').key, 'normal', '不認得的難度收斂回普通，不丟例外');
  eq(Rules.paceOf(undefined).key, 'normal', '沒給難度就是普通');
  ok(Rules.PACE_ORDER.every((k) => Rules.paceOf(k).label && Rules.paceOf(k).blurb), '每段難度都有名字與說明');

  const st = { no: 1, fromMs: 0, label: '熱身', spawnMs: 900, jitter: 260, maxUp: 3, upScale: 1.25 };
  eq(Rules.scaleStage(st, 12, 'normal'), st, '12 洞 + 普通時節奏縮放是恆等的（原本調好的基準不變）');

  const P = Rules.PACE_ORDER.map((k) => Rules.scaleStage(st, 12, k));
  for (let i = 1; i < P.length; i++) {
    ok(P[i].upScale < P[i - 1].upScale,
      Rules.paceOf(Rules.PACE_ORDER[i]).label + ' 的地鼠停留時間比前一級短');
    ok(P[i].spawnMs < P[i - 1].spawnMs,
      Rules.paceOf(Rules.PACE_ORDER[i]).label + ' 的地鼠冒得比前一級快');
  }
  ok(P[0].upScale > P[3].upScale * 2.5, '超級新手的停留時間是困難的兩倍以上');
  ok(P[0].maxUp < P[3].maxUp, '超級新手同時在場的地鼠比困難少');
  ok(Rules.PACE_ORDER.every((k) => Rules.scaleStage(st, 36, k).spawnMs >= 150),
    '再快也有冒出間隔的下限');

  /* 難度真的會影響一局的地鼠總數與停留時間 */
  const spawnedAt = {};
  const upMsAt = {};
  for (const k of Rules.PACE_ORDER) {
    const state = Rules.createMatch({ seed: 'pace', players: [{ id: 'me', name: '我' }], now: T0, pace: k });
    eq(state.pace, k, k + ' 的難度有存進對局狀態');
    eq(Rules.snapshot(state, T0).pace, k, k + ' 的難度有進快照，前端才知道');
    const rng = RNG.createRng('spawn:pace');
    let t = T0, ups = [];
    while (t < state.endAt + 100) {
      t += 50;
      const evs = Rules.tick(state, t, rng);
      evs.forEach((e) => { if (e.k === 'spawn') ups.push(e.mole.upMs); });
    }
    spawnedAt[k] = state.spawned;
    upMsAt[k] = ups.reduce((a, b) => a + b, 0) / Math.max(1, ups.length);
  }
  ok(spawnedAt.rookie < spawnedAt.easy, '超級新手一局冒出來的地鼠比簡單少');
  ok(spawnedAt.easy < spawnedAt.normal, '簡單比普通少');
  ok(spawnedAt.normal < spawnedAt.hard, '普通比困難少');
  ok(upMsAt.rookie > upMsAt.normal * 2, '超級新手的地鼠平均停留時間是普通的兩倍以上',
    Math.round(upMsAt.rookie) + 'ms vs ' + Math.round(upMsAt.normal) + 'ms');
  ok(upMsAt.hard < upMsAt.normal, '困難的地鼠停得比普通短');
  ok(upMsAt.rookie > 2000, '超級新手的地鼠平均停超過 2 秒，來得及看清楚',
    Math.round(upMsAt.rookie) + 'ms');
}


/* ============================================================ 房間盤面設定 */
group('房間的盤面大小（房主設定）');

{
  const store = new RoomStore({});
  const r = store.create('h', { name: '房主', now: T0 });
  const room = r.room;
  eq(room.board, Rules.DEFAULT_BOARD, '新房間用預設盤面');

  ok(!room.setBoard('someone', '6x6').ok, '不是房主不能改盤面');
  eq(room.board, Rules.DEFAULT_BOARD, '被擋下來之後盤面沒有被改動');

  ok(!room.setBoard('h', '99x99').ok, '不存在的盤面被擋下來');
  eq(room.board, Rules.DEFAULT_BOARD, '擋下來之後仍是預設盤面');

  const okRes = room.setBoard('h', '6x6');
  ok(okRes.ok, '房主可以改盤面');
  ok(okRes.changed, '真的改了會回報 changed');
  eq(room.board, '6x6', '盤面已更新');
  ok(!room.setBoard('h', '6x6').changed, '改成同一個值不算變更（不用再廣播訊息）');

  eq(room.viewFor('h', T0).board, '6x6', '房間投影帶著盤面');
  ok(room.viewFor('h', T0).boards.length >= 3, '投影帶著可選清單，前端不用自己寫死');
  ok(room.viewFor('h', T0).you.can.setBoard, '房主在 lobby 有改盤面的權限');
  eq(room.brief().board, '6x6', '大廳列表也看得到盤面');
  /* 難度和盤面一樣是房主設定，而且和 AI 座位的強弱是兩件事 */
  eq(room.pace, Rules.DEFAULT_PACE, '新房間用預設難度');
  ok(!room.setPace('someone', 'rookie').ok, '不是房主不能改難度');
  ok(!room.setPace('h', '亂填').ok, '不存在的難度被擋下來');
  eq(room.pace, Rules.DEFAULT_PACE, '被擋下來之後難度沒被改動');
  ok(room.setPace('h', 'rookie').ok, '房主可以改難度');
  eq(room.pace, 'rookie', '難度已更新');
  ok(!room.setPace('h', 'rookie').changed, '改成同一個值不算變更');
  eq(room.viewFor('h', T0).pace, 'rookie', '房間投影帶著難度');
  ok(room.viewFor('h', T0).paces.length === Rules.PACE_ORDER.length, '投影帶著可選難度清單');
  ok(room.viewFor('h', T0).you.can.setPace, '房主在 lobby 有改難度的權限');
  eq(room.brief().pace, 'rookie', '大廳列表也看得到難度');
  /* 一局長度也是房主設定 */
  eq(Rules.roundSecOf(room.roundMs), Rules.DEFAULT_ROUND_SEC, '新房間用預設一局長度（60 秒）');
  ok(!room.setRound('someone', 90).ok, '不是房主不能改一局長度');
  ok(!room.setRound('h', 45).ok, '不在清單裡的長度被擋下來');
  ok(room.setRound('h', 90).changed, '房主可以改一局長度');
  eq(room.roundMs, 90000, '一局長度已更新');
  ok(!room.setRound('h', 90).changed, '改成同一個值不算變更');
  eq(room.viewFor('h', T0).roundSec, 90, '房間投影帶著一局長度');
  eq(room.viewFor('h', T0).rounds.join(','), '60,75,90', '投影帶著可選長度');
  ok(room.viewFor('h', T0).you.can.setRound, '房主在 lobby 可以改一局長度');
  eq(room.brief().roundSec, 90, '大廳列表也看得到一局長度');



  /* 開打之後不能改：地洞編號會對不上，進行中的地鼠會跑到不存在的洞 */
  room.join('p2', { name: '玩家二', role: 'player', now: T0 });
  room.setReady('h', true); room.setReady('p2', true);
  const st = room.start('h', T0, { roundMs: 5000, countdownMs: 0 });
  ok(st.ok, '房間開得起來');
  eq(room.state.holes, 36, '開局用的是房主選的 36 洞盤面');
  ok(!room.setBoard('h', '4x3').ok, '對局進行中不能改盤面');
  ok(!room.setPace('h', 'hard').ok, '對局進行中不能改難度');
  ok(!room.setRound('h', 60).ok, '對局進行中不能改一局長度');
  eq(room.state.endAt - room.state.startAt, 90000, '開局用的是房主選的一局長度');
  eq(room.state.pace, 'rookie', '開局用的是房主選的難度');
  ok(!room.viewFor('h', T0).you.can.setBoard, '進行中權限旗標也關掉了');
  eq(room.board, '6x6', '進行中盤面保持不變');
}

/* ============================================================ 空房自動關閉 */
group('沒人的房間自動關閉');

{
  const store = new RoomStore({});
  const r = store.create('h', { name: '房主', now: T0 });
  const code = r.room.code;
  r.room.join('p2', { name: '玩家二', role: 'player', now: T0 });
  eq(store.size(), 1, '房間開起來了');

  const l1 = r.room.leave('p2', T0 + 100);
  ok(l1.ok, '玩家二離開');
  ok(!l1.emptied, '還有人在，不算空房');
  eq(store.size(), 1, '房間還在');

  const l2 = r.room.leave('h', T0 + 200);
  ok(l2.ok, '房主也離開');
  ok(l2.emptied, '最後一個人走了，回報房間已空');

  /* 回收不再等 TTL：空房下一輪就關掉 */
  const swept = store.sweep(T0 + 300);
  eq(swept.closed.length, 1, '空房立刻被回收（不用等兩分鐘）');
  eq(swept.closed[0].code, code, '關掉的是那一間');
  eq(store.size(), 0, '房間已經從清單消失');
  eq(store.get(code), null, '房號查不到了');

  /* store.close 也可以直接關（伺服器在最後一人離開時就是用這支） */
  const r2 = store.create('h2', { name: '房主二', now: T0 });
  eq(store.size(), 1, '再開一間');
  ok(store.close(r2.room.code), 'close 關得掉');
  eq(store.size(), 0, '關完就不見了');
  eq(store.close('ZZZZZ'), null, '關一間不存在的房不會爆掉');
}

{
  /* 斷線的人還算在房間裡：座位要保留給他重連，不能馬上把房間關掉 */
  const store = new RoomStore({});
  const r = store.create('h', { name: '房主', now: T0 });
  r.room.disconnect('h', T0 + 10);
  eq(store.sweep(T0 + 1000).closed.length, 0, '有人斷線但還在保留期，房間不關');
  eq(store.size(), 1, '房間還在，等他回來');

  /* 過了保留期，人被清掉 → 房間變空 → 同一輪就關掉 */
  const swept = store.sweep(T0 + 10 + DISCONNECT_GRACE_MS + 1);
  eq(swept.closed.length, 1, '保留期過了就連房間一起收掉');
  eq(store.size(), 0, '房間已回收');
}

/* ============================================================ server URL 設定 */
group('server URL 解析（GitHub Pages 用得到）');

{
  /* config.js 是給瀏覽器用的，這裡用最小的 window stub 載進來測純函式 */
  const fakeWin = { location: { search: '', protocol: 'https:', origin: 'https://example.github.io' } };
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'config.js'), 'utf8');
  new Function('window', 'console', 'localStorage', src)(fakeWin, console, {
    getItem() { return null; }, setItem() {}, removeItem() {}
  });
  const R = fakeWin.GameConfig._resolve;

  eq(R('', '', 'https:', 'https://a.b').url, 'https://a.b', '同源：直接用頁面自己的 origin');
  eq(R('', '', 'https:', 'https://a.b').source, 'same-origin', '來源標記為 same-origin');
  eq(R('https://api.example.com', '', 'https:', 'https://pages.io').url, 'https://api.example.com',
    '建置注入的值優先於同源（GitHub Pages 就是靠這個指到 Render）');
  eq(R('https://api.example.com', 'https://other.com', 'https:', 'https://p.io').url, 'https://other.com',
    '網址參數 ?server= 又比注入值優先');
  eq(R('', '', 'file:', '').status, 'unset', 'file:// 直接開就只能玩單機');
  eq(R('ftp://x', '', 'https:', 'https://a.b').status, 'invalid', '只接受 http/https');
  eq(R('http://api.example.com', '', 'https:', 'https://a.b').status, 'invalid',
    'https 頁面不接受 http 伺服器（混合內容會被瀏覽器擋掉）');
  eq(R('http://localhost:3030', '', 'http:', 'http://localhost:8080').url, 'http://localhost:3030',
    '本機開發可以用 http');
  eq(R('https://api.example.com/', '', 'https:', 'https://a.b').url, 'https://api.example.com',
    '結尾斜線會被去掉');
  ok(R('', '', 'https:', 'https://a.b').url.indexOf('localhost') < 0, '正式環境不會偷偷回退到 localhost');
}

/* ============================================================ 總結 */
console.log('\n' + '='.repeat(46));
if (fail) {
  console.log('失敗 ' + fail + ' 項：');
  fails.forEach((f) => console.log('  ✗ ' + f));
}
console.log((fail ? '✗ ' : '✓ ') + '通過 ' + pass + ' / ' + (pass + fail) + ' 項');
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
