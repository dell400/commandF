import { search, stopOcr } from "./engine.js";
import { idbCache } from "./idbcache.js";

const $ = (id) => document.getElementById(id);
const form = $("form"), q = $("q"), goBtn = $("go"), stopBtn = $("stop");
const ocrBox = $("ocr"), maxBox = $("max"), findBox = $("cmdf");
const statusEl = $("status"), activeEl = $("active"), resultsEl = $("results");
const problemsEl = $("problems");

let controller = null;
let currentTabId = null;

// ---------- Settings (remembered per browser) ----------

chrome.storage.local.get(["settings"]).then(({ settings }) => {
  if (!settings) return;
  ocrBox.checked = settings.useOcr ?? true;
  maxBox.value = settings.maxLinks ?? 50;
  findBox.checked = settings.takeOverFind ?? true;
});
const saveSettings = () =>
  chrome.storage.local.set({
    settings: { useOcr: ocrBox.checked, maxLinks: Number(maxBox.value), takeOverFind: findBox.checked },
  });
ocrBox.addEventListener("change", saveSettings);
maxBox.addEventListener("change", saveSettings);
findBox.addEventListener("change", saveSettings);

// ---------- Focus (Cmd-F while the panel is open) ----------

function focusSearch(selection) {
  window.focus();
  if (selection && !controller) q.value = selection;
  q.focus();
  q.select();
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "deep-find-focus") focusSearch(msg.selection);
});
// Cmd-F inside the panel itself jumps back to the search box.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    focusSearch("");
  }
});

// ---------- Cache (IndexedDB, 7 days; shared with the find bar) ----------

const cache = idbCache;

async function showCacheInfo() {
  const n = await cache.count();
  $("cacheInfo").textContent = n ? `${n} item${n === 1 ? "" : "s"} cached` : "";
}
$("clear").addEventListener("click", async () => {
  await cache.clear();
  showCacheInfo();
});
showCacheInfo();

// ---------- Run a search sent from the find bar's list button ----------

function runQuery(query) {
  if (!query || controller) return;
  q.value = query;
  form.requestSubmit();
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "deep-find-run") {
    chrome.storage.session?.remove("pendingQuery").catch(() => {});
    runQuery(msg.query);
  }
});
chrome.storage.session?.get("pendingQuery").then(({ pendingQuery }) => {
  if (!pendingQuery) return;
  chrome.storage.session.remove("pendingQuery");
  runQuery(pendingQuery);
}).catch(() => {});

// ---------- Read the current tab ----------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function readPage(tab) {
  const url = tab.url || "";
  // Chrome's PDF viewer has no DOM we can read: treat the tab as a document.
  if (/\.pdf(\?|#|$)/i.test(url)) {
    return { url: url.split("#")[0], title: tab.title, text: "", images: [], links: [], isDocument: true };
  }
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    if (res?.result) return res.result;
  } catch (e) {
    if (/^https?:/.test(url)) {
      // Not scriptable but downloadable (e.g. a PDF without .pdf in the URL).
      return { url: url.split("#")[0], title: tab.title, text: "", images: [], links: [], isDocument: true };
    }
    throw new Error("Chrome does not let extensions read this page.");
  }
  throw new Error("Could not read this page.");
}

// Prefill with the text selected on the page, if any.
(async () => {
  try {
    const tab = await getActiveTab();
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => getSelection().toString().trim(),
    });
    const sel = res?.result;
    if (sel && sel.length < 100 && !q.value) { q.value = sel; q.select(); }
  } catch {}
})();

// ---------- Run a search ----------

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const keyword = q.value.trim();
  if (!keyword || controller) return;

  controller = new AbortController();
  resultsEl.replaceChildren();
  activeEl.replaceChildren();
  problemsEl.hidden = true;
  statusEl.className = "";
  statusEl.textContent = "Reading page…";
  goBtn.hidden = true;
  stopBtn.hidden = false;

  let count = 0;
  try {
    const tab = await getActiveTab();
    currentTabId = tab.id;
    const page = await readPage(tab);
    const summary = await search(page, {
      keyword,
      maxLinks: Math.max(0, Number(maxBox.value) || 0),
      useOcr: ocrBox.checked,
      signal: controller.signal,
      cache,
      onResult: (r) => { count++; addResult(r, keyword); },
      onProgress: (p) => showProgress(p, count),
    });
    showDone(summary, count);
  } catch (err) {
    statusEl.className = "done";
    statusEl.textContent = err.name === "AbortError" ? `Stopped. ${count} match${count === 1 ? "" : "es"} so far.` : err.message;
    activeEl.replaceChildren();
  } finally {
    controller = null;
    goBtn.hidden = false;
    stopBtn.hidden = true;
    showCacheInfo();
  }
});

stopBtn.addEventListener("click", () => {
  controller?.abort();
  stopOcr(); // queued OCR jobs cannot be cancelled one by one
});

// ---------- Rendering ----------

function showProgress(p, count) {
  const parts = [];
  if (p.linksTotal) parts.push(`links ${p.linksDone}/${p.linksTotal}`);
  if (p.imagesTotal) parts.push(`images ${p.imagesDone}/${p.imagesTotal}`);
  statusEl.textContent = `${count} match${count === 1 ? "" : "es"} · searching ${parts.join(", ") || "page"}…`;
  activeEl.replaceChildren(
    ...p.active.slice(0, 6).map((t) => Object.assign(document.createElement("li"), { textContent: t }))
  );
}

function showDone(s, count) {
  statusEl.className = "done";
  activeEl.replaceChildren();
  const where = [`this page`];
  if (s.imagesTotal) where.push(`${s.imagesTotal} image${s.imagesTotal === 1 ? "" : "s"}`);
  if (s.linksFound) where.push(`${s.linksTotal} of ${s.linksFound} links`);
  statusEl.textContent =
    (count ? `${count} match${count === 1 ? "" : "es"} in ${s.sources} place${s.sources === 1 ? "" : "s"}.` : "No matches.") +
    ` Searched ${where.join(", ")}.` +
    (s.linksFound > s.linksTotal ? ` Raise “Links” to search more.` : "");

  const items = [
    ...s.failed.map((f) => ({ cls: "err", text: `${f.url} — ${f.error}` })),
  ];
  if (items.length || s.skipped) {
    problemsEl.hidden = false;
    problemsEl.querySelector("summary").textContent =
      [s.failed.length && `${s.failed.length} could not be read`, s.skipped && `${s.skipped} skipped (not a page, PDF or image)`]
        .filter(Boolean).join(" · ");
    problemsEl.querySelector("ul").replaceChildren(
      ...items.map((i) => Object.assign(document.createElement("li"), { className: i.cls, textContent: i.text }))
    );
  }
}

function addResult(r) {
  const li = document.createElement("li");

  const src = document.createElement("div");
  src.className = "src";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = r.source === "page" && r.kind !== "pdf" ? "This page" : r.label;
  name.title = r.label;
  src.append(name);
  const badges = [];
  if (r.page != null) badges.push(`p. ${r.page}`);
  if (r.kind === "pdf") badges.push("PDF");
  if (r.source === "image" || r.kind === "image") badges.push("image");
  if (r.via === "ocr") badges.push("OCR");
  for (const b of badges) src.append(Object.assign(document.createElement("span"), { className: "badge", textContent: b }));

  const snip = document.createElement("div");
  snip.className = "snippet";
  snip.append(r.before, Object.assign(document.createElement("mark"), { textContent: r.match }), r.after);

  const host = document.createElement("div");
  host.className = "host";
  try { host.textContent = r.url.startsWith("data:") ? "embedded image" : decodeURI(r.url); } catch { host.textContent = r.url; }

  li.append(src, snip, host);
  li.addEventListener("click", () => openResult(r));
  resultsEl.append(li);
}

// ---------- Open a result ----------

async function openResult(r) {
  if (r.source === "page" && r.kind !== "pdf") {
    // Text on the current page: select the next occurrence.
    return chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: (text) => {
        if (!window.find(text, false, false, true)) window.find(text.replace(/\s+/g, " "), false, false, true);
      },
      args: [r.match],
    });
  }
  if (r.source === "image") {
    // Image on the current page: scroll to it and outline it.
    return chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: (src) => {
        const img = [...document.images].find((i) => (i.currentSrc || i.src) === src);
        if (!img) return;
        img.scrollIntoView({ behavior: "smooth", block: "center" });
        const old = img.style.outline;
        img.style.outline = "4px solid #ffb800";
        setTimeout(() => (img.style.outline = old), 2500);
      },
      args: [r.url],
    });
  }
  let url = r.url;
  if (r.kind === "pdf" && r.page != null) url += `#page=${r.page}`;
  else if (r.kind === "html") {
    // start,end form also matches when the words sit in different elements.
    const words = r.match.split(/\s+/).filter(Boolean);
    const enc = (w) => encodeURIComponent(w).replace(/-/g, "%2D");
    url += "#:~:text=" + (words.length > 1 ? `${enc(words[0])},${enc(words[words.length - 1])}` : enc(r.match));
  }
  if (r.source === "page") return chrome.tabs.update(currentTabId, { url });
  return chrome.tabs.create({ url, openerTabId: currentTabId ?? undefined });
}
