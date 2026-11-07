/* ============================================================================
 * ui-groups.js —— 按功能分组 + 顶部组导航（两页共用）
 *
 * 借鉴：
 *   同花顺数据中心 —— 顶部二级功能条，点了**跳转**，不改变页面结构
 *   集思录        —— 入口做成块状条，标题 + 计数，省地方
 *
 * 关键：**不移动任何卡片、不插入组标题**。
 *   上一版用 appendChild 重排，结果把 .grid 里的双列卡片拽出来、布局全乱。
 *   这里只做两件事：给卡片打 data-grp 标记 + 顶部生成一条跳转条。
 * ==========================================================================*/
(function () {
  "use strict";

  var GROUPS = {
    live: [
      { k: "quote", n: "行情", items: ["指数分时", "市场情绪", "市场温度计"] },
      { k: "mood", n: "情绪", items: ["通达信口径核对", "牛熊六维", "资金主线雷达"] },
      { k: "pick", n: "选股", items: ["临近支撑位", "快上穿", "上攻晋级", "上穿晋级", "个股信号"] },
      { k: "stock", n: "个股", items: ["涨停池", "板块实时", "个股实时", "龙虎榜"] },
      { k: "review", n: "复盘", items: ["龙头", "高切低", "指标口径与阈值"] }
    ],
    index: [
      { k: "over", n: "总览", items: ["今日盘面总结", "牛熊识别", "市场快讯"] },
      { k: "pick", n: "选股", items: ["今日选股", "快上穿", "上穿晋级", "区间回看"] },
      { k: "hist", n: "历史", items: ["0AMV 叠加", "官方三件套", "活跃比例", "全历史周线"] },
      { k: "cal", n: "口径", items: ["数据源状态", "通达信口径核对", "指标口径与阈值"] }
    ]
  };

  function pageKey() { return /live/i.test(location.pathname) ? "live" : "index"; }

  function groupOf(title, groups) {
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].items.length; j++) {
        if (title.indexOf(groups[i].items[j]) >= 0) return groups[i];
      }
    }
    return null;
  }

  function build() {
    var wrap = document.querySelector(".wrap");
    if (!wrap || wrap.__grouped) return;
    var cards = wrap.querySelectorAll(".card");     // 任意层级，覆盖 .grid 里的卡片
    if (cards.length < 4) return;
    wrap.__grouped = true;

    var groups = GROUPS[pageKey()] || [];
    var firstOf = {};        // k -> 第一张卡片（跳转锚点）
    var count = {};
    var order = [];

    Array.prototype.forEach.call(cards, function (card) {
      var h2 = card.querySelector("h2");
      if (!h2) return;
      var g = groupOf((h2.textContent || "").trim(), groups);
      if (!g) return;
      card.setAttribute("data-grp", g.k);
      if (!firstOf[g.k]) { firstOf[g.k] = card; order.push(g.k); }
      count[g.k] = (count[g.k] || 0) + 1;
    });
    if (!order.length) return;

    // 按 GROUPS 声明顺序排列
    order.sort(function (a, b) {
      var ia = groups.findIndex(function (x) { return x.k === a; });
      var ib = groups.findIndex(function (x) { return x.k === b; });
      return ia - ib;
    });

    var bar = document.createElement("div");
    bar.className = "grpbar";
    order.forEach(function (k) {
      var def = groups.find(function (x) { return x.k === k; });
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gbtn";
      btn.innerHTML = def.n + ' <span class="cnt">' + count[k] + "</span>";
      btn.addEventListener("click", function () {
        var t = firstOf[k];
        if (!t) return;
        var y = t.getBoundingClientRect().top + window.scrollY - 118;   // 留出 sticky 头
        window.scrollTo({ top: y, behavior: "smooth" });
        Array.prototype.forEach.call(bar.children, function (x) { x.classList.remove("on"); });
        btn.classList.add("on");
      });
      bar.appendChild(btn);
    });

    wrap.insertBefore(bar, wrap.firstChild);

    // 滚动高亮
    var anchors = order.map(function (k) { return { k: k, el: firstOf[k] }; });
    window.addEventListener("scroll", function () {
      var y = window.scrollY + 140, idx = 0;
      anchors.forEach(function (a, i) {
        if (a.el && a.el.getBoundingClientRect().top + window.scrollY <= y) idx = i;
      });
      Array.prototype.forEach.call(bar.children, function (x, i) {
        x.classList.toggle("on", i === idx);
      });
    }, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(build, 900); });
  } else {
    setTimeout(build, 900);
  }
  setTimeout(build, 4000);
})();
