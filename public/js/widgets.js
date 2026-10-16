/* ===== widgets.js — 自繪元件：滑桿與捲軸 =====
 *
 * 瀏覽器原生的 <input type="range"> 和捲軸長相由系統決定，跟遊戲風格對不起來，
 * 所以改成自己畫：
 *   Widgets.slider(el, opts)   把 .slider 元素變成可拖曳、可用鍵盤操作的滑桿
 *   Widgets.setSlider(el, n)   由程式設定滑桿值（0 ~ 100）
 *   Widgets.scrollbar(el)      替會溢出的容器畫一條自繪捲軸（原生捲軸藏起來）
 * 這個檔案不含任何會顯示給玩家看的文字，所以不需要翻譯。
 */
(function (w) {
  'use strict';

  /* ------------------------------------------------------------ 滑桿 */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function paintSlider(el) {
    var v = Number(el.dataset.value) || 0;
    var pct = clamp(v, 0, 100);
    el.style.setProperty('--pct', pct + '%');
    el.setAttribute('aria-valuenow', String(Math.round(pct)));
    el.setAttribute('aria-valuetext', Math.round(pct) + '%');
  }

  function setSlider(el, v) {
    el.dataset.value = String(clamp(Math.round(Number(v) || 0), 0, 100));
    paintSlider(el);
  }

  function getSlider(el) { return Number(el.dataset.value) || 0; }

  /**
   * @param {HTMLElement} el   .slider 元素
   * @param {{step?:number, onInput?:function(number), onChange?:function(number)}} opts
   */
  function slider(el, opts) {
    opts = opts || {};
    var step = opts.step || 5;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.querySelector('.slider-knob')) {
      el.innerHTML = '<span class="slider-rail"><i class="slider-fill"></i></span><b class="slider-knob"></b>';
    }
    paintSlider(el);

    function fromPointer(e) {
      var r = el.getBoundingClientRect();
      var pad = 16;                                    // 旋鈕半徑，兩端留白
      var raw = (e.clientX - r.left - pad) / Math.max(1, r.width - pad * 2) * 100;
      return clamp(Math.round(raw / step) * step, 0, 100);
    }

    var dragging = false;
    el.addEventListener('pointerdown', function (e) {
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
      el.focus();
      setSlider(el, fromPointer(e));
      if (opts.onInput) opts.onInput(getSlider(el));
    });
    el.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      setSlider(el, fromPointer(e));
      if (opts.onInput) opts.onInput(getSlider(el));
    });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      if (opts.onChange) opts.onChange(getSlider(el));
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('keydown', function (e) {
      var v = getSlider(el);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += step;
      else if (e.key === 'Home') v = 0;
      else if (e.key === 'End') v = 100;
      else return;
      e.preventDefault();
      setSlider(el, v);
      if (opts.onInput) opts.onInput(getSlider(el));
      if (opts.onChange) opts.onChange(getSlider(el));
    });
  }

  /* ------------------------------------------------------------ 捲軸 */

  var bars = [];
  var raf = 0;

  function refreshAll() {
    raf = 0;
    for (var i = 0; i < bars.length; i++) layout(bars[i]);
  }
  function schedule() { if (!raf) raf = w.requestAnimationFrame(refreshAll); }

  function layout(b) {
    var el = b.el;
    var vis = el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
    var max = el.scrollHeight - el.clientHeight;
    if (!vis || max <= 2 || el.clientHeight < 40) { b.track.hidden = true; return; }
    b.track.hidden = false;
    var h = el.clientHeight;
    var trackPad = 6;
    var th = h - trackPad * 2;
    var thumb = clamp(Math.round(th * el.clientHeight / el.scrollHeight), 36, th);
    var top = Math.round((th - thumb) * (el.scrollTop / max));
    var parent = b.track.offsetParent || el.parentElement;
    var pr = parent.getBoundingClientRect();
    var er = el.getBoundingClientRect();
    b.track.style.left = Math.round(er.right - pr.left - parent.clientLeft - 11 + parent.scrollLeft) + 'px';
    b.track.style.top = Math.round(er.top - pr.top - parent.clientTop + trackPad + parent.scrollTop) + 'px';
    b.track.style.height = th + 'px';
    b.thumb.style.height = thumb + 'px';
    b.thumb.style.transform = 'translateY(' + top + 'px)';
  }

  function scrollbar(el) {
    if (!el || el.dataset.csb) return;
    el.dataset.csb = '1';
    el.classList.add('csb-host');
    var parent = el.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

    var track = document.createElement('div');
    track.className = 'csb-track';
    track.setAttribute('aria-hidden', 'true');
    track.hidden = true;
    var thumb = document.createElement('div');
    thumb.className = 'csb-thumb';
    track.appendChild(thumb);
    parent.appendChild(track);
    var b = { el: el, track: track, thumb: thumb };
    bars.push(b);

    el.addEventListener('scroll', schedule, { passive: true });
    if (w.ResizeObserver) {
      var ro = new ResizeObserver(schedule);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    if (w.MutationObserver) {
      new MutationObserver(schedule).observe(el, { childList: true, subtree: true, characterData: true });
    }

    var drag = null;
    thumb.addEventListener('pointerdown', function (e) {
      var max = el.scrollHeight - el.clientHeight;
      drag = { y: e.clientY, top: el.scrollTop, ratio: max / Math.max(1, track.clientHeight - thumb.offsetHeight) };
      try { thumb.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    thumb.addEventListener('pointermove', function (e) {
      if (!drag) return;
      el.scrollTop = drag.top + (e.clientY - drag.y) * drag.ratio;
    });
    var stop = function () { drag = null; };
    thumb.addEventListener('pointerup', stop);
    thumb.addEventListener('pointercancel', stop);
    track.addEventListener('pointerdown', function (e) {
      if (e.target === thumb) return;
      var r = track.getBoundingClientRect();
      el.scrollTop += (e.clientY < r.top + thumb.offsetTop ? -1 : 1) * el.clientHeight * 0.85;
    });
    schedule();
  }

  w.addEventListener('resize', schedule);
  w.addEventListener('orientationchange', schedule);
  /* 畫面切換、彈窗開關會改變顯示狀態但不一定觸發 resize，低頻補一次 */
  setInterval(function () { if (bars.length) schedule(); }, 600);

  w.Widgets = { slider: slider, setSlider: setSlider, getSlider: getSlider, scrollbar: scrollbar, refresh: schedule };
}(window));
