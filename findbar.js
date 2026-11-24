// Deep Find bar. Cmd-F (Ctrl-F off the Mac) opens a find bar like Chrome's.
// Enter steps through the matches on the page in order. Links whose page or
// PDF contains the word, and images whose text does, are extra stops: one
// per link or image, in page order.
//
// Runs in the top frame of every http(s) page. Downloads and OCR happen in
// the extension's offscreen document (offscreen.js), reached through a port.
(() => {
  if (window.top !== window || window.__deepFindBar) return;
  window.__deepFindBar = true;

  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  const MIN_LINK_QUERY = 3;     // shorter words match almost every link
  const MAX_TEXT_MATCHES = 1000;
  const LINK_DELAY = 350;       // ms after typing stops before links are searched

  const settings = { takeOverFind: true, useOcr: true, maxLinks: 50 };
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const loadSettings = () =>
    chrome.storage.local.get("settings")
      .then(({ settings: s }) => Object.assign(settings, s || {}))
      .catch(() => {});
  loadSettings();
  try { chrome.storage.onChanged.addListener((c) => { if (c.settings) loadSettings(); }); } catch {}

  let ui = null;          // built on first open
  let isOpen = false;
  let query = "";         // the query the stops belong to
  let stops = [];         // sorted in page order
  let current = null;     // the active stop
  let targets = new Map(); // "link|url" or "image|url" -> element
  let outlined = null;
  let port = null;
  let scanId = 0;
  let scan = { running: false, done: 0, total: 0, failed: 0 };
  let textTimer = 0, linkTimer = 0;

  // ---------- Keys ----------

  window.addEventListener("keydown", (e) => {
    if (!alive()) return; // extension reloaded: leave Chrome's find alone
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const key = (e.key || "").toLowerCase();
    if (mod && !e.altKey && !e.shiftKey && key === "f") {
      if (!settings.takeOverFind) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openBar();
    } else if (isOpen && mod && !e.altKey && key === "g") {
      e.preventDefault();
      e.stopImmediatePropagation();
      flushQuery();
      step(e.shiftKey ? -1 : 1);
    }
  }, true);

  // ---------- UI ----------

  function build() {
    const host = document.createElement("div");
    host.id = "deep-find-host";
    host.style.cssText = "all: initial; position: fixed; top: 6px; right: 18px; z-index: 2147483647; display: none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .wrap {
          --bg: #fff; --fg: #1f1f1f; --muted: #5f6368; --line: #dadce0; --hover: #f1f3f4; --mark: #ff9632; --accent: #0b57d0;
          width: 400px; max-width: calc(100vw - 36px);
          background: var(--bg); color: var(--fg);
          border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,.18), 0 6px 18px rgba(0,0,0,.12);
          overflow: hidden;
        }
        @media (prefers-color-scheme: dark) {
          .wrap { --bg: #35363a; --fg: #e8eaed; --muted: #9aa0a6; --line: #5f6368; --hover: #45474a; --accent: #a8c7fa; }
        }
        .bar { display: flex; align-items: center; gap: 2px; padding: 6px 6px 6px 12px; }
        input {
          flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg);
          font-size: 14px; padding: 4px 0;
        }
        .count { color: var(--muted); font-size: 12px; white-space: nowrap; padding: 0 6px; font-variant-numeric: tabular-nums; }
        .count.none { color: #d93025; }
        .links { color: var(--muted); font-size: 11px; white-space: nowrap; padding-right: 6px; }
        .links .spin { display: inline-block; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
        button {
          all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: 50%;
          display: grid; place-items: center; color: var(--muted);
        }
        button:hover { background: var(--hover); color: var(--fg); }
        button:disabled { opacity: .35; cursor: default; background: none; }
        button svg { width: 16px; height: 16px; fill: currentColor; }
        .card { border-top: 1px solid var(--line); padding: 8px 12px 10px; }
        .card[hidden] { display: none; }
        .where { display: flex; align-items: center; gap: 8px; font-weight: 600; }
        .where span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .open {
          all: unset; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--accent);
          padding: 2px 8px; border: 1px solid var(--line); border-radius: 12px; white-space: nowrap;
        }
        .open:hover { background: var(--hover); }
        .label { color: var(--muted); font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .snip { margin-top: 4px; font-size: 12px; word-break: break-word; }
        mark { background: var(--mark); color: #000; border-radius: 2px; padding: 0 1px; }
      </style>
      <div class="wrap" role="search">
        <div class="bar">
          <input type="text" spellcheck="false" autocomplete="off" aria-label="Find in page and linked pages">
          <span class="count"></span>
          <span class="links"></span>
          <span class="sep"></span>
          <button class="prev" title="Previous (Shift-Enter)" aria-label="Previous">
            <svg viewBox="0 0 24 24"><path d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"/></svg></button>
          <button class="next" title="Next (Enter)" aria-label="Next">
            <svg viewBox="0 0 24 24"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg></button>
          <button class="list" title="All results in the side panel" aria-label="All results">
            <svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg></button>
          <button class="close" title="Close (Esc)" aria-label="Close">
            <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button>
        </div>
        <div class="card" hidden>
          <div class="where"><span></span><button class="open" hidden>Open ↗</button></div>
          <div class="label"></div>
          <div class="snip"></div>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    ui = {
      host, root, input: $("input"), count: $(".count"), links: $(".links"),
      prev: $(".prev"), next: $(".next"), list: $(".list"), close: $(".close"),
      card: $(".card"), where: $(".where span"), open: $(".open"), label: $(".label"), snip: $(".snip"),
    };

    ui.input.addEventListener("input", () => scheduleQuery());
    ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const fresh = ui.input.value !== query;
        flushQuery();
        if (!fresh) step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeBar(true);
      }
    });
    ui.prev.addEventListener("click", () => { flushQuery(); step(-1); });
    ui.next.addEventListener("click", () => { flushQuery(); step(1); });
    ui.close.addEventListener("click", () => closeBar(false));
    ui.list.addEventListener("click", () => {
      try { chrome.runtime.sendMessage({ type: "deep-find-panel", query: ui.input.value.trim() }); } catch {}
    });
    ui.open.addEventListener("click", () => current?.hit && openHit(current.hit));
    // Keep typing in the bar from reaching the page's own shortcuts.
    for (const t of ["keydown", "keyup", "keypress", "input"]) host.addEventListener(t, (e) => e.stopPropagation());

    const style = document.createElement("style");
    style.id = "deep-find-highlights";
    style.textContent = `
      ::highlight(deep-find-all) { background-color: #ffff00; color: #000; }
      ::highlight(deep-find-current) { background-color: #ff9632; color: #000; }
      ::highlight(deep-find-link) { background-color: #c2e7ff; color: #000; }`;
    (document.head || document.documentElement).append(style);
    document.documentElement.append(host);
  }

  function openBar() {
    if (!ui || !ui.host.isConnected) build();
    let sel = "";
    try { sel = String(getSelection()).trim(); } catch {}
    if (sel && sel.length <= 100 && !sel.includes("\n")) ui.input.value = sel;
    if (!isOpen) {
      isOpen = true;
      ui.host.style.display = "block";
    }
    ui.input.focus();
    ui.input.select();
    if (ui.input.value !== query || !stops.length) flushQuery();
  }

  function closeBar(selectMatch) {
    isOpen = false;
    ui.host.style.display = "none";
    cancelScan();
    clearTimeout(textTimer);
    clearTimeout(linkTimer);
    const keep = current;
    unoutline();
    clearHighlights();
    stops = [];
    current = null;
    query = "";
    // Like Chrome: Esc leaves the active match selected on the page.
    if (selectMatch && keep?.type === "text") {
      try { const s = getSelection(); s.removeAllRanges(); s.addRange(keep.range); } catch {}
    }
  }

  // ---------- Matching on the page ----------

  const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Case-insensitive; whitespace-tolerant, so "John Smith" also matches across a line break.
  function makeMatcher(q) {
    const chars = [...q.replace(/\s+/g, "")];
    return chars.length ? new RegExp(chars.map(escapeRe).join("\\s*"), "gi") : null;
  }

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT", "OPTION", "IFRAME", "OBJECT"]);

  function textRanges(re) {
    const root = document.body || document.documentElement;
    const visible = new Map();
    const isVisible = (el) => {
      let v = visible.get(el);
      if (v === undefined) {
        v = el.checkVisibility ? el.checkVisibility({ checkVisibilityCSS: true }) : true;
        visible.set(el, v);
      }
      return v;
    };
    const nodes = [], starts = [];
    let text = "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName) || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return isVisible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
      starts.push(text.length);
      text += walker.currentNode.nodeValue;
    }
    const locate = (pos) => {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
      }
      return lo;
    };
    const ranges = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && ranges.length < MAX_TEXT_MATCHES) {
      if (!m[0]) { re.lastIndex++; continue; }
      const end = m.index + m[0].length;
      const a = locate(m.index), b = locate(end - 1);
      const r = document.createRange();
      r.setStart(nodes[a], m.index - starts[a]);
      r.setEnd(nodes[b], end - starts[b]);
      ranges.push(r);
    }
    return ranges;
  }

  function scheduleQuery() {
    clearTimeout(textTimer);
    textTimer = setTimeout(flushQuery, 120);
  }

  function flushQuery() {
    clearTimeout(textTimer);
    if (!ui) return;
    const q = ui.input.value;
    if (q === query) return;
    query = q;
    cancelScan();
    unoutline();
    ui.card.hidden = true;
    stops = [];
    current = null;
    const re = makeMatcher(q);
    if (re) {
      for (const r of textRanges(re)) stops.push({ type: "text", node: r.startContainer, offset: r.startOffset, range: r });
    }
    // Like Chrome: start at the first match that is not above the window.
    current = stops.find((s) => s.range.getBoundingClientRect().bottom >= 0) || stops[0] || null;
    paint();
    if (current) reveal(current);
    status();
    scheduleLinks();
  }

  function sortStops() {
    stops.sort((a, b) => {
      if (a.node === b.node) return (a.offset || 0) - (b.offset || 0);
      const pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function step(dir) {
    if (!stops.length) return;
    let i = stops.indexOf(current);
    i = i < 0 ? (dir > 0 ? 0 : stops.length - 1) : (i + dir + stops.length) % stops.length;
    current = stops[i];
    paint();
    reveal(current);
    status();
  }

  // ---------- Painting and scrolling ----------

  function paint() {
    if (!window.CSS?.highlights || typeof Highlight === "undefined") return;
    const all = [], links = [];
    for (const s of stops) {
      if (s === current) continue;
      if (s.type === "text") all.push(s.range);
      else if (s.type === "link" && s.node.tagName === "A") {
        const r = document.createRange();
        r.selectNodeContents(s.node);
        links.push(r);
      }
    }
    CSS.highlights.set("deep-find-all", new Highlight(...all));
    CSS.highlights.set("deep-find-link", new Highlight(...links));
    if (current?.type === "text") CSS.highlights.set("deep-find-current", new Highlight(current.range));
    else CSS.highlights.delete("deep-find-current");
  }

  function clearHighlights() {
    if (!window.CSS?.highlights) return;
    for (const n of ["deep-find-all", "deep-find-current", "deep-find-link"]) CSS.highlights.delete(n);
  }

  function reveal(s) {
    unoutline();
    if (s.type === "text") {
      ui.card.hidden = true;
      let r = s.range.getBoundingClientRect();
      const barBottom = ui.host.getBoundingClientRect().bottom + 8;
      const inView = r.top >= barBottom && r.bottom <= innerHeight - 8 && r.left >= 0 && r.right <= innerWidth;
      if (inView) return;
      // Bring nested scroll areas along, then center the match in the window.
      s.node.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
      r = s.range.getBoundingClientRect();
      window.scrollBy({ top: r.top - innerHeight / 2, left: r.left < 0 || r.right > innerWidth ? r.left - innerWidth / 2 : 0 });
      return;
    }
    const el = s.node;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    outlined = { el, outline: el.style.outline, offset: el.style.outlineOffset };
    el.style.outline = "3px solid #ff9632";
    el.style.outlineOffset = "2px";
    showCard(s);
  }

  function unoutline() {
    if (!outlined) return;
    outlined.el.style.outline = outlined.outline;
    outlined.el.style.outlineOffset = outlined.offset;
    outlined = null;
  }

  function showCard(s) {
    const h = s.hit;
    let where;
    if (h.type === "image") where = "In this image";
    else if (h.kind === "pdf") where = `In linked PDF, page ${h.page}` + (h.via === "ocr" ? " (scanned)" : "");
    else if (h.kind === "image") where = "In linked image";
    else if (h.kind === "text") where = "In linked text file";
    else where = "In linked page";
    ui.where.textContent = where;
    ui.open.hidden = h.type === "image";
    ui.label.textContent = s.label || "";
    ui.label.hidden = !s.label;
    const mark = document.createElement("mark");
    mark.textContent = h.match;
    ui.snip.replaceChildren(h.before, mark, h.after);
    ui.card.hidden = false;
  }

  function openHit(h) {
    let url = h.url;
    if (h.kind === "pdf" && h.page != null) url += `#page=${h.page}`;
    else if (h.kind === "html") {
      const words = h.match.split(/\s+/).filter(Boolean);
      const enc = (w) => encodeURIComponent(w).replace(/-/g, "%2D");
      url += "#:~:text=" + (words.length > 1 ? `${enc(words[0])},${enc(words[words.length - 1])}` : enc(h.match));
    }
    window.open(url, "_blank", "noopener");
  }

  function status() {
    if (!ui) return;
    const n = stops.length;
    const i = current ? stops.indexOf(current) + 1 : 0;
    ui.count.textContent = query.trim() ? `${i}/${n}` : "";
    ui.count.classList.toggle("none", !!query.trim() && n === 0 && !scan.running);
    ui.prev.disabled = ui.next.disabled = n === 0;
    const linkStops = stops.filter((s) => s.type !== "text").length;
    if (scan.running) {
      const spin = Object.assign(document.createElement("span"), { className: "spin", textContent: "↻" });
      ui.links.replaceChildren(spin, scan.total ? ` links ${scan.done}/${scan.total}` : " links");
      ui.links.title = "Searching linked pages, PDFs and images";
    } else if (linkStops) {
      ui.links.textContent = `${linkStops} in links`;
      ui.links.title = `${linkStops} linked page${linkStops === 1 ? "" : "s"} or image${linkStops === 1 ? "" : "s"} contain this` +
        (scan.failed ? `. ${scan.failed} could not be read.` : "");
    } else {
      ui.links.textContent = "";
      ui.links.title = "";
    }
  }

  // ---------- Links and images (searched in the offscreen document) ----------

  function collectTargets() {
    targets = new Map();
    const here = location.href.split("#")[0];
    const links = [], images = [];
    const byUrl = new Map();
    const vis = (el) => (el.checkVisibility ? el.checkVisibility({ checkVisibilityCSS: true }) : true);
    const addLink = (el, raw, label) => {
      let u;
      try { u = new URL(raw, location.href); } catch { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      u.hash = "";
      const url = u.href;
      if (url === here) return;
      const key = "link|" + url;
      const shown = vis(el);
      const prev = byUrl.get(url);
      if (!prev) {
        targets.set(key, el);
        const link = { url, label: (label || "").replace(/\s+/g, " ").trim().slice(0, 120), hidden: !shown };
        byUrl.set(url, link);
        links.push(link);
      } else if (prev.hidden && shown) {
        targets.set(key, el); // prefer a link the reader can see
        prev.hidden = false;
      }
    };
    document.querySelectorAll("a[href], area[href]").forEach((a) =>
      addLink(a, a.getAttribute("href"), a.innerText || a.title || a.getAttribute("aria-label")));
    document.querySelectorAll("iframe[src], embed[src], object[data]").forEach((el) =>
      addLink(el, el.getAttribute("src") || el.getAttribute("data"), el.title || "Embedded document"));
    for (const img of document.images) {
      const src = img.currentSrc || img.src;
      if (!src || targets.has("image|" + src)) continue;
      if (img.naturalWidth < 100 || img.naturalHeight < 100) continue;
      if (!/^(https?:|data:)/.test(src)) continue;
      targets.set("image|" + src, img);
      images.push({ url: src, label: img.alt || "" });
    }
    return { links, images };
  }

  function scheduleLinks() {
    clearTimeout(linkTimer);
    if (query.replace(/\s/g, "").length < MIN_LINK_QUERY) return;
    linkTimer = setTimeout(startScan, LINK_DELAY);
  }

  async function startScan() {
    const id = ++scanId;
    const keyword = query;
    const { links, images } = collectTargets();
    if (!links.length && !(settings.useOcr && images.length)) return;
    scan = { running: true, done: 0, total: 0, failed: 0 };
    status();
    const p = await getPort();
    if (id !== scanId) return;
    if (!p) { scan.running = false; status(); return; }
    try {
      p.postMessage({ type: "scan", id, keyword, links, images, useOcr: settings.useOcr, maxLinks: settings.maxLinks });
    } catch { port = null; scan.running = false; status(); }
  }

  async function getPort() {
    if (port) return port;
    try {
      await chrome.runtime.sendMessage({ type: "deep-find-worker" }); // makes sure the offscreen document exists
      port = chrome.runtime.connect({ name: "deep-find" });
    } catch { return null; }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (scan.running) { scan.running = false; status(); }
    });
    return port;
  }

  function cancelScan() {
    clearTimeout(linkTimer);
    scanId++;
    scan = { running: false, done: 0, total: 0, failed: 0 };
    try { port?.postMessage({ type: "cancel" }); } catch {}
  }

  function onPortMessage(m) {
    if (m?.id !== scanId || !isOpen) return;
    if (m.type === "progress") { scan.done = m.done; scan.total = m.total; }
    else if (m.type === "done") { scan.running = false; scan.failed = m.failed || 0; }
    else if (m.type === "hit") addHit(m.hit);
    status();
  }

  function addHit(h) {
    const el = targets.get(`${h.type}|${h.url}`);
    if (!el || !el.isConnected) return;
    if (stops.some((s) => s.node === el)) return;
    const label = h.type === "image" ? el.alt || "" : (el.innerText || el.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
    stops.push({ type: h.type, node: el, hit: h, label });
    sortStops();
    if (!current) { current = stops.find((s) => s.node === el); reveal(current); }
    paint();
  }

  // For tests: lets a harness drive the bar without key events.
  window.__deepFind = { open: openBar, close: () => closeBar(true), step, state: () => ({ query, stops, current, scan, isOpen }) };
})();
