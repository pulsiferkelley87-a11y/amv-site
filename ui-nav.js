/* ============================================================
   ui-nav.js —— 实盘页（live.html）粘性锚点导航
   ------------------------------------------------------------
   做法：不改任何已有 HTML，运行时扫描 .wrap > .card 的 h2，
   生成横向 chips 导航，并给每张卡片补一个稳定的 id。

   为什么用脚本而不是直接改 HTML：
   1. 卡片标题以后还会增删，脚本自动跟随，不用每次改两处；
   2. 出问题只要删掉 <script src="ui-nav.js">，页面立刻回原样；
   3. 不碰任何渲染逻辑与数据流。

   与 ui-upgrade.css 配合：--header-h 由本脚本实测页头高度写入，
   保证导航紧贴粘性页头下方，不重叠。
   ============================================================ */
(function () {
  "use strict";

  var wrap = document.querySelector(".wrap");
  var header = document.querySelector("header");
  if (!wrap) return;

  /* 1. 实测页头高度，写入 :root，供 CSS 的 sticky 定位使用 */
  function syncHeaderHeight() {
    var h = header ? Math.round(header.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty("--header-h", h + "px");
  }
  syncHeaderHeight();
  window.addEventListener("resize", syncHeaderHeight);

  /* 2. 取标题纯文本：h2 里常带 <span> 说明，只要主标题 */
  function titleOf(h2) {
    var clone = h2.cloneNode(true);
    Array.prototype.forEach.call(clone.children, function (c) {
      if (c.tagName === "SPAN" || c.tagName === "A") c.remove();
    });
    return clone.textContent.replace(/\s+/g, " ").trim();
  }

  /* 3. 中文标题做不了拼音 slug，用序号 + 稳定短哈希，保证刷新后 id 不变 */
  function slug(text, index) {
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return "sec-" + index + "-" + hash.toString(36);
  }

  var cards = Array.prototype.slice.call(wrap.querySelectorAll(":scope > .card"));
  if (!cards.length) return;

  var items = [];
  cards.forEach(function (card, index) {
    var h2 = card.querySelector("h2");
    if (!h2) return;
    var text = titleOf(h2);
    if (!text) return;
    if (!card.id) card.id = slug(text, index);
    items.push({ id: card.id, text: text, card: card });
  });
  if (!items.length) return;

  /* 4. 生成导航 */
  var nav = document.createElement("nav");
  nav.className = "anchornav";
  nav.setAttribute("aria-label", "小节导航");

  items.forEach(function (it) {
    var a = document.createElement("a");
    a.href = "#" + it.id;
    a.textContent = it.text.length > 14 ? it.text.slice(0, 13) + "…" : it.text;
    a.title = it.text;
    a.dataset.target = it.id;
    nav.appendChild(a);
  });

  wrap.insertBefore(nav, wrap.firstChild);

  /* 5. 点击：补偿粘性页头 + 导航自身高度，并短暂高亮目标卡片 */
  function offsetTop() {
    var hh = header ? header.getBoundingClientRect().height : 0;
    var nh = nav.getBoundingClientRect().height || 0;
    return hh + nh + 12;
  }

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  nav.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-target]");
    if (!a) return;
    e.preventDefault();
    var target = document.getElementById(a.dataset.target);
    if (!target) return;

    var y = target.getBoundingClientRect().top + window.pageYOffset - offsetTop();
    window.scrollTo({ top: Math.max(0, y), behavior: reduce ? "auto" : "smooth" });

    target.classList.add("flash");
    setTimeout(function () { target.classList.remove("flash"); }, 1400);

    history.replaceState(null, "", "#" + a.dataset.target);
    setActive(a.dataset.target);
  });

  /* 6. 滚动时高亮当前小节 */
  var links = Array.prototype.slice.call(nav.querySelectorAll("a[data-target]"));

  function setActive(id) {
    links.forEach(function (a) {
      a.classList.toggle("on", a.dataset.target === id);
    });
  }

  if ("IntersectionObserver" in window) {
    var visible = new Map();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) visible.set(en.target.id, en.intersectionRatio);
        else visible.delete(en.target.id);
      });
      var best = null, bestRatio = -1;
      visible.forEach(function (ratio, id) {
        if (ratio > bestRatio) { bestRatio = ratio; best = id; }
      });
      if (best) setActive(best);
    }, {
      rootMargin: "-" + offsetTop() + "px 0px -55% 0px",
      threshold: [0, .15, .4, .75]
    });
    items.forEach(function (it) { io.observe(it.card); });
  }

  /* 7. 带 hash 打开时，等页面布局稳定后再定位一次 */
  if (location.hash) {
    var id = location.hash.slice(1);
    var el = document.getElementById(id);
    if (el) {
      setTimeout(function () {
        var y = el.getBoundingClientRect().top + window.pageYOffset - offsetTop();
        window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
        setActive(id);
      }, 120);
    }
  }
})();
