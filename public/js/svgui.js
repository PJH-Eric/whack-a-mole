/* ===== svgui.js — 立體 SVG 按鈕、地鼠造型、標題 LOGO、背景裝飾 =====
 *
 * 按鈕外觀是依元素實際尺寸即時畫出來的 SVG，所以縮放時不會被拉扁，
 * 也保證有「上層面 + 較深底座 + 高光」的區塊立體感。
 * 文字仍然是 HTML，不會烘焙進圖裡，方便本地化與螢幕閱讀器。
 */
(function (w) {
  'use strict';
  var INK = '#4A3B55';

  var PALETTE = {
    grape: ['#C9B6F5', '#A48FDB'],
    peach: ['#FFC2B4', '#E89C8B'],
    mint:  ['#A9E7D2', '#79C6AC'],
    sky:   ['#AED9F5', '#7FB4DA'],
    lemon: ['#FFE3A0', '#E7C263'],
    cream: ['#FFF0DE', '#E6D2B4'],
    rose:  ['#FFB8CF', '#E88CAA'],
    gray:  ['#E9E3EE', '#C8BFD1']
  };


  /* ---- 立體按鈕 ---- */
  function paint(el) {
    var wpx = el.offsetWidth, hpx = el.offsetHeight;
    if (!wpx || !hpx) return;
    var cs = getComputedStyle(el);
    var d = parseFloat(cs.getPropertyValue('--d')) || 8;
    var key = el.getAttribute('data-color') || 'cream';
    var c = PALETTE[key] || PALETTE.cream;
    var faceH = hpx - d - 4;
    if (faceH < 10) return;
    var r = Math.min(20, faceH / 2.2);
    var svg = el.querySelector('.b3-svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'b3-svg');
      svg.setAttribute('aria-hidden', 'true');
      el.insertBefore(svg, el.firstChild);
    }
    svg.setAttribute('viewBox', '0 0 ' + wpx + ' ' + hpx);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML =
      '<rect x="2" y="' + (2 + d) + '" width="' + (wpx - 4) + '" height="' + faceH + '" rx="' + r + '" fill="' + c[1] + '" stroke="' + INK + '" stroke-width="3"/>' +
      '<g class="b3-face">' +
      '<rect x="2" y="2" width="' + (wpx - 4) + '" height="' + faceH + '" rx="' + r + '" fill="' + c[0] + '" stroke="' + INK + '" stroke-width="3"/>' +
      '<rect x="' + (r * 0.55 + 4) + '" y="7" width="' + Math.max(4, wpx - 8 - r * 1.1) + '" height="' + Math.max(4, faceH * 0.36) + '" rx="' + (r * 0.5) + '" fill="#FFFFFF" opacity="0.45"/>' +
      '</g>';
  }

  var ro = w.ResizeObserver ? new ResizeObserver(function (list) {
    for (var i = 0; i < list.length; i++) paint(list[i].target);
  }) : null;

  function decorate(el) {
    if (el.dataset.b3) return;
    el.dataset.b3 = '1';
    var lbl = document.createElement('span');
    lbl.className = 'b3-lbl';
    lbl.innerHTML = el.innerHTML;
    el.innerHTML = '';
    el.appendChild(lbl);
    paint(el);
    if (ro) ro.observe(el); else w.addEventListener('resize', function () { paint(el); });

    var press = function () { if (!el.disabled) el.classList.add('press'); };
    var release = function () { el.classList.remove('press'); };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('pointercancel', release);
  }

  function decorateAll(root) {
    var list = (root || document).querySelectorAll('.btn3d');
    for (var i = 0; i < list.length; i++) decorate(list[i]);
  }
  function repaintAll(root) {
    var list = (root || document).querySelectorAll('.btn3d');
    for (var i = 0; i < list.length; i++) paint(list[i]);
  }

  function setLabel(el, html) {
    var lbl = el.querySelector('.b3-lbl');
    if (lbl) lbl.innerHTML = html; else el.innerHTML = html;
  }
  function setColor(el, key) {
    el.setAttribute('data-color', key);
    paint(el);
  }


  /* ================================================================
   * 地鼠造型
   *
   * 全部畫在 100 x 100 的 viewBox 裡，腳的部分故意畫到底邊之外，
   * 由地洞的遮罩切掉，看起來就像從土裡冒出來。
   *
   * 好人和壞人的差別「不能只有顏色」（色弱玩家要看得出來）：
   *   壞人：尖尖的耳朵／怒眉，頭上沒有光圈，角落是 ＋ 號徽章
   *   好人：柔和圓耳／笑眼，頭後面有一圈綠色光環，角落是 − 號徽章
   * ================================================================ */

  /* 怒眉（壞人專用） */
  function angryBrows(y) {
    return '<path d="M28 ' + y + ' l14 6" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>' +
           '<path d="M72 ' + y + ' l-14 6" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>';
  }
  /* 好人專用：頭後面的柔和光環，讓「不要打我」一眼看得出來 */
  function halo() {
    return '<ellipse cx="50" cy="48" rx="42" ry="40" fill="none" stroke="#7ED9A8" stroke-width="5" opacity=".55" stroke-dasharray="7 6"/>';
  }
  /* 圓圓的眼睛 + 高光 */
  var dizzyOn = false;
  /* 被打扁的表情：兩顆叉叉眼 */
  function crossEyes(x1, x2, y, r) {
    var k = r * 0.95;
    function x(cx) {
      return '<path d="M' + (cx - k) + ' ' + (y - k) + ' L' + (cx + k) + ' ' + (y + k) + ' M' + (cx + k) + ' ' + (y - k) + ' L' + (cx - k) + ' ' + (y + k) +
        '" stroke="' + INK + '" stroke-width="4" fill="none" stroke-linecap="round"/>';
    }
    return x(x1) + x(x2);
  }
  function eyes(x1, x2, y, r, closed) {
    if (dizzyOn) return crossEyes(x1, x2, y, r);
    if (closed) {
      return '<path d="M' + (x1 - r) + ' ' + y + ' q' + r + ' ' + (r * 1.1) + ' ' + (r * 2) + ' 0" stroke="' + INK + '" stroke-width="4" fill="none" stroke-linecap="round"/>' +
             '<path d="M' + (x2 - r) + ' ' + y + ' q' + r + ' ' + (r * 1.1) + ' ' + (r * 2) + ' 0" stroke="' + INK + '" stroke-width="4" fill="none" stroke-linecap="round"/>';
    }
    return '<circle cx="' + x1 + '" cy="' + y + '" r="' + r + '" fill="' + INK + '"/>' +
           '<circle cx="' + x2 + '" cy="' + y + '" r="' + r + '" fill="' + INK + '"/>' +
           '<circle cx="' + (x1 + r * 0.35) + '" cy="' + (y - r * 0.4) + '" r="' + (r * 0.34) + '" fill="#fff"/>' +
           '<circle cx="' + (x2 + r * 0.35) + '" cy="' + (y - r * 0.4) + '" r="' + (r * 0.34) + '" fill="#fff"/>';
  }
  /* 鼠鼻 + 鬍鬚 + 門牙 */
  function snout(cy, teeth, noseColor) {
    var s = '<ellipse cx="50" cy="' + cy + '" rx="13" ry="9.5" fill="#FFF6EC" stroke="' + INK + '" stroke-width="3"/>' +
      '<ellipse cx="50" cy="' + (cy - 3) + '" rx="5" ry="4" fill="' + (noseColor || '#F2879F') + '" stroke="' + INK + '" stroke-width="2.5"/>';
    if (teeth) {
      s += '<rect x="45" y="' + (cy + 3) + '" width="4.4" height="9" rx="1.6" fill="#fff" stroke="' + INK + '" stroke-width="2"/>' +
           '<rect x="50.6" y="' + (cy + 3) + '" width="4.4" height="9" rx="1.6" fill="#fff" stroke="' + INK + '" stroke-width="2"/>';
    }
    s += '<path d="M36 ' + (cy - 2) + ' h-13 M36 ' + (cy + 3) + ' h-12" stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round" opacity=".7"/>' +
         '<path d="M64 ' + (cy - 2) + ' h13 M64 ' + (cy + 3) + ' h12" stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round" opacity=".7"/>';
    return s;
  }
  /* 尖耳（壞人） */
  function pointyEars(body, dark) {
    return '<path d="M20 30 L14 8 L38 20 Z" fill="' + body + '" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
           '<path d="M80 30 L86 8 L62 20 Z" fill="' + body + '" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
           '<path d="M22 26 L19 15 L32 21 Z" fill="' + dark + '" opacity=".8"/>' +
           '<path d="M78 26 L81 15 L68 21 Z" fill="' + dark + '" opacity=".8"/>';
  }
  /* 圓耳（好人） */
  function roundEars(body, inner) {
    return '<circle cx="22" cy="22" r="13" fill="' + body + '" stroke="' + INK + '" stroke-width="4"/>' +
           '<circle cx="78" cy="22" r="13" fill="' + body + '" stroke="' + INK + '" stroke-width="4"/>' +
           '<circle cx="22" cy="22" r="6" fill="' + inner + '"/>' +
           '<circle cx="78" cy="22" r="6" fill="' + inner + '"/>';
  }
  /* 身體：橢圓形，畫超出底邊讓地洞切掉 */
  function bodyBlob(body, dark) {
    return '<ellipse cx="50" cy="96" rx="40" ry="30" fill="' + dark + '" stroke="' + INK + '" stroke-width="4"/>' +
           '<ellipse cx="50" cy="99" rx="27" ry="22" fill="' + body + '" opacity=".75"/>';
  }
  /* 頭 */
  function head(body, cy, rx, ry) {
    return '<ellipse cx="50" cy="' + (cy || 52) + '" rx="' + (rx || 36) + '" ry="' + (ry || 33) + '" fill="' + body + '" stroke="' + INK + '" stroke-width="4"/>';
  }

  var MOLE_ART = {
    /* ---------- 壞人（打了加分） ---------- */

    /* 小土鼠：最樸素的一隻，記住牠的樣子就記住了「基本款」 */
    mole: function () {
      var b = '#D6AC80', d = '#B98C5F';
      return bodyBlob(b, d) + pointyEars(b, d) + head(b) +
        angryBrows(38) + eyes(38, 62, 50, 6) + snout(64, true);
    },

    /* 疾風鼠：護目鏡 + 速度線，一看就知道很快 */
    swift: function () {
      var b = '#A9C9E8', d = '#7FA8CC';
      return '<path d="M4 34 h22 M2 46 h16 M96 34 h-22 M98 46 h-16" stroke="#7FA8CC" stroke-width="4" stroke-linecap="round" opacity=".75"/>' +
        bodyBlob(b, d) + pointyEars(b, d) + head(b) +
        '<rect x="16" y="40" width="68" height="20" rx="10" fill="#3E4A63" stroke="' + INK + '" stroke-width="3.5"/>' +
        '<circle cx="34" cy="50" r="6.5" fill="#BFE6FF"/><circle cx="66" cy="50" r="6.5" fill="#BFE6FF"/>' +
        '<path d="M30 46 l5 4" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' +
        snout(70, true);
    },

    /* 鐵盔鼠：頭上有鐵盔，第一下只會把盔打歪，要兩下才倒 */
    helmet: function (hpLeft) {
      var b = '#C3C9D2', d = '#9AA3B0';
      var dented = hpLeft !== undefined && hpLeft < 2;
      var tilt = dented ? ' transform="rotate(-16 50 30)"' : '';
      return bodyBlob(b, d) + pointyEars(b, d) + head(b) +
        angryBrows(40) + eyes(38, 62, 52, 5.5) + snout(66, true) +
        '<g' + tilt + '>' +
        '<path d="M16 34 a34 30 0 0 1 68 0 z" fill="#8E99A8" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
        '<rect x="12" y="30" width="76" height="9" rx="4.5" fill="#6F7A88" stroke="' + INK + '" stroke-width="3.5"/>' +
        '<path d="M30 20 a24 20 0 0 1 40 0" stroke="#DDE4EC" stroke-width="5" fill="none" stroke-linecap="round" opacity=".8"/>' +
        (dented ? '<path d="M40 14 l8 8 l-6 6" stroke="' + INK + '" stroke-width="3.5" fill="none" stroke-linecap="round"/>' : '') +
        '</g>';
    },

    /* 炸彈鼠：抱著一顆點著引線的炸彈，分數高但停留很短 */
    bomber: function () {
      var b = '#A796C4', d = '#8773A8';
      return bodyBlob(b, d) + pointyEars(b, d) + head(b, 46, 33, 30) +
        angryBrows(32) + eyes(38, 62, 44, 5.5) + snout(58, true) +
        '<circle cx="50" cy="88" r="17" fill="#3D3548" stroke="' + INK + '" stroke-width="4"/>' +
        '<rect x="45" y="70" width="10" height="7" rx="2" fill="#6F6280" stroke="' + INK + '" stroke-width="3"/>' +
        '<path d="M50 70 q10 -10 3 -18" stroke="#C2A17C" stroke-width="3.5" fill="none" stroke-linecap="round"/>' +
        '<circle cx="52" cy="50" r="5" fill="#FFC93C"/><circle cx="52" cy="50" r="2.4" fill="#FF6B4A"/>' +
        '<circle cx="42" cy="86" r="5" fill="#fff" opacity=".28"/>';
    },

    /* 彩虹鼠：頭上一道彩虹，敲到之後六秒內自己的正分加倍 */
    rainbow: function () {
      var b = '#FFD9EC', d = '#F0AFD0';
      var arcs = ['#FF7A7A', '#FFB35C', '#FFE066', '#7ED9A8', '#7FB4DA', '#B79BE8'];
      var s = '';
      for (var i = 0; i < arcs.length; i++) {
        var r = 44 - i * 5;
        s += '<path d="M' + (50 - r) + ' 34 a' + r + ' ' + r + ' 0 0 1 ' + (r * 2) + ' 0" fill="none" stroke="' + arcs[i] + '" stroke-width="5"/>';
      }
      return s + bodyBlob(b, d) + pointyEars(b, d) + head(b, 56, 33, 30) +
        eyes(38, 62, 52, 6) + '<path d="M40 66 q10 10 20 0" stroke="' + INK + '" stroke-width="4" fill="none" stroke-linecap="round"/>' +
        '<circle cx="28" cy="64" r="6" fill="#FF9EC4" opacity=".7"/><circle cx="72" cy="64" r="6" fill="#FF9EC4" opacity=".7"/>' +
        '<path d="M18 22 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z" fill="#FFE066" stroke="' + INK + '" stroke-width="2"/>';
    },

    /* 大王鼠：又大又肥，戴皇冠、留鬍子，要敲三下 */
    boss: function (hpLeft) {
      var b = '#B8804A', d = '#946234';
      var bruise = '';
      if (hpLeft === 2) bruise = '<path d="M26 62 l7 7 M33 62 l-7 7" stroke="' + INK + '" stroke-width="3" stroke-linecap="round"/>';
      if (hpLeft === 1) bruise = '<path d="M26 62 l7 7 M33 62 l-7 7 M67 62 l7 7 M74 62 l-7 7" stroke="' + INK + '" stroke-width="3" stroke-linecap="round"/>';
      return bodyBlob(b, d) + pointyEars(b, d) + head(b, 54, 40, 36) +
        '<path d="M18 24 L26 6 L38 18 L50 2 L62 18 L74 6 L82 24 Z" fill="#FFD65C" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
        '<circle cx="50" cy="14" r="4" fill="#FF7A9C" stroke="' + INK + '" stroke-width="2"/>' +
        angryBrows(40) + eyes(36, 64, 52, 7) + snout(68, true) + bruise +
        '<path d="M28 76 q-8 6 -12 3 M72 76 q8 6 12 3" stroke="#FFF6EC" stroke-width="4" fill="none" stroke-linecap="round"/>';
    },

    /* 黃金鼠：全場最高分，只露臉半秒 */
    golden: function () {
      var b = '#FFD75E', d = '#E0AE2C';
      var spark = function (x, y, r) {
        return '<path d="M' + x + ' ' + (y - r) + ' q1.6 ' + (r * 0.8) + ' ' + r + ' ' + r +
          ' q-' + (r * 0.8) + ' 1.6 -' + r + ' ' + r + ' q-1.6 -' + (r * 0.8) + ' -' + r + ' -' + r +
          ' q' + (r * 0.8) + ' -1.6 ' + r + ' -' + r + 'z" fill="#FFF6C9" stroke="' + INK + '" stroke-width="2"/>';
      };
      return spark(14, 26, 9) + spark(86, 22, 7) + spark(90, 58, 6) +
        bodyBlob(b, d) + pointyEars(b, d) + head(b) +
        '<path d="M14 44 a36 33 0 0 1 72 0 a36 20 0 0 0 -72 0z" fill="#FFF0AC" opacity=".65"/>' +
        angryBrows(38) + eyes(38, 62, 50, 6) + snout(64, true, '#E08A2C') +
        '<circle cx="50" cy="26" r="7" fill="#FFF6C9" stroke="' + INK + '" stroke-width="3"/>' +
        '<text x="50" y="30" font-size="9" font-weight="900" text-anchor="middle" fill="' + INK + '">$</text>';
    },

    /* ---------- 好人（打了扣分） ---------- */

    /* 小雞：圓圓一顆，橘色喙 */
    chick: function () {
      var b = '#FFE08A', d = '#F0C55A';
      return halo() + bodyBlob(b, d) +
        '<path d="M50 16 q-5 -10 2 -13 q4 5 2 13z" fill="#F0C55A" stroke="' + INK + '" stroke-width="3" stroke-linejoin="round"/>' +
        head(b, 52, 34, 32) +
        eyes(38, 62, 48, 5.5) +
        '<path d="M42 60 L58 60 L50 70 Z" fill="#FF9A3C" stroke="' + INK + '" stroke-width="3" stroke-linejoin="round"/>' +
        '<circle cx="28" cy="60" r="5.5" fill="#FFB3B3" opacity=".8"/><circle cx="72" cy="60" r="5.5" fill="#FFB3B3" opacity=".8"/>';
    },

    /* 小兔子：長耳朵，笑瞇瞇 */
    bunny: function () {
      var b = '#FFF7F2', d = '#EAD9CF';
      return halo() +
        '<ellipse cx="34" cy="16" rx="9" ry="22" fill="' + b + '" stroke="' + INK + '" stroke-width="4"/>' +
        '<ellipse cx="66" cy="16" rx="9" ry="22" fill="' + b + '" stroke="' + INK + '" stroke-width="4"/>' +
        '<ellipse cx="34" cy="17" rx="4" ry="14" fill="#FFC2CE"/>' +
        '<ellipse cx="66" cy="17" rx="4" ry="14" fill="#FFC2CE"/>' +
        bodyBlob(b, d) + head(b, 58, 33, 29) +
        eyes(38, 62, 54, 5.5, true) + snout(68, true, '#FF9AB0') +
        '<circle cx="26" cy="66" r="5.5" fill="#FFC2CE" opacity=".85"/><circle cx="74" cy="66" r="5.5" fill="#FFC2CE" opacity=".85"/>';
    },

    /* 農夫爺爺：草帽 + 白鬍子，這塊田的主人 */
    farmer: function () {
      var skin = '#F6D3B0', d = '#DFB78E';
      return halo() +
        '<ellipse cx="50" cy="96" rx="40" ry="30" fill="#8FBF7A" stroke="' + INK + '" stroke-width="4"/>' +
        '<path d="M50 74 v26 M38 82 l12 8 M62 82 l-12 8" stroke="#5F8F4E" stroke-width="3" opacity=".7"/>' +
        head(skin, 54, 31, 29) +
        eyes(39, 61, 50, 5, true) +
        '<path d="M31 30 q19 -14 38 0" stroke="' + INK + '" stroke-width="4" fill="none" stroke-linecap="round"/>' +
        '<ellipse cx="50" cy="30" rx="46" ry="11" fill="#F2D08A" stroke="' + INK + '" stroke-width="4"/>' +
        '<path d="M28 30 a22 20 0 0 1 44 0z" fill="#F7DFA6" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
        '<path d="M28 30 h44" stroke="#D9A94E" stroke-width="3"/>' +
        '<path d="M34 62 q16 20 32 0 q-4 16 -16 16 q-12 0 -16 -16z" fill="#FFFDF8" stroke="' + INK + '" stroke-width="3.5" stroke-linejoin="round"/>' +
        '<circle cx="30" cy="56" r="5" fill="#F2A0A0" opacity=".7"/><circle cx="70" cy="56" r="5" fill="#F2A0A0" opacity=".7"/>';
    },

    /* 貓店長：拿著「請勿敲打」的牌子，扣最多分 */
    catshop: function () {
      var b = '#FFFDF6', d = '#E8DCCB';
      return halo() + bodyBlob(b, d) +
        '<path d="M24 34 L18 12 L40 24 Z" fill="' + b + '" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
        '<path d="M76 34 L82 12 L60 24 Z" fill="' + b + '" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
        '<path d="M26 30 L23 19 L34 25 Z" fill="#FFC2CE"/><path d="M74 30 L77 19 L66 25 Z" fill="#FFC2CE"/>' +
        head(b, 50, 34, 31) +
        eyes(38, 62, 46, 5.5, true) +
        '<path d="M50 56 l-5 -5 h10z" fill="#FF9AB0" stroke="' + INK + '" stroke-width="2.5" stroke-linejoin="round"/>' +
        '<path d="M44 60 q6 6 12 0" stroke="' + INK + '" stroke-width="3.5" fill="none" stroke-linecap="round"/>' +
        '<path d="M34 52 h-16 M34 57 h-15 M66 52 h16 M66 57 h15" stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round" opacity=".65"/>' +
        '<g transform="rotate(-8 62 82)">' +
        '<rect x="40" y="70" width="48" height="24" rx="5" fill="#FFF0DE" stroke="' + INK + '" stroke-width="3.5"/>' +
        (globalThis.I18N ? globalThis.I18N.t("text.130") : "<text x=\"64\" y=\"86\" font-size=\"13\" font-weight=\"900\" text-anchor=\"middle\" fill=\"#D2444F\">勿敲</text>") +
        '</g>';
    }
  };

  /**
   * 取得一隻地鼠的 SVG 內容（不含 <svg> 外層），供 render.js 組裝。
   * @param {string} key   地鼠種類
   * @param {number} hpLeft 剩餘血量（鐵盔鼠與大王鼠會依此換造型）
   */
  function moleArt(key, hpLeft, dizzy) {
    var fn = MOLE_ART[key] || MOLE_ART.mole;
    dizzyOn = !!dizzy;
    try { return fn(hpLeft); } finally { dizzyOn = false; }
  }

  /** 頒獎台上的玩家頭像：圓圓的小地鼠，身體顏色就是玩家色；第 1 名頭上戴皇冠 */
  function avatar(hex, champ) {
    var crown = champ
      ? '<path d="M27 22l6-14 11 9 6-13 6 13 11-9 6 14z" fill="#FFD65C" stroke="' + INK + '" stroke-width="3.5" stroke-linejoin="round"/>' +
        '<rect x="27" y="21" width="46" height="7" rx="2" fill="#E8B72E" stroke="' + INK + '" stroke-width="3.5"/>' +
        '<circle cx="50" cy="12" r="2.6" fill="#FF8FA3"/>'
      : '';
    return '<svg viewBox="0 0 100 100" class="av-svg" aria-hidden="true">' +
      '<circle cx="24" cy="46" r="13" fill="' + hex + '" stroke="' + INK + '" stroke-width="4"/><circle cx="24" cy="46" r="6" fill="#FFD0DC"/>' +
      '<circle cx="76" cy="46" r="13" fill="' + hex + '" stroke="' + INK + '" stroke-width="4"/><circle cx="76" cy="46" r="6" fill="#FFD0DC"/>' +
      '<circle cx="50" cy="62" r="32" fill="' + hex + '" stroke="' + INK + '" stroke-width="4.5"/>' +
      '<ellipse cx="50" cy="73" rx="15" ry="11" fill="#FFE7D6" stroke="' + INK + '" stroke-width="3.5"/>' +
      '<ellipse cx="50" cy="68" rx="5.5" ry="3.8" fill="' + INK + '"/>' +
      '<path d="M44 76q6 6 12 0" stroke="' + INK + '" stroke-width="3.5" fill="none" stroke-linecap="round"/>' +
      '<circle cx="37" cy="58" r="5" fill="' + INK + '"/><circle cx="63" cy="58" r="5" fill="' + INK + '"/>' +
      '<circle cx="38.8" cy="56" r="1.8" fill="#fff"/><circle cx="64.8" cy="56" r="1.8" fill="#fff"/>' +
      '<circle cx="27" cy="70" r="4.5" fill="#FF9FB6" opacity=".75"/><circle cx="73" cy="70" r="4.5" fill="#FF9FB6" opacity=".75"/>' +
      crown + '</svg>';
  }

  /** 暈眩小星星（繞著頭轉的三顆星） */
  function stars() {
    function star(cx, cy, r) {
      var p = [];
      for (var i = 0; i < 10; i++) {
        var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
        p.push((cx + Math.cos(a) * rr).toFixed(1) + ',' + (cy + Math.sin(a) * rr).toFixed(1));
      }
      return '<polygon points="' + p.join(' ') + '" fill="#FFD65C" stroke="' + INK + '" stroke-width="3" stroke-linejoin="round"/>';
    }
    return '<svg viewBox="0 0 100 40" class="stars-svg" aria-hidden="true">' + star(20, 22, 11) + star(50, 12, 13) + star(80, 22, 11) + '</svg>';
  }

  /** 成就徽章：圓形獎牌 + 每枚各自的圖樣；locked 時畫成灰色 */
  function badge(id, locked) {
    var col = { clean: '#A9E7D2', combo30: '#FFB8CF', golden: '#FFD65C', sharp: '#AED9F5', rainbow: '#C9B6F5', hundred: '#FFC2B4', win: '#FFE3A0' }[id] || '#C9B6F5';
    if (locked) col = '#E4DDEC';
    var glyph = {
      clean: '<path d="M32 52l12 12 24-26" fill="none" stroke="' + INK + '" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>',
      combo30: '<path d="M50 24c6 12 18 16 18 32a18 18 0 0 1-36 0c0-8 4-12 8-16 0 6 4 8 6 8-2-10 2-18 4-24z" fill="#FFF" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>',
      golden: '<path d="M50 24l7 15 16 2-12 11 4 16-15-9-15 9 4-16-12-11 16-2z" fill="#FFF" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>',
      sharp: '<circle cx="50" cy="50" r="22" fill="none" stroke="' + INK + '" stroke-width="5"/><circle cx="50" cy="50" r="11" fill="none" stroke="' + INK + '" stroke-width="5"/><circle cx="50" cy="50" r="3.5" fill="' + INK + '"/>',
      rainbow: '<path d="M24 62a26 26 0 0 1 52 0" fill="none" stroke="#FF8FA3" stroke-width="7" stroke-linecap="round"/><path d="M33 62a17 17 0 0 1 34 0" fill="none" stroke="#FFD65C" stroke-width="7" stroke-linecap="round"/><path d="M41 62a9 9 0 0 1 18 0" fill="none" stroke="#7ED9A8" stroke-width="7" stroke-linecap="round"/>',
      hundred: '<rect x="36" y="26" width="28" height="17" rx="4" fill="#FFF" stroke="' + INK + '" stroke-width="5"/><path d="M50 43v28" stroke="' + INK + '" stroke-width="7" stroke-linecap="round"/>',
      win: '<path d="M32 30h36v14a18 18 0 0 1-36 0z" fill="#FFF" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/><path d="M50 62v10M40 74h20" stroke="' + INK + '" stroke-width="6" stroke-linecap="round"/>'
    }[id] || '';
    if (locked) glyph = '<path d="M38 38a12 12 0 1 1 18 10c-4 3-6 5-6 10" fill="none" stroke="#9A8CAA" stroke-width="7" stroke-linecap="round"/><circle cx="50" cy="70" r="4.5" fill="#9A8CAA"/>';
    return '<svg viewBox="0 0 100 100" class="badge-svg' + (locked ? ' locked' : '') + '" aria-hidden="true">' +
      '<path d="M32 74l-8 20 16-6 8 10 6-26zM68 74l8 20-16-6-8 10-6-26z" fill="' + (locked ? '#CFC5DA' : '#FF8FA3') + '" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
      '<circle cx="50" cy="48" r="38" fill="' + col + '" stroke="' + INK + '" stroke-width="5"/>' +
      '<circle cx="50" cy="48" r="29" fill="none" stroke="#fff" stroke-width="3" opacity=".7"/>' + glyph + '</svg>';
  }

  /** 完整的 <svg>，圖鑑、結算畫面直接用 */
  function moleSvg(key, hpLeft, cls) {
    return '<svg class="' + (cls || 'mole-svg') + '" viewBox="0 0 100 100" aria-hidden="true">' +
      moleArt(key, hpLeft) + '</svg>';
  }

  /* ---- 地洞 ----
   * 分成前後兩層，地鼠夾在中間，看起來就真的是從洞裡冒出來：
   *   holeBack  草皮 + 土堆 + 黑黑的洞口（畫在地鼠後面）
   *   holeFront 洞口前緣的土（畫在地鼠前面，遮住牠的下半身）
   */
  function holeBack() {
    return ''
      /* 草皮 */
      + '<ellipse cx="50" cy="72" rx="49" ry="27" fill="#9ED18A"/>'
      + '<ellipse cx="50" cy="70" rx="49" ry="27" fill="#B6DE9E"/>'
      /* 土堆 */
      + '<ellipse cx="50" cy="66" rx="43" ry="23" fill="#B98C5F" stroke="#6B4E30" stroke-width="3.5"/>'
      + '<ellipse cx="50" cy="64" rx="37" ry="19" fill="#A87D4E"/>'
      /* 洞口 */
      + '<ellipse cx="50" cy="62" rx="31" ry="15.5" fill="#4A3524"/>'
      + '<ellipse cx="50" cy="64" rx="27" ry="12" fill="#2A1D14"/>'
      /* 草叢點綴 */
      + '<path d="M8 74 q3 -9 6 0 q3 -7 6 0" fill="none" stroke="#6FAF58" stroke-width="3.4" stroke-linecap="round"/>'
      + '<path d="M80 76 q3 -9 6 0 q3 -7 6 0" fill="none" stroke="#6FAF58" stroke-width="3.4" stroke-linecap="round"/>';
  }
  function holeFront() {
    return ''
      /* 洞口前緣：擋住地鼠的下半身，讓牠像是卡在洞裡 */
      + '<ellipse cx="50" cy="80" rx="41" ry="18" fill="#B98C5F" stroke="#6B4E30" stroke-width="3.5"/>'
      + '<ellipse cx="50" cy="78" rx="34" ry="12" fill="#C79A6C"/>'
      + '<path d="M26 79 q7 -4 14 -1 M60 80 q7 -4 14 -1" stroke="#A87D4E" stroke-width="3.4" stroke-linecap="round" fill="none"/>';
  }

  /* ---- 槌子（滑鼠游標 / 揮槌動畫 / 設定預覽 / 結算裝飾） ----
   * 三款手繪向量槌子，同一個 100×100 座標：槌頭在上（約 y12–46、中心 50,29），
   * 握把朝下。全部用純色疊層做出立體感（不用漸層 id，才不會在隱藏的彈窗裡失效）。 */
  var HAMMER_STYLES = ['classic', 'soft', 'gold'];

  function hammerArt(style) {
    var I = INK;
    if (style === 'soft') {
      return ''
        + '<rect x="45" y="40" width="10" height="46" rx="5" fill="#FFF1D6" stroke="' + I + '" stroke-width="4"/>'
        + '<path d="M45 52l10-6M45 62l10-6M45 72l10-6" stroke="#FF8FA8" stroke-width="3.4" stroke-linecap="round"/>'
        + '<circle cx="50" cy="88" r="7.5" fill="#FF8FA8" stroke="' + I + '" stroke-width="4"/>'
        + '<circle cx="47.5" cy="85.5" r="2.2" fill="#fff" opacity=".65"/>'
        + '<rect x="11" y="9" width="78" height="40" rx="20" fill="#FF9DB5" stroke="' + I + '" stroke-width="4.5"/>'
        + '<rect x="22" y="9" width="6" height="40" fill="#FFF1D6" stroke="' + I + '" stroke-width="3"/>'
        + '<rect x="72" y="9" width="6" height="40" fill="#FFF1D6" stroke="' + I + '" stroke-width="3"/>'
        + '<rect x="30" y="14" width="22" height="7" rx="3.5" fill="#fff" opacity=".6"/>'
        + '<ellipse cx="36" cy="35" rx="5" ry="3" fill="#FF6F94" opacity=".6"/>'
        + '<ellipse cx="64" cy="35" rx="5" ry="3" fill="#FF6F94" opacity=".6"/>'
        + '<circle cx="43" cy="29" r="2.6" fill="' + I + '"/><circle cx="57" cy="29" r="2.6" fill="' + I + '"/>'
        + '<path d="M46.5 34q3.5 3.6 7 0" fill="none" stroke="' + I + '" stroke-width="2.4" stroke-linecap="round"/>'
        + '<rect x="14" y="40" width="72" height="6" rx="3" fill="#E0577F" opacity=".18"/>';
    }
    if (style === 'gold') {
      return ''
        + '<rect x="43" y="38" width="14" height="55" rx="7" fill="#7A4A2B" stroke="' + I + '" stroke-width="4"/>'
        + '<rect x="45.5" y="42" width="3" height="46" rx="1.5" fill="#fff" opacity=".22"/>'
        + '<rect x="41" y="52" width="18" height="6" rx="2.5" fill="#FFD65C" stroke="' + I + '" stroke-width="3"/>'
        + '<rect x="41" y="70" width="18" height="6" rx="2.5" fill="#FFD65C" stroke="' + I + '" stroke-width="3"/>'
        + '<rect x="40" y="86" width="20" height="8" rx="4" fill="#FFD65C" stroke="' + I + '" stroke-width="3.5"/>'
        + '<rect x="9" y="10" width="82" height="38" rx="10" fill="#FFD65C" stroke="' + I + '" stroke-width="4.5"/>'
        + '<rect x="9" y="10" width="17" height="38" rx="9" fill="#E8A92A" stroke="' + I + '" stroke-width="4.5"/>'
        + '<rect x="74" y="10" width="17" height="38" rx="9" fill="#E8A92A" stroke="' + I + '" stroke-width="4.5"/>'
        + '<path d="M34 22h32M34 36h32" stroke="#E8A92A" stroke-width="2.6" stroke-linecap="round"/>'
        + '<rect x="30" y="14" width="30" height="5" rx="2.5" fill="#fff" opacity=".6"/>'
        + '<rect x="12" y="41" width="76" height="5" rx="2.5" fill="#B87812" opacity=".3"/>'
        + '<circle cx="50" cy="29" r="7" fill="#FF5C7A" stroke="' + I + '" stroke-width="3"/>'
        + '<circle cx="47.6" cy="26.6" r="2" fill="#fff" opacity=".8"/>'
        + '<svg x="12" y="12" width="76" height="34" overflow="hidden"><g class="ham-shine"><rect x="-26" y="-4" width="12" height="44" fill="#fff" opacity=".7" transform="skewX(-20)"/></g></svg>';
    }
    /* classic：經典木槌 —— 木紋槌頭＋金屬箍＋纏帶握把 */
    return ''
      + '<rect x="43" y="38" width="14" height="55" rx="7" fill="#D9A066" stroke="' + I + '" stroke-width="4"/>'
      + '<path d="M47.5 46v38M52.5 50v30" stroke="#A8703A" stroke-width="2" stroke-linecap="round" opacity=".7"/>'
      + '<rect x="45" y="40" width="3" height="48" rx="1.5" fill="#fff" opacity=".3"/>'
      + '<rect x="42" y="68" width="16" height="22" rx="6" fill="#8B5A33" stroke="' + I + '" stroke-width="3.5"/>'
      + '<path d="M43 74l14 4M43 82l14 4" stroke="#C9A177" stroke-width="2.4" stroke-linecap="round"/>'
      + '<rect x="12" y="12" width="76" height="34" rx="11" fill="#C27F45" stroke="' + I + '" stroke-width="4.5"/>'
      + '<rect x="12" y="12" width="14" height="34" rx="8" fill="#9A5F2F" stroke="' + I + '" stroke-width="4.5"/>'
      + '<rect x="74" y="12" width="14" height="34" rx="8" fill="#9A5F2F" stroke="' + I + '" stroke-width="4.5"/>'
      + '<path d="M36 23h28M38 30h24M36 37h28" stroke="#8F5A2C" stroke-width="2.2" stroke-linecap="round" opacity=".65"/>'
      + '<rect x="29" y="11" width="7" height="36" fill="#CFD8E2" stroke="' + I + '" stroke-width="3"/>'
      + '<rect x="64" y="11" width="7" height="36" fill="#CFD8E2" stroke="' + I + '" stroke-width="3"/>'
      + '<rect x="30.5" y="13" width="2" height="32" fill="#fff" opacity=".7"/>'
      + '<rect x="39" y="15" width="22" height="5" rx="2.5" fill="#fff" opacity=".35"/>'
      + '<rect x="15" y="40" width="70" height="5" rx="2.5" fill="#000" opacity=".12"/>';
  }

  function hammer(style) {
    return '<svg viewBox="0 0 100 100" class="hammer-svg" aria-hidden="true">' + hammerArt(style) + '</svg>';
  }

  function dataUrl(svg) {
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  /* ---- 可愛鐵鎚滑鼠游標 ----
   * 和其他地方同一支槌子，斜著拿。游標圖一定要有明確的 width/height
   * （不能只給 viewBox），而且 Chrome 只吃 128px 以內，所以固定畫成 64px。
   * 熱點放在槌頭中心：玩家覺得「打到的是槌頭」，不是滑鼠箭頭的尖端。
   */
  function hammerCursor(hit, style) {
    var deg = hit ? 44 : 18;   // 按下去時多甩一點，像真的敲下去
    var q = String.fromCharCode(34);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 100 100">' +
        '<g transform="translate(0,4) rotate(' + deg + ' 50 30)">' + hammerArt(style) + '</g>' +
      '</svg>';
    /* 32 21 = 槌頭中心換算到 64px 圖上的座標 */
    return 'url(' + q + dataUrl(svg) + q + ') 32 21, pointer';
  }

  /* 結算、戰績標題前面的小裝飾（CSS 變數用的 url()） */
  function hammerDeco(style) {
    var q = String.fromCharCode(34);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 100 100">' +
      '<g transform="rotate(-24 50 50)">' + hammerArt(style) + '</g></svg>';
    return 'url(' + q + dataUrl(svg) + q + ')';
  }

  /* ---- 標題 LOGO ---- */
  function logo() {
    return '<svg viewBox="0 0 320 130" class="logo-svg" aria-hidden="true">' +
      '<ellipse cx="160" cy="112" rx="130" ry="16" fill="#C9B6F5" opacity=".45"/>' +
      '<g transform="translate(28,26) scale(0.62)">' + MOLE_ART.mole() + '</g>' +
      '<g transform="translate(196,20) scale(0.55)">' + MOLE_ART.bunny() + '</g>' +
      '<g transform="translate(118,6) rotate(18) scale(0.66)">' + hammerArt('classic') + '</g>' +
      '</svg>';
  }

  function trophy() {
    return '<svg viewBox="0 0 100 100" class="trophy-svg" aria-hidden="true">' +
      '<path d="M26 16h48v22a24 24 0 0 1-48 0z" fill="#FFD65C" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
      '<path d="M26 22H14a14 14 0 0 0 14 14M74 22h12a14 14 0 0 1-14 14" fill="none" stroke="' + INK + '" stroke-width="4"/>' +
      '<rect x="42" y="60" width="16" height="14" fill="#E0AE2C" stroke="' + INK + '" stroke-width="4"/>' +
      '<rect x="28" y="74" width="44" height="12" rx="5" fill="#FFD65C" stroke="' + INK + '" stroke-width="4"/>' +
      '<circle cx="50" cy="34" r="7" fill="#fff" opacity=".55"/>' +
      '</svg>';
  }

  /* ---- 背景漂浮裝飾 ---- */
  function bgDeco(host) {
    if (!host) return;
    var colors = ['#C9B6F5', '#A9E7D2', '#FFC2B4', '#AED9F5', '#FFE3A0'];
    var html = '';
    for (var i = 0; i < 14; i++) {
      var size = 26 + (i % 5) * 16;
      html += '<span style="left:' + ((i * 7.3) % 96) + '%;top:' + ((i * 13.7) % 92) + '%;'
        + 'width:' + size + 'px;height:' + size + 'px;background:' + colors[i % colors.length] + ';'
        + 'animation-duration:' + (9 + (i % 6) * 2.5) + 's;animation-delay:-' + (i * 1.3) + 's"></span>';
    }
    host.innerHTML = html;
  }

  w.SvgUI = {
    PALETTE: PALETTE,
    INK: INK,
    decorate: decorate,
    decorateAll: decorateAll,
    repaintAll: repaintAll,
    paint: paint,
    setLabel: setLabel,
    setColor: setColor,
    moleArt: moleArt,
    moleSvg: moleSvg,
    stars: stars,
    avatar: avatar,
    badge: badge,
    holeBack: holeBack,
    holeFront: holeFront,
    hammer: hammer,
    hammerCursor: hammerCursor,
    hammerArt: hammerArt,
    hammerDeco: hammerDeco,
    HAMMER_STYLES: HAMMER_STYLES,
    logo: logo,
    trophy: trophy,
    bgDeco: bgDeco
  };
}(window));
