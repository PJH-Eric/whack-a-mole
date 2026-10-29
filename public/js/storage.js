/* ===== storage.js — 本機偏好與戰績 =====
 * localStorage 在無痕視窗、封鎖第三方資料的瀏覽器裡可能會丟例外，
 * 所以每一次存取都包 try/catch，失敗就當作「沒有存過」繼續玩。
 */
(function (w) {
  'use strict';

  var KEY = {
    nick: 'wam_nick',
    clientId: 'wam_client',
    tutorialDone: 'wam_tutorial',
    aiLevel: 'wam_ai_level',
    aiCount: 'wam_ai_count',
    stats: 'wam_stats',
    best: 'wam_best',
    reduceMotion: 'wam_reduce_motion',
    vibrate: 'wam_vibrate',
    bigMark: 'wam_big_mark',
    board: 'wam_board',
    roundSec: 'wam_round_sec',
    hammerCursor: 'wam_hammer_cursor',
    hammerStyle: 'wam_hammer_style',
    sidebarOpen: 'wam_sidebar',
    records: 'wam_records',
    totals: 'wam_totals',
    badges: 'wam_badges'
  };

  function get(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }
  function getJson(k, d) {
    try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function setJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function getFlag(k, d) { var v = get(k, null); return v === null ? d : v === '1'; }
  function setFlag(k, v) { set(k, v ? '1' : '0'); }
  function getNum(k, d) { var v = Number(get(k, NaN)); return isFinite(v) ? v : d; }

  /** 這台裝置的身分：重新整理後要靠它回到原本的座位 */
  function clientId() {
    var id = get(KEY.clientId, '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = 'c' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      set(KEY.clientId, id);
    }
    return id;
  }

  var EMPTY_STATS = { solo: { win: 0, lose: 0, draw: 0 }, online: { win: 0, lose: 0, draw: 0 } };

  function stats() {
    var s = getJson(KEY.stats, null);
    if (!s || !s.solo || !s.online) return JSON.parse(JSON.stringify(EMPTY_STATS));
    return s;
  }

  function recordResult(mode, outcome) {
    var s = stats();
    var bucket = s[mode === 'online' ? 'online' : 'solo'];
    if (outcome === 'win' || outcome === 'lose' || outcome === 'draw') bucket[outcome] += 1;
    setJson(KEY.stats, s);
    return s;
  }

  /** 單機最高分紀錄 */
  function best(v) {
    if (v === undefined) return getJson(KEY.best, { score: 0, combo: 0, accuracy: 0 });
    var cur = best();
    var next = {
      score: Math.max(cur.score || 0, v.score || 0),
      combo: Math.max(cur.combo || 0, v.combo || 0),
      accuracy: Math.max(cur.accuracy || 0, v.accuracy || 0)
    };
    setJson(KEY.best, next);
    return next;
  }

  /* ---- 各難度紀錄、累計數字與成就徽章（只存本機，不上傳） ---- */
  var BADGES = [
    { id: 'clean', test: function (g) { return g.hits >= 15 && g.goodHits === 0; } },
    { id: 'combo30', test: function (g) { return g.bestCombo >= 30; } },
    { id: 'golden', test: function (g, t) { return (t.byType.golden || 0) >= 10; } },
    { id: 'sharp', test: function (g) { return g.swings >= 20 && g.accuracy >= 0.9; } },
    { id: 'rainbow', test: function (g, t) { return (t.byType.rainbow || 0) >= 10; } },
    { id: 'hundred', test: function (g, t) { return t.hits >= 500; } },
    { id: 'win', test: function (g, t) { return t.wins >= 1; } }
  ];

  function records() { var r = getJson(KEY.records, null); return r && typeof r === 'object' ? r : {}; }
  function totals() {
    var t = getJson(KEY.totals, null);
    if (!t || typeof t !== 'object') t = {};
    return { hits: Number(t.hits) || 0, wins: Number(t.wins) || 0, games: Number(t.games) || 0,
      byType: t.byType && typeof t.byType === 'object' ? t.byType : {} };
  }
  function badges() { var b = getJson(KEY.badges, null); return b && typeof b === 'object' ? b : {}; }

  /**
   * 一局打完記一次：更新該難度的最高分／最長連擊、累計數字，並判斷有沒有新成就。
   * @param {string} pace 難度 key
   * @param {object} row 我自己的結算列（score/hits/goodHits/swings/bestCombo/accuracy/byType）
   * @param {boolean} won 是否贏了一場有對手的對局
   * @returns {{newBest:{score:boolean,combo:boolean}, unlocked:string[]}}
   */
  function recordMatch(pace, row, won) {
    var all = records();
    var cur = all[pace] || { score: 0, combo: 0, hits: 0, games: 0 };
    var newBest = { score: (row.score || 0) > (cur.score || 0), combo: (row.bestCombo || 0) > (cur.combo || 0) };
    all[pace] = {
      score: Math.max(cur.score || 0, row.score || 0),
      combo: Math.max(cur.combo || 0, row.bestCombo || 0),
      hits: (cur.hits || 0) + (row.hits || 0),
      games: (cur.games || 0) + 1
    };
    setJson(KEY.records, all);

    var t = totals();
    t.hits += row.hits || 0;
    t.games += 1;
    if (won) t.wins += 1;
    var bt = row.byType || {};
    Object.keys(bt).forEach(function (k) { t.byType[k] = (t.byType[k] || 0) + (bt[k] || 0); });
    setJson(KEY.totals, t);

    var have = badges();
    var unlocked = [];
    BADGES.forEach(function (b) {
      if (have[b.id]) return;
      var ok = false;
      try { ok = !!b.test(row, t); } catch (e) {}
      if (ok) { have[b.id] = Date.now(); unlocked.push(b.id); }
    });
    if (unlocked.length) setJson(KEY.badges, have);
    return { newBest: newBest, unlocked: unlocked };
  }

  w.Store = {
    KEY: KEY,
    clientId: clientId,
    nick: function (v) { if (v === undefined) return get(KEY.nick, ''); set(KEY.nick, v); return v; },
    aiLevel: function (v) { if (v === undefined) return get(KEY.aiLevel, 'normal'); set(KEY.aiLevel, v); return v; },
    aiCount: function (v) { if (v === undefined) return getNum(KEY.aiCount, 2); set(KEY.aiCount, v); return v; },
    tutorialDone: function (v) { if (v === undefined) return getFlag(KEY.tutorialDone, false); setFlag(KEY.tutorialDone, v); return v; },
    reduceMotion: function (v) { if (v === undefined) return getFlag(KEY.reduceMotion, false); setFlag(KEY.reduceMotion, v); return v; },
    vibrate: function (v) { if (v === undefined) return getFlag(KEY.vibrate, true); setFlag(KEY.vibrate, v); return v; },
    bigMark: function (v) { if (v === undefined) return getFlag(KEY.bigMark, true); setFlag(KEY.bigMark, v); return v; },
    /* 本機偏好的盤面大小；建立線上房間時先沿用，之後仍由房主決定 */
    board: function (v) { if (v === undefined) return get(KEY.board, ''); set(KEY.board, v); return v; },
    /* 本機偏好的一局長度；建立線上房間時先沿用，之後仍由房主決定 */
    roundSec: function (v) { if (v === undefined) return getNum(KEY.roundSec, 0); set(KEY.roundSec, v); return v; },
    hammerCursor: function (v) { if (v === undefined) return getFlag(KEY.hammerCursor, true); setFlag(KEY.hammerCursor, v); return v; },
    hammerStyle: function (v) {
      var ok = ['classic', 'soft', 'gold'];
      if (v === undefined) { var g = get(KEY.hammerStyle, 'classic'); return ok.indexOf(g) < 0 ? 'classic' : g; }
      if (ok.indexOf(v) < 0) v = 'classic';
      set(KEY.hammerStyle, v); return v;
    },
    sidebarOpen: function (v) { if (v === undefined) return getFlag(KEY.sidebarOpen, true); setFlag(KEY.sidebarOpen, v); return v; },
    best: best,
    BADGES: BADGES,
    records: records,
    totals: totals,
    badges: badges,
    recordMatch: recordMatch,
    stats: stats,
    recordResult: recordResult,
    resetDefaults: function () {
      setFlag(KEY.reduceMotion, false);
      setFlag(KEY.vibrate, true);
      setFlag(KEY.bigMark, true);
      setFlag(KEY.hammerCursor, true);
      set(KEY.hammerStyle, 'classic');
    }
  };
}(window));
