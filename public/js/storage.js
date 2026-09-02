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
    hammerCursor: 'wam_hammer_cursor',
    sidebarOpen: 'wam_sidebar'
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
    /* 單機盤面大小；線上的盤面由房主決定，不看這個值 */
    board: function (v) { if (v === undefined) return get(KEY.board, ''); set(KEY.board, v); return v; },
    hammerCursor: function (v) { if (v === undefined) return getFlag(KEY.hammerCursor, true); setFlag(KEY.hammerCursor, v); return v; },
    sidebarOpen: function (v) { if (v === undefined) return getFlag(KEY.sidebarOpen, true); setFlag(KEY.sidebarOpen, v); return v; },
    best: best,
    stats: stats,
    recordResult: recordResult,
    resetDefaults: function () {
      setFlag(KEY.reduceMotion, false);
      setFlag(KEY.vibrate, true);
      setFlag(KEY.bigMark, true);
      setFlag(KEY.hammerCursor, true);
    }
  };
}(window));
