/* ===== rules.js — 打地鼠的規則核心（伺服器與前端共用的唯一真相）=====
 *
 * 這個檔案沒有任何 DOM / Socket / 音效相依：
 *   - 瀏覽器用 <script> 載入 → window.Rules
 *   - Node（server.js、tests）用 require('./public/js/rules.js')
 *
 * 單機、線上、AI 全部共用這一份，避免兩套規則各自漂移。
 * 所有隨機都走可注入的種子亂數（rng.js），同一個種子會長出同一場地鼠。
 */
(function (root, factory) {
  'use strict';
  var RNG = (typeof module === 'object' && module.exports)
    ? require('./rng.js')
    : root.RNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Rules = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (RNG) {
  'use strict';

  /* ------------------------------------------------------------------ 盤面 */

  var COLS = 4;
  var ROWS = 3;
  var HOLES = COLS * ROWS;          // 預設 12 個地洞，手機直向也塞得下

  /* 可以選的盤面大小。直向裝置會把 cols/rows 對調顯示，那純粹是排版，
   * 地洞的編號不會變，所以規則、AI、重播都不受影響。 */
  var BOARDS = [
    { key: '3x3', cols: 3, rows: 3, label: '3 × 3', note: '9 洞・最小' },
    { key: '4x3', cols: 4, rows: 3, label: '4 × 3', note: '12 洞・標準' },
    { key: '4x4', cols: 4, rows: 4, label: '4 × 4', note: '16 洞' },
    { key: '5x4', cols: 5, rows: 4, label: '5 × 4', note: '20 洞' },
    { key: '5x5', cols: 5, rows: 5, label: '5 × 5', note: '25 洞・熱鬧' },
    { key: '6x6', cols: 6, rows: 6, label: '6 × 6', note: '36 洞・混亂' }
  ];
  for (var bi = 0; bi < BOARDS.length; bi++) BOARDS[bi].holes = BOARDS[bi].cols * BOARDS[bi].rows;
  /* 明確寫死，不要用 BOARDS[0] —— 清單順序改動不該悄悄換掉預設盤面 */
  var DEFAULT_BOARD = '4x3';

  /** 盤面 key → 盤面設定。不認得的 key 一律回到預設，不丟例外。 */
  function boardOf(key) {
    var i, fallback = null;
    for (i = 0; i < BOARDS.length; i++) {
      if (BOARDS[i].key === key) return BOARDS[i];
      if (BOARDS[i].key === DEFAULT_BOARD) fallback = BOARDS[i];
    }
    return fallback || BOARDS[0];
  }

  /* 一局長度與開賽倒數（毫秒）。伺服器可用環境變數覆蓋。 */
  var ROUND_MS = 60000;
  var COUNTDOWN_MS = 3000;

  /* 可以選的一局長度（秒）。階段切點是按比例算的（見 stageAt），
     所以換長度不會讓第 3 階段永遠跑不到。 */
  var ROUND_SECONDS = [60, 75, 90];
  var DEFAULT_ROUND_SEC = 60;

  /** 秒數 → 毫秒。不在清單裡的一律回到預設，不丟例外。 */
  function roundMsOf(sec) {
    var n = Math.round(Number(sec));
    for (var i = 0; i < ROUND_SECONDS.length; i++) if (ROUND_SECONDS[i] === n) return n * 1000;
    return DEFAULT_ROUND_SEC * 1000;
  }

  /**
   * 毫秒 → 秒數，純粹給 UI 顯示用，不做收斂 ——
   * 伺服器可以用環境變數開一個 14 秒的房間（測試就是這樣跑的），
   * 那時候要照實顯示 14，只是選單上不會有任何一格被標成選中。
   */
  function roundSecOf(ms) {
    var n = Math.round(Number(ms) / 1000);
    return n > 0 ? n : DEFAULT_ROUND_SEC;
  }

  /* 地鼠冒出／縮回的動畫時間，命中判定要把它算進去 */
  var RISE_MS = 170;
  var SINK_MS = 200;

  /* 連擊：每 5 連擊 +10% 分數，最多 +50%。只加正分。 */
  var COMBO_STEP = 5;
  var COMBO_BONUS = 0.10;
  var COMBO_MAX_BONUS = 0.50;

  /* 彩虹鼠給的雙倍加成持續時間 */
  var BUFF_MS = 6000;

  var MAX_PLAYERS = 5;

  /* ------------------------------------------------------------ 地鼠圖鑑 */
  /*
   * side: 'bad'  = 壞人，打了加分
   *       'good' = 好人，打了扣分（絕對不要打）
   * hp:   要敲幾下才會倒。多血地鼠每一下都給 round(points/hp)，
   *       敲倒的最後一下再多拿一份，鼓勵搶尾刀。
   * upMs: 基礎停留時間，實際會再乘上該階段的 upScale。
   * w:    各階段的出現權重（w[0] 是第 1 階段，以此類推），0 代表該階段不會出現。
   */
  var MOLE_TYPES = {
    mole: {
      key: 'mole', side: 'bad', label: '小土鼠', emoji: '🐹',
      points: 10, hp: 1, upMs: 1250, w: [46, 24, 13],
      hint: '最常見的小嘍囉，看到就敲。'
    },
    swift: {
      key: 'swift', side: 'bad', label: '疾風鼠', emoji: '💨',
      points: 25, hp: 1, upMs: 640, w: [16, 17, 14],
      hint: '戴著護目鏡，冒出來一下就縮回去。'
    },
    helmet: {
      key: 'helmet', side: 'bad', label: '鐵盔鼠', emoji: '⛑',
      points: 44, hp: 2, upMs: 1750, w: [0, 12, 11],
      hint: '頭上有鐵盔，要敲兩下才會倒。'
    },
    bomber: {
      key: 'bomber', side: 'bad', label: '炸彈鼠', emoji: '💣',
      points: 60, hp: 1, upMs: 820, w: [0, 8, 9],
      hint: '抱著炸彈，分數高但停留很短。'
    },
    rainbow: {
      key: 'rainbow', side: 'bad', label: '彩虹鼠', emoji: '🌈',
      points: 50, hp: 1, upMs: 900, w: [0, 5, 5], buff: true,
      hint: '敲到之後 6 秒內，你打到的正分全部加倍。'
    },
    boss: {
      key: 'boss', side: 'bad', label: '大王鼠', emoji: '👑',
      points: 96, hp: 3, upMs: 2700, w: [0, 3, 6],
      hint: '又大又肥，要敲三下，最後一下的人拿雙份。'
    },
    golden: {
      key: 'golden', side: 'bad', label: '黃金鼠', emoji: '✨',
      points: 120, hp: 1, upMs: 540, w: [0, 2, 4],
      hint: '全場最高分，但只露臉半秒，手要夠快。'
    },
    chick: {
      key: 'chick', side: 'good', label: '小雞', emoji: '🐤',
      points: -15, hp: 1, upMs: 1400, w: [14, 9, 7],
      hint: '路過的小雞，不要敲牠。'
    },
    bunny: {
      key: 'bunny', side: 'good', label: '小兔子', emoji: '🐰',
      points: -20, hp: 1, upMs: 1300, w: [14, 9, 8],
      hint: '來借蘿蔔的鄰居，敲下去會扣分。'
    },
    farmer: {
      key: 'farmer', side: 'good', label: '農夫爺爺', emoji: '👒',
      points: -35, hp: 1, upMs: 1500, w: [10, 8, 8],
      hint: '這塊田的主人，千萬別敲。'
    },
    catshop: {
      key: 'catshop', side: 'good', label: '貓店長', emoji: '🐱',
      points: -50, hp: 1, upMs: 1650, w: [0, 3, 5],
      hint: '拿著「請勿敲打」牌子的店長，扣最多分。'
    }
  };

  /* 圖鑑顯示順序：壞人由低分到高分，接著好人由輕到重 */
  var MOLE_ORDER = ['mole', 'swift', 'helmet', 'bomber', 'rainbow', 'boss', 'golden',
    'chick', 'bunny', 'farmer', 'catshop'];

  var BAD_TYPES = MOLE_ORDER.filter(function (k) { return MOLE_TYPES[k].side === 'bad'; });
  var GOOD_TYPES = MOLE_ORDER.filter(function (k) { return MOLE_TYPES[k].side === 'good'; });

  /* ------------------------------------------------------------ 階段節奏 */

  /* 難度：管的是「地鼠冒多快、停多久、同時幾隻」。
   *
   * 以前難度只換電腦對手的強弱，地鼠的節奏三段都寫死，所以選「簡單」
   * 地鼠一樣咻一下就縮回去。現在難度同時決定節奏：
   *   upScale     停留時間的倍率（愈大＝停愈久＝愈好敲）
   *   spawnScale  冒出間隔的倍率（愈大＝冒得愈慢）
   *   maxUpDelta  同時在場的地鼠數增減
   * 普通＝1 倍，是原本調好的基準，所以既有的難度數字完全沒動。
   */
  var PACES = {
    rookie: {
      key: 'rookie', label: '超級新手', emoji: '🍼',
      upScale: 2.4, spawnScale: 1.9, maxUpDelta: -1,
      blurb: '地鼠慢慢冒、停很久，看清楚是好人壞人再敲也來得及。'
    },
    easy: {
      key: 'easy', label: '簡單', emoji: '🌱',
      upScale: 1.6, spawnScale: 1.35, maxUpDelta: 0,
      blurb: '地鼠停得久一點、冒得慢一點，剛上手玩這個。'
    },
    normal: {
      key: 'normal', label: '普通', emoji: '🔥',
      upScale: 1, spawnScale: 1, maxUpDelta: 0,
      blurb: '標準節奏，三階段愈來愈快。'
    },
    hard: {
      key: 'hard', label: '困難', emoji: '⚡',
      upScale: 0.75, spawnScale: 0.8, maxUpDelta: 1,
      blurb: '地鼠一下就縮回去，冒得又快又多，手要夠穩。'
    }
  };
  var PACE_ORDER = ['rookie', 'easy', 'normal', 'hard'];
  var DEFAULT_PACE = 'normal';

  /** 難度 key → 節奏設定。不認得的一律回到普通，不丟例外。 */
  function paceOf(key) { return PACES[key] || PACES[DEFAULT_PACE]; }

  /* at＝這個階段從一局的幾分之幾開始。用比例而不是寫死的毫秒，
     一局長度改成 60 或 75 秒時第 3 階段才不會永遠跑不到。 */
  var STAGES = [
    { no: 1, at: 0, label: '熱身', spawnMs: 900, jitter: 260, maxUp: 3, upScale: 1.25 },
    { no: 2, at: 1 / 3, label: '加速', spawnMs: 640, jitter: 200, maxUp: 4, upScale: 1.00 },
    { no: 3, at: 2 / 3, label: '狂亂', spawnMs: 430, jitter: 150, maxUp: 6, upScale: 0.82 }
  ];

  /**
   * 依「已經打了幾毫秒」找出目前階段。
   * @param {number} elapsedMs
   * @param {number} [roundMs] 這一局多長；省略就用預設長度
   */
  function stageAt(elapsedMs, roundMs) {
    var total = roundMs || ROUND_MS;
    var s = STAGES[0];
    for (var i = 0; i < STAGES.length; i++) if (elapsedMs >= STAGES[i].at * total) s = STAGES[i];
    return s;
  }

  /**
   * 洞變多的時候節奏要一起放大，不然 36 個洞配 3 隻地鼠整面都是空的；
   * 同時在場的地鼠數按洞數比例增加，冒出間隔按同一比例縮短。
   * 難度則決定地鼠停多久、冒多快、同時幾隻。
   * 12 洞 + 普通難度時這個函式是恆等的 —— 原本調好的基準完全不受影響。
   */
  function scaleStage(st, holes, pace) {
    var k = (holes || HOLES) / HOLES;
    var P = paceOf(pace);
    if (k === 1 && P.key === DEFAULT_PACE) return st;
    return {
      no: st.no, at: st.at, label: st.label,
      upScale: st.upScale * P.upScale,
      spawnMs: Math.max(150, Math.round(st.spawnMs / k * P.spawnScale)),
      jitter: Math.max(0, Math.round(st.jitter / k * P.spawnScale)),
      maxUp: Math.max(1, Math.round(st.maxUp * k) + P.maxUpDelta)
    };
  }

  /* ------------------------------------------------------------ 小工具 */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function typeOf(key) { return MOLE_TYPES[key] || MOLE_TYPES.mole; }

  /** 該階段的地鼠抽籤表 */
  function weightsFor(stageNo) {
    var idx = clamp(stageNo, 1, STAGES.length) - 1;
    var list = [];
    for (var i = 0; i < MOLE_ORDER.length; i++) {
      var k = MOLE_ORDER[i];
      var w = MOLE_TYPES[k].w[idx] || 0;
      if (w > 0) list.push({ key: k, w: w });
    }
    return list;
  }

  /** 依權重抽一隻地鼠；rng 是可注入的種子亂數 */
  function pickType(stageNo, rng) {
    var list = weightsFor(stageNo);
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].w;
    var r = (rng || Math.random)() * total;
    for (i = 0; i < list.length; i++) {
      r -= list[i].w;
      if (r <= 0) return list[i].key;
    }
    return list.length ? list[list.length - 1].key : 'mole';
  }

  /** 連擊加成倍率（只作用在正分上） */
  function comboMultiplier(combo) {
    var steps = Math.floor(combo / COMBO_STEP);
    return 1 + Math.min(COMBO_MAX_BONUS, steps * COMBO_BONUS);
  }

  /** 一下敲擊的基礎分：多血地鼠平分，敲倒的最後一下多拿一份 */
  function hitUnit(type) {
    var t = typeOf(type);
    return Math.round(t.points / t.hp);
  }

  /** 純函式：算出這一下實際加減多少分。測試直接打這一支。 */
  function scoreHit(opts) {
    var t = typeOf(opts.type);
    var unit = hitUnit(t.key);
    var raw = unit + (opts.killed && t.hp > 1 ? unit : 0);
    if (t.side === 'good') return { gain: raw, multiplier: 1, base: raw };
    var mult = comboMultiplier(opts.combo || 0) * (opts.buffed ? 2 : 1);
    return { gain: Math.round(raw * mult), multiplier: mult, base: raw };
  }

  function describeMole(key) {
    var t = typeOf(key);
    return t.label + '（' + (t.points > 0 ? '+' : '') + t.points + '分'
      + (t.hp > 1 ? '、' + t.hp + '下' : '') + '）';
  }

  /* ------------------------------------------------------------ 玩家 */

  var PLAYER_COLORS = ['grape', 'mint', 'peach', 'sky', 'lemon'];
  var PLAYER_COLOR_HEX = {
    grape: '#A48FDB', mint: '#79C6AC', peach: '#E89C8B', sky: '#7FB4DA', lemon: '#E7C263'
  };

  function newPlayer(p, index) {
    var byType = {};
    for (var i = 0; i < MOLE_ORDER.length; i++) byType[MOLE_ORDER[i]] = 0;
    return {
      id: String(p.id),
      name: String(p.name || ('玩家' + (index + 1))),
      color: p.color || PLAYER_COLORS[index % PLAYER_COLORS.length],
      ai: p.ai || null,
      score: 0,
      hits: 0,          // 打中壞人的次數
      goodHits: 0,      // 誤打好人的次數
      swings: 0,        // 總出手次數
      combo: 0,
      bestCombo: 0,
      buffUntil: 0,
      byType: byType
    };
  }

  /** 命中率：打中壞人 / 總出手 */
  function accuracyOf(p) {
    return p.swings > 0 ? p.hits / p.swings : 0;
  }

  /* ------------------------------------------------------------ 對局狀態 */

  /**
   * 建立一場對局。startAt 之後才會開始冒地鼠（中間是開賽倒數）。
   * @param {{seed:string, players:Array, now:number, roundMs?:number, countdownMs?:number}} o
   */
  function createMatch(o) {
    var now = o.now;
    var roundMs = o.roundMs || ROUND_MS;
    var countdownMs = o.countdownMs === undefined ? COUNTDOWN_MS : o.countdownMs;
    var seed = RNG.normalizeSeed(o.seed) || RNG.randomSeed();
    var board = boardOf(o.board);
    var pace = paceOf(o.pace);
    var players = {};
    var order = [];
    (o.players || []).slice(0, MAX_PLAYERS).forEach(function (p, i) {
      players[String(p.id)] = newPlayer(p, i);
      order.push(String(p.id));
    });
    return {
      seed: seed,
      board: board.key,
      pace: pace.key,
      holes: board.holes, cols: board.cols, rows: board.rows,
      createdAt: now,
      startAt: now + countdownMs,
      endAt: now + countdownMs + roundMs,
      roundMs: roundMs,
      countdownMs: countdownMs,
      players: players,
      order: order,
      moles: [],
      nextMoleId: 1,
      nextSpawnAt: now + countdownMs + 400,
      spawned: 0,
      escaped: 0,
      over: false,
      endedAt: 0,
      winner: null,     // 單一贏家 id；平手時為 null 且 draw = true
      draw: false
    };
  }

  function elapsed(state, now) { return clamp(now - state.startAt, 0, state.roundMs); }
  function remainMs(state, now) { return clamp(state.endAt - now, 0, state.roundMs); }
  function phaseOf(state, now) {
    if (state.over) return 'over';
    if (now < state.startAt) return 'countdown';
    if (now >= state.endAt) return 'over';
    return 'playing';
  }

  function liveMole(state, moleId) {
    for (var i = 0; i < state.moles.length; i++) {
      if (state.moles[i].id === moleId) return state.moles[i];
    }
    return null;
  }

  function holeBusy(state, hole) {
    for (var i = 0; i < state.moles.length; i++) if (state.moles[i].hole === hole) return true;
    return false;
  }

  function freeHoles(state) {
    var used = {};
    for (var i = 0; i < state.moles.length; i++) used[state.moles[i].hole] = true;
    var out = [];
    for (var h = 0; h < state.holes; h++) if (!used[h]) out.push(h);
    return out;
  }

  /**
   * 推進到 now：讓過期的地鼠逃走、依節奏冒出新地鼠、時間到就結算。
   * 只有伺服器（線上）或單機主迴圈會呼叫，用同一個 rng 串就能重現整場。
   * @returns {Array} events
   */
  function tick(state, now, rng) {
    var events = [];
    if (state.over) return events;
    var i;

    /* 1. 逃走判定 */
    for (i = state.moles.length - 1; i >= 0; i--) {
      var m = state.moles[i];
      if (now >= m.expireAt) {
        state.moles.splice(i, 1);
        state.escaped += 1;
        events.push({ k: 'escape', moleId: m.id, hole: m.hole, type: m.type, side: typeOf(m.type).side });
      }
    }

    /* 2. 時間到 */
    if (now >= state.endAt) {
      finish(state, now);
      events.push({ k: 'end' });
      return events;
    }

    /* 3. 倒數期間不冒地鼠 */
    if (now < state.startAt) return events;

    /* 4. 依節奏冒新地鼠（一個 tick 最多補 4 隻，避免分頁切回來時瞬間爆量） */
    var guard = 0;
    while (now >= state.nextSpawnAt && guard < 4) {
      guard += 1;
      var el = elapsed(state, state.nextSpawnAt);
      var st = scaleStage(stageAt(el, state.roundMs), state.holes, state.pace);
      var gap = st.spawnMs + Math.round(((rng || Math.random)() * 2 - 1) * st.jitter);
      state.nextSpawnAt += Math.max(140, gap);

      if (state.moles.length >= st.maxUp) continue;
      var holes = freeHoles(state);
      if (!holes.length) continue;

      var hole = holes[Math.floor((rng || Math.random)() * holes.length) % holes.length];
      var key = pickType(st.no, rng);
      var t = typeOf(key);
      var up = Math.max(360, Math.round(t.upMs * st.upScale));
      var mole = {
        id: state.nextMoleId++,
        hole: hole,
        type: key,
        side: t.side,
        hp: t.hp,
        hpLeft: t.hp,
        spawnAt: now,
        expireAt: now + up,
        upMs: up,
        stage: st.no
      };
      state.moles.push(mole);
      state.spawned += 1;
      events.push({ k: 'spawn', mole: mole });
    }

    return events;
  }

  /**
   * 敲一下。共用盤面搶打先得分：同一隻地鼠誰先送到伺服器誰得分。
   * @param {string} playerId
   * @param {{moleId?:number, hole:number}} aim
   * @returns {{ok:boolean, event?:object, error?:string, code?:string}}
   */
  function whack(state, playerId, aim, now) {
    var p = state.players[String(playerId)];
    if (!p) return { ok: false, error: '你不在這一局裡（可能是觀戰中）。', code: 'notplayer' };
    if (phaseOf(state, now) !== 'playing') {
      return { ok: false, error: '現在還不能出手。', code: 'phase' };
    }
    var hole = Number(aim && aim.hole);
    if (!(hole >= 0 && hole < state.holes)) {
      return { ok: false, error: '沒有這個地洞。', code: 'badhole' };
    }

    p.swings += 1;

    /* 找這個洞裡活著的地鼠；帶 moleId 時要對得起來，避免打到剛換上來的下一隻 */
    var m = null;
    for (var i = 0; i < state.moles.length; i++) {
      var c = state.moles[i];
      if (c.hole !== hole) continue;
      if (aim && aim.moleId && c.id !== aim.moleId) continue;
      m = c; break;
    }

    /* 空槌：不扣分，但列入命中率統計 */
    if (!m) {
      return { ok: true, event: { k: 'miss', by: p.id, hole: hole, gain: 0 } };
    }

    var t = typeOf(m.type);
    m.hpLeft -= 1;
    var killed = m.hpLeft <= 0;
    var buffed = t.side === 'bad' && now < p.buffUntil;

    var sc = scoreHit({ type: m.type, combo: p.combo, killed: killed, buffed: buffed });
    p.score += sc.gain;
    p.byType[m.type] = (p.byType[m.type] || 0) + 1;

    if (t.side === 'bad') {
      p.hits += 1;
      p.combo += 1;
      if (p.combo > p.bestCombo) p.bestCombo = p.combo;
      if (t.buff && killed) p.buffUntil = now + BUFF_MS;
    } else {
      p.goodHits += 1;
      p.combo = 0;
    }

    if (killed) {
      var idx = state.moles.indexOf(m);
      if (idx >= 0) state.moles.splice(idx, 1);
    }

    return {
      ok: true,
      event: {
        k: 'hit',
        by: p.id,
        moleId: m.id,
        hole: hole,
        type: m.type,
        side: t.side,
        gain: sc.gain,
        multiplier: sc.multiplier,
        buffed: buffed,
        killed: killed,
        hpLeft: Math.max(0, m.hpLeft),
        combo: p.combo,
        score: p.score,
        buffUntil: p.buffUntil
      }
    };
  }

  /** 結算：排名、贏家、平手 */
  function finish(state, now) {
    state.over = true;
    state.endedAt = now;
    state.moles = [];
    var rank = standings(state);
    if (!rank.length) { state.winner = null; state.draw = false; return state; }
    var top = rank[0];
    var tie = rank.filter(function (r) { return r.score === top.score; });
    state.draw = tie.length > 1;
    state.winner = state.draw ? null : top.id;
    return state;
  }

  /**
   * 即時排名。同分時依序比：打中壞人數多者前、誤打好人少者前、最佳連擊高者前、名字。
   */
  function standings(state) {
    var list = state.order.map(function (id) { return state.players[id]; }).filter(Boolean);
    list = list.slice().sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.hits !== a.hits) return b.hits - a.hits;
      if (a.goodHits !== b.goodHits) return a.goodHits - b.goodHits;
      if (b.bestCombo !== a.bestCombo) return b.bestCombo - a.bestCombo;
      return String(a.name).localeCompare(String(b.name));
    });
    var out = [];
    var rank = 0, prevScore = null;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (prevScore === null || p.score !== prevScore) { rank = i + 1; prevScore = p.score; }
      out.push({
        rank: rank, id: p.id, name: p.name, color: p.color, ai: p.ai,
        score: p.score, hits: p.hits, goodHits: p.goodHits, swings: p.swings,
        combo: p.combo, bestCombo: p.bestCombo, accuracy: accuracyOf(p),
        buffUntil: p.buffUntil,
        byType: p.byType
      });
    }
    return out;
  }

  /** 給 UI 的一包即時快照（不含任何隱藏資訊，觀戰者也能拿到同一份） */
  function snapshot(state, now) {
    var el = elapsed(state, now);
    var st = stageAt(el, state.roundMs);
    return {
      seed: state.seed,
      phase: phaseOf(state, now),
      board: state.board, pace: state.pace, cols: state.cols, rows: state.rows, holes: state.holes,
      startAt: state.startAt, endAt: state.endAt,
      remainMs: remainMs(state, now),
      countdownMs: Math.max(0, state.startAt - now),
      stage: { no: st.no, label: st.label },
      moles: state.moles.map(function (m) {
        return {
          id: m.id, hole: m.hole, type: m.type, side: m.side,
          hp: m.hp, hpLeft: m.hpLeft, spawnAt: m.spawnAt, expireAt: m.expireAt
        };
      }),
      standings: standings(state),
      spawned: state.spawned, escaped: state.escaped,
      over: state.over, winner: state.winner, draw: state.draw
    };
  }

  /* 一行文字的事件描述，聊天室／摘要共用 */
  function describeEvent(ev, nameOf) {
    var who = nameOf ? nameOf(ev.by) : '有人';
    if (ev.k === 'hit') {
      var t = typeOf(ev.type);
      if (t.side === 'good') return who + ' 誤敲了' + t.label + '，' + ev.gain + ' 分！';
      if (!ev.killed) return who + ' 敲中' + t.label + '（還要 ' + ev.hpLeft + ' 下）+' + ev.gain;
      return who + ' 打倒' + t.label + ' +' + ev.gain + (ev.combo >= COMBO_STEP ? '（' + ev.combo + ' 連擊）' : '');
    }
    if (ev.k === 'escape') return typeOf(ev.type).label + '溜掉了。';
    if (ev.k === 'miss') return who + ' 敲了個空。';
    return '';
  }

  return {
    COLS: COLS, ROWS: ROWS, HOLES: HOLES,
    BOARDS: BOARDS, DEFAULT_BOARD: DEFAULT_BOARD, boardOf: boardOf, scaleStage: scaleStage,
    PACES: PACES, PACE_ORDER: PACE_ORDER, DEFAULT_PACE: DEFAULT_PACE, paceOf: paceOf,
    ROUND_SECONDS: ROUND_SECONDS, DEFAULT_ROUND_SEC: DEFAULT_ROUND_SEC,
    roundMsOf: roundMsOf, roundSecOf: roundSecOf,
    ROUND_MS: ROUND_MS, COUNTDOWN_MS: COUNTDOWN_MS,
    RISE_MS: RISE_MS, SINK_MS: SINK_MS,
    COMBO_STEP: COMBO_STEP, COMBO_BONUS: COMBO_BONUS, COMBO_MAX_BONUS: COMBO_MAX_BONUS,
    BUFF_MS: BUFF_MS, MAX_PLAYERS: MAX_PLAYERS,
    MOLE_TYPES: MOLE_TYPES, MOLE_ORDER: MOLE_ORDER,
    BAD_TYPES: BAD_TYPES, GOOD_TYPES: GOOD_TYPES,
    STAGES: STAGES, PLAYER_COLORS: PLAYER_COLORS, PLAYER_COLOR_HEX: PLAYER_COLOR_HEX,

    typeOf: typeOf, stageAt: stageAt, weightsFor: weightsFor, pickType: pickType,
    comboMultiplier: comboMultiplier, hitUnit: hitUnit, scoreHit: scoreHit,
    describeMole: describeMole, describeEvent: describeEvent,
    accuracyOf: accuracyOf,

    createMatch: createMatch, tick: tick, whack: whack, finish: finish,
    standings: standings, snapshot: snapshot,
    phaseOf: phaseOf, elapsed: elapsed, remainMs: remainMs,
    liveMole: liveMole, freeHoles: freeHoles, holeBusy: holeBusy
  };
}));
