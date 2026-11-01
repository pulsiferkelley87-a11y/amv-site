/**
 * live-quote-bar.js —— 在页面顶部注入一条实时指数/自选行情带
 *
 * 设计原则：**纯附加**。不修改 app.js / app21.js，不读写它们的变量，
 * 只在自己的 DOM 节点里渲染；Quote 不存在时自动静默退出。
 *
 * 依赖：realtime-quote.js（window.Quote）必须在本文件之前加载。
 *
 * 配色沿用站点现有 CSS 变量（--up / --down / --muted / --border / --card），
 * 深色主题自动跟随，不写死颜色。
 */
(function () {
  'use strict';

  /** 默认展示的指数；改这里即可 */
  var CODES = ['sh000001', 'sz399001', 'sz399006', 'sh000300'];
  var UNITS = { sh000001: '上证', sz399001: '深成', sz399006: '创业板', sh000300: '沪深300' };

  function injectStyles() {
    if (document.getElementById('rt-bar-style')) return;
    var s = document.createElement('style');
    s.id = 'rt-bar-style';
    s.textContent = [
      '#rt-bar{display:flex;gap:18px;flex-wrap:wrap;align-items:center;',
      'padding:7px 16px;margin:0 0 10px;font-size:12.5px;',
      'background:var(--card,#fff);border-bottom:1px solid var(--border,#e5e7eb);}',
      '#rt-bar .rt-item{display:inline-flex;align-items:baseline;gap:6px;white-space:nowrap;}',
      '#rt-bar .rt-name{color:var(--muted,#6b7280);}',
      '#rt-bar .rt-price{font-variant-numeric:tabular-nums;font-weight:600;}',
      '#rt-bar .rt-chg{font-variant-numeric:tabular-nums;}',
      '#rt-bar .rt-up{color:var(--up,#d64545);}',
      '#rt-bar .rt-down{color:var(--down,#2fa36b);}',
      '#rt-bar .rt-flat{color:var(--muted,#6b7280);}',
      '#rt-bar .rt-dot{width:6px;height:6px;border-radius:50%;background:var(--muted,#9ca3af);}',
      '#rt-bar .rt-dot.on{background:var(--down,#2fa36b);}',
      '#rt-bar .rt-time{color:var(--muted,#6b7280);margin-left:auto;font-size:11.5px;}',
    ].join('');
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmt(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return Number(v).toFixed(digits);
  }

  function digitsFor(code) {
    // 指数点位保留 2 位；个股 2 位足够
    return 2;
  }

  function render(rows) {
    var bar = document.getElementById('rt-bar');
    if (!bar) return;
    var box = bar.querySelector('.rt-items');
    box.textContent = '';
    var newest = null;

    rows.forEach(function (r) {
      if (!r) return;
      var item = el('span', 'rt-item');
      item.appendChild(el('span', 'rt-name', UNITS[r.code] || r.name || r.code));

      var cls = 'rt-flat';
      if (r.change > 0) cls = 'rt-up';
      else if (r.change < 0) cls = 'rt-down';

      item.appendChild(el('span', 'rt-price ' + cls, fmt(r.price, digitsFor(r.code))));
      item.appendChild(el(
        'span',
        'rt-chg ' + cls,
        (r.changePct > 0 ? '+' : '') + fmt(r.changePct, 2) + '%'
      ));
      if (r.stale) item.title = '数据为上次缓存（接口暂时不可用）';
      box.appendChild(item);
      if (r.timeISO && (!newest || r.timeISO > newest)) newest = r.timeISO;
    });

    var dot = bar.querySelector('.rt-dot');
    if (dot) {
      dot.className = 'rt-dot' + (rows.some(function (r) { return r && !r.stale; }) ? ' on' : '');
      dot.title = Quote.inSession() ? '交易时段，3 秒刷新' : '非交易时段，60 秒刷新';
    }
    var t = bar.querySelector('.rt-time');
    if (t) t.textContent = newest ? '行情时间 ' + newest.slice(11, 19) : '';
  }

  function init() {
    if (!window.Quote) {
      // 行情模块未加载：静默退出，不影响页面任何功能
      if (window.console && console.info) {
        console.info('[rt-bar] realtime-quote.js 未加载，跳过实时行情条');
      }
      return;
    }
    if (document.getElementById('rt-bar')) return;

    injectStyles();

    var bar = el('div');
    bar.id = 'rt-bar';
    var dot = el('span', 'rt-dot');
    var box = el('span', 'rt-items');
    var time = el('span', 'rt-time', '');
    bar.appendChild(dot);
    bar.appendChild(box);
    bar.appendChild(time);

    var header = document.querySelector('header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(bar, header.nextSibling);
    } else {
      document.body.insertBefore(bar, document.body.firstChild);
    }

    if (Quote.inSession()) {
      /* 交易时段按 3 秒刷新 */
    }

    Quote.watch(CODES, render, function (err) {
      if (window.console && console.warn) console.warn('[rt-bar]', err);
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
