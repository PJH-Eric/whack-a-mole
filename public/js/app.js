/* ===== app.js — 畫面流程、單機主迴圈、線上房間串接 =====
 *
 * 分工：
 *   rules.js  規則與計分（前後端共用，唯一真相）
 *   ai.js     電腦對手（單機在這裡跑，線上在伺服器跑，同一份程式）
 *   render.js 盤面繪製
 *   online.js Socket.IO 包裝
 *   app.js    只做「把上面幾個接起來 + 使用者介面」
 *
 * 線上模式一律不自己判斷分數：畫面上的每一分都來自伺服器的事件或同步包。
 */
(function (w) {
  'use strict';

  var Rules = w.Rules, AI = w.AI, RNG = w.RNG, SvgUI = w.SvgUI, Board = w.Board;
  var Store = w.Store, Sound = w.Sound, Config = w.GameConfig, Online = w.Online;

  var $ = function (id) { return document.getElementById(id); };
  var el = function (sel, root) { return (root || document).querySelector(sel); };
  var els = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };

  /* ------------------------------------------------------------ 狀態 */

  var S = {
    screen: 's-home',
    mode: null,               // 'solo' | 'online'
    clientId: Store.clientId(),
    name: '',
    clockOffset: 0,           // 伺服器時間 - 本機時間
    /* 單機 */
    solo: { state: null, rng: null, brains: {}, ids: [] },
    /* 線上 */
    view: null,               // 最近一次 room:sync
    match: null,              // 目前盤面快照（線上會用事件在本機補幀）
    lastStage: 0,
    lastCombo: 0,
    warned: false,
    unread: 0,
    sidePane: 'sum',
    raf: 0,
    lastPaint: 0,
    joinIntent: null
  };

  function srvNow() { return Date.now() + S.clockOffset; }

  /* ------------------------------------------------------------ 小工具 */

  var toastTimer = 0;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function colorHex(key) { return Rules.PLAYER_COLOR_HEX[key] || '#A48FDB'; }

  function show(id) {
    els('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    S.screen = id;
    Sound.setTrack(id === 's-game' ? 'battle' : 'menu');
    SvgUI.repaintAll();
    var focusable = el('.screen.active h2, .screen.active h1, .screen.active .btn3d');
    if (focusable && focusable.focus) { try { focusable.focus({ preventScroll: true }); } catch (e) {} }
  }

  /* ------------------------------------------------------------ 圖鑑 */

  function dexCard(key, mini) {
    var t = Rules.typeOf(key);
    return '<div class="dexcard ' + t.side + '">'
      + '<div class="pic">' + SvgUI.moleSvg(key, t.hp) + '</div>'
      + '<div class="txt"><div class="nm">' + esc(t.label) + '</div>'
      + '<div class="pt">' + (t.points > 0 ? '+' : '') + t.points + ' 分'
      + (t.hp > 1 ? '・要 ' + t.hp + ' 下' : '') + '</div>'
      + (mini ? '' : '<div class="ds">' + esc(t.hint) + '</div>')
      + '</div></div>';
  }

  function buildDex() {
    $('dex-bad').innerHTML = Rules.BAD_TYPES.map(function (k) { return dexCard(k); }).join('');
    $('dex-good').innerHTML = Rules.GOOD_TYPES.map(function (k) { return dexCard(k); }).join('');
    $('dex-mini').innerHTML = Rules.MOLE_ORDER.map(function (k) { return dexCard(k, true); }).join('');
  }

  /* ------------------------------------------------------------ 設定彈窗 */

  var lastFocus = null;

  function openModal(id) {
    lastFocus = document.activeElement;
    var m = $(id);
    m.hidden = false;
    if (id === 'settings-modal') {
      $('b-settings').setAttribute('aria-expanded', 'true');
      syncSettingsUi();
    }
    var first = el('.iconbtn, .switch, .btn3d, input, select', m);
    if (first && first.focus) first.focus();
    SvgUI.repaintAll(m);
  }

  function closeModal(id) {
    $(id).hidden = true;
    if (id === 'settings-modal') $('b-settings').setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  function anyOpenModal() {
    var m = els('.modal').filter(function (x) { return !x.hidden; });
    return m.length ? m[m.length - 1] : null;
  }

  /* 焦點鎖在彈窗裡；Esc / 返回鍵關閉 */
  document.addEventListener('keydown', function (e) {
    var m = anyOpenModal();
    if (!m) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(m.id); return; }
    if (e.key !== 'Tab') return;
    var f = els('button:not([disabled]), input:not([disabled]), select, [tabindex]:not([tabindex="-1"])', m)
      .filter(function (x) { return x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  function syncSettingsUi() {
    $('set-music').checked = Sound.isMusicOn();
    $('set-sfx').checked = Sound.isSfxOn();
    $('set-chatcue').checked = Sound.isChatCueOn();
    $('set-haptic').checked = Sound.isHapticOn();
    $('set-music-vol').value = Math.round(Sound.getMusicVolume() * 100);
    $('set-sfx-vol').value = Math.round(Sound.getSfxVolume() * 100);
    $('set-motion').checked = Store.reduceMotion();
    $('set-mark').checked = Store.bigMark();
    $('set-hammer').checked = Store.hammerCursor();
    $('set-server').textContent = Config.describe();
    $('set-server-url').value = Config.storedUrl ? Config.storedUrl() : '';
    $('set-audio-note').textContent = Sound.isUnlocked()
      ? '' : '瀏覽器規定要先碰一下畫面才會出聲，按任何一顆按鈕就會解鎖。';
  }

  function applyDisplayPrefs() {
    document.body.classList.toggle('reduce-motion', Store.reduceMotion());
    Board.setOptions({ reduceMotion: Store.reduceMotion(), bigMark: Store.bigMark() });
    applyHammerCursor();
  }

  /* 鐵鎚游標的圖從 SvgUI 產生，寫成 CSS 變數讓樣式表去套。
     觸控裝置的判斷交給 CSS 的 (hover:hover)，這裡只管開關與圖。 */
  function applyHammerCursor() {
    var on = Store.hammerCursor();
    document.body.classList.toggle('hammer-cursor', on);
    if (!on) return;
    var root = document.documentElement.style;
    if (!root.getPropertyValue('--cur-hammer')) {
      root.setProperty('--cur-hammer', SvgUI.hammerCursor(false));
      root.setProperty('--cur-hammer-hit', SvgUI.hammerCursor(true));
    }
  }

  /* ============================================================
   * 敲擊事件的共同處理（單機、線上都走這裡）
   * ============================================================ */

  function nameOfId(id) {
    if (!S.match) return '';
    for (var i = 0; i < S.match.standings.length; i++) {
      if (S.match.standings[i].id === id) return S.match.standings[i].name;
    }
    return '';
  }

  function colorOfId(id) {
    if (!S.match) return null;
    for (var i = 0; i < S.match.standings.length; i++) {
      if (S.match.standings[i].id === id) return colorHex(S.match.standings[i].color);
    }
    return null;
  }

  function meId() { return S.mode === 'solo' ? 'me' : (S.view && S.view.you ? S.view.you.id : null); }

  function handleEvents(events, now) {
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var mine = ev.by && ev.by === meId();

      if (ev.k === 'spawn') { Sound.play('pop'); continue; }

      if (ev.k === 'go') { Sound.play('start'); Board.shout('開始！', 'go'); continue; }

      if (ev.k === 'end') { continue; }

      if (ev.k === 'escape') {
        if (Rules.typeOf(ev.type).side === 'bad') Sound.play('escape');
        continue;
      }

      if (ev.k === 'miss') {
        /* 只顯示自己的空槌；別人（尤其是電腦）的空槌會把畫面洗成一片字 */
        if (mine) { Board.popEvent(ev, {}); Sound.play('whiff'); }
        continue;
      }

      if (ev.k === 'hit') {
        Board.popEvent(ev, { who: mine ? '' : nameOfId(ev.by), color: colorOfId(ev.by) });
        var t = Rules.typeOf(ev.type);
        if (t.side === 'good') {
          if (mine) { Sound.play('oops'); Sound.vibrate([30, 40, 30]); }
          else Sound.play('whiff');
        } else if (!ev.killed) {
          Sound.play('bonk');
          if (mine) Sound.vibrate(12);
        } else if (ev.type === 'golden' || ev.type === 'rainbow') {
          Sound.play('shiny');
          if (mine) Sound.vibrate([12, 30, 18]);
          if (mine && ev.type === 'rainbow') { Sound.play('buff', 0.15); Board.shout('分數加倍 6 秒！', 'buff', 1100); }
        } else {
          Sound.play(t.hp > 1 ? 'smash' : 'bonk');
          if (mine) Sound.vibrate(t.hp > 1 ? [14, 24, 20] : 12);
        }
        if (mine && ev.combo && ev.combo % Rules.COMBO_STEP === 0) {
          Sound.play('combo');
          Board.shout(ev.combo + ' 連擊！', 'combo', 800);
        }
      }
    }
  }

  /* 線上：用事件在本機把盤面補到下一次同步之前（不自己算分，分數只信伺服器） */
  function applyEventToSnap(snap, ev) {
    if (!snap) return;
    var i;
    if (ev.k === 'spawn') {
      for (i = 0; i < snap.moles.length; i++) if (snap.moles[i].id === ev.mole.id) return;
      snap.moles.push({
        id: ev.mole.id, hole: ev.mole.hole, type: ev.mole.type, side: ev.mole.side,
        hp: ev.mole.hp, hpLeft: ev.mole.hpLeft, spawnAt: ev.mole.spawnAt, expireAt: ev.mole.expireAt
      });
      return;
    }
    if (ev.k === 'escape') {
      snap.moles = snap.moles.filter(function (m) { return m.id !== ev.moleId; });
      return;
    }
    if (ev.k === 'hit') {
      if (ev.killed) snap.moles = snap.moles.filter(function (m) { return m.id !== ev.moleId; });
      else for (i = 0; i < snap.moles.length; i++) {
        if (snap.moles[i].id === ev.moleId) snap.moles[i].hpLeft = ev.hpLeft;
      }
      /* 分數直接沿用伺服器算好的值，前端不重算 */
      for (i = 0; i < snap.standings.length; i++) {
        if (snap.standings[i].id !== ev.by) continue;
        snap.standings[i].score = ev.score;
        snap.standings[i].combo = ev.combo;
        if (ev.side === 'bad') snap.standings[i].hits += 1; else snap.standings[i].goodHits += 1;
        snap.standings[i].swings += 1;
        if (ev.combo > snap.standings[i].bestCombo) snap.standings[i].bestCombo = ev.combo;
      }
      snap.standings.sort(function (a, b) { return b.score - a.score || b.hits - a.hits; });
      for (i = 0; i < snap.standings.length; i++) snap.standings[i].rank = i + 1;
      return;
    }
    if (ev.k === 'miss') {
      for (i = 0; i < snap.standings.length; i++) {
        if (snap.standings[i].id === ev.by) snap.standings[i].swings += 1;
      }
    }
  }

  /* 本機把過期的地鼠收掉，就算 escape 事件晚到動畫也不會卡住 */
  function pruneExpired(snap, now) {
    if (!snap) return;
    snap.moles = snap.moles.filter(function (m) { return now < m.expireAt; });
  }

  /* ============================================================
   * 單機模式
   * ============================================================ */

  function startSolo() {
    var level = Store.aiLevel();
    var count = Number(Store.aiCount()) || 0;
    var seed = RNG.randomSeed();
    var now = Date.now();

    var roster = [{ id: 'me', name: S.name || '我' }];
    S.solo.brains = {};
    S.solo.ids = ['me'];
    for (var i = 0; i < count; i++) {
      var id = 'ai:' + i;
      roster.push({ id: id, name: AI.aiName(level, i), ai: level });
      S.solo.brains[id] = AI.createBrain(level, 'solo:' + seed + ':' + i);
      S.solo.ids.push(id);
    }

    S.mode = 'solo';
    S.clockOffset = 0;
    S.view = null;
    S.solo.state = Rules.createMatch({ seed: seed, players: roster, now: now, board: Store.board() });
    S.solo.rng = RNG.createRng('spawn:solo:' + seed);
    S.match = Rules.snapshot(S.solo.state, now);
    S.lastStage = 0; S.lastCombo = 0; S.warned = false;

    enterGameScreen();
  }

  function soloStep(now) {
    var st = S.solo.state;
    if (!st) return;
    var events = Rules.tick(st, now, S.solo.rng);
    if (!st.over && now >= st.startAt) {
      var snap = Rules.snapshot(st, now);
      for (var i = 0; i < S.solo.ids.length; i++) {
        var id = S.solo.ids[i];
        var brain = S.solo.brains[id];
        if (!brain) continue;
        var aim = brain.step(snap, now);
        if (!aim) continue;
        var res = Rules.whack(st, id, aim, now);
        if (res.ok) events.push(res.event);
      }
    }
    S.match = Rules.snapshot(st, now);
    if (events.length) handleEvents(events, now);
    if (st.over && !S.soloResultShown) { S.soloResultShown = true; onSoloOver(); }
  }

  function onSoloOver() {
    var rank = S.match.standings;
    var me = rank.filter(function (r) { return r.id === 'me'; })[0];
    var outcome = 'draw';
    if (me) {
      if (S.match.draw && me.rank === 1) outcome = 'draw';
      else if (S.match.winner === 'me') outcome = 'win';
      else if (rank.length === 1) outcome = 'win';
      else outcome = me.rank === 1 ? 'win' : 'lose';
      Store.recordResult('solo', outcome);
      Store.best({ score: me.score, combo: me.bestCombo, accuracy: me.accuracy });
    }
    Sound.play(outcome === 'lose' ? 'lose' : 'win');
    showResult();
  }

  /* ============================================================
   * 對戰畫面：HUD、左側摘要、浮層
   * ============================================================ */

  function enterGameScreen() {
    S.soloResultShown = false;
    if (S.match) Board.setGrid(S.match);
    $('ov-result').hidden = true;
    $('ov-wait').hidden = true;
    Board.clear();
    applyDisplayPrefs();
    $('tab-chat').hidden = S.mode !== 'online';
    $('chat-hint').hidden = S.mode === 'online';
    $('b-open-chat').hidden = S.mode !== 'online';
    if (S.mode !== 'online' && S.sidePane === 'chat') setPane('sum');
    show('s-game');
    startLoop();
    refreshAll();
  }

  function leaveGame() {
    stopLoop();
    if (S.mode === 'online' && S.view) Online.send('room:leave', {});
    S.mode = null; S.solo.state = null; S.match = null; S.view = null;
    Board.clear();
    show('s-home');
  }

  function startLoop() {
    if (S.raf) return;
    var tick = function () {
      S.raf = w.requestAnimationFrame(tick);
      var now = srvNow();
      if (S.mode === 'solo') soloStep(Date.now());
      else pruneExpired(S.match, now);
      if (S.match) Board.draw(S.match, now);
      /* DOM 更新壓在 ~12fps，省電也避免手機掉幀 */
      if (now - S.lastPaint > 80) { S.lastPaint = now; paintHud(); paintSummary(); }
    };
    S.raf = w.requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (S.raf) w.cancelAnimationFrame(S.raf);
    S.raf = 0;
  }

  function myRow() {
    if (!S.match) return null;
    var id = meId();
    for (var i = 0; i < S.match.standings.length; i++) {
      if (S.match.standings[i].id === id) return S.match.standings[i];
    }
    return null;
  }

  function paintHud() {
    var m = S.match;
    if (!m) return;
    var sec = Math.ceil(m.remainMs / 1000);
    var clock = $('hud-clock');
    if (clock.textContent !== String(sec)) clock.textContent = sec;
    $('hud-time').classList.toggle('low', m.phase === 'playing' && sec <= 10);
    if (m.phase === 'playing' && sec <= 10 && !S.warned) { S.warned = true; Sound.play('warn'); }

    var st = $('hud-stage');
    st.textContent = '第 ' + m.stage.no + ' 階段・' + m.stage.label;
    st.className = 'hud-stage' + (m.stage.no > 1 ? ' s' + m.stage.no : '');
    if (m.phase === 'playing' && m.stage.no !== S.lastStage) {
      if (S.lastStage) { Sound.play('stage'); Board.shout(m.stage.label + '！地鼠變快了', 'stage', 1100); }
      S.lastStage = m.stage.no;
    }

    var fill = $('timebar-fill');
    fill.style.width = (m.remainMs / (m.endAt - m.startAt) * 100).toFixed(1) + '%';
    fill.className = m.stage.no > 1 ? 's' + m.stage.no : '';

    var me = myRow();
    $('hud-score').textContent = me ? me.score : 0;
    var cb = $('hud-combo');
    if (me && me.combo >= 2) { cb.hidden = false; $('hud-combo-n').textContent = me.combo; }
    else cb.hidden = true;

    /* 倒數 */
    var cd = $('countdown');
    if (m.phase === 'countdown') {
      var n = Math.ceil(m.countdownMs / 1000);
      cd.hidden = false;
      if (cd.textContent !== String(n)) { cd.textContent = n; Sound.play('count'); }
    } else if (!cd.hidden) {
      cd.hidden = true;
    }
  }

  function paintSummary() {
    var m = S.match;
    if (!m) return;

    /* 一行帶完房間／模式資訊 */
    var room = $('sum-room');
    if (S.mode === 'online' && S.view) {
      var you = S.view.you;
      var role = you.role === 'player' ? '玩家' : (you.role === 'spectator' ? '觀戰' : '訪客');
      room.innerHTML = '<b>' + esc(S.view.code) + '</b>　' + role + (you.host ? '・房主' : '')
        + '　' + (S.view.seats - S.view.seatsFree) + '/' + S.view.seats + ' 人';
    } else {
      room.innerHTML = '單機・' + esc(AI.levelOf(Store.aiLevel()).label)
        + '・對手 ' + (S.solo.ids.length - 1) + ' 個';
    }

    /* 即時排行：名次、名字、分數。連擊只在真的有連擊時用小字帶出來。 */
    var me = meId();
    $('rank-list').innerHTML = m.standings.map(function (p) {
      return '<li class="rankrow' + (p.id === me ? ' me' : '') + '" style="--who:' + colorHex(p.color) + '">'
        + '<span class="no">' + p.rank + '</span>'
        + '<span class="nm">' + esc(p.name) + '</span>'
        + '<span class="sc">' + p.score
        + (p.combo >= 2 ? '<small>' + p.combo + ' 連</small>' : '') + '</span>'
        + '</li>';
    }).join('');

    /* 我的表現：一行就好，分數已經在 HUD 上了 */
    var r = myRow();
    $('my-stat').textContent = r
      ? '命中 ' + r.hits + '・誤敲 ' + r.goodHits + '・準度 ' + Math.round((r.accuracy || 0) * 100) + '%'
        + (r.bestCombo >= 2 ? '・最佳連擊 ' + r.bestCombo : '')
      : '觀戰中，看得到完整盤面';

    /* 彩虹加倍剩餘時間顯示在 HUD 上 */
    var refNow = S.mode === 'solo' ? Date.now() : srvNow();
    var buffLeft = r && r.buffUntil ? Math.max(0, r.buffUntil - refNow) : 0;
    $('hud-buff').hidden = buffLeft <= 0;
    if (buffLeft > 0) $('hud-buff').textContent = '🌈 加倍中 ' + Math.ceil(buffLeft / 1000) + 's';

    paintSideActions();
  }

  function paintSideActions() {
    var box = $('side-actions');
    var html = '';
    if (S.mode === 'online' && S.view) {
      var can = S.view.you.can || {};
      if (can.invite) html += '<button class="btn3d" data-color="sky" data-act="invite">🔗 邀請</button>';
      if (can.sit) html += '<button class="btn3d" data-color="mint" data-act="sit">下場對戰</button>';
      if (can.stand) html += '<button class="btn3d" data-color="cream" data-act="stand">改成觀戰</button>';
    }
    html += '<button class="btn3d" data-color="cream" data-act="quit">離開</button>';
    if (box.dataset.html !== html) {
      box.dataset.html = html;
      box.innerHTML = html;
      SvgUI.decorateAll(box);
    }
  }

  /* ---- 等待／結算浮層 ---- */

  function paintWaitOverlay() {
    var v = S.view;
    if (S.mode !== 'online' || !v) { $('ov-wait').hidden = true; return; }
    var waiting = v.phase === 'lobby';
    $('ov-wait').hidden = !waiting;
    if (!waiting) return;

    $('ov-wait-title').textContent = '準備開始・房號 ' + v.code;

    var seats = [];
    v.members.filter(function (m) { return m.role === 'player'; }).forEach(function (m, i) {
      seats.push('<div class="seatrow" style="--who:' + colorHex(Rules.PLAYER_COLORS[i % 5]) + '">'
        + '<span class="nm">' + esc(m.name) + '</span>'
        + (m.host ? '<span class="tag host">房主</span>' : '')
        + (m.connected ? '' : '<span class="tag off">斷線</span>')
        + '<span class="tag' + (m.ready ? ' ready' : '') + '">' + (m.ready ? '準備好' : '還沒準備') + '</span>'
        + '</div>');
    });
    v.ai.forEach(function (a) {
      seats.push('<div class="seatrow" style="--who:#C8BFD1">'
        + '<span class="nm">' + esc(a.name) + '</span><span class="tag ai">電腦</span>'
        + (v.you.can.manageAi ? '<button class="x" data-rmai="' + esc(a.id) + '" aria-label="移除 ' + esc(a.name) + '">✕</button>' : '')
        + '</div>');
    });
    var specs = v.members.filter(function (m) { return m.role === 'spectator'; });
    if (specs.length) {
      seats.push('<div class="seatrow" style="--who:#C8BFD1"><span class="nm">觀戰 '
        + specs.length + ' 人：' + esc(specs.map(function (m) { return m.name; }).join('、')) + '</span></div>');
    }
    $('seat-list').innerHTML = seats.join('');

    $('ai-manage').hidden = !v.you.can.manageAi;
    if (v.you.can.manageAi) {
      $('ai-add').innerHTML = AI.ORDER.map(function (k) {
        var L = AI.levelOf(k);
        return '<button class="btn3d" data-color="sky" data-addai="' + k + '"'
          + (v.seatsFree > 0 ? '' : ' disabled') + '>' + L.emoji + ' ' + L.label + '</button>';
      }).join('');
      SvgUI.decorateAll($('ai-add'));
    }

    /* 盤面大小只有房主能改，其他人看得到目前設定（寫在下面的說明裡） */
    /* 還沒開打時就先把空盤面換成房主選的尺寸，改了立刻看得到 */
    Board.setGrid(Rules.boardOf(v.board));
    $('board-manage').hidden = !v.you.can.setBoard;
    if (v.you.can.setBoard) {
      $('board-pick').innerHTML = (v.boards || []).map(function (b) {
        var on = b.key === v.board;
        return '<button class="btn3d" data-color="' + (on ? 'mint' : 'cream') + '"'
          + ' data-setboard="' + esc(b.key) + '" role="radio" aria-checked="' + on + '">'
          + esc(b.label) + '</button>';
      }).join('');
      SvgUI.decorateAll($('board-pick'));
    }

    var note = [];
    var bd = Rules.boardOf(v.board);
    note.push('盤面 ' + bd.label + '（' + bd.holes + ' 個地洞）。');
    note.push('座位 ' + (v.seats - v.seatsFree) + '/' + v.seats + '，最多 ' + v.seats + ' 人共用同一組地洞。');
    if (v.you.role === 'spectator') note.push('你目前是觀戰身分。');
    if (v.you.startBlockedBy) note.push(v.you.startBlockedBy + '。');
    $('ov-wait-note').textContent = note.join(' ');

    var btns = '';
    if (v.you.can.ready) {
      btns += '<button class="btn3d big" data-color="' + (v.you.ready ? 'cream' : 'mint') + '" data-act="ready">'
        + (v.you.ready ? '取消準備' : '✔ 準備好了') + '</button>';
    }
    if (v.you.host) {
      btns += '<button class="btn3d big" data-color="grape" data-act="start"'
        + (v.you.can.start ? '' : ' disabled') + '>▶ 開始這一局</button>';
    }
    if (v.you.can.sit) btns += '<button class="btn3d" data-color="mint" data-act="sit">下場對戰</button>';
    if (v.you.can.stand) btns += '<button class="btn3d" data-color="cream" data-act="stand">改成觀戰</button>';
    if (v.you.can.invite) btns += '<button class="btn3d" data-color="sky" data-act="invite">🔗 邀請朋友</button>';
    $('ov-wait-btns').innerHTML = btns;
    SvgUI.decorateAll($('ov-wait-btns'));
  }

  function showResult() {
    var m = S.match;
    if (!m) return;
    var me = meId();
    $('ov-trophy').innerHTML = SvgUI.trophy();
    var champs = m.standings.filter(function (p) { return p.rank === 1; });
    var iWon = champs.some(function (p) { return p.id === me; });
    $('ov-result-title').textContent = m.draw
      ? '平手！' + champs.map(function (p) { return p.name; }).join('、') + ' 同分'
      : (iWon ? '你贏了！' : (champs[0] ? champs[0].name + ' 獲勝' : '時間到'));

    $('result-table').innerHTML = m.standings.map(function (p) {
      return '<div class="resrow' + (p.rank === 1 ? ' win' : '') + '" style="--who:' + colorHex(p.color) + '">'
        + '<span class="no">' + p.rank + '</span>'
        + '<span class="nm">' + esc(p.name)
        + '<small>敲中 ' + p.hits + '・誤敲 ' + p.goodHits + '・最佳連擊 ' + p.bestCombo
        + '・命中率 ' + Math.round((p.accuracy || 0) * 100) + '%</small></span>'
        + '<span class="sc">' + p.score + '</span></div>';
    }).join('');

    var btns = '';
    if (S.mode === 'solo') {
      btns += '<button class="btn3d big" data-color="mint" data-act="again">🔁 再玩一次</button>'
        + '<button class="btn3d" data-color="cream" data-act="quit">回主選單</button>';
    } else if (S.view) {
      var v = S.view;
      if (v.you.can.rematch) {
        btns += '<button class="btn3d big" data-color="mint" data-act="rematch">🔁 再來一局（'
          + v.rematch.votes + '/' + v.rematch.need + '）</button>';
      }
      if (v.you.can.reset) btns += '<button class="btn3d" data-color="sky" data-act="reset">回房間調整</button>';
      btns += '<button class="btn3d" data-color="cream" data-act="quit">離開房間</button>';
    }
    $('ov-result-btns').innerHTML = btns;
    SvgUI.decorateAll($('ov-result-btns'));
    $('ov-result').hidden = false;
  }

  /* ============================================================
   * 線上模式
   * ============================================================ */

  function connStatus(st) {
    var dot = $('conn-dot'), txt = $('conn-text');
    var map = {
      idle: ['', '尚未連線'], loading: ['warn', '正在載入連線程式…'],
      connecting: ['warn', '連線中…（免費方案冷啟動可能要十幾秒）'],
      connected: ['ok', '已連上 ' + Config.describe()],
      error: ['bad', st.message || '連線失敗'],
      offline: ['bad', st.message || '沒有可用的伺服器，只能玩單機']
    };
    var m = map[st.status] || ['', st.status];
    dot.className = 'dot ' + m[0];
    txt.textContent = m[1];
    $('b-reconnect').hidden = !(st.status === 'error' || st.status === 'offline');
  }

  function connect() {
    S.name = ($('lobby-nick').value || Store.nick() || '').trim() || '玩家';
    Store.nick(S.name);
    return Online.connect({ clientId: S.clientId, name: S.name })
      .then(function () {
        Online.send('lobby:subscribe', {});
        return true;
      })
      .catch(function (err) { toast(err.message || '連不上伺服器'); throw err; });
  }

  function paintRoomList(payload) {
    $('rooms-count').textContent = payload.total || 0;
    var list = payload.rooms || [];
    if (!list.length) {
      $('room-list').innerHTML = '<div class="empty">目前沒有公開房間。按上面的「建立房間」開一間，把房號或邀請連結給朋友就好。</div>';
      return;
    }
    $('room-list').innerHTML = list.map(function (r) {
      var tag = r.phase === 'playing' || r.phase === 'countdown' ? '<span class="tag playing">對戰中</span>'
        : (r.phase === 'over' ? '<span class="tag over">剛打完</span>' : '<span class="tag">等待中</span>');
      return '<div class="roomrow">'
        + '<span class="rname">' + esc(r.name) + '<small>房號 ' + esc(r.code) + '</small></span>'
        + tag
        + '<span class="rmeta">玩家 ' + (r.players + r.ai) + '/' + r.seats
        + (r.spectators ? '・觀戰 ' + r.spectators : '') + '</span>'
        + '<button class="btn3d small" data-color="mint" data-joincode="' + esc(r.code) + '">'
        + (r.seatsFree > 0 && r.phase !== 'playing' ? '加入' : '觀戰') + '</button>'
        + '</div>';
    }).join('');
    SvgUI.decorateAll($('room-list'));
  }

  function joinRoom(code, token, role) {
    return connect().then(function () {
      return new Promise(function (resolve) {
        Online.send('room:join', { code: code, name: S.name, token: token || null, role: role || null }, function (res) {
          if (!res || !res.ok) { toast((res && res.error) || '加入失敗'); return resolve(false); }
          S.mode = 'online';
          if (res.downgraded) toast('玩家席位已滿，你先以觀戰身分進來了。', 3600);
          else if (res.waiting) toast('這局已經開打，你先觀戰，下一局就能下場。', 3600);
          else if (res.note) toast(res.note, 3600);
          Sound.play('join');
          resolve(true);
        });
      });
    }).catch(function () { return false; });
  }

  function createRoom() {
    return connect().then(function () {
      Online.send('room:create', {
        name: S.name,
        roomName: $('room-name').value,
        private: $('room-private').checked
      }, function (res) {
        if (!res || !res.ok) return toast((res && res.error) || '建立失敗');
        S.mode = 'online';
        Sound.play('join');
      });
    }).catch(function () {});
  }

  function onSync(view) {
    var wasPhase = S.view ? S.view.phase : null;
    S.view = view;
    S.match = view.match;
    if (S.screen !== 's-game') {
      S.mode = 'online';
      enterGameScreen();
    }
    if (view.phase === 'countdown' && wasPhase !== 'countdown') {
      S.lastStage = 0; S.lastCombo = 0; S.warned = false;
      $('ov-result').hidden = true;
      Board.clear();
    }
    if (view.phase === 'over' && wasPhase !== 'over') {
      var me = meId();
      var r = (view.match ? view.match.standings : []).filter(function (p) { return p.id === me; })[0];
      if (r) {
        var outcome = r.rank === 1 ? (view.match.draw ? 'draw' : 'win') : 'lose';
        Store.recordResult('online', outcome);
        Store.best({ score: r.score, combo: r.bestCombo, accuracy: r.accuracy });
        Sound.play(outcome === 'lose' ? 'lose' : 'win');
      }
    }
    /* 結算浮層上的「再來一局」票數會一直變，所以每次同步都重畫 */
    if (view.phase === 'over') showResult();
    else $('ov-result').hidden = true;
    paintWaitOverlay();
    paintChat(view.chat);
    paintInviteList(view.invites);
    if (view.match) { paintHud(); paintSummary(); }
  }

  /* ---- 聊天室 ---- */

  var lastChatId = 0;
  function paintChat(list) {
    if (!list) return;
    var me = meId();
    var log = $('chat-log');
    var atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.innerHTML = list.map(function (m) {
      if (m.system) return '<div class="msg sys">' + esc(m.text) + '</div>';
      var cls = 'msg' + (m.from === me ? ' me' : '') + (m.role === 'spectator' ? ' spec' : '');
      return '<div class="' + cls + '"><span class="who">' + esc(m.name) + '</span>' + esc(m.text) + '</div>';
    }).join('');
    if (atBottom) log.scrollTop = log.scrollHeight;
    var newest = list.length ? list[list.length - 1].id : 0;
    if (newest > lastChatId) {
      if (S.sidePane !== 'chat' || !isSideOpen()) {
        var added = list.filter(function (m) { return m.id > lastChatId && !m.system; }).length;
        if (added) { S.unread += added; paintUnread(); Sound.playChat(); }
      }
      lastChatId = newest;
    }
  }

  function paintUnread() {
    var show = S.unread > 0;
    var txt = S.unread > 99 ? '99+' : String(S.unread);
    ['chat-unread', 'chat-unread2'].forEach(function (id) {
      var e = $(id);
      e.hidden = !show;
      e.textContent = txt;
    });
  }

  /* ---- 邀請 ---- */

  function paintInviteList(list) {
    var box = $('invite-list');
    if (!list || !list.length) {
      box.innerHTML = '<div class="empty">還沒有產生過邀請連結。</div>';
      return;
    }
    var now = srvNow();
    box.innerHTML = list.map(function (iv) {
      var dead = iv.revoked || iv.expiresAt < now || iv.uses >= iv.maxUses;
      var why = iv.revoked ? '已撤銷' : (iv.expiresAt < now ? '已過期'
        : (iv.uses >= iv.maxUses ? '次數用完' : Math.ceil((iv.expiresAt - now) / 60000) + ' 分鐘後過期'));
      return '<div class="invrow' + (dead ? ' dead' : '') + '">'
        + '<span class="txt">' + (iv.role === 'spectator' ? '觀戰' : '玩家') + '・'
        + iv.uses + '/' + iv.maxUses + ' 次・' + why + '</span>'
        + (dead ? '' : '<button class="iconbtn" data-copyinv="' + esc(iv.token) + '" aria-label="複製這個邀請連結">⧉</button>'
          + '<button class="iconbtn" data-revoke="' + esc(iv.token) + '" aria-label="撤銷這個邀請連結">✕</button>')
        + '</div>';
    }).join('');
  }

  function makeInvite() {
    Online.send('room:invite', {
      role: $('inv-role').value,
      ttlMinutes: Number($('inv-ttl').value),
      maxUses: Number($('inv-uses').value)
    }, function (res) {
      if (!res || !res.ok) return toast((res && res.error) || '產生失敗');
      var url = Config.inviteUrl(S.view.code, res.token);
      $('invite-url').value = url;
      $('invite-out').hidden = false;
      copyText(url, '邀請連結已經複製，貼給朋友就可以了。');
    });
  }

  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || '已複製'); };
    if (w.navigator && w.navigator.clipboard && w.navigator.clipboard.writeText) {
      w.navigator.clipboard.writeText(text).then(done).catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var i = $('invite-url');
      i.hidden = false;
      i.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { toast('複製失敗，請手動選取連結複製。'); }
    }
  }

  /* ---- 側欄開合 ---- */

  function isSideOpen() {
    var side = $('side');
    return !isNarrow() || side.classList.contains('open');
  }
  function isNarrow() { return $('side-fab').offsetParent !== null; }

  function setPane(name) {
    S.sidePane = name;
    ['sum', 'chat', 'dex'].forEach(function (k) {
      $('pane-' + k).classList.toggle('on', k === name);
      var tab = $('tab-' + k);
      tab.classList.toggle('on', k === name);
      tab.setAttribute('aria-selected', k === name ? 'true' : 'false');
    });
    if (name === 'chat') { S.unread = 0; paintUnread(); $('chat-log').scrollTop = $('chat-log').scrollHeight; }
  }

  function openSide(pane) {
    if (pane) setPane(pane);
    $('side').classList.add('open');
    Store.sidebarOpen(true);
  }
  function closeSide() { $('side').classList.remove('open'); Store.sidebarOpen(false); }

  function refreshAll() {
    paintWaitOverlay();
    paintHud();
    paintSummary();
    paintUnread();
  }

  /* ============================================================
   * 操作綁定
   * ============================================================ */

  function doAction(act) {
    if (act === 'quit') {
      if (S.mode === 'online' && S.view && S.view.phase === 'playing' && S.view.you.role === 'player') {
        if (!w.confirm('這一局還沒打完，確定要離開嗎？你的分數會留在排行榜上。')) return;
      }
      leaveGame();
      return;
    }
    if (act === 'again') { startSolo(); return; }
    if (S.mode !== 'online') return;
    if (act === 'ready') Online.send('room:ready', { ready: !S.view.you.ready });
    else if (act === 'start') Online.send('room:start', {});
    else if (act === 'sit') Online.send('room:sit', {});
    else if (act === 'stand') Online.send('room:stand', {});
    else if (act === 'rematch') Online.send('room:rematch', {});
    else if (act === 'reset') Online.send('room:reset', {});
    else if (act === 'invite') openModal('invite-modal');
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act],[data-back],[data-joincode],[data-addai],[data-rmai],[data-setboard],[data-revoke],[data-copyinv],[data-close-modal],[data-pane]') : null;
    if (!t) return;
    if (t.dataset.back) { show(t.dataset.back); Sound.play('click'); return; }
    if (t.dataset.act) { Sound.play('click'); doAction(t.dataset.act); return; }
    if (t.dataset.pane) { Sound.play('tick'); setPane(t.dataset.pane); return; }
    if (t.dataset.joincode) { Sound.play('click'); joinRoom(t.dataset.joincode); return; }
    if (t.dataset.addai) { Online.send('room:addAi', { level: t.dataset.addai }); return; }
    if (t.dataset.rmai) { Online.send('room:removeAi', { id: t.dataset.rmai }); return; }
    if (t.dataset.setboard) { Sound.play('tick'); Online.send('room:setBoard', { board: t.dataset.setboard }); return; }
    if (t.dataset.revoke) { Online.send('room:revokeInvite', { token: t.dataset.revoke }); return; }
    if (t.dataset.copyinv) { copyText(Config.inviteUrl(S.view.code, t.dataset.copyinv)); return; }
    if (t.hasAttribute('data-close-modal')) { closeModal(t.closest('.modal').id); }
  });

  /* 第一次手勢解鎖音訊（瀏覽器規定） */
  ['pointerdown', 'keydown'].forEach(function (evt) {
    w.addEventListener(evt, function once() {
      Sound.unlock();
      if (Sound.isMusicOn()) Sound.startBgm();
      w.removeEventListener(evt, once);
    }, { once: true });
  });

  function bindUi() {
    /* 首頁 */
    $('b-solo').addEventListener('click', function () {
      $('solo-nick').value = Store.nick();
      paintSoloOptions();
      show('s-solo');
    });
    $('b-online').addEventListener('click', function () {
      $('lobby-nick').value = Store.nick();
      show('s-lobby');
      connect().catch(function () {});
    });
    $('b-help').addEventListener('click', function () { show('s-help'); });
    $('b-stats').addEventListener('click', function () { paintStats(); show('s-stats'); });

    /* 單機設定 */
    $('solo-nick').addEventListener('change', function () { Store.nick(this.value.trim()); });
    $('b-solo-start').addEventListener('click', function () {
      S.name = ($('solo-nick').value || '').trim() || '我';
      Store.nick(S.name);
      startSolo();
    });

    /* 大廳 */
    $('lobby-nick').addEventListener('change', function () { Store.nick(this.value.trim()); });
    $('b-create').addEventListener('click', createRoom);
    $('b-join').addEventListener('click', function () {
      var code = ($('join-code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 4) return toast('請輸入完整的房號。');
      joinRoom(code);
    });
    $('join-code').addEventListener('input', function () {
      this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    });
    $('b-reconnect').addEventListener('click', function () { connect().catch(function () {}); });

    /* 側欄 */
    $('b-side-close').addEventListener('click', closeSide);
    $('b-open-sum').addEventListener('click', function () { openSide('sum'); });
    $('b-open-chat').addEventListener('click', function () { openSide('chat'); });
    $('b-quit').addEventListener('click', function () { doAction('quit'); });

    /* 聊天 */
    $('chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = $('chat-input').value.trim();
      if (!v) return;
      if (S.mode !== 'online') return toast('單機模式沒有聊天室。');
      Online.send('room:chat', { text: v });
      $('chat-input').value = '';
    });

    /* 設定彈窗 */
    $('b-settings').addEventListener('click', function () { openModal('settings-modal'); });
    $('b-settings-close').addEventListener('click', function () { closeModal('settings-modal'); });
    $('b-settings-ok').addEventListener('click', function () { closeModal('settings-modal'); });
    $('set-music').addEventListener('change', function () { Sound.setMusic(this.checked); });
    $('set-sfx').addEventListener('change', function () { Sound.setSfx(this.checked); });
    $('set-chatcue').addEventListener('change', function () { Sound.setChatCue(this.checked); });
    $('set-haptic').addEventListener('change', function () { Sound.setHaptic(this.checked); Sound.vibrate(15); });
    $('set-music-vol').addEventListener('input', function () { Sound.setMusicVolume(this.value / 100); });
    $('set-sfx-vol').addEventListener('change', function () { Sound.setSfxVolume(this.value / 100); Sound.play('click'); });
    $('set-motion').addEventListener('change', function () { Store.reduceMotion(this.checked); applyDisplayPrefs(); });
    $('set-mark').addEventListener('change', function () { Store.bigMark(this.checked); applyDisplayPrefs(); });
    $('set-hammer').addEventListener('change', function () { Store.hammerCursor(this.checked); applyDisplayPrefs(); });
    $('b-server-save').addEventListener('click', function () {
      var res = Config.setServerUrl($('set-server-url').value);
      if (!res.ok) return toast(res.error || '網址格式不對，請填完整的 https:// 網址。', 3600);
      toast(res.cleared ? '已清除自訂位址，重新載入中…' : '已存好，重新載入中…', 1400);
      setTimeout(function () { w.location.reload(); }, 900);
    });
    $('b-settings-reset').addEventListener('click', function () {
      Sound.resetDefaults(); Store.resetDefaults(); applyDisplayPrefs(); syncSettingsUi();
      toast('已恢復預設設定。');
    });

    /* 邀請彈窗 */
    $('b-invite-close').addEventListener('click', function () { closeModal('invite-modal'); });
    $('b-invite-done').addEventListener('click', function () { closeModal('invite-modal'); });
    $('b-invite-make').addEventListener('click', makeInvite);
    $('b-invite-copy').addEventListener('click', function () { copyText($('invite-url').value); });

    /* 戰績 */
    $('b-stats-reset').addEventListener('click', function () {
      if (!w.confirm('確定要清除這台裝置上的戰績嗎？')) return;
      try {
        localStorage.removeItem(Store.KEY.stats);
        localStorage.removeItem(Store.KEY.best);
      } catch (err) {}
      paintStats();
      toast('戰績已清除。');
    });

    /* 選項卡片（單機難度／對手數量） */
    ['opt-ai', 'opt-aicount', 'opt-board'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        var c = e.target.closest('.pickcard');
        if (!c) return;
        els('.pickcard', this).forEach(function (x) { x.setAttribute('aria-checked', String(x === c)); });
        if (id === 'opt-ai') Store.aiLevel(c.dataset.v);
        else if (id === 'opt-aicount') Store.aiCount(c.dataset.v);
        else Store.board(c.dataset.v);
        Sound.play('tick');
      });
    });

    /* 轉向／改變視窗大小時，盤面重挑一次排法（洞數不變，只是換排列） */
    w.addEventListener('resize', function () { SvgUI.repaintAll(); Board.relayout(); });
  }

  function paintSoloOptions() {
    var lv = Store.aiLevel();
    $('opt-ai').innerHTML = AI.ORDER.map(function (k) {
      var L = AI.levelOf(k);
      return '<button class="pickcard" type="button" role="radio" data-v="' + k + '"'
        + ' aria-checked="' + (k === lv) + '"><b>' + L.emoji + ' ' + L.label + '</b><span>'
        + esc(L.blurb) + '</span></button>';
    }).join('');
    var cnt = String(Store.aiCount());
    els('#opt-aicount .pickcard').forEach(function (c) {
      c.setAttribute('aria-checked', String(c.dataset.v === cnt));
    });

    var bd = Rules.boardOf(Store.board()).key;
    $('opt-board').innerHTML = Rules.BOARDS.map(function (b) {
      return '<button class="pickcard" type="button" role="radio" data-v="' + b.key + '"'
        + ' aria-checked="' + (b.key === bd) + '"><b>' + esc(b.label) + '</b><span>'
        + esc(b.note) + '</span></button>';
    }).join('');
  }

  function paintStats() {
    var s = Store.stats(), b = Store.best();
    var cells = [
      ['單機勝', s.solo.win], ['單機敗', s.solo.lose],
      ['線上勝', s.online.win], ['線上敗', s.online.lose],
      ['最高分', b.score || 0], ['最長連擊', b.combo || 0],
      ['最佳命中率', Math.round((b.accuracy || 0) * 100) + '%']
    ];
    $('stat-grid').innerHTML = cells.map(function (c) {
      return '<div class="statcard"><b>' + c[1] + '</b><span>' + c[0] + '</span></div>';
    }).join('');
  }

  /* ------------------------------------------------------------ 線上事件 */

  function bindOnline() {
    Online.on('status', connStatus);
    Online.on('hello', function (res) {
      /* 單程延遲忽略不計：50ms 的 tick 對打地鼠的手感綽綽有餘 */
      if (res && res.serverTime) S.clockOffset = res.serverTime - Date.now();
    });
    Online.on('lobby:rooms', paintRoomList);
    Online.on('room:sync', onSync);
    Online.on('room:events', function (p) {
      if (!p || !p.events) return;
      for (var i = 0; i < p.events.length; i++) applyEventToSnap(S.match, p.events[i]);
      handleEvents(p.events, srvNow());
    });
    Online.on('room:chat', function (p) {
      if (!S.view) return;
      S.view.chat = (S.view.chat || []).concat([p.message]).slice(-40);
      paintChat(S.view.chat);
    });
    Online.on('room:error', function (p) { toast(p.message || '操作失敗'); });
    Online.on('room:closed', function (p) { toast(p.reason || '房間已關閉'); leaveGame(); });
    Online.on('room:left', function () { Sound.play('leave'); });
    Online.on('reconnected', function () {
      if (S.mode === 'online' && S.view) {
        Online.send('room:join', { code: S.view.code, name: S.name });
      }
    });
  }

  /* ------------------------------------------------------------ 啟動 */

  function boot() {
    SvgUI.bgDeco($('bgdeco'));
    $('logo').innerHTML = SvgUI.logo();
    buildDex();
    SvgUI.decorateAll();
    applyDisplayPrefs();
    bindUi();
    bindOnline();
    setPane('sum');

    Board.mount($('board'), $('fx'), Rules.HOLES, function (hole, moleId) {
      if (S.mode === 'solo') {
        if (!S.solo.state) return;
        var res = Rules.whack(S.solo.state, 'me', { hole: hole, moleId: moleId }, Date.now());
        if (res.ok) { S.match = Rules.snapshot(S.solo.state, Date.now()); handleEvents([res.event], Date.now()); }
        return;
      }
      if (S.mode === 'online') {
        if (!S.view || !S.view.you.can.whack) return;
        /* 先給一點手感回饋，真正的判定結果等伺服器的 room:events */
        Sound.play('tick');
        Online.send('room:whack', { hole: hole, moleId: moleId || 0 });
      }
    });

    /* 記住上次的暱稱 */
    var nick = Store.nick();
    $('solo-nick').value = nick;
    $('lobby-nick').value = nick;
    S.name = nick || '玩家';

    /* 沒有伺服器就把線上入口降級成提示，而不是點了沒反應 */
    if (!Config.isOnlineEnabled()) {
      $('b-online').addEventListener('click', function () {
        toast(Config.error || '這份頁面沒有連到遊戲伺服器，只能玩單機。用 npm start 啟動伺服器後再開一次。', 4200);
      }, true);
    }

    /* 邀請連結：?room=XXXXX&invite=token */
    var entry = Config.entry();
    if (entry.room && Config.isOnlineEnabled()) {
      show('s-lobby');
      $('join-code').value = entry.room;
      connect().then(function () {
        if (!entry.invite) return joinRoom(entry.room);
        Online.send('invite:check', { code: entry.room, token: entry.invite }, function (res) {
          if (!res || !res.ok) return toast((res && res.error) || '這個邀請連結不能用了。', 4200);
          if (res.note) toast(res.note, 3800);
          joinRoom(entry.room, entry.invite, res.role);
        });
      }).catch(function () {});
    }

    /* 分頁切回來時補一次同步，避免長時間背景後畫面對不上 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || S.mode !== 'online' || !S.view) return;
      Online.send('room:join', { code: S.view.code, name: S.name });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  w.WAM = { S: S, srvNow: srvNow };
}(window));
