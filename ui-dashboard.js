/* ============================================================
   ui-dashboard.js —— 首页仪表盘骨架（KPI + 标签页）
   ------------------------------------------------------------
   做法：运行时把 .wrap 里现有的卡片分组搬进 4 个面板，
   生成顶部 KPI 条与粘性标签栏。**不改任何 HTML 结构**，
   所有元素 id 原样保留，app21.js 的渲染目标一个都没动。

   回滚：删掉 <script src="ui-dashboard.js"> 即可，页面回原样。

   关键风险与对策：
   1. 图表在 display:none 的容器里初始化会得到 0 尺寸。
      → 延迟隐藏（load 后 1.2s，此时图表已建好）；
      → 每次切到某页时，对页内 .chart 调 echarts.resize()。
   2. 原页面有 .grid 双列容器，直接搬 .card 会破坏栅格。
      → 以 .wrap 的直接子块为单位整体搬，不拆 .grid。
   3. 标题改了就分错组。
      → 规则按顺序匹配，兜底进「盘面」，并在控制台告警。
   ============================================================ */
(function () {
  "use strict";

  var wrap = document.querySelector(".wrap");
  var header = document.querySelector("header");
  if (!wrap) return;

  /* ── 页头高度 ─────────────────────────────────────────── */
  function syncHeaderHeight() {
    var h = header ? Math.round(header.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty("--header-h", h + "px");
  }
  syncHeaderHeight();
  window.addEventListener("resize", syncHeaderHeight);

  /* ── 分组规则（顺序敏感：先命中的生效） ──────────────── */
  var RULES = [
    [/牛熊|盘面总结|数据源状态|快讯/, "mkt"],
    [/板块|资金主线/, "sector"],
    [/官方\s*0AMV\s*叠加|三件套|活跃比例|周线|回测/, "hist"],
    [/快上穿|支撑共振|晋级|个股信号|今日选股|贡献/, "stock"]   // 贡献 放在板块规则之后，板块贡献仍归板块
  ];

  var TABS = [
    { key: "mkt", label: "盘面" },
    { key: "stock", label: "个股" },
    { key: "sector", label: "板块" },
    { key: "hist", label: "历史" }
  ];

  function textOfBlock(el) {
    var h2s = el.querySelectorAll("h2");
    var out = [];
    Array.prototype.forEach.call(h2s, function (h) {
      var c = h.cloneNode(true);
      Array.prototype.forEach.call(c.children, function (ch) {
        if (ch.tagName === "SPAN" || ch.tagName === "A") ch.remove();
      });
      out.push(c.textContent.replace(/\s+/g, " ").trim());
    });
    return out;
  }

  function groupOf(el) {
    var titles = textOfBlock(el).join(" ");
    if (!titles) return null;
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(titles)) return RULES[i][1];
    }
    return "mkt";
  }

  /* ── ① KPI 条：优先读 app21.js 导出的 window.__AMV_META，正则只作兜底 ─── */
  function metaAmount() {
    var M = window.__AMV_META;
    if (!M) return null;
    if (M.amount == null || isNaN(M.amount)) return null;
    return Number(M.amount).toFixed(2);
  }
  function amountSub() {
    var M = window.__AMV_META || {};
    var b = M.byMarket;
    if (b) return "万亿 · 沪 " + b.sh + " ／ 深 " + b.sz + " ／ 北 " + b.bj;
    return "万亿（沪深京合计）";
  }
  function buildKpis() {
    var M = window.__AMV_META || {};
    var meta = (document.querySelector("header .meta") || {}).textContent || "";
    function pick(re) { var m = meta.match(re); return m ? m[1] : "—"; }

    var amv = (M.amv != null)
      ? Number(M.amv).toLocaleString("zh-CN", { maximumFractionDigits: 1 })
      : pick(/0AMV\s*([\d,]+(?:\.\d+)?)/);
    var amvPct = (M.amvPct != null)
      ? ((Number(M.amvPct) >= 0 ? "+" : "") + M.amvPct + "%")
      : pick(/（([+\-][\d.]+%)）/);
    var ratio = (M.ratio != null) ? Number(M.ratio).toFixed(2) + "%" : pick(/活跃比例\s*([\d.]+%)/);
    var amount = metaAmount() || pick(/成交额\s*([\d.]+)/);

    var scoreEl = document.querySelector('#bullBearBox div[style*="font-size:38px"]');
    var score = scoreEl ? scoreEl.textContent.trim() : "—";
    var stateEl = scoreEl && scoreEl.nextElementSibling;
    var state = stateEl ? stateEl.textContent.trim() : "";

    var num = parseFloat(String(score).replace("+", ""));
    var cls = isNaN(num) ? "" : (num >= 15 ? "up" : num <= -15 ? "down" : "");

    var defs = [
      { lbl: "官方 0AMV", val: amv, sub: (amvPct === "—" ? "" : amvPct + " · ") + "最新交易日", cls: amvPct.indexOf("-") === 0 ? "down" : "up" },
      { lbl: "活跃比例", val: ratio, sub: "历史区间 7.7% ~ 30.6%", cls: "" },
      { lbl: "牛熊六维评分", val: score, sub: state, cls: cls },
      { lbl: "沪深京成交额", val: amount === "—" ? "—" : amount, sub: amount === "—" ? "" : amountSub(), cls: "" }
    ];

    var box = document.createElement("div");
    box.className = "kpis";
    defs.forEach(function (d) {
      var k = document.createElement("div");
      k.className = "kpi" + (d.cls ? " " + d.cls : "");

      var l = document.createElement("div");
      l.className = "lbl";
      l.textContent = d.lbl;

      var v = document.createElement("div");
      v.className = "val" + (d.cls ? " " + d.cls : "");
      v.textContent = d.val;

      var s = document.createElement("div");
      s.className = "sub";
      s.textContent = d.sub || "";

      k.appendChild(l); k.appendChild(v); k.appendChild(s);
      box.appendChild(k);
    });
    return box;
  }

  /* ── ② 分组搬块 ───────────────────────────────────────── */
  var blocks = Array.prototype.slice.call(wrap.children).filter(function (el) {
    return el.classList && (el.classList.contains("card") || el.classList.contains("grid"));
  });
  if (!blocks.length) return;

  var panels = {};
  TABS.forEach(function (t) {
    var sec = document.createElement("section");
    sec.className = "panel";
    sec.id = "panel-" + t.key;
    sec.setAttribute("role", "tabpanel");
    panels[t.key] = sec;
  });

  var counts = {};
  var anchor = blocks[0];
  wrap.insertBefore(panels.mkt, anchor);

  blocks.forEach(function (el) {
    /* .grid 是双列容器：子元素同组就整体搬（保留并排），
       分属不同组才拆开，避免"个股贡献"被"板块"顺带拖走。 */
    if (el.classList && el.classList.contains("grid")) {
      var kids = Array.prototype.slice.call(el.children);
      var gs = {};
      kids.forEach(function (k) { gs[groupOf(k) || "mkt"] = 1; });
      var keys = Object.keys(gs);
      if (keys.length <= 1) {
        var only = keys[0] || "mkt";
        if (!panels[only]) only = "mkt";
        panels[only].appendChild(el);
        return;
      }
      kids.forEach(function (k) {
        var g2 = groupOf(k) || "mkt";
        if (!panels[g2]) g2 = "mkt";
        panels[g2].appendChild(k);
      });
      return;
    }
    var g = groupOf(el) || "mkt";
    if (!panels[g]) g = "mkt";
    panels[g].appendChild(el);
  });

  /* 面板顺序插到 .mkt 之后，保持标签顺序 */
  var cursor = panels.mkt;
  TABS.slice(1).forEach(function (t) {
    cursor.parentNode.insertBefore(panels[t.key], cursor.nextSibling);
    cursor = panels[t.key];
  });

  /* 角标按实际卡片数（h2 个数）统计，避免 .grid 只算 1 个 */
  TABS.forEach(function (t2) {
    counts[t2.key] = panels[t2.key].querySelectorAll("h2").length;
  });
  /* ── ③ 标签栏 ─────────────────────────────────────────── */
  var bar = document.createElement("div");
  bar.className = "tabbar";
  bar.setAttribute("role", "tablist");

  var btns = {};
  TABS.forEach(function (t) {
    var b = document.createElement("button");
    b.className = "tabbtn";
    b.type = "button";
    b.setAttribute("role", "tab");
    b.dataset.tab = t.key;
    b.setAttribute("aria-selected", "false");
    b.textContent = t.label;
    if (counts[t.key]) {
      var c = document.createElement("span");
      c.className = "cnt";
      c.textContent = counts[t.key];
      b.appendChild(c);
    }
    b.addEventListener("click", function () { activate(t.key, true); });
    btns[t.key] = b;
    bar.appendChild(b);
  });

  /* ── ④ KPI 与标签栏插入到最前 ─────────────────────────── */
  var kpis;
  try { kpis = buildKpis(); } catch (e) { kpis = null; }
  wrap.insertBefore(bar, wrap.firstChild);
  if (kpis) wrap.insertBefore(kpis, bar);

  /* ── ④b KPI 补值：header .meta 与牛熊分都是 app21.js 异步渲染的，
        首次构建时拿到的是空串，这里在数据到位后回填。 ───── */
  function refreshKpis() {
    if (!kpis) return false;
    var M = window.__AMV_META || {};
    var metaEl = document.querySelector("header .meta");
    var meta = metaEl ? metaEl.textContent : "";
    function pick(re) { var m = meta.match(re); return m ? m[1] : null; }

    var amv = (M.amv != null)
      ? Number(M.amv).toLocaleString("zh-CN", { maximumFractionDigits: 1 })
      : pick(/0AMV\s*([\d,]+(?:\.\d+)?)/);
    var pct = (M.amvPct != null)
      ? ((Number(M.amvPct) >= 0 ? "+" : "") + M.amvPct + "%")
      : (pick(/（([+\-][\d.]+%)）/) || pick(/([+\-][\d.]+%)/));
    var ratio = (M.ratio != null) ? Number(M.ratio).toFixed(2) + "%" : pick(/活跃比例\s*([\d.]+%)/);
    var amount = metaAmount() || pick(/成交额\s*([\d.]+)/);

    var scoreEl = document.querySelector('#bullBearBox div[style*="font-size:38px"]');
    var score = scoreEl ? scoreEl.textContent.trim() : null;
    var state = (scoreEl && scoreEl.nextElementSibling)
      ? scoreEl.nextElementSibling.textContent.trim() : "";

    var tiles = kpis.querySelectorAll(".kpi");
    function set(i, val, sub, cls) {
      var tile = tiles[i];
      if (!tile || !val || val === "—") return;
      tile.className = "kpi" + (cls ? " " + cls : "");
      var v = tile.querySelector(".val");
      var s = tile.querySelector(".sub");
      v.textContent = val;
      v.className = "val" + (cls ? " " + cls : "");
      if (sub !== undefined) s.textContent = sub;
    }

    var num = score ? parseFloat(score.replace("+", "")) : NaN;
    var cls = isNaN(num) ? "" : (num >= 15 ? "up" : num <= -15 ? "down" : "");
    var pctCls = (pct && pct.charAt(0) === "-") ? "down" : "up";

    set(0, amv, (pct ? pct + " · " : "") + "最新交易日", pctCls);
    set(1, ratio, "历史区间 7.7% ~ 30.6%", "");
    set(2, score, state, cls);
    set(3, amount, amountSub(), "");

    return !!(amv && ratio && score && amount);
  }

  (function scheduleKpiRefresh() {
    var tries = [400, 1200, 2200, 3600, 5200, 7500, 10000];
    tries.forEach(function (ms) {
      setTimeout(function () { refreshKpis(); }, ms);
    });
  })();
  /* ── 诊断分支：仅在 ?diag=1 时生效，正常访问完全不受影响 ── */
  if (/[?&]diag=1/.test(location.search)) {
    setTimeout(function () {
      var vw = document.documentElement.clientWidth;
      var bad = [];
      Array.prototype.forEach.call(document.querySelectorAll("body *"), function (el) {
        var r = el.getBoundingClientRect();
        if (r.width > vw + 1) {
          var tag = el.tagName.toLowerCase();
          var id = el.id ? "#" + el.id : "";
          var cls = (typeof el.className === "string" && el.className) ? "." + el.className.trim().split(/\s+/)[0] : "";
          bad.push(tag + id + cls + "=" + Math.round(r.width));
        }
      });
      document.title = "DIAG vw=" + vw + " sw=" + document.documentElement.scrollWidth +
        " n=" + bad.length + " :: " + bad.slice(0, 10).join(" | ");
    }, 3500);
  }
  /* ── ⑤ 切换与图表尺寸 ─────────────────────────────────── */
  function resizeCharts(root) {
    if (typeof echarts === "undefined" || !echarts.getInstanceByDom) return;
    Array.prototype.forEach.call(root.querySelectorAll(".chart"), function (el) {
      var inst = echarts.getInstanceByDom(el);
      if (inst) { try { inst.resize(); } catch (e) {} }
    });
  }

  var current = null;

  function activate(key, pushHash) {
    if (!panels[key]) key = "mkt";
    current = key;
    TABS.forEach(function (t) {
      if (btns[t.key]) btns[t.key].setAttribute("aria-selected", t.key === key ? "true" : "false");
      panels[t.key].hidden = (t.key !== key);
    });
    if (key !== "sector" && typeof undockStockCard === "function") undockStockCard();  /* 离开板块页 → 表格归位 */
    /* 面板刚显示，容器才有尺寸，此时再让表格/图表重算 */
    requestAnimationFrame(function () { resizeCharts(panels[key]); });
    setTimeout(function () { resizeCharts(panels[key]); }, 320);
    if (pushHash) {
      history.replaceState(null, "", "#" + key);
      var barTop = bar.getBoundingClientRect().top + window.pageYOffset
        - (header ? header.getBoundingClientRect().height : 0);
      if (window.pageYOffset > barTop + 8) {
        window.scrollTo({ top: barTop, behavior: "auto" });
      }
    }
  }

  /* 初始：全部先可见，等图表建好再隐藏，避免 0 尺寸初始化 */
  TABS.forEach(function (t) { panels[t.key].hidden = false; });
  if (btns.mkt) btns.mkt.setAttribute("aria-selected", "true");

  function hideOthers() {
    var initial = (location.hash || "").replace("#", "").replace("tab=", "") || "mkt";
    if (!panels[initial]) initial = "mkt";
    activate(initial, false);
  }

  if (document.readyState === "complete") {
    setTimeout(hideOthers, 1200);
  } else {
    window.addEventListener("load", function () { setTimeout(hideOthers, 1200); });
  }

  /* ── ⑥ 点板块 → 成分股就地展开在「板块」页 ─────────────────────────
     app21.js 的 showSectorStocks() 把成分股写进 #stockTable，那张卡原本在
     「个股」页。这里不跳页，而是把整张卡临时挪到「板块」页的图表下方，
     离开「板块」页时再挪回原位——挪节点而不是克隆，行的点击事件一并保留。 */
  var stockTable = document.getElementById("stockTable");
  var stockCard = stockTable ? stockTable.closest(".card") : null;
  var stockHome = null;      /* 记录原位置，用于归位 */
  var docked = false;

  function dockStockCard() {
    if (!stockCard || docked) return;
    if (!stockHome) stockHome = { parent: stockCard.parentNode, next: stockCard.nextSibling };
    panels.sector.appendChild(stockCard);
    docked = true;
  }

  function undockStockCard() {
    if (!stockCard || !docked || !stockHome) return;
    if (stockHome.next && stockHome.next.parentNode === stockHome.parent) {
      stockHome.parent.insertBefore(stockCard, stockHome.next);
    } else {
      stockHome.parent.appendChild(stockCard);
    }
    docked = false;
  }

  var pending = null;
  if (stockTable && window.MutationObserver) {
    var mo = new MutationObserver(function () {
      clearTimeout(pending);
      pending = setTimeout(function () {
        if (current !== "sector") return;                       /* 只在板块页就地展开 */
        if ((stockTable.textContent || "").trim().length < 20) return;
        var title = (document.getElementById("stockTableTitle") || {}).textContent || "";
        if (title.indexOf("全市场") >= 0) { undockStockCard(); return; }  /* 返回全市场 → 收起 */
        dockStockCard();
      }, 160);
    });
    mo.observe(stockTable, { childList: true, subtree: true, characterData: true });
  }
  /* 窗口变化时，只有可见面板需要重算 */
  /* 自检：?selftest=sector 时模拟"点了一个板块"，把状态写进标题便于无头验证 */
  if (/[?&]selftest=sector/.test(location.search)) {
    setTimeout(function () {
      try { activate("sector", false); } catch (e) {}   // 模拟用户正停在板块页
      var name = null;
      try {
        var ch = (typeof echarts !== "undefined" && echarts.getInstanceByDom)
          ? echarts.getInstanceByDom(document.getElementById("chartSectors")) : null;
        var cats = ch ? ((ch.getOption().yAxis[0] || {}).data || []) : [];
        name = cats.length ? cats[cats.length - 1] : null;    /* 取 y 轴最后一个板块名 */
        if (name && typeof window.showSectorStocks === "function") window.showSectorStocks(name);
      } catch (e) {}
      setTimeout(function () {
        var tbl = document.getElementById("stockTable");
        var card = tbl ? tbl.closest(".card") : null;
        var inSector = !!(card && panels.sector.contains(card));
        var inStock = !!(card && panels.stock.contains(card));
        document.title = "SELFTEST sector=" + name
          + " rows=" + ((tbl && tbl.textContent || "").trim().length)
          + " cardInSector=" + inSector
          + " cardInStock=" + inStock
          + " stockPanelHidden=" + (panels.stock ? panels.stock.hidden : "?");
      }, 900);
    }, 4000);
  }
  var t = null;
  window.addEventListener("resize", function () {
    clearTimeout(t);
    t = setTimeout(function () {
      if (current && panels[current]) resizeCharts(panels[current]);
    }, 180);
  });
})();
