// Injected into the current tab. The value of the last expression is
// returned to the side panel: page text, image URLs, and link URLs.
(() => {
  const here = location.href.split("#")[0];
  const isHttp = (u) => /^https?:/i.test(u);

  const seenLinks = new Map();
  const links = [];
  const vis = (el) => (el.checkVisibility ? el.checkVisibility({ checkVisibilityCSS: true }) : true);
  const addLink = (el, raw, label) => {
    let url;
    try { url = new URL(raw, location.href); } catch { return; }
    if (!isHttp(url.href)) return;
    url.hash = "";
    const key = url.href;
    if (key === here) return;
    const shown = vis(el);
    const prev = seenLinks.get(key);
    if (prev) { if (shown) prev.hidden = false; return; }
    const link = { url: key, label: (label || "").replace(/\s+/g, " ").trim().slice(0, 120), hidden: !shown };
    seenLinks.set(key, link);
    links.push(link);
  };
  document.querySelectorAll("a[href], area[href]").forEach((a) =>
    addLink(a, a.getAttribute("href"), a.innerText || a.title || a.getAttribute("aria-label"))
  );
  // Embedded documents (PDF viewers in iframes, <embed>, <object>).
  document.querySelectorAll("iframe[src], embed[src], object[data]").forEach((el) =>
    addLink(el, el.getAttribute("src") || el.getAttribute("data"), el.title || "Embedded document")
  );

  const seenImgs = new Set();
  const images = [];
  document.querySelectorAll("img").forEach((img) => {
    const src = img.currentSrc || img.src;
    if (!src || seenImgs.has(src)) return;
    if (img.naturalWidth < 100 || img.naturalHeight < 100) return;
    if (!isHttp(src) && !src.startsWith("data:")) return;
    seenImgs.add(src);
    images.push({ url: src, label: img.alt || "" });
  });

  return {
    url: here,
    title: document.title,
    text: document.body ? document.body.innerText : "",
    images,
    links,
  };
})();
