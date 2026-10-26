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
    drewOver: false,        // 結算後已經補畫過最後一幀了沒
    joinIntent: null
  };

  function srvNow() { return Date.now() + S.clockOffset; }

  /* ------------------------------------------------------------ 小工具 */

  var toastTimer = 0;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = w.I18N.message(msg);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }


  /** Bot display names follow the interface language; human names remain untouched. */
  function playerName(player) {
    if (!player || (!player.ai && !player.level)) return player ? player.name : '';
    var index = player.nameIdx == null ? 0 : player.nameIdx;
    var name = w.I18N.t('ai.name.' + index);
    return name + ' (' + w.I18N.t('pace.' + (player.ai || player.level) + '.label') + ')';
  }

  function colorHex(key) { return Rules.PLAYER_COLOR_HEX[key] || '#A48FDB'; }

  function show(id) {
    if (w.ServerOutage) w.ServerOutage.setScreen(id);
    els('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    S.screen = id;
    if (id !== 's-game' && w.NetworkLatency) w.NetworkLatency.setActive(false);
    if (w.NetworkLatency) w.NetworkLatency.setActive(id === 's-game' && S.mode === 'online' && !!S.view && S.view.phase === 'playing');
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
      + '<div class="pt">' + (t.points > 0 ? '+' : '') + t.points + (globalThis.I18N ? globalThis.I18N.t("text.124") : " 分")
      + (t.hp > 1 ? (globalThis.I18N ? globalThis.I18N.t("text.123") : "・要 ") + t.hp + (globalThis.I18N ? globalThis.I18N.t("text.122") : " 下") : '') + '</div>'
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
  var pendingConfirm = null;

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
    if (id === 'confirm-modal') pendingConfirm = null;
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

  function askConfirm(title, message, onConfirm) {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    pendingConfirm = onConfirm;
    openModal('confirm-modal');
    $('b-confirm-ok').focus();
  }

  function cancelConfirm() {
    closeModal('confirm-modal');
  }

  function acceptConfirm() {
    var onConfirm = pendingConfirm;
    pendingConfirm = null;
    closeModal('confirm-modal');
    if (onConfirm) onConfirm();
  }

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
    $('set-audio-note').textContent = Sound.isUnlocked()
      ? '' : (globalThis.I18N ? globalThis.I18N.t("text.121") : "瀏覽器規定要先碰一下畫面才會出聲，按任何一顆按鈕就會解鎖。");
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

      if (ev.k === 'go') { Sound.play('start'); Board.shout((globalThis.I18N ? globalThis.I18N.t("text.120") : "開始！"), 'go'); continue; }

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
          if (mine && ev.type === 'rainbow') { Sound.play('buff', 0.15); Board.shout((globalThis.I18N ? globalThis.I18N.t("text.119") : "分數加倍 6 秒！"), 'buff', 1100); }
        } else {
          Sound.play(t.hp > 1 ? 'smash' : 'bonk');
          if (mine) Sound.vibrate(t.hp > 1 ? [14, 24, 20] : 12);
        }
        if (mine && ev.combo && ev.combo % Rules.COMBO_STEP === 0) {
          Sound.play('combo');
          Board.shout(ev.combo + (globalThis.I18N ? globalThis.I18N.t("text.118") : " 連擊！"), 'combo', 800);
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

  /* 單機設定頁同時是「直接開打」和「建立房間」的共同設定來源。
     秒數沒有手動選過時保留伺服器預設，明確選過才把值帶進新房間。 */
  function localGameSettings() {
    var rawRoundSec = Number(Store.roundSec());
    return {
      pace: AI.levelOf(Store.aiLevel()).key,
      board: Rules.boardOf(Store.board()).key,
      roundSec: Rules.ROUND_SECONDS.indexOf(rawRoundSec) >= 0 ? rawRoundSec : null
    };
  }

  function startSolo() {
    var settings = localGameSettings();
    var level = settings.pace;
    var count = Number(Store.aiCount()) || 0;
    var seed = RNG.randomSeed();
    var now = Date.now();

    var roster = [{ id: 'me', name: S.name || (globalThis.I18N ? globalThis.I18N.t("text.023") : "我") }];
    S.solo.brains = {};
    S.solo.ids = ['me'];
    for (var i = 0; i < count; i++) {
      var id = 'ai:' + i;
      roster.push({ id: id, name: AI.aiName(level, i), ai: level, nameIdx: i });
      S.solo.brains[id] = AI.createBrain(level, 'solo:' + seed + ':' + i);
      S.solo.ids.push(id);
    }

    S.mode = 'solo';
    S.clockOffset = 0;
    S.view = null;
    /* 同一個難度同時決定地鼠節奏與電腦對手強弱 —— 玩家只要選一次 */
    S.solo.state = Rules.createMatch({ seed: seed, players: roster, now: now,
      board: settings.board, pace: settings.pace, roundMs: Rules.roundMsOf(settings.roundSec) });
    S.solo.rng = RNG.createRng('spawn:solo:' + seed);
    S.match = Rules.snapshot(S.solo.state, now);
    GameAnalytics.start({ mode: 'solo', difficulty: level, players: roster.length });
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
    document.body.classList.remove('playing');
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
    document.body.classList.remove('playing');
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
      /* 結算之後盤面是靜止的（地鼠都收掉了），只再畫一次把最後一隻清乾淨，
         之後就不必每一幀重畫 —— 大家常常停在結算畫面聊天，手機省一點電。
         下一局進倒數時 phase 就不是 over 了，會自動恢復每幀重畫。 */
      if (S.match) {
        var still = S.match.phase === 'over';
        if (!still || !S.drewOver) { Board.draw(S.match, now); S.drewOver = still; }
      }
      /* DOM 更新壓在 ~12fps，省電也避免手機掉幀 */
      if (now - S.lastPaint > 80) { S.lastPaint = now; paintHud(); paintSummary(); paintPlayingFlag(); }
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

  /* 還沒開打（線上房間等待中）的 HUD：秒數要顯示這一局實際會有多長，
     不能留著 HTML 裡的預設值騙人。 */
  function paintIdleHud() {
    var v = S.view;
    var sec = v && v.roundSec ? v.roundSec : Rules.roundSecOf(Store.roundSec());
    $('hud-clock').textContent = sec;
    $('hud-time').classList.remove('low');
    $('hud-stage').textContent = (globalThis.I18N ? globalThis.I18N.t("text.117") : "準備中");
    $('hud-stage').className = 'hud-stage';
    $('hud-score').textContent = '0';
    $('hud-combo').hidden = true;
    $('hud-buff').hidden = true;
    $('timebar-fill').style.width = '100%';
    $('timebar-fill').className = '';
    $('countdown').hidden = true;
  }

  function paintHud() {
    var m = S.match;
    if (!m) { paintIdleHud(); return; }
    var over = m.phase === 'over';
    var sec = Math.ceil(m.remainMs / 1000);
    var clock = $('hud-clock');
    if (clock.textContent !== String(sec)) clock.textContent = sec;
    $('hud-time').classList.toggle('low', m.phase === 'playing' && sec <= 10);
    if (m.phase === 'playing' && sec <= 10 && !S.warned) { S.warned = true; Sound.play('warn'); }

    var st = $('hud-stage');
    /* 「第 N 階段・」包成 span：窄螢幕用 CSS 收起來，HUD 才排得下一行 */
    st.innerHTML = over ? (globalThis.I18N ? globalThis.I18N.t("text.071") : "時間到")
      : (globalThis.I18N ? globalThis.I18N.t("text.116") : "<span class=\"stage-no\">第 ") + m.stage.no + (globalThis.I18N ? globalThis.I18N.t("text.115") : " 階段・</span>") + esc(w.I18N.t('stage.' + m.stage.no));
    st.className = 'hud-stage' + (!over && m.stage.no > 1 ? ' s' + m.stage.no : '');
    if (m.phase === 'playing' && m.stage.no !== S.lastStage) {
      if (S.lastStage) { Sound.play('stage'); Board.shout(w.I18N.t('stage.' + m.stage.no) + (globalThis.I18N ? globalThis.I18N.t("text.114") : "！地鼠變快了"), 'stage', 1100); }
      S.lastStage = m.stage.no;
    }

    var fill = $('timebar-fill');
    fill.style.width = (m.remainMs / (m.endAt - m.startAt) * 100).toFixed(1) + '%';
    fill.className = m.stage.no > 1 ? 's' + m.stage.no : '';

    var me = myRow();
    $('hud-score').textContent = me ? me.score : 0;
    var cb = $('hud-combo');
    if (!over && me && me.combo >= 2) { cb.hidden = false; $('hud-combo-n').textContent = me.combo; }
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

  /* 線上房間還在等待時，摘要頁本來是空白的一格虛線框。
     房號、身分、座位、這一局的設定和目前有誰，全部先列出來，
     手機從抽屜看也一樣清楚。 */
  function paintLobbySummary() {
    var v = S.view;
    if (S.mode !== 'online' || !v) return;
    var you = v.you;
    var role = you.role === 'player' ? (globalThis.I18N ? globalThis.I18N.t("text.003") : "玩家") : (you.role === 'spectator' ? (globalThis.I18N ? globalThis.I18N.t("text.034") : "觀戰") : (globalThis.I18N ? globalThis.I18N.t("text.110") : "訪客"));
    $('sum-room').innerHTML = '<b>' + esc(v.code) + '</b>　' + role + (you.host ? (globalThis.I18N ? globalThis.I18N.t("text.109") : "・房主") : '')
      + '　' + (v.seats - v.seatsFree) + '/' + v.seats + (globalThis.I18N ? globalThis.I18N.t("text.108") : " 人");

    var rows = [];
    v.members.filter(function (mm) { return mm.role === 'player'; }).forEach(function (mm, i) {
      rows.push({
        name: mm.name, hex: colorHex(Rules.PLAYER_COLORS[i % 5]), me: mm.id === you.id,
        get tag() { return mm.connected === false ? (globalThis.I18N ? globalThis.I18N.t("text.113") : "斷線") : (mm.ready ? (globalThis.I18N ? globalThis.I18N.t("text.094") : "準備好") : (globalThis.I18N ? globalThis.I18N.t("text.093") : "還沒準備")); }
      });
    });
    (v.ai || []).forEach(function (a) { rows.push({ name: playerName(a), hex: '#C8BFD1', get tag() { return globalThis.I18N ? globalThis.I18N.t("text.112") : "電腦"; } }); });
    v.members.filter(function (mm) { return mm.role === 'spectator'; }).forEach(function (mm) {
      rows.push({ name: mm.name, hex: '#C8BFD1', me: mm.id === you.id, get tag() { return globalThis.I18N ? globalThis.I18N.t("text.034") : "觀戰"; } });
    });
    $('rank-list').innerHTML = rows.map(function (r, i) {
      return '<li class="rankrow' + (r.me ? ' me' : '') + '" style="--who:' + r.hex + '">'
        + '<span class="no">' + (i + 1) + '</span>'
        + '<span class="nm">' + esc(r.name) + '</span>'
        + '<span class="sc"><small>' + esc(r.tag) + '</small></span>'
        + '</li>';
    }).join('');

    var bd = Rules.boardOf(v.board);
    $('my-stat').textContent = (globalThis.I18N ? globalThis.I18N.t("text.087") : "一局 ") + v.roundSec + (globalThis.I18N ? globalThis.I18N.t("text.086") : " 秒・難度「") + Rules.paceOf(v.pace).label
      + (globalThis.I18N ? globalThis.I18N.t("text.085") : "」・盤面 ") + bd.label + '（' + bd.holes + (globalThis.I18N ? globalThis.I18N.t("text.111") : " 洞）");
    $('live-bar').innerHTML = '';
    $('live-bar').dataset.html = '';
    paintSideActions();
  }

  function paintSummary() {
    var m = S.match;
    if (!m) { paintLobbySummary(); return; }

    /* 一行帶完房間／模式資訊 */
    var room = $('sum-room');
    if (S.mode === 'online' && S.view) {
      var you = S.view.you;
      var role = you.role === 'player' ? (globalThis.I18N ? globalThis.I18N.t("text.003") : "玩家") : (you.role === 'spectator' ? (globalThis.I18N ? globalThis.I18N.t("text.034") : "觀戰") : (globalThis.I18N ? globalThis.I18N.t("text.110") : "訪客"));
      room.innerHTML = '<b>' + esc(S.view.code) + '</b>　' + role + (you.host ? (globalThis.I18N ? globalThis.I18N.t("text.109") : "・房主") : '')
        + '　' + (S.view.seats - S.view.seatsFree) + '/' + S.view.seats + (globalThis.I18N ? globalThis.I18N.t("text.108") : " 人");
    } else {
      room.innerHTML = (globalThis.I18N ? globalThis.I18N.t("text.107") : "單機・") + esc(AI.levelOf(Store.aiLevel()).label)
        + (globalThis.I18N ? globalThis.I18N.t("text.106") : "・對手 ") + (S.solo.ids.length - 1) + (globalThis.I18N ? globalThis.I18N.t("text.105") : " 個");
    }

    /* 即時排行：名次、名字、分數。連擊只在真的有連擊時用小字帶出來。 */
    var me = meId();
    $('rank-list').innerHTML = m.standings.map(function (p) {
      return '<li class="rankrow' + (p.id === me ? ' me' : '') + '" style="--who:' + colorHex(p.color) + '">'
        + '<span class="no">' + p.rank + '</span>'
        + '<span class="nm">' + esc(playerName(p)) + '</span>'
        + '<span class="sc">' + p.score
        + (p.combo >= 2 ? '<small>' + p.combo + (globalThis.I18N ? globalThis.I18N.t("text.104") : " 連</small>") : '') + '</span>'
        + '</li>';
    }).join('');

    /* 窄版（手機、平板直向）盤面等比縮放後周圍會留白，把即時排行貼在那裡：
       打到一半不用開抽屜也知道誰領先。寬版有固定側欄，CSS 會把它藏起來。 */
    var lb = $('live-bar');
    /* 只有自己一個人在打（單機不加對手）時 HUD 已經有分數了，浮條就免了；
       觀戰的人自己不在排行裡，所以看到誰都要顯示。 */
    var showLive = m.standings.length > 1 || !m.standings.some(function (p) { return p.id === me; });
    var lbHtml = showLive
      ? m.standings.slice(0, 5).map(function (p) {
        return '<span class="lchip' + (p.id === me ? ' me' : '') + '" style="--who:' + colorHex(p.color) + '">'
          + '<b>' + p.rank + '</b><span class="ln">' + esc(playerName(p)) + '</span><i>' + p.score + '</i></span>';
      }).join('')
      : '';
    if (lb.dataset.html !== lbHtml) { lb.dataset.html = lbHtml; lb.innerHTML = lbHtml; }

    /* 我的表現：一行就好，分數已經在 HUD 上了 */
    var r = myRow();
    $('my-stat').textContent = r
      ? (globalThis.I18N ? globalThis.I18N.t("text.103") : "命中 ") + r.hits + (globalThis.I18N ? globalThis.I18N.t("text.069") : "・誤敲 ") + r.goodHits + (globalThis.I18N ? globalThis.I18N.t("text.102") : "・準度 ") + Math.round((r.accuracy || 0) * 100) + '%'
        + (r.bestCombo >= 2 ? (globalThis.I18N ? globalThis.I18N.t("text.068") : "・最佳連擊 ") + r.bestCombo : '')
      : (globalThis.I18N ? globalThis.I18N.t("text.101") : "觀戰中，看得到完整盤面");

    /* 彩虹加倍剩餘時間顯示在 HUD 上 */
    var refNow = S.mode === 'solo' ? Date.now() : srvNow();
    var buffLeft = m.phase === 'playing' && r && r.buffUntil ? Math.max(0, r.buffUntil - refNow) : 0;
    $('hud-buff').hidden = buffLeft <= 0;
    if (buffLeft > 0) $('hud-buff').textContent = (globalThis.I18N ? globalThis.I18N.t("text.100") : "🌈 加倍中 ") + Math.ceil(buffLeft / 1000) + 's';

    paintSideActions();
  }

  function paintSideActions() {
    var box = $('side-actions');
    var html = '';
    if (S.mode === 'online' && S.view) {
      var can = S.view.you.can || {};
      if (can.invite) html += (globalThis.I18N ? globalThis.I18N.t("text.099") : "<button class=\"btn3d\" data-color=\"sky\" data-act=\"invite\">🔗 邀請</button>");
      if (can.sit) html += (globalThis.I18N ? globalThis.I18N.t("text.062") : "<button class=\"btn3d\" data-color=\"mint\" data-act=\"sit\">下場對戰</button>");
      if (can.stand) html += (globalThis.I18N ? globalThis.I18N.t("text.061") : "<button class=\"btn3d\" data-color=\"cream\" data-act=\"stand\">改成觀戰</button>");
    }
    html += (globalThis.I18N ? globalThis.I18N.t("text.098") : "<button class=\"btn3d\" data-color=\"cream\" data-act=\"quit\">離開</button>");
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

    $('ov-wait-title').textContent = (globalThis.I18N ? globalThis.I18N.t("text.097") : "準備開始・房號 ") + v.code;

    var seats = [];
    v.members.filter(function (m) { return m.role === 'player'; }).forEach(function (m, i) {
      seats.push('<div class="seatrow" style="--who:' + colorHex(Rules.PLAYER_COLORS[i % 5]) + '">'
        + '<span class="nm">' + esc(m.name) + '</span>'
        + (m.host ? (globalThis.I18N ? globalThis.I18N.t("text.096") : "<span class=\"tag host\">房主</span>") : '')
        + (m.connected ? '' : (globalThis.I18N ? globalThis.I18N.t("text.095") : "<span class=\"tag off\">斷線</span>"))
        + '<span class="tag' + (m.ready ? ' ready' : '') + '">' + (m.ready ? (globalThis.I18N ? globalThis.I18N.t("text.094") : "準備好") : (globalThis.I18N ? globalThis.I18N.t("text.093") : "還沒準備")) + '</span>'
        + '</div>');
    });
    v.ai.forEach(function (a) {
      seats.push('<div class="seatrow" style="--who:#C8BFD1">'
        + '<span class="nm">' + esc(playerName(a)) + (globalThis.I18N ? globalThis.I18N.t("text.092") : "</span><span class=\"tag ai\">電腦</span>")
        + (v.you.can.manageAi ? '<button class="x" data-rmai="' + esc(a.id) + (globalThis.I18N ? globalThis.I18N.t("text.091") : "\" aria-label=\"移除 ") + esc(playerName(a)) + '">✕</button>' : '')
        + '</div>');
    });
    var specs = v.members.filter(function (m) { return m.role === 'spectator'; });
    if (specs.length) {
      seats.push((globalThis.I18N ? globalThis.I18N.t("text.090") : "<div class=\"seatrow\" style=\"--who:#C8BFD1\"><span class=\"nm\">觀戰 ")
        + specs.length + (globalThis.I18N ? globalThis.I18N.t("text.089") : " 人：") + esc(specs.map(function (m) { return m.name; }).join('、')) + '</span></div>');
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
    $('round-manage').hidden = !v.you.can.setRound;
    if (v.you.can.setRound) {
      $('round-pick').innerHTML = (v.rounds || []).map(function (sec) {
        var on = sec === v.roundSec;
        return '<button class="btn3d" data-color="' + (on ? 'mint' : 'cream') + '"'
          + ' data-setround="' + sec + '" role="radio" aria-checked="' + on + '">'
          + sec + (globalThis.I18N ? globalThis.I18N.t("text.088") : " 秒</button>");
      }).join('');
      SvgUI.decorateAll($('round-pick'));
    }

    $('pace-manage').hidden = !v.you.can.setPace;
    if (v.you.can.setPace) {
      $('pace-pick').innerHTML = (v.paces || []).map(function (P) {
        var on = P.key === v.pace;
        return '<button class="btn3d" data-color="' + (on ? 'mint' : 'cream') + '"'
          + ' data-setpace="' + esc(P.key) + '" role="radio" aria-checked="' + on + '"'
          + ' title="' + esc(w.I18N.t('pace.' + P.key + '.blurb')) + '">' + P.emoji + ' ' + esc(w.I18N.t('pace.' + P.key + '.label')) + '</button>';
      }).join('');
      SvgUI.decorateAll($('pace-pick'));
    }

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
    note.push((globalThis.I18N ? globalThis.I18N.t("text.087") : "一局 ") + v.roundSec + (globalThis.I18N ? globalThis.I18N.t("text.086") : " 秒・難度「") + Rules.paceOf(v.pace).label + (globalThis.I18N ? globalThis.I18N.t("text.085") : "」・盤面 ") + bd.label + '（' + bd.holes + (globalThis.I18N ? globalThis.I18N.t("text.084") : " 個地洞）。"));
    note.push((globalThis.I18N ? globalThis.I18N.t("text.083") : "座位 ") + (v.seats - v.seatsFree) + '/' + v.seats + (globalThis.I18N ? globalThis.I18N.t("text.082") : "，最多 ") + v.seats + (globalThis.I18N ? globalThis.I18N.t("text.081") : " 人共用同一組地洞。"));
    if (v.you.role === 'spectator') note.push((globalThis.I18N ? globalThis.I18N.t("text.080") : "你目前是觀戰身分。"));
    if (v.you.startBlockedBy) note.push(w.I18N.message(v.you.startBlockedBy));
    $('ov-wait-note').textContent = note.join(' ');

    var btns = '';
    if (v.you.can.ready) {
      btns += '<button class="btn3d big" data-color="' + (v.you.ready ? 'cream' : 'mint') + '" data-act="ready">'
        + (v.you.ready ? (globalThis.I18N ? globalThis.I18N.t("text.079") : "取消準備") : (globalThis.I18N ? globalThis.I18N.t("text.078") : "✔ 準備好了")) + '</button>';
    }
    if (v.you.host) {
      btns += '<button class="btn3d big" data-color="grape" data-act="start"'
        + (v.you.can.start ? '' : ' disabled') + (globalThis.I18N ? globalThis.I18N.t("text.077") : ">▶ 開始這一局</button>");
    }
    if (v.you.can.sit) btns += (globalThis.I18N ? globalThis.I18N.t("text.062") : "<button class=\"btn3d\" data-color=\"mint\" data-act=\"sit\">下場對戰</button>");
    if (v.you.can.stand) btns += (globalThis.I18N ? globalThis.I18N.t("text.061") : "<button class=\"btn3d\" data-color=\"cream\" data-act=\"stand\">改成觀戰</button>");
    if (v.you.can.invite) btns += (globalThis.I18N ? globalThis.I18N.t("text.076") : "<button class=\"btn3d\" data-color=\"sky\" data-act=\"invite\">🔗 邀請朋友</button>");
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
    GameAnalytics.end({ result: m.draw ? 'draw' : (iWon ? 'win' : 'lose') });
    $('ov-result-title').textContent = m.draw
      ? (globalThis.I18N ? globalThis.I18N.t("text.075") : "平手！") + champs.map(function (p) { return playerName(p); }).join('、') + (globalThis.I18N ? globalThis.I18N.t("text.074") : " 同分")
      : (iWon ? (globalThis.I18N ? globalThis.I18N.t("text.073") : "你贏了！") : (champs[0] ? champs[0].name + (globalThis.I18N ? globalThis.I18N.t("text.072") : " 獲勝") : (globalThis.I18N ? globalThis.I18N.t("text.071") : "時間到")));

    $('result-table').innerHTML = m.standings.map(function (p) {
      return '<div class="resrow' + (p.rank === 1 ? ' win' : '') + '" style="--who:' + colorHex(p.color) + '">'
        + '<span class="no">' + p.rank + '</span>'
        + '<span class="nm">' + esc(playerName(p))
        + (globalThis.I18N ? globalThis.I18N.t("text.070") : "<small>敲中 ") + p.hits + (globalThis.I18N ? globalThis.I18N.t("text.069") : "・誤敲 ") + p.goodHits + (globalThis.I18N ? globalThis.I18N.t("text.068") : "・最佳連擊 ") + p.bestCombo
        + (globalThis.I18N ? globalThis.I18N.t("text.067") : "・命中率 ") + Math.round((p.accuracy || 0) * 100) + '%</small></span>'
        + '<span class="sc">' + p.score + '</span></div>';
    }).join('');

    var btns = '';
    if (S.mode === 'solo') {
      btns += (globalThis.I18N ? globalThis.I18N.t("text.066") : "<button class=\"btn3d big\" data-color=\"mint\" data-act=\"again\">🔁 再玩一次</button>")
        + (globalThis.I18N ? globalThis.I18N.t("text.065") : "<button class=\"btn3d\" data-color=\"cream\" data-act=\"quit\">回主選單</button>");
    } else if (S.view) {
      var v = S.view;
      if (v.you.can.rematch) {
        btns += (globalThis.I18N ? globalThis.I18N.t("text.064") : "<button class=\"btn3d big\" data-color=\"mint\" data-act=\"rematch\">🔁 再來一局（")
          + v.rematch.votes + '/' + v.rematch.need + '）</button>';
      }
      if (v.you.can.reset) btns += (globalThis.I18N ? globalThis.I18N.t("text.063") : "<button class=\"btn3d\" data-color=\"sky\" data-act=\"reset\">回房間調整</button>");
      /* 觀戰的人看完結算最想做的事就是下場打下一局，按鈕直接放在這裡 */
      if (v.you.can.sit) btns += (globalThis.I18N ? globalThis.I18N.t("text.062") : "<button class=\"btn3d\" data-color=\"mint\" data-act=\"sit\">下場對戰</button>");
      if (v.you.can.stand) btns += (globalThis.I18N ? globalThis.I18N.t("text.061") : "<button class=\"btn3d\" data-color=\"cream\" data-act=\"stand\">改成觀戰</button>");
      btns += (globalThis.I18N ? globalThis.I18N.t("text.060") : "<button class=\"btn3d\" data-color=\"cream\" data-act=\"quit\">離開房間</button>");
    }
    $('ov-result-btns').innerHTML = btns;
    SvgUI.decorateAll($('ov-result-btns'));
    $('ov-result').hidden = false;
  }

  /* ============================================================
   * 線上模式
   * ============================================================ */

  function connStatus(st) {
    S.connection = st;
    var dot = $('conn-dot'), txt = $('conn-text');
    var map = {
      idle: ['', (globalThis.I18N ? globalThis.I18N.t("text.059") : "尚未連線")], loading: ['warn', (globalThis.I18N ? globalThis.I18N.t("text.058") : "正在載入連線程式…")],
      connecting: ['warn', (globalThis.I18N ? globalThis.I18N.t("text.057") : "連線中…（免費方案冷啟動可能要十幾秒）")],
      connected: ['ok', (globalThis.I18N ? globalThis.I18N.t("text.056") : "已連上 ") + Config.describe()],
      error: ['bad', (st.key ? w.I18N.message(st) : st.message) || (globalThis.I18N ? globalThis.I18N.t("text.055") : "連線失敗")],
      offline: ['bad', (st.key ? w.I18N.message(st) : st.message) || (globalThis.I18N ? globalThis.I18N.t("text.054") : "沒有可用的伺服器，只能玩單機")]
    };
    var m = map[st.status] || ['', st.status];
    dot.className = 'dot ' + m[0];
    txt.textContent = m[1];
    $('b-reconnect').hidden = !(st.status === 'error' || st.status === 'offline');
  }

  function connect() {
    S.name = ($('lobby-nick').value || Store.nick() || '').trim() || (globalThis.I18N ? globalThis.I18N.t("text.003") : "玩家");
    Store.nick(S.name);
    return Online.connect({ clientId: S.clientId, name: S.name })
      .then(function () {
        Online.send('lobby:subscribe', {});
        return true;
      })
      .catch(function (err) { toast((err.key ? w.I18N.message(err) : err.message) || (globalThis.I18N ? globalThis.I18N.t("text.053") : "連不上伺服器")); throw err; });
  }

  function paintRoomList(payload) {
    S.roomList = payload;
    $('rooms-count').textContent = payload.total || 0;
    var list = payload.rooms || [];
    if (!list.length) {
      $('room-list').innerHTML = (globalThis.I18N ? globalThis.I18N.t("text.052") : "<div class=\"empty\">目前沒有公開房間。按上面的「建立房間」開一間，把房號或邀請連結給朋友就好。</div>");
      return;
    }
    $('room-list').innerHTML = list.map(function (r) {
      var tag = r.phase === 'playing' || r.phase === 'countdown' ? (globalThis.I18N ? globalThis.I18N.t("text.051") : "<span class=\"tag playing\">對戰中</span>")
        : (r.phase === 'over' ? (globalThis.I18N ? globalThis.I18N.t("text.050") : "<span class=\"tag over\">剛打完</span>") : (globalThis.I18N ? globalThis.I18N.t("text.049") : "<span class=\"tag\">等待中</span>"));
      return '<div class="roomrow">'
        + '<span class="rname">' + esc(r.name) + (globalThis.I18N ? globalThis.I18N.t("text.048") : "<small>房號 ") + esc(r.code) + '</small></span>'
        + tag
        + (globalThis.I18N ? globalThis.I18N.t("text.047") : "<span class=\"rmeta\">玩家 ") + (r.players + r.ai) + '/' + r.seats
        + (r.spectators ? (globalThis.I18N ? globalThis.I18N.t("text.046") : "・觀戰 ") + r.spectators : '') + '</span>'
        + '<button class="btn3d small" data-color="mint" data-joincode="' + esc(r.code) + '">'
        + (r.seatsFree > 0 && r.phase !== 'playing' ? (globalThis.I18N ? globalThis.I18N.t("text.045") : "加入") : (globalThis.I18N ? globalThis.I18N.t("text.034") : "觀戰")) + '</button>'
        + '</div>';
    }).join('');
    SvgUI.decorateAll($('room-list'));
  }

  function joinRoom(code, token, role) {
    return connect().then(function () {
      /* 先認定自己要進線上模式：同步包有可能比 ack 早到，
         晚設會讓第一包同步被 onSync 的守門丟掉。 */
      S.mode = 'online';
      return new Promise(function (resolve) {
        Online.send('room:join', { code: code, name: S.name, token: token || null, role: role || null }, function (res) {
          if (!res || !res.ok) {
            if (!S.view) S.mode = null;
            toast((res && (res.key ? w.I18N.message(res) : w.I18N.message(res.error))) || (globalThis.I18N ? globalThis.I18N.t("text.044") : "加入失敗"));
            return resolve(false);
          }
          S.mode = 'online';
          if (res.downgraded) toast((globalThis.I18N ? globalThis.I18N.t("text.043") : "玩家席位已滿，你先以觀戰身分進來了。"), 3600);
          else if (res.waiting) toast((globalThis.I18N ? globalThis.I18N.t("text.042") : "這局已經開打，你先觀戰，下一局就能下場。"), 3600);
          else if (res.note) toast(res.note, 3600);
          Sound.play('join');
          resolve(true);
        });
      });
    }).catch(function () { return false; });
  }

  /* 邀請連結的進場流程。自動進場與「加入房間」按鈕共用同一份，
     這樣先取名字再進來也帶得到邀請 token（私人房間非它不可）。 */
  function enterByIntent() {
    var it = S.joinIntent;
    if (!it) return Promise.resolve(false);
    return connect().then(function () {
      if (!it.invite) return joinRoom(it.room);
      return new Promise(function (resolve) {
        Online.send('invite:check', { code: it.room, token: it.invite }, function (res) {
          if (!res || !res.ok) { toast((res && (res.key ? w.I18N.message(res) : w.I18N.message(res.error))) || (globalThis.I18N ? globalThis.I18N.t("text.041") : "這個邀請連結不能用了。"), 4200); return resolve(false); }
          if (res.note) toast(res.note, 3800);
          joinRoom(it.room, it.invite, res.role).then(resolve);
        });
      });
    }).catch(function () { return false; });
  }

  function createRoom() {
    return connect().then(function () {
      S.mode = 'online';
      var settings = localGameSettings();
      var payload = {
        name: S.name,
        roomName: $('room-name').value,
        private: $('room-private').checked,
        board: settings.board,
        pace: settings.pace
      };
      if (settings.roundSec !== null) payload.roundSec = settings.roundSec;
      Online.send('room:create', payload, function (res) {
        if (!res || !res.ok) {
          if (!S.view) S.mode = null;
          return toast((res && (res.key ? w.I18N.message(res) : w.I18N.message(res.error))) || (globalThis.I18N ? globalThis.I18N.t("text.040") : "建立失敗"));
        }
        S.mode = 'online';
        Sound.play('join');
      });
    }).catch(function () {});
  }

  function onSync(view) {
    /* 已經離開房間（S.mode 被清掉）時，伺服器路上還沒到的同步包要丟掉，
       不然剛按完「離開」就會被拉回對戰畫面。 */
    if (S.mode !== 'online') return;
    if (view.match && view.phase !== 'over') GameAnalytics.sync(view.phase, view.code + '|' + view.match.seed, {
      mode: 'online', difficulty: view.pace, players: view.match.standings.length,
      spectator: !view.you || view.you.role !== 'player'
    });
    var wasPhase = S.view ? S.view.phase : null;
    S.view = view;
    if (w.NetworkLatency) w.NetworkLatency.setActive(S.screen === 's-game' && view.phase === 'playing');
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
    if (view.phase === 'over') { if (w.NetworkLatency) w.NetworkLatency.setActive(false); showResult(); }
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
      if (m.system) return '<div class="msg sys">' + esc(w.I18N.message(m)) + '</div>';
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
      box.innerHTML = (globalThis.I18N ? globalThis.I18N.t("text.039") : "<div class=\"empty\">還沒有產生過邀請連結。</div>");
      return;
    }
    var now = srvNow();
    box.innerHTML = list.map(function (iv) {
      var dead = iv.revoked || iv.expiresAt < now || iv.uses >= iv.maxUses;
      var why = iv.revoked ? (globalThis.I18N ? globalThis.I18N.t("text.038") : "已撤銷") : (iv.expiresAt < now ? (globalThis.I18N ? globalThis.I18N.t("text.037") : "已過期")
        : (iv.uses >= iv.maxUses ? (globalThis.I18N ? globalThis.I18N.t("text.036") : "次數用完") : Math.ceil((iv.expiresAt - now) / 60000) + (globalThis.I18N ? globalThis.I18N.t("text.035") : " 分鐘後過期")));
      return '<div class="invrow' + (dead ? ' dead' : '') + '">'
        + '<span class="txt">' + (iv.role === 'spectator' ? (globalThis.I18N ? globalThis.I18N.t("text.034") : "觀戰") : (globalThis.I18N ? globalThis.I18N.t("text.003") : "玩家")) + '・'
        + iv.uses + '/' + iv.maxUses + (globalThis.I18N ? globalThis.I18N.t("text.033") : " 次・") + why + '</span>'
        + (dead ? '' : '<button class="iconbtn" data-copyinv="' + esc(iv.token) + (globalThis.I18N ? globalThis.I18N.t("text.032") : "\" aria-label=\"複製這個邀請連結\">⧉</button>")
          + '<button class="iconbtn" data-revoke="' + esc(iv.token) + (globalThis.I18N ? globalThis.I18N.t("text.031") : "\" aria-label=\"撤銷這個邀請連結\">✕</button>"))
        + '</div>';
    }).join('');
  }

  function makeInvite() {
    Online.send('room:invite', {
      role: $('inv-role').value,
      ttlMinutes: Number($('inv-ttl').value),
      maxUses: Number($('inv-uses').value)
    }, function (res) {
      if (!res || !res.ok) return toast((res && (res.key ? w.I18N.message(res) : w.I18N.message(res.error))) || (globalThis.I18N ? globalThis.I18N.t("text.030") : "產生失敗"));
      var url = Config.inviteUrl(S.view.code, res.token);
      $('invite-url').value = url;
      $('invite-out').hidden = false;
      copyText(url, (globalThis.I18N ? globalThis.I18N.t("text.029") : "邀請連結已經複製，貼給朋友就可以了。"));
    });
  }

  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || (globalThis.I18N ? globalThis.I18N.t("text.028") : "已複製")); };
    if (w.navigator && w.navigator.clipboard && w.navigator.clipboard.writeText) {
      w.navigator.clipboard.writeText(text).then(done).catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var i = $('invite-url');
      i.hidden = false;
      i.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { toast((globalThis.I18N ? globalThis.I18N.t("text.027") : "複製失敗，請手動選取連結複製。")); }
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
    paintPlayingFlag();
  }

  /* body.playing 只在真的在打的時候成立。準備／倒數／結算都不算 ——
     鐵鎚游標靠這個旗標，設定和等待畫面用一般游標就好。 */
  function paintPlayingFlag() {
    var phase = S.mode === 'online'
      ? (S.view && S.view.phase)
      : (S.match && S.match.phase);
    document.body.classList.toggle('playing', phase === 'playing');
  }

  /* ============================================================
   * 操作綁定
   * ============================================================ */

  function doAction(act) {
    if (act === 'quit') {
      /* 打到一半誤觸「離開」很痛，單機和線上都先問一句 */
      var live = S.mode === 'online'
        ? !!(S.view && S.view.phase === 'playing' && S.view.you.role === 'player')
        : !!(S.match && S.match.phase === 'playing');
      if (live) {
        askConfirm((globalThis.I18N ? globalThis.I18N.t("text.026") : "離開這一局？"), S.mode === 'online'
          ? (globalThis.I18N ? globalThis.I18N.t("text.025") : "這一局還沒打完，你的分數會留在排行榜上。")
          : (globalThis.I18N ? globalThis.I18N.t("text.024") : "這一局還沒打完，離開就不會計入戰績。"), leaveGame);
        return;
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
    var t = e.target.closest ? e.target.closest('[data-act],[data-back],[data-joincode],[data-addai],[data-rmai],[data-setboard],[data-setpace],[data-setround],[data-revoke],[data-copyinv],[data-close-modal],[data-pane]') : null;
    if (!t) return;
    if (t.dataset.back) { show(t.dataset.back); Sound.play('click'); return; }
    if (t.dataset.act) { Sound.play('click'); doAction(t.dataset.act); return; }
    if (t.dataset.pane) { Sound.play('tick'); setPane(t.dataset.pane); return; }
    if (t.dataset.joincode) { Sound.play('click'); joinRoom(t.dataset.joincode); return; }
    if (t.dataset.addai) { Online.send('room:addAi', { level: t.dataset.addai }); return; }
    if (t.dataset.rmai) { Online.send('room:removeAi', { id: t.dataset.rmai }); return; }
    if (t.dataset.setboard) { Sound.play('tick'); Online.send('room:setBoard', { board: t.dataset.setboard }); return; }
    if (t.dataset.setpace) { Sound.play('tick'); Online.send('room:setPace', { pace: t.dataset.setpace }); return; }
    if (t.dataset.setround) { Sound.play('tick'); Online.send('room:setRound', { roundSec: Number(t.dataset.setround) }); return; }
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
      S.name = ($('solo-nick').value || '').trim() || (globalThis.I18N ? globalThis.I18N.t("text.023") : "我");
      Store.nick(S.name);
      startSolo();
    });

    /* 大廳 */
    $('lobby-nick').addEventListener('change', function () { Store.nick(this.value.trim()); });
    $('b-create').addEventListener('click', createRoom);
    $('b-join').addEventListener('click', function () {
      var code = ($('join-code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 4) return toast((globalThis.I18N ? globalThis.I18N.t("text.022") : "請輸入完整的房號。"));
      /* 從邀請連結進來的話要帶著 token，不然私人房間會被擋在門外 */
      if (S.joinIntent && S.joinIntent.room === code && S.joinIntent.invite) return enterByIntent();
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
      if (S.mode !== 'online') return toast((globalThis.I18N ? globalThis.I18N.t("text.021") : "單機模式沒有聊天室。"));
      Online.send('room:chat', { text: v });
      $('chat-input').value = '';
    });

    /* 設定彈窗 */
    $('b-settings').addEventListener('click', function () { openModal('settings-modal'); });
    $('b-settings-close').addEventListener('click', function () { closeModal('settings-modal'); });
    $('b-settings-ok').addEventListener('click', function () { closeModal('settings-modal'); });
    $('b-confirm-close').addEventListener('click', cancelConfirm);
    $('b-confirm-cancel').addEventListener('click', cancelConfirm);
    $('b-confirm-ok').addEventListener('click', acceptConfirm);
    $('set-music').addEventListener('change', function () { Sound.setMusic(this.checked); });
    $('set-sfx').addEventListener('change', function () { Sound.setSfx(this.checked); });
    $('set-chatcue').addEventListener('change', function () { Sound.setChatCue(this.checked); });
    $('set-haptic').addEventListener('change', function () { Sound.setHaptic(this.checked); Sound.vibrate(15); });
    $('set-music-vol').addEventListener('input', function () { Sound.setMusicVolume(this.value / 100); });
    $('set-sfx-vol').addEventListener('change', function () { Sound.setSfxVolume(this.value / 100); Sound.play('click'); });
    $('set-motion').addEventListener('change', function () { Store.reduceMotion(this.checked); applyDisplayPrefs(); });
    $('set-mark').addEventListener('change', function () { Store.bigMark(this.checked); applyDisplayPrefs(); });
    $('set-hammer').addEventListener('change', function () { Store.hammerCursor(this.checked); applyDisplayPrefs(); });
    $('b-settings-reset').addEventListener('click', function () {
      Sound.resetDefaults(); Store.resetDefaults(); applyDisplayPrefs(); syncSettingsUi();
      toast((globalThis.I18N ? globalThis.I18N.t("text.020") : "已恢復預設設定。"));
    });

    /* 邀請彈窗 */
    $('b-invite-close').addEventListener('click', function () { closeModal('invite-modal'); });
    $('b-invite-done').addEventListener('click', function () { closeModal('invite-modal'); });
    $('b-invite-make').addEventListener('click', makeInvite);
    $('b-invite-copy').addEventListener('click', function () { copyText($('invite-url').value); });

    /* 戰績 */
    $('b-stats-reset').addEventListener('click', function () {
      askConfirm((globalThis.I18N ? globalThis.I18N.t("text.019") : "清除本機戰績？"), (globalThis.I18N ? globalThis.I18N.t("text.018") : "清除後無法復原，確定要繼續嗎？"), function () {
        try {
          localStorage.removeItem(Store.KEY.stats);
          localStorage.removeItem(Store.KEY.best);
        } catch (err) {}
        paintStats();
        toast((globalThis.I18N ? globalThis.I18N.t("text.017") : "戰績已清除。"));
      });
    });

    /* 選項卡片（單機難度／對手數量） */
    ['opt-ai', 'opt-aicount', 'opt-board', 'opt-round'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        var c = e.target.closest('.pickcard');
        if (!c) return;
        els('.pickcard', this).forEach(function (x) { x.setAttribute('aria-checked', String(x === c)); });
        if (id === 'opt-ai') Store.aiLevel(c.dataset.v);
        else if (id === 'opt-aicount') Store.aiCount(c.dataset.v);
        else if (id === 'opt-board') Store.board(c.dataset.v);
        else Store.roundSec(c.dataset.v);
        Sound.play('tick');
      });
    });

    /* 轉向／改變視窗大小時只重繪裝飾；盤面列欄固定，尺寸交給 CSS 適配。 */
    w.addEventListener('resize', function () { SvgUI.repaintAll(); });
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

    var rs = Rules.roundSecOf(Store.roundSec());
    $('opt-round').innerHTML = Rules.ROUND_SECONDS.map(function (sec) {
      return '<button class="pickcard" type="button" role="radio" data-v="' + sec + '"'
        + ' aria-checked="' + (sec === rs) + '"><b>' + sec + (globalThis.I18N ? globalThis.I18N.t("text.016") : " 秒</b><span>")
        + (sec === 60 ? (globalThis.I18N ? globalThis.I18N.t("text.015") : "快一場") : (sec === 75 ? (globalThis.I18N ? globalThis.I18N.t("text.014") : "中等") : (globalThis.I18N ? globalThis.I18N.t("text.013") : "完整一局"))) + '</span></button>';
    }).join('');

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
      [(globalThis.I18N ? globalThis.I18N.t("text.012") : "單機勝"), s.solo.win], [(globalThis.I18N ? globalThis.I18N.t("text.011") : "單機敗"), s.solo.lose],
      [(globalThis.I18N ? globalThis.I18N.t("text.010") : "線上勝"), s.online.win], [(globalThis.I18N ? globalThis.I18N.t("text.009") : "線上敗"), s.online.lose],
      [(globalThis.I18N ? globalThis.I18N.t("text.008") : "最高分"), b.score || 0], [(globalThis.I18N ? globalThis.I18N.t("text.007") : "最長連擊"), b.combo || 0],
      [(globalThis.I18N ? globalThis.I18N.t("text.006") : "最佳命中率"), Math.round((b.accuracy || 0) * 100) + '%']
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
      if (!p || !p.events || S.mode !== 'online') return;
      for (var i = 0; i < p.events.length; i++) applyEventToSnap(S.match, p.events[i]);
      handleEvents(p.events, srvNow());
    });
    Online.on('room:chat', function (p) {
      if (!S.view) return;
      S.view.chat = (S.view.chat || []).concat([p.message]).slice(-40);
      paintChat(S.view.chat);
    });
    Online.on('room:error', function (p) { toast(w.I18N.message(p.key ? p : p.message) || (globalThis.I18N ? globalThis.I18N.t("text.005") : "操作失敗")); });
    Online.on('room:closed', function (p) { toast(w.I18N.message(p.key ? p : p.reason) || (globalThis.I18N ? globalThis.I18N.t("text.004") : "房間已關閉")); leaveGame(); });
    Online.on('room:left', function () { Sound.play('leave'); });
    Online.on('reconnected', function () {
      if (S.mode === 'online' && S.view) {
        Online.send('room:join', { code: S.view.code, name: S.name });
      }
    });
  }

  /* ------------------------------------------------------------ 啟動 */

  function boot() {

    w.I18N.mountToggle({ after: $('b-settings') });
    w.I18N.onChange(function () {
      S.sigs = {};
      if (S.connection) connStatus(S.connection);
      if (S.roomList) paintRoomList(S.roomList);
      buildDex(); paintSoloOptions(); paintStats(); syncSettingsUi();
      if (S.view) paintChat(S.view.chat);
      paintWaitOverlay();
      paintHud(); paintSummary(); paintSideActions(); paintWaitOverlay();
      if (S.match && S.match.phase === 'over') showResult();
      var link = document.querySelector('.lobby-home-link');
      if (link) link.href = w.I18N.withLang(link.href);
    });

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
    S.name = nick || (globalThis.I18N ? globalThis.I18N.t("text.003") : "玩家");

    /* 沒有伺服器就把線上入口降級成提示，而不是點了沒反應 */
    if (!Config.isOnlineEnabled()) {
      $('b-online').addEventListener('click', function () {
        toast((Config.error ? w.I18N.message(Config.error) : null) || (globalThis.I18N ? globalThis.I18N.t("text.002") : "這份頁面沒有連到遊戲伺服器，只能玩單機。用 npm start 啟動伺服器後再開一次。"), 4200);
      }, true);
    }

    /* 邀請連結：?room=XXXXX&invite=token */
    var entry = Config.entry();
    if (entry.room && Config.isOnlineEnabled()) {
      show('s-lobby');
      $('join-code').value = entry.room;
      S.joinIntent = { room: entry.room, invite: entry.invite || null };
      if (entry.invite || !Store.nick()) {
        /* 邀請連結一定先讓人確認／修改名字，不能用裝置上的舊名稱直接進房。
           先把線連起來，這樣填名字的時候就看得到伺服器狀態。 */
        connect().catch(function () {});
        toast((globalThis.I18N ? globalThis.I18N.t("text.001") : "先確認一下你的名字，再按「加入房間」就進去了。"), 4600);
        try { $('lobby-nick').focus(); } catch (e) {}
      } else {
        enterByIntent();
      }
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
