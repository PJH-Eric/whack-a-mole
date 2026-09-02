/* ===== render.js — 盤面繪製與特效 =====
 *
 * 只負責「把 Rules.snapshot() 畫出來」，不做任何規則判斷。
 * 地鼠的升降位置是用 spawnAt / expireAt 兩個時間戳在前端內插算出來的，
 * 所以伺服器只要在「冒出／被打／逃走」時送事件，中間的動畫本地就能補滿，
 * 免費雲端的頻寬也撐得住。
 */
(function (w) {
  'use strict';

  var Rules = w.Rules, SvgUI = w.SvgUI;

  var board = null;         // 盤面容器
  var fx = null;            // 特效層
  var holes = [];           // 每個地洞的 DOM 快取
  var onWhack = null;       // 玩家敲下去時的 callback
  var reduceMotion = false;
  var bigMark = true;
  var grid = null;          // 目前畫出來的盤面尺寸 {cols, rows, holes}
  var bound = false;        // 事件只綁一次（用委派，重建地洞不用重綁）

  /* ---------------------------------------------------------- 建立盤面 */

  /** 視窗大小／方向變了只需讓 CSS 重新縮放，不能改變玩家選定的列欄。 */
  function relayout() {
    /* 盤面列欄固定由 Rules 的盤面選項決定，尺寸由 CSS 自動適配容器。 */
  }

  /** 盤面尺寸可以是 Rules 的 board 物件、快照，或單純一個地洞數。 */
  function normalizeGrid(g) {
    if (typeof g === 'number') {
      var b = Rules.boardOf(Rules.DEFAULT_BOARD);
      return { cols: b.cols, rows: b.rows, holes: g || b.holes };
    }
    if (g && g.cols && g.rows) return { cols: g.cols, rows: g.rows, holes: g.holes || g.cols * g.rows };
    var d = Rules.boardOf(g && g.board);
    return { cols: d.cols, rows: d.rows, holes: d.holes };
  }

  /**
   * @param {HTMLElement} el     盤面容器
   * @param {HTMLElement} fxEl   特效層
   * @param {object|number} g    盤面尺寸（{cols,rows,holes}、快照，或地洞數）
   * @param {function} cb        cb(holeIndex, moleId|null, domEvent)
   */
  function mount(el, fxEl, g, cb) {
    board = el; fx = fxEl; onWhack = cb;
    bindEvents();
    grid = null;
    setGrid(g);
  }

  /**
   * 換盤面尺寸。尺寸沒變就什麼都不做 —— 每一幀都會呼叫，重建 DOM 會把動畫打斷。
   * @returns {boolean} 有沒有真的重建
   */
  function setGrid(g) {
    var n = normalizeGrid(g);
    if (grid && grid.holes === n.holes && grid.cols === n.cols && grid.rows === n.rows) return false;
    grid = { cols: n.cols, rows: n.rows, holes: n.holes };
    /* --bc / --br 給 CSS 排格線用；列欄就是玩家選的盤面尺寸。 */
    board.style.setProperty('--bc', String(n.cols));
    board.style.setProperty('--br', String(n.rows));
    build(n.holes);
    return true;
  }

  function build(count) {
    holes = [];
    board.innerHTML = '';
    board.setAttribute('role', 'grid');
    board.setAttribute('aria-label', '地鼠盤面，共 ' + count +' 個地洞');

    for (var i = 0; i < count; i++) {
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'hole';
      cell.dataset.hole = String(i);
      cell.setAttribute('aria-label', '第 ' + (i + 1) + ' 號地洞，空的');
      cell.innerHTML =
        '<svg class="hole-back" viewBox="0 0 100 100" aria-hidden="true">' + SvgUI.holeBack() + '</svg>' +
        '<div class="mole-clip"><div class="mole-slot">' +
        '<svg class="mole-svg" viewBox="0 0 100 100" aria-hidden="true"></svg>' +
        '</div></div>' +
        '<span class="mole-badge" aria-hidden="true"></span>' +
        '<svg class="hole-front" viewBox="0 0 100 100" aria-hidden="true">' + SvgUI.holeFront() + '</svg>' +
        '<span class="hole-flash" aria-hidden="true"></span>';

      var rec = {
        el: cell,
        slot: cell.querySelector('.mole-slot'),
        svg: cell.querySelector('.mole-svg'),
        badge: cell.querySelector('.mole-badge'),
        flash: cell.querySelector('.hole-flash'),
        moleId: 0,
        drawnKey: ''
      };
      holes.push(rec);
      board.appendChild(cell);
    }

    board.classList.toggle('big-mark', bigMark);
  }

  /* 事件綁在盤面容器上做委派，所以換盤面尺寸重建地洞時不用重綁 */
  function bindEvents() {
    if (bound) return;
    bound = true;

    /* pointerdown 而不是 click：打地鼠要「按下去就算」，慢半拍會被搶走 */
    board.addEventListener('pointerdown', function (e) {
      var cell = e.target.closest ? e.target.closest('.hole') : null;
      if (!cell || !board.contains(cell)) return;
      e.preventDefault();
      var idx = Number(cell.dataset.hole);
      var rec = holes[idx];
      if (onWhack) onWhack(idx, rec ? rec.moleId || null : null, e);
    });

    /* 鍵盤：1-9 與 QWER... 對應地洞，讓不能用觸控的人也玩得到 */
    board.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var cell = e.target.closest ? e.target.closest('.hole') : null;
      if (!cell) return;
      e.preventDefault();
      var idx = Number(cell.dataset.hole);
      if (onWhack) onWhack(idx, holes[idx] ? holes[idx].moleId || null : null, e);
    });
  }

  function setOptions(o) {
    if (o.reduceMotion !== undefined) reduceMotion = !!o.reduceMotion;
    if (o.bigMark !== undefined) bigMark = !!o.bigMark;
    if (board) board.classList.toggle('big-mark', bigMark);
  }

  /* ---------------------------------------------------------- 每幀更新 */

  /**
   * 依快照更新盤面。每一幀呼叫一次（rAF）。
   * 升起／縮回都用時間內插，所以就算伺服器 200ms 才推一次也很滑順。
   */
  function draw(snap, now) {
    if (!board || !snap) return;
    /* 對局的盤面尺寸可能和目前畫出來的不一樣（線上房主改過、或換了單機設定）。
       尺寸相同就是 no-op，不會每幀重建 DOM。 */
    setGrid(snap);
    var byHole = {};
    var i, m;
    for (i = 0; i < snap.moles.length; i++) byHole[snap.moles[i].hole] = snap.moles[i];

    for (i = 0; i < holes.length; i++) {
      var rec = holes[i];
      m = byHole[i];

      if (!m) {
        if (rec.moleId || rec.slot.classList.contains('up') || rec.badge.classList.contains('on')) {
          rec.moleId = 0;
          rec.drawnKey = '';
          rec.slot.style.transform = 'translateY(105%)';
          rec.slot.style.opacity = '0';
          rec.slot.classList.remove('up', 'leaving');
          delete rec.slot.dataset.mole;
          rec.badge.textContent = '';
          rec.badge.className = 'mole-badge';
          rec.el.setAttribute('aria-label', '第 ' + (i + 1) + ' 號地洞，空的');
        }
        continue;
      }

      var t = Rules.typeOf(m.type);
      var key = m.id + ':' + m.hpLeft;
      if (rec.drawnKey !== key) {
        rec.drawnKey = key;
        rec.svg.innerHTML = SvgUI.moleArt(m.type, m.hpLeft);
        rec.slot.className = 'mole-slot up side-' + t.side + ' type-' + m.type;
        /* 標上這一隻的 id：同一個洞連續冒兩隻時，外部工具才分得出是兩隻 */
        rec.slot.dataset.mole = String(m.id);
        rec.badge.className = 'mole-badge side-' + t.side;
        rec.badge.textContent = (t.points > 0 ? '+' : '') + t.points
          + (t.hp > 1 ? ' ×' + m.hpLeft : '');
        rec.el.setAttribute('aria-label',
          '第 ' + (i + 1) + ' 號地洞，' + t.label + '，' + (t.side === 'bad' ? '打了加 ' : '打了扣 ')
          + Math.abs(t.points) + ' 分' + (m.hpLeft > 1 ? '，還要 ' + m.hpLeft + ' 下' : ''));
      }
      rec.moleId = m.id;

      /* 升起 → 停留 → 縮回 */
      var age = now - m.spawnAt;
      var left = m.expireAt - now;
      var up = 1;
      if (age < Rules.RISE_MS) up = ease(age / Rules.RISE_MS);
      else if (left < Rules.SINK_MS) up = ease(Math.max(0, left) / Rules.SINK_MS);
      if (reduceMotion) up = left > 0 ? 1 : 0;

      /* 分數標記和地鼠共用同一個可見門檻，避免標記單獨飄在空洞上。 */
      var visible = up >= 0.06;
      rec.slot.style.transform = 'translateY(' + ((1 - up) * 105).toFixed(1) + '%)';
      rec.slot.style.opacity = visible ? '1' : '0';
      rec.badge.classList.toggle('on', visible);

      /* 快溜掉的最後 300ms 抖一下，提醒玩家要來不及了 */
      rec.slot.classList.toggle('leaving', !reduceMotion && left < 320);
    }
  }

  function ease(x) {
    var v = Math.max(0, Math.min(1, x));
    return 1 - Math.pow(1 - v, 2.4);
  }

  /* ---------------------------------------------------------- 特效 */

  /** 敲擊回饋：地洞閃一下 + 浮出分數 */
  function popEvent(ev, opts) {
    var o = opts || {};
    var rec = holes[ev.hole];
    if (!rec) return;

    if (!reduceMotion) {
      rec.el.classList.remove('shake');
      void rec.el.offsetWidth;
      rec.el.classList.add('shake');
      setTimeout(function () { rec.el.classList.remove('shake'); }, 320);
    }

    var cls = 'flyscore';
    var text = '';
    if (ev.k === 'hit') {
      cls += ev.gain >= 0 ? ' good' : ' bad';
      text = (ev.gain >= 0 ? '+' : '') + ev.gain;
      if (ev.buffed) text += ' ×2';
      else if (ev.multiplier > 1.001) text += ' ×' + ev.multiplier.toFixed(1);
      rec.flash.className = 'hole-flash on ' + (ev.gain >= 0 ? 'hit-good' : 'hit-bad');
    } else if (ev.k === 'miss') {
      cls += ' miss';
      text = '空槌';
      rec.flash.className = 'hole-flash on hit-miss';
    } else {
      return;
    }
    setTimeout(function () { rec.flash.className = 'hole-flash'; }, 260);

    if (o.who) text = o.who + ' ' + text;

    var n = document.createElement('span');
    n.className = cls;
    if (o.color) n.style.setProperty('--who', o.color);
    n.textContent = text;
    n.dataset.hole = String(ev.hole);
    /* 同一個洞連續兩槌時，舊的字先收掉：兩層字疊在一起誰都看不懂 */
    var stale = fx.querySelectorAll('.flyscore[data-hole="' + ev.hole + '"]');
    for (var i = 0; i < stale.length; i++) stale[i].parentNode.removeChild(stale[i]);
    var r = rec.el.getBoundingClientRect();
    var f = fx.getBoundingClientRect();
    n.style.left = (r.left - f.left + r.width / 2) + 'px';
    n.style.top = (r.top - f.top + r.height * 0.3) + 'px';
    fx.appendChild(n);
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 950);
  }

  /** 中央大字：倒數、階段提示、連擊里程碑 */
  function shout(text, cls, ms) {
    if (!fx) return;
    /* 中央同時只留一句話：階段提示和連擊里程碑常常一起來，疊起來會糊成一團 */
    var stale = fx.querySelectorAll('.shout');
    for (var i = 0; i < stale.length; i++) stale[i].parentNode.removeChild(stale[i]);
    var n = document.createElement('div');
    n.className = 'shout ' + (cls || '');
    n.textContent = text;
    fx.appendChild(n);
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, ms || 900);
  }

  /** 清掉所有地鼠與特效（結算、離開房間時用） */
  function clear() {
    for (var i = 0; i < holes.length; i++) {
      holes[i].moleId = 0;
      holes[i].drawnKey = '';
      holes[i].slot.style.transform = 'translateY(105%)';
      holes[i].slot.style.opacity = '0';
      holes[i].slot.classList.remove('up', 'leaving');
      holes[i].badge.textContent = '';
      holes[i].badge.className = 'mole-badge';
    }
    if (fx) fx.innerHTML = '';
  }

  w.Board = {
    mount: mount,
    setGrid: setGrid,
    relayout: relayout,
    grid: function () { return grid; },
    draw: draw,
    clear: clear,
    popEvent: popEvent,
    shout: shout,
    setOptions: setOptions,
    holeCount: function () { return holes.length; }
  };
}(window));
