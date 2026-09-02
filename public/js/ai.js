/* ===== ai.js — 電腦對手 =====
 *
 * 三段難度的差別是「看得多快、認得多準、手多穩、會不會挑高分的打」，
 * 不是只換一個名字。四個參數各自可觀察：
 *   reactionMs  地鼠冒出來到 AI「注意到」它所需的時間
 *   swingMs     兩次揮槌之間的冷卻
 *   goodMistake 「這一槌看走眼」的機率（每次揮槌只擲一次骰，不是每隻地鼠一次）
 *   whiff       瞄準時手滑、敲到旁邊空洞的機率
 *   valueBias   挑目標時有多偏好高分地鼠（0 = 隨便打、1 = 專挑高分）
 *   moveMs      槌子每跨一格地洞要多花的時間，讓 AI 不會瞬間橫掃全場
 *
 * 沒有 DOM 相依：單機由瀏覽器跑，線上房間由伺服器跑，同一份程式。
 */
(function (root, factory) {
  'use strict';
  var Rules = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.Rules;
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.RNG;
  var api = factory(Rules, RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Rules, RNG) {
  'use strict';

  var LEVELS = {
    easy: {
      key: 'easy', label: '簡單', emoji: '🌱',
      reactionMs: 640, reactionJitter: 220, swingMs: 700, swingJitter: 220,
      goodMistake: 0.34, whiff: 0.24, valueBias: 0.15, moveMs: 95,
      blurb: '反應慢、常常誤敲好人，適合小朋友和第一次玩。'
    },
    normal: {
      key: 'normal', label: '普通', emoji: '🔥',
      reactionMs: 430, reactionJitter: 150, swingMs: 500, swingJitter: 140,
      goodMistake: 0.16, whiff: 0.11, valueBias: 0.6, moveMs: 62,
      blurb: '手腳算快，會挑分數高的打，偶爾會失手。'
    },
    hard: {
      key: 'hard', label: '困難', emoji: '⚡',
      reactionMs: 300, reactionJitter: 90, swingMs: 390, swingJitter: 90,
      goodMistake: 0.05, whiff: 0.05, valueBias: 1, moveMs: 40,
      blurb: '幾乎不誤敲好人，專挑黃金鼠和大王鼠，會跟你搶尾刀。'
    }
  };

  var ORDER = ['easy', 'normal', 'hard'];

  /** 兩個地洞在方格上的距離（切比雪夫距離，斜著移動算一格） */
  function gridDistance(a, b, cols) {
    if (a < 0 || b < 0) return 0;
    var c = cols || 4;
    var dx = Math.abs((a % c) - (b % c));
    var dy = Math.abs(Math.floor(a / c) - Math.floor(b / c));
    return Math.max(dx, dy);
  }

  function levelOf(key) { return LEVELS[key] || LEVELS.normal; }

  var NAME_POOL = ['槌槌', '阿呆', '小咚', '鐵手', '眼鏡', '嘟嘟', '快手', '老練'];

  function aiName(level, index) {
    var l = levelOf(level);
    return NAME_POOL[index % NAME_POOL.length] + '（' + l.label + '）';
  }

  /**
   * 建立一顆 AI 大腦。狀態放在自己身上（注意到哪些地鼠、下一次能揮槌的時間），
   * 所以同一場可以同時跑好幾顆而互不干擾。
   */
  function createBrain(level, seed) {
    var L = levelOf(level);
    var rng = RNG.createRng(seed === undefined ? Math.random() : seed);
    var noticed = {};      // moleId -> 注意到它的時間
    var nextSwingAt = 0;
    var lastHole = -1;     // 槌子上一次落點，用來算移動時間
    var sloppy = null;     // 這一槌會不會看走眼；擲一次骰後沿用到真的揮出去為止

    function jitter(base, spread) {
      return Math.max(60, Math.round(base + RNG.symmetric(rng) * spread));
    }

    /**
     * 想一步。回傳 null 代表這個瞬間還不出手。
     * @param {object} snap Rules.snapshot() 的結果（AI 看到的和玩家完全一樣）
     * @param {number} now
     */
    function step(snap, now) {
      if (!snap || snap.phase !== 'playing') { nextSwingAt = 0; return null; }

      var moles = snap.moles || [];
      var i, m;
      var alive = {};

      /* 1. 記錄「什麼時候會注意到這隻地鼠」 */
      for (i = 0; i < moles.length; i++) {
        m = moles[i];
        alive[m.id] = true;
        if (noticed[m.id] === undefined) {
          noticed[m.id] = m.spawnAt + jitter(L.reactionMs, L.reactionJitter);
        }
      }
      for (var id in noticed) if (!alive[id]) delete noticed[id];

      if (now < nextSwingAt) return null;

      /* 2. 已經注意到、而且還來得及敲的地鼠 */
      var seen = [];
      for (i = 0; i < moles.length; i++) {
        m = moles[i];
        if (now < noticed[m.id]) continue;
        if (now > m.expireAt - 70) continue;
        seen.push(m);
      }
      if (!seen.length) return null;

      /* 3. 選目標。壞人依「剩餘價值 × 快沒時間了要優先」評分；
       *    好人本來不該碰，只有在「這一槌看走眼」時才會進候選。
       *    看走眼只擲一次骰，不然每多一隻好人就多一次機會，誤敲率會被放大。 */
      if (sloppy === null) sloppy = rng() < L.goodMistake;
      var best = null, bestScore = -Infinity;
      for (i = 0; i < seen.length; i++) {
        m = seen[i];
        var t = Rules.typeOf(m.type);
        var mistaken = false;
        if (t.side === 'good') {
          if (!sloppy) continue;                  /* 認出來了，跳過 */
          mistaken = true;
        }
        var value = t.side === 'good' ? 12 : Math.max(1, Rules.hitUnit(m.type));
        /* valueBias 0 → 幾乎不看分數；1 → 分數決定一切 */
        var weighted = Math.pow(value, 0.35 + L.valueBias * 1.15);
        /* 快消失的優先處理，免得白白讓牠溜掉 */
        var urgency = 1 + Math.max(0, 1 - (m.expireAt - now) / 900) * 0.8;
        var score = weighted * urgency * (0.75 + rng() * 0.5);
        if (mistaken) score *= 0.8;
        if (score > bestScore) { bestScore = score; best = m; }
      }
      if (!best) return null;

      /* 槌子要從上一個洞移過去，跨越的格數越多、下一槌就越慢 */
      nextSwingAt = now + jitter(L.swingMs, L.swingJitter)
        + gridDistance(lastHole, best.hole, snap.cols) * L.moveMs;
      lastHole = best.hole;
      sloppy = null;

      /* 4. 手滑：敲到旁邊的空洞（真的會落空，不是假動作） */
      if (rng() < L.whiff) {
        var free = Rules.freeHoles(snap);
        if (free.length) {
          var h = free[Math.floor(rng() * free.length) % free.length];
          lastHole = h;
          return { hole: h, moleId: null, whiff: true };
        }
      }

      return { hole: best.hole, moleId: best.id, whiff: false };
    }

    function reset() { noticed = {}; nextSwingAt = 0; lastHole = -1; sloppy = null; }

    return { level: L.key, config: L, step: step, reset: reset };
  }

  return {
    LEVELS: LEVELS,
    ORDER: ORDER,
    levelOf: levelOf,
    aiName: aiName,
    NAME_POOL: NAME_POOL,
    gridDistance: gridDistance,
    createBrain: createBrain
  };
}));
