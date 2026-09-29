// Injected into the dashboard page by probe.py: once the payload has rendered,
// write layout metrics into <pre id="layout-result"> for --dump-dom.
(function () {
  function rect(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
  }
  function visible(el) {
    if (!el) return false;
    for (var n = el; n && n.classList; n = n.parentElement) {
      if (n.classList.contains("hidden")) return false;
    }
    var s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
  }
  function run() {
    var doc = document.documentElement;
    var content = document.querySelector(".dashboard-content");
    var bar = document.getElementById("touch-bar");
    var footer = document.querySelector(".footer-logo");
    var barTop = visible(bar) ? rect(bar).top : window.innerHeight;
    var footerTop = visible(footer) ? rect(footer).top : window.innerHeight;
    var sections = [];
    document.querySelectorAll(".control-section, .fault-banner, .warning-banner, .dashboard-header").forEach(function (el) {
      if (!visible(el)) return;
      sections.push({ id: el.id || el.className.split(" ")[0], rect: rect(el) });
    });
    var targets = [];
    document.querySelectorAll("#touch-bar button, #vsd-section button").forEach(function (b) {
      if (!visible(b)) return;
      targets.push({ id: b.id, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height });
    });
    var smallest = null;
    document.querySelectorAll(".dashboard-content *, #touch-bar *").forEach(function (el) {
      if (!visible(el) || !el.childNodes.length) return;
      var hasText = Array.prototype.some.call(el.childNodes, function (c) {
        return c.nodeType === 3 && c.textContent.trim();
      });
      if (!hasText) return;
      var px = parseFloat(getComputedStyle(el).fontSize);
      if (smallest === null || px < smallest) smallest = px;
    });
    var out = {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      doc: { scrollH: doc.scrollHeight, scrollW: doc.scrollWidth },
      content: { scrollH: content.scrollHeight, clientH: content.clientHeight, scrollW: content.scrollWidth, clientW: content.clientWidth },
      obstacleTop: Math.min(barTop, footerTop),
      barTop: barTop,
      footerTop: footerTop,
      sections: sections,
      targets: targets,
      smallestFontPx: smallest,
      hasVsd: document.querySelector(".dashboard-container").classList.contains("has-vsd"),
      touch: visible(bar),
    };
    var pre = document.createElement("pre");
    pre.id = "layout-result";
    pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
  }
  // Render the embedded payload with the dashboard's own render(), then
  // measure once layout has settled.
  (function wait() {
    var d = window.dashboard;
    if (!d) return setTimeout(wait, 50);
    d.render(window.__LAYOUT_PAYLOAD__);
    // (requestAnimationFrame never fires under --dump-dom virtual time.)
    setTimeout(run, 200);
  })();
})();
