/* ============================================================
 * fundamentals.js — 通达信基本面（主力净流入 / DDX / 自由换手）独立加载器
 *
 * 为什么单独一个文件：
 *   这些字段原本被 update_cloud.py 折叠进 app-data.js（10 MB 整体重建）。
 *   只要那次跑批没带 fundamentals，主力资金流面板就整片空白，
 *   而且要等一次完整重建才能恢复 —— 2026-11-05 就是这样丢掉了一晚上。
 *   现在 fundamentals.json（约 500 KB）单独发布、单独加载，
 *   主数据怎么变都不影响这块面板。
 *
 * 设计约束：
 *   1. 不修改 app21.js 的内部状态；只往 window.DATA.all_stocks 里补字段，
 *      再调用 app21 已经导出的全局渲染函数。
 *   2. 任何一步失败都必须安静降级（面板显示"暂无"并说明原因），
 *      绝不能让主页面因为基本面加载失败而卡住或报错。
 *   3. 只有用户还停在全市场视图时才重绘个股表，避免打断板块下钻。
 * ============================================================ */
(function () {
  "use strict";

  var COS_HOST = "https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com";
  // 与 scripts/make_fundamentals_slim.py 的 COLS 一一对应，改一处必须改两处
  var COLS = ["c", "mainlx", "m3", "m5", "m10", "ddx", "ddy", "ddz", "gdr", "free", "px", "ipo", "pe"];

  var STATUS = { state: "idle", source: "", updated_at: "", count: 0, merged: 0, error: "" };
  window.__AMV_FUND = STATUS;

  function log() {
    if (window.console && console.debug) {
      console.debug.apply(console, ["[fund]"].concat([].slice.call(arguments)));
    }
  }

  /* ── 1. 等主数据就绪 ──────────────────────────────────────────
   * 注意：不要等 window.DATA。现代浏览器路径下 app21.js 的 load() 走
   * d2.js.gz + DecompressionStream，数据留在脚本内的 `let D` 里，
   * window.DATA 只在旧浏览器 / app-data.js 回退路径里才有。
   * 可靠的就绪信号是 app21 渲染时导出的 window.__AMV_META / __AMV_DATA。 */
  function whenData(cb, tries) {
    tries = tries == null ? 80 : tries; // 80 × 250ms ≈ 20s
    var D = window.__AMV_DATA;
    if (D && D.all_stocks && D.all_stocks.length) return cb(D);
    if (tries <= 0) return cb(null);
    setTimeout(function () { whenData(cb, tries - 1); }, 250);
  }

  /* ── 2. 拉取：COS 优先，回落到本地 Pages ───────────────────── */
  function fetchPayload() {
    var urls = [
      COS_HOST + "/fundamentals.json?t=" + Date.now(),
      "fundamentals.json?v=" + Date.now()
    ];
    var i = 0;
    function next() {
      if (i >= urls.length) {
        STATUS.state = "error";
        STATUS.error = "fundamentals.json 拉取失败（COS 与本地均不可用）";
        log(STATUS.error);
        return Promise.reject(new Error(STATUS.error));
      }
      var u = urls[i++];
      return fetch(u, { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (j) {
        STATUS.source = u.indexOf(COS_HOST) === 0 ? "cos" : "pages";
        return j;
      }).catch(function (e) {
        log("拉取失败", u, e && e.message);
        return next();
      });
    }
    return next();
  }

  /* ── 3. 合并 ─────────────────────────────────────────────────
   * 注意：页面上有三份同源但不同对象的个股数组 ——
   *   D.all_stocks  → 主力资金流面板
   *   D.stocks_top  → 个股表的「全市场 Top 50/80」（showMarketStocks 读这个）
   *   D.stocks_amv  → 「活跃SZ(递推)」口径的列表
   * 只合并 all_stocks 会出现"面板有数据、表格主力列还是 —"的假象，三份都要贴。 */
  function applyTo(arr, pos, rows) {
    if (!arr || !arr.length) return 0;
    var idx = Object.create(null);
    for (var i = 0; i < arr.length; i++) idx[arr[i].code] = arr[i];
    var n = 0;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var s = idx[row[pos.c]];
      if (!s) continue;
      s.mainlx = row[pos.mainlx];
      if (pos.m3 != null) s.m3 = row[pos.m3];
      s.m5 = row[pos.m5];
      if (pos.m10 != null) s.m10 = row[pos.m10];
      s.ddx = row[pos.ddx];
      if (pos.ddy != null) s.ddy = row[pos.ddy];
      if (pos.ddz != null) s.ddz = row[pos.ddz];
      s.gdr = row[pos.gdr];
      // 个股表的「上市」「PE」两列：stocks_top 里从来没有，靠这里补
      if (pos.ipo != null && row[pos.ipo] && s.ipo == null) s.ipo = row[pos.ipo];
      if (pos.pe != null && row[pos.pe] && s.pe == null) s.pe = row[pos.pe];
      // 自由流通换手率 = 成交金额 ÷ (自由流通股数 × 价格) × 100
      // 量纲提醒：free 单位是「万股」，必须先 ×1e4 换成股，再乘价格才是自由流通市值。
      if (s.fturn == null) {
        var free = row[pos.free], px = row[pos.px];
        if (free && px && s.amount) {
          s.fturn = Math.round(s.amount / (free * 1e4 * px) * 100 * 100) / 100;
        }
      }
      n++;
    }
    return n;
  }

  function merge(D, payload) {
    var cols = payload.cols || COLS;
    var rows = payload.rows || [];
    var pos = {};
    for (var c = 0; c < cols.length; c++) pos[cols[c]] = c;

    var a = applyTo(D.all_stocks, pos, rows);
    applyTo(D.stocks_top, pos, rows);
    applyTo(D.stocks_amv, pos, rows);

    D.fundamentals_updated_at = payload.updated_at || "";
    D.fundamentals_count = a;
    STATUS.merged = a;
    STATUS.updated_at = payload.updated_at || "";
    STATUS.count = payload.count || rows.length;
    return a;
  }

  /* ── 4. 重绘受影响的块 ─────────────────────────────────────── */
  function repaint() {
    try {
      if (typeof window.renderFlow === "function") window.renderFlow();
    } catch (e) { log("renderFlow 失败", e && e.message); }

    // 个股表里也有「主力(亿)」列，但只有在全市场视图下重绘才安全；
    // 用户正在看某个板块时重绘会把他踢回全市场。
    try {
      var t = document.getElementById("stockTableTitle");
      var title = t ? t.textContent || "" : "";
      if (/全市场/.test(title) && typeof window.showMarketStocks === "function") {
        window.showMarketStocks();
      }
    } catch (e) { log("showMarketStocks 失败", e && e.message); }
  }

  /* ── 5. 主流程 ─────────────────────────────────────────────── */
  var PAYLOAD = null;

  /* 供 app21.js 的 renderAll() 在整包数据刷新后回调：
     那时 D 已是新对象，之前贴上去的字段全丢了，必须重新合并。 */
  window.__AMV_FUND_APPLY = function () {
    if (!PAYLOAD) return;
    var D = window.__AMV_DATA;
    if (!D || !D.all_stocks || !D.all_stocks.length) return;
    if (D.fundamentals_updated_at) return; // 这个数据对象已经贴过了
    var n = merge(D, PAYLOAD);
    log("重新合并", n);
    try { if (typeof window.renderFlow === "function") window.renderFlow(); } catch (e) { /* noop */ }
    try {
      var t = document.getElementById("stockTableTitle");
      if (t && /全市场/.test(t.textContent || "") && typeof window.showMarketStocks === "function") {
        window.showMarketStocks();
      }
    } catch (e) { /* noop */ }
  };

  STATUS.state = "loading";
  fetchPayload().then(function (payload) {
    PAYLOAD = payload;
    whenData(function (D) {
      if (!D) {
        STATUS.state = "error";
        STATUS.error = "行情主数据未就绪，基本面暂时无法合并";
        log(STATUS.error);
        renderDiag();
        return;
      }
      var n = merge(D, payload);
      STATUS.state = n > 0 ? "ready" : "empty";
      log("合并完成", n, "/", D.all_stocks.length, "updated_at=", STATUS.updated_at);
      repaint();
      renderDiag();
    });
  }).catch(function () {
    // fetchPayload 已记录错误；这里只需要让面板能说明原因
    try { if (typeof window.renderFlow === "function") window.renderFlow(); } catch (e) { /* noop */ }
    renderDiag();
  });

  /* ── 6. 诊断：地址栏加 ?diag=1 时，把运行时状态贴到页面上 ─────
   * 这个页面已经两次栽在"我这边验证成功、用户那边看不见"上：
   * 一次是上传了没发布，一次是数据没同步。以后排查不用再猜，直接看这行数字。 */
  function renderDiag() {
    if (!/[?&]diag=1/.test(location.search)) return;
    var D = window.__AMV_DATA || {};
    var box = document.getElementById("fundDiag");
    if (!box) {
      box = document.createElement("div");
      box.id = "fundDiag";
      box.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;background:rgba(0,0,0,.82);" +
        "color:#8fe28f;font:11px/1.6 monospace;padding:8px 10px;border-radius:6px;max-width:62vw;" +
        "white-space:pre-wrap;pointer-events:none;";
      document.body.appendChild(box);
    }
    var n = (D.all_stocks || []).filter(function (s) { return s.mainlx != null && s.mainlx !== 0; }).length;
    box.textContent = JSON.stringify({
      fund: window.__AMV_FUND,
      all_stocks: (D.all_stocks || []).length,
      stocks_top: (D.stocks_top || []).length,
      withMainlx: n,
      fundamentals_updated_at: D.fundamentals_updated_at || "",
      data_updated_at: D.updated_at || ""
    }, null, 1);
  }
})();
