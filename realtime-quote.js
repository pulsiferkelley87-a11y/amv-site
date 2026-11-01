/**
 * realtime-quote.js —— 浏览器端直连 A 股行情
 *
 * 为什么能直连：腾讯 qt.gtimg.cn 不返回 Access-Control-Allow-Origin，
 * fetch() 会被 CORS 挡死；但它返回的是 JS 赋值语句（v_sh600000="..."），
 * 用 <script src> 加载就不受同源策略约束，加载完直接读 window.v_sh600000。
 *
 * 注意编码：响应是 GBK，必须给 script 标签设 charset，否则中文名乱码。
 *
 * 无依赖，IIFE 挂到 window.Quote。
 */
(function (global) {
  'use strict';

  var ENDPOINT = 'https://qt.gtimg.cn/q=';
  var TIMEOUT_MS = 8000;
  var BATCH = 50;

  /** 字段下标（腾讯行情串，按 '~' 切分后取值；已对照实测数据核对） */
  var F = {
    market: 0, name: 1, code: 2, price: 3, prevClose: 4, open: 5,
    volumeHand: 6, outerVol: 7, innerVol: 8,
    time: 30, change: 31, changePct: 32, high: 33, low: 34,
    turnoverRate: 38, pe: 39, amplitude: 43,
    floatCapYi: 44, totalCapYi: 45, pb: 46, limitUp: 47, limitDown: 48,
  };

  var cache = Object.create(null);   // code -> { at, data }
  var inflight = Object.create(null); // code -> Promise

  /* ── 代码规范化：600000 → sh600000 ── */
  function normalize(raw) {
    var c = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!c) return '';
    if (/^(sh|sz|bj)\d{6}$/.test(c)) return c;
    if (!/^\d{6}$/.test(c)) return c;              // 交给服务端判断
    var h = c.charAt(0);
    if (h === '6' || h === '9') return 'sh' + c;
    if (h === '0' || h === '3') return 'sz' + c;
    if (h === '4' || h === '8') return 'bj' + c;   // 北交所
    return 'sh' + c;
  }

  /* ── 交易时段判断：决定缓存时长 ── */
  function inSession(now) {
    var d = now || new Date();
    var day = d.getDay();
    if (day === 0 || day === 6) return false;
    var m = d.getHours() * 60 + d.getMinutes();
    return (m >= 555 && m <= 695) || (m >= 775 && m <= 905); // 09:15-11:35, 12:55-15:05
  }

  function ttl() { return inSession() ? 3000 : 60000; }

  /* ── 解析一条行情串 ── */
  function parse(code, raw) {
    if (typeof raw !== 'string' || raw.indexOf('~') < 0) return null;
    var p = raw.split('~');
    var num = function (i, scale) {
      var v = parseFloat(p[i]);
      return isFinite(v) ? v : null;
    };
    var t = p[F.time] || '';
    return {
      code: code,
      symbol: p[F.code] || code.slice(2),
      name: p[F.name] || '',
      price: num(F.price),
      prevClose: num(F.prevClose),
      open: num(F.open),
      high: num(F.high),
      low: num(F.low),
      change: num(F.change),
      changePct: num(F.changePct),
      volumeHand: num(F.volumeHand),
      turnoverRate: num(F.turnoverRate),
      amplitude: num(F.amplitude),
      pe: num(F.pe),
      pb: num(F.pb),
      floatCapYi: num(F.floatCapYi),
      totalCapYi: num(F.totalCapYi),
      limitUp: num(F.limitUp),
      limitDown: num(F.limitDown),
      time: /^\d{14}$/.test(t) ? t : null,
      timeISO: /^\d{14}$/.test(t)
        ? t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) + ' ' +
          t.slice(8, 10) + ':' + t.slice(10, 12) + ':' + t.slice(12, 14)
        : null,
      stale: false,
    };
  }

  /* ── 用 script 标签拉一批（绕开 CORS），返回 Promise ── */
  function loadBatch(codes) {
    return new Promise(function (resolve) {
      if (!codes.length) return resolve([]);
      var url = ENDPOINT + codes.join(',') + '&_=' + Date.now();
      var el = document.createElement('script');
      var done = false;

      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (el.parentNode) el.parentNode.removeChild(el);
        var out = [];
        codes.forEach(function (c) {
          var raw = global['v_' + c];
          var rec = raw ? parse(c, raw) : null;
          if (rec) out.push(rec);
          try { delete global['v_' + c]; } catch (e) { global['v_' + c] = undefined; }
        });
        if (!ok && !out.length) {
          // 请求失败：把上次缓存标成 stale 回给调用方，好过没有
          codes.forEach(function (c) {
            if (cache[c]) out.push(Object.assign({}, cache[c].data, { stale: true }));
          });
        }
        resolve(out);
      }

      el.charset = 'GBK';        // 响应是 GBK，不设会导致中文名乱码
      el.src = url;
      el.onload = function () { finish(true); };
      el.onerror = function () { finish(false); };
      var timer = setTimeout(function () { finish(false); }, TIMEOUT_MS);
      (document.head || document.documentElement).appendChild(el);
    });
  }

  /**
   * 取行情。codes 可以是单个代码或数组；返回对象数组。
   * 命中缓存（交易时段 3s / 非交易时段 60s）时不发请求。
   */
  function fetchQuotes(codes) {
    var list = (Array.isArray(codes) ? codes : [codes]).map(normalize).filter(Boolean);
    var uniq = [];
    var seen = Object.create(null);
    list.forEach(function (c) { if (!seen[c]) { seen[c] = 1; uniq.push(c); } });

    var now = Date.now();
    var need = [];
    var ready = [];
    uniq.forEach(function (c) {
      var hit = cache[c];
      if (hit && now - hit.at < ttl()) ready.push(hit.data);
      else need.push(c);
    });

    if (!need.length) return Promise.resolve(ready);

    var jobs = [];
    for (var i = 0; i < need.length; i += BATCH) {
      var chunk = need.slice(i, i + BATCH);
      (function (chunk) {
        var key = chunk.join(',');
        var p = inflight[key] || (inflight[key] = loadBatch(chunk).then(function (rows) {
          delete inflight[key];
          var t = Date.now();
          rows.forEach(function (r) { cache[r.code] = { at: t, data: r }; });
          return rows;
        }, function (err) { delete inflight[key]; throw err; }));
        jobs.push(p);
      })(chunk);
    }

    return Promise.all(jobs).then(function (all) {
      var flat = [];
      all.forEach(function (arr) { flat = flat.concat(arr); });
      return flat;
    }).then(function (fetched) {
      var byCode = Object.create(null);
      fetched.forEach(function (r) { byCode[r.code] = r; });
      uniq.forEach(function (c) { if (!byCode[c] && cache[c]) byCode[c] = cache[c].data; });
      return uniq.map(function (c) { return byCode[c]; }).filter(Boolean);
    }).then(function (all) {
      return ready.length ? ready.concat(all) : all;
    });
  }

  /**
   * 轮询。返回 stop()。
   * 交易时段按 intervalMs（默认 3000）刷新；非交易时段自动降到 60s。
   */
  function watch(codes, onData, onError, intervalMs) {
    var stopped = false;
    var timer = null;
    var base = intervalMs || 3000;

    function tick() {
      if (stopped) return;
      fetchQuotes(codes).then(function (rows) {
        if (stopped) return;
        try { onData(rows); } catch (e) { /* 不打断轮询 */ }
      }, function (err) {
        if (stopped) return;
        if (onError) { try { onError(err); } catch (e) {} }
      }).then(function () {
        if (stopped) return;
        var wait = inSession() ? base : Math.max(base, 60000);
        timer = setTimeout(tick, wait);
      });
    }
    tick();
    return function stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  function clearCache() { cache = Object.create(null); }

  global.Quote = {
    fetch: fetchQuotes,
    watch: watch,
    normalize: normalize,
    clearCache: clearCache,
    inSession: inSession,
    _fields: F,
    _parse: parse,          // 暴露给单测；生产代码不需要
  };
})(typeof window !== 'undefined' ? window : globalThis);
