// Injected into the current tab. The value of the last expression is
// returned to the side panel: page text, image URLs, and link URLs.
(() => {
  const here = location.href.split("#")[0];
  const isHttp = (u) => /^https?:/i.test(u);

  const seenLinks = new Set();
  const links = [];
  const addLink = (raw, label) => {
    let url;
    try { url = new URL(raw, location.href); } catch { return; }
    if (!isHttp(url.href)) return;
    url.hash = "";
    const key = url.href;
    if (key === here || seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({ url: key, label: (label || "").replace(/\s+/g, " ").trim().slice(0, 120) });
  };
  document.querySelectorAll("a[href], area[href]").forEach((a) =>
    addLink(a.getAttribute("href"), a.innerText || a.title || a.getAttribute("aria-label"))
  );
  // Embedded documents (PDF viewers in iframes, <embed>, <object>).
  document.querySelectorAll("iframe[src], embed[src], object[data]").forEach((el) =>
    addLink(el.getAttribute("src") || el.getAttribute("data"), el.title || "Embedded document")
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
