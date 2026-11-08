/* ============================================================================
 * ui-layout.js —— 页面结构重建（2026-11-09 第二版）
 *
 * 之前：所有卡片平铺在 .wrap 里，一行排到底，靠滚动 + 锚点跳转。
 * 现在：把卡片按功能装进 <section class="pane">，顶部导航**切换分区**（含"全部"），
 *       而不是滚动。这才是"推倒重建"该有的骨架。
 *
 * 原则：
 *   · 一切 ID 和渲染函数保持不动（各 render 函数照旧往 #xxx 里写）
 *   · 只搬 DOM 节点，不改它们的内容
 *   · 记忆上次选的分区；URL hash 同步（可分享）
 *   · 提供"全部"入口，任何时候都能回到长页面
 * ==========================================================================*/
(function () {
  "use strict";

  var GROUPS = {
    live: [
      { k: "quote",  n: "行情", items: ["指数分时", "市场情绪", "市场温度计"] },
      { k: "mood",   n: "情绪", items: ["通达信口径核对", "牛熊六维", "资金主线雷达"] },
      { k: "pick",   n: "选股", items: ["临近支撑位", "快上穿十日线", "快上穿×支撑共振", "上穿晋级统计", "个股信号"] },
      { k: "stock",  n: "个股", items: ["涨停池", "板块实时", "个股实时", "龙虎榜"] },
      { k: "review", n: "复盘", items: ["龙头", "高切低", "指标口径与阈值"] }
    ],
    index: [
      { k: "over", n: "总览", items: ["今日盘面总结", "牛熊识别", "市场快讯"] },
      { k: "pick", n: "选股", items: ["今日选股", "快上穿", "上穿晋级", "个股信号面板"] },
      { k: "hist", n: "历史", items: ["0AMV 叠加", "官方三件套", "活跃比例", "全历史周线",
                                      "板块活跃SZ贡献", "个股活跃市值贡献"] },
      { k: "flow", n: "资金", items: ["主力资金流"] },
      { k: "cal",  n: "口径", items: ["数据源状态", "通达信口径核对", "指标口径与阈值"] }
    ]
  };

  var KEY = "amv_pane_v1";

  function pageKey() { return /live/i.test(location.pathname) ? "live" : "index"; }

  function groupOf(title, groups) {
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].items.length; j++) {
        if (title.indexOf(groups[i].items[j]) >= 0) return groups[i];
      }
    }
    return null;
  }

  function titleOf(node) {
    var h = node.querySelector ? node.querySelector("h2") : null;
    return h ? (h.textContent || "").trim() : "";
  }

  function build() {
    var wrap = document.querySelector(".wrap");
    if (!wrap || wrap.__layout) return;
    var groups = GROUPS[pageKey()] || [];

    // 收集顶层节点（卡片或 .grid 容器）
    var nodes = Array.prototype.filter.call(wrap.children, function (el) {
      return el.classList && (el.classList.contains("card") || el.classList.contains("grid"));
    });
    if (nodes.length < 4) return;
    wrap.__layout = true;

    // 分区容器
    var panes = {};
    groups.forEach(function (g) {
      var s = document.createElement("section");
      s.className = "pane";
      s.id = "pane-" + g.k;
      s.setAttribute("role", "tabpanel");
      s.setAttribute("aria-label", g.n);
      panes[g.k] = s;
      s.__meta = { k: g.k, n: g.n, count: 0 };
    });
    var other = document.createElement("section");
    other.className = "pane";
    other.id = "pane-other";
    other.__meta = { k: "other", n: "其他", count: 0 };
    panes.other = other;

    // 分配节点
    // 注意：.grid 容器里可能装着**不同分区**的卡片（比如「龙头/高切低」和「龙虎榜/涨停池」
    // 曾共用一个 grid），按整块搬家会让整块跟着第一张卡的归属跑。
    // 规则：grid 内卡片同属一个分区 → 整块搬（保留双列）；否则拆开逐张搬。
    nodes.forEach(function (node) {
      if (node.classList.contains("grid")) {
        var kids = Array.prototype.slice.call(node.querySelectorAll(":scope > .card"));
        var ks = kids.map(function (c) { return groupOf(titleOf(c), groups); });
        var same = ks.every(function (g) { return g && g.k === ks[0].k; });
        if (same && kids.length) {
          var g0 = ks[0];
          panes[g0.k].appendChild(node);
          panes[g0.k].__meta.count += kids.length;
          node.setAttribute("data-pane", g0.k);
          return;
        }
        kids.forEach(function (c) {
          var g = groupOf(titleOf(c), groups);
          var target = g ? panes[g.k] : panes.other;
          target.appendChild(c);
          target.__meta.count += 1;
          c.setAttribute("data-pane", g ? g.k : "other");
        });
        node.remove();                      // 空掉的 grid 壳子丢掉
        return;
      }
      var t = titleOf(node);
      var g = groupOf(t, groups);
      var target = g ? panes[g.k] : panes.other;
      target.appendChild(node);
      target.__meta.count += 1;
      node.setAttribute("data-pane", g ? g.k : "other");
    });

    // 按声明顺序插入
    var anchor = wrap.firstChild;
    ["mkt"].forEach(function () { });
    groups.forEach(function (g) {
      if (panes[g.k].__meta.count) wrap.insertBefore(panes[g.k], anchor);
    });
    if (panes.other.__meta.count) wrap.appendChild(panes.other);

    // 导航
    var bar = document.createElement("div");
    bar.className = "pane-bar";
    bar.setAttribute("role", "tablist");

    var order = groups.filter(function (g) { return panes[g.k].__meta.count; })
      .map(function (g) { return g.k; });
    if (panes.other.__meta.count) order.push("other");

    var allBtn = null;
    function mkBtn(key, label, count) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pane-btn";
      b.setAttribute("role", "tab");
      b.dataset.pane = key;
      b.innerHTML = label + ' <span class="cnt">' + count + "</span>";
      b.addEventListener("click", function () { activate(key, true); });
      bar.appendChild(b);
      return b;
    }
    order.forEach(function (k) {
      var m = panes[k].__meta;
      mkBtn(k, m.n, m.count);
    });
    var totalCards = 0;
    Object.keys(panes).forEach(function (k) { totalCards += panes[k].__meta.count; });
    allBtn = mkBtn("all", "全部", totalCards);
    bar.insertBefore(allBtn, bar.firstChild);   // "全部"放最前

    wrap.insertBefore(bar, wrap.firstChild);

    function activate(key, push) {
      if (key !== "all" && !panes[key]) key = "all";
      Object.keys(panes).forEach(function (k) {
        panes[k].hidden = (key !== "all" && k !== key);
      });
      Array.prototype.forEach.call(bar.children, function (b) {
        b.classList.toggle("on", b.dataset.pane === key);
      });
      try { localStorage.setItem(KEY, key); } catch (e) { }
      if (push) {
        var h = "#" + (key === "all" ? "" : "pane=" + key);
        if (history.replaceState) history.replaceState(null, "", h || location.pathname + location.search);
      }
      window.dispatchEvent(new Event("resize"));   // ECharts 重新量尺寸
      window.scrollTo(0, 0);
    }

    // 初始分区：hash > 上次记忆 > 第一个
    var want = (location.hash.match(/pane=([a-z]+)/) || [])[1];
    if (!want) { try { want = localStorage.getItem(KEY); } catch (e) { } }
    if (want === "all" || (want && panes[want])) activate(want, false);
    else activate(order[0] || "all", false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(build, 800); });
  } else {
    setTimeout(build, 800);
  }
  setTimeout(build, 4000);   // 兜底：卡片可能在数据回来后重建
})();
