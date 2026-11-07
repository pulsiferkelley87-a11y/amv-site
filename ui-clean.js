/* ============================================================================
 * ui-clean.js —— 清爽化脚本（两页共用）
 *
 * 做三件事，都是"减法"：
 *   1. 去掉卡片标题里的 emoji（📐🐂🐻💰🎯⚡…）—— 一排彩色图标是最大噪音源
 *   2. 把 h2 之后的内容包进 .card-body，并在标题右侧加折叠按钮
 *   3. 按页面配置默认收起"说明/核对/低频"类卡片，主数据保持展开；
 *      用户手动展开/收起会记进 localStorage
 *
 * 为什么不改 HTML：
 *   卡片标题以后还会增删，脚本自动跟随；出问题删掉 <script> 就恢复原样。
 *   包装 div 不影响 getElementById —— 元素还在文档里，各渲染函数照常工作。
 * ==========================================================================*/
(function () {
  "use strict";

  /* 默认收起哪些（按标题包含的关键词匹配） */
  var COLLAPSE = {
    live: [
      "市场温度计",        // 250 根柱状图，占一屏，看图信息量低
      "通达信口径核对",    // 说明类
      "指标口径与阈值",    // 13 行长表
      "牛熊六维",          // 与"市场情绪"表达重叠
      "资金主线雷达",
      "临近支撑位监控",
      "上穿晋级统计",
      "高切低监测",
      "龙虎榜"
    ],
    index: [
      "数据源状态",
      "通达信口径核对",
      "指标口径与阈值",
      "上穿晋级统计",
      "全历史周线",
      "官方三件套",
      "0AMV 叠加",
      "市场快讯"
    ]
  };

  var EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

  function pageKey() {
    return /live/i.test(location.pathname) ? "live" : "index";
  }

  function storeGet(k) {
    try { return JSON.parse(localStorage.getItem("amv_clean_" + k) || "{}"); } catch (e) { return {}; }
  }
  function storeSet(k, v) {
    try { localStorage.setItem("amv_clean_" + k, JSON.stringify(v)); } catch (e) { }
  }

  function stripEmoji(el) {
    // 只处理文本节点，别动 span/button 里的内容
    if (!el) return;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = walker.nextNode())) {
      var t = n.nodeValue.replace(EMOJI, "").replace(/\s{2,}/g, " ");
      if (t !== n.nodeValue) n.nodeValue = t;
    }
  }

  function wrapBody(card, h2) {
    if (card.querySelector(":scope > .card-body")) return card.querySelector(":scope > .card-body");
    var body = document.createElement("div");
    body.className = "card-body";
    var node = h2.nextSibling;
    while (node) {
      var next = node.nextSibling;
      body.appendChild(node);
      node = next;
    }
    card.appendChild(body);
    return body;
  }

  function cleanNav() {
    var nav = document.querySelector(".anchornav");
    if (!nav) return;
    Array.prototype.forEach.call(nav.querySelectorAll("a"), function (a) {
      var tt = (a.textContent || "").replace(EMOJI, "").replace(/\s{2,}/g, " ").trim();
      if (tt !== a.textContent) a.textContent = tt;
    });
  }

  function setup() {
    var key = pageKey();
    var defaults = COLLAPSE[key] || [];
    var saved = storeGet(key);
    var cards = document.querySelectorAll(".wrap > .card, .card.full");

    cleanNav();

    Array.prototype.forEach.call(cards, function (card) {
      var h2 = card.querySelector("h2");
      if (!h2 || card.__clean) return;
      card.__clean = true;

      stripEmoji(h2);
      wrapBody(card, h2);

      var title = (h2.textContent || "").trim();

      var btn = document.createElement("span");
      btn.className = "card-toggle";
      btn.setAttribute("role", "button");
      btn.setAttribute("title", "展开 / 收起");
      btn.textContent = "▾";
      h2.appendChild(btn);

      // 默认状态：用户存过就按存的；没存过按名单决定
      var isCollapsed = (typeof saved[title] === "boolean")
        ? saved[title]
        : defaults.some(function (k) { return title.indexOf(k) >= 0; });

      card.classList.toggle("is-collapsed", isCollapsed);

      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var now = !card.classList.contains("is-collapsed");
        card.classList.toggle("is-collapsed", now);
        var s = storeGet(key);
        s[title] = now;
        storeSet(key, s);
      });
    });
  }

  // 卡片是各页面脚本动态渲染的，DOM 就绪后再跑一次
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(setup, 300); });
  } else {
    setTimeout(setup, 300);
  }
  // 数据刷新后可能新增卡片，隔几秒补一次（幂等）
  setTimeout(setup, 3000);
  setTimeout(setup, 8000);
})();
