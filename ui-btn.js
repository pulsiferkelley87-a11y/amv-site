/* ============================================================================
 * ui-btn.js —— 把页面里的 <button> 统一成 shadcn 风格
 *
 * 站里的按钮大量带着内联样式（padding/border/background/border-radius…），
 * 内联样式优先级高于样式表，所以光加 CSS 类不生效。
 *
 * 这里做两件事：
 *   1. 剥掉按钮上的**视觉**内联样式（保留功能性的，如 float/display:none）
 *   2. 按语义补 class：激活态 → btn-default，其余 → btn-outline
 *
 * 为什么用脚本而不是改模板：按钮散落在十几个 render 函数里，
 * 一个个改容易漏、也容易和将来的改动冲突；这里一处收敛。
 * ==========================================================================*/
(function () {
  "use strict";

  var VISUAL = ["padding", "border", "background", "border-radius", "color",
                "font-size", "cursor", "font-weight", "height", "line-height",
                "box-shadow", "outline"];
  var KEEP = ["float", "display", "margin", "margin-left", "margin-right", "width"];

  function normalize(btn) {
    if (!btn || btn.__btn) return;
    btn.__btn = true;

    // 1) 剥视觉内联样式（保留布局类）
    var st = btn.getAttribute("style") || "";
    if (st) {
      var keep = [];
      st.split(";").forEach(function (decl) {
        var d = decl.trim();
        if (!d) return;
        var k = d.split(":")[0].trim().toLowerCase();
        if (VISUAL.indexOf(k) >= 0) return;      // 丢弃
        if (KEEP.indexOf(k) >= 0 || k) keep.push(d);
      });
      if (keep.length) btn.setAttribute("style", keep.join("; "));
      else btn.removeAttribute("style");
    }

    // 2) 补 class
    var cls = btn.className || "";
    if (/\bbtn\b/.test(cls)) return;            // 已经显式指定，尊重作者
    var active = /\b(active|on)\b/.test(cls);
    btn.classList.add("btn");
    btn.classList.add(active ? "btn-default" : "btn-outline");
  }

  function scan(root) {
    (root || document).querySelectorAll("button").forEach(normalize);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(scan, 400); });
  } else {
    setTimeout(scan, 400);
  }
  // 按钮大多是 render 出来的，隔一会儿补扫 + 监听新增节点
  setTimeout(scan, 2500);
  setTimeout(scan, 7000);
  try {
    var mo = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes || [], function (n) {
          if (n.nodeType !== 1) return;
          if (n.tagName === "BUTTON") normalize(n);
          else if (n.querySelectorAll) scan(n);
        });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (e) { }
})();
