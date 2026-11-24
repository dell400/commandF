// Deep Find search engine. No chrome.* calls here, so it also runs in a
// plain web page for testing. Tesseract must be loaded as a global first.
import * as pdfjsLib from "./lib/pdfjs/pdf.min.mjs";

const LIB = new URL("./lib/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdfjs/pdf.worker.min.mjs";

const PDF_OPTS = {
  cMapUrl: LIB + "pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: LIB + "pdfjs/standard_fonts/",
  wasmUrl: LIB + "pdfjs/wasm/",
  iccUrl: LIB + "pdfjs/iccs/",
  isEvalSupported: false,
  // Errors only. Broken fonts in real-world PDFs log harmless "TT: ..."
  // warnings that Chrome lists on the extension's Errors page.
  verbosity: pdfjsLib.VerbosityLevel?.ERRORS ?? 0,
};

const DOWNLOAD_CONCURRENCY = 5;
const OCR_WORKERS = 2;
const SCAN_TEXT_THRESHOLD = 30; // a page with fewer non-space chars is a scan
const MAX_BYTES = 80 * 1024 * 1024;
const MAX_RENDER_SIDE = 4000;
const SNIPPET = 60;
const MAX_HITS_PER_PAGE = 10;
const CACHE_VERSION = 1;
const SKIP_EXT = /\.(zip|gz|tgz|rar|7z|exe|dmg|msi|pkg|mp3|mp4|m4a|mov|avi|wmv|wav|flac|webm|mkv|iso|apk|css|js|json|woff2?|ttf|ico|svg|docx?|xlsx?|pptx?|csv|kmz|kml|shp)(\?|$)/i;
const IMG_EXT = /\.(png|jpe?g|gif|bmp|webp|tiff?)(\?|$)/i;

// ---------- OCR ----------

let schedulerReady = null;
let generation = 0;

function getScheduler() {
  if (schedulerReady) return schedulerReady;
  const gen = generation;
  schedulerReady = (async () => {
    const s = Tesseract.createScheduler();
    const workers = await Promise.all(
      Array.from({ length: OCR_WORKERS }, () =>
        Tesseract.createWorker("eng", 1, {
          workerPath: LIB + "tesseract/worker.min.js",
          corePath: LIB + "tesseract/core",
          langPath: LIB + "tesseract/lang",
          workerBlobURL: false,
        })
      )
    );
    workers.forEach((w) => s.addWorker(w));
    // Stopped while the workers were starting: shut them down.
    if (gen !== generation) { s.terminate(); throw abortError(); }
    return s;
  })();
  return schedulerReady;
}

// Kills the OCR workers. Queued jobs cannot be cancelled one by one.
export async function stopOcr() {
  const ready = schedulerReady;
  generation++;
  schedulerReady = null;
  if (!ready) return;
  try { (await ready).terminate(); } catch {}
}

async function ocr(image, signal) {
  if (signal?.aborted) throw abortError();
  const s = await getScheduler();
  // A terminated worker never settles its jobs, so also settle on abort.
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    s.addJob("recognize", image)
      .then(({ data }) => resolve(data.text || ""), reject)
      .finally(() => signal?.removeEventListener("abort", onAbort));
  });
}

// ---------- Matching ----------

const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "John Smith" matches "john smith", "John\nSmith" and "JohnSmith".
export function makeMatcher(keyword) {
  const chars = [...keyword.replace(/\s+/g, "")];
  if (!chars.length) return null;
  return new RegExp(chars.map(escapeRe).join("\\s*"), "gi");
}

export function findMatches(text, re) {
  if (!text) return [];
  const flat = text.replace(/\s+/g, " ");
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(flat)) && out.length < MAX_HITS_PER_PAGE) {
    if (!m[0]) { re.lastIndex++; continue; }
    const s = m.index, e = s + m[0].length;
    out.push({
      before: (s > SNIPPET ? "…" : "") + flat.slice(Math.max(0, s - SNIPPET), s),
      match: m[0],
      after: flat.slice(e, e + SNIPPET) + (e + SNIPPET < flat.length ? "…" : ""),
    });
  }
  return out;
}

// ---------- Text extraction ----------

function abortError() {
  return new DOMException("Stopped", "AbortError");
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, template, svg").forEach((n) => n.remove());
  const root = doc.body || doc.documentElement;
  const parts = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode.nodeValue;
    if (t.trim()) parts.push(t);
  }
  return { title: (doc.title || "").trim(), text: parts.join(" ") };
}

function decode(bytes, contentType) {
  const cs = /charset=([^;]+)/i.exec(contentType || "")?.[1]?.trim();
  try { return new TextDecoder(cs || "utf-8").decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

function looksLikePdf(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, MAX_RENDER_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // "print" intent avoids requestAnimationFrame, which stalls when the panel is hidden.
  await page.render({ canvasContext: ctx, canvas, viewport, intent: "print" }).promise;
  return canvas;
}

// Calls onPage({ n, text, via }) for each page as it is ready.
async function extractPdf(bytes, { useOcr, signal, onPage, onOcrPage }) {
  const task = pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes });
  const pdf = await task.promise;
  let title = "";
  try { title = (await pdf.getMetadata())?.info?.Title || ""; } catch {}
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      if (signal?.aborted) throw abortError();
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      let text = tc.items.map((it) => (it.str || "") + (it.hasEOL ? " " : "")).join("");
      let via = "text";
      if (useOcr && text.replace(/\s/g, "").length < SCAN_TEXT_THRESHOLD) {
        onOcrPage?.(n, pdf.numPages);
        const canvas = await renderPage(page);
        text = await ocr(canvas, signal);
        canvas.width = canvas.height = 0;
        via = "ocr";
      }
      page.cleanup();
      onPage({ n, text, via });
    }
  } finally {
    task.destroy();
  }
  return title;
}

// Downloads one URL and returns { kind, title, pages: [{n, text, via}] }.
// onPage fires for each page as soon as it is ready (useful for long scans).
async function extractUrl(url, { useOcr, signal, onPage, onOcrPage }) {
  if (SKIP_EXT.test(new URL(url).pathname)) return { kind: "skip", reason: "file type", pages: [] };
  const res = await fetch(url, { signal, credentials: "include", redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return { kind: "skip", reason: "too large", pages: [] };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const pages = [];
  let kind = "html";
  const push = (p) => { p.kind = kind; pages.push(p); onPage?.(p); };

  if (ct.includes("pdf") || looksLikePdf(bytes)) {
    kind = "pdf";
    const title = await extractPdf(bytes, { useOcr, signal, onPage: push, onOcrPage });
    return { kind: "pdf", title, pages };
  }
  if (ct.startsWith("image/") || (!ct && IMG_EXT.test(url))) {
    if (!useOcr) return { kind: "skip", reason: "image (OCR off)", pages: [] };
    kind = "image";
    push({ n: null, text: await ocr(new Blob([bytes], { type: ct || "image/png" }), signal), via: "ocr" });
    return { kind: "image", title: "", pages };
  }
  if (ct.includes("html") || ct.includes("xml") || !ct) {
    const { title, text } = htmlToText(decode(bytes, ct));
    push({ n: null, text, via: "text" });
    return { kind: "html", title, pages };
  }
  if (ct.startsWith("text/")) {
    kind = "text";
    push({ n: null, text: decode(bytes, ct), via: "text" });
    return { kind: "text", title: "", pages };
  }
  return { kind: "skip", reason: ct.split(";")[0], pages: [] };
}

// Cache wrapper. A result extracted with OCR also serves a search without OCR.
async function getDoc(url, opts, cache) {
  const ocrKey = `v${CACHE_VERSION}:ocr:${url}`;
  const plainKey = `v${CACHE_VERSION}:plain:${url}`;
  const keys = opts.useOcr ? [ocrKey] : [ocrKey, plainKey];
  for (const k of keys) {
    const hit = await cache.get(k);
    if (hit) {
      hit.pages.forEach((p) => opts.onPage?.(p));
      return { ...hit, cached: true };
    }
  }
  const doc = await extractUrl(url, opts);
  await cache.set(opts.useOcr ? ocrKey : plainKey, doc);
  return doc;
}

// ---------- Search ----------

// Sign-in, sign-out and unsubscribe links are never worth reading, and a GET
// to some sign-out links would sign the user out.
const ACCOUNT_LINK = /\/(log[-_]?(in|out|off)|sign[-_]?(in|out|off|up)|logoff|unsubscribe)(\b|_|$)/i;

// Order: PDFs the reader can see, hidden PDFs, other visible links, other
// hidden links (menus and drawers). Within each group, page order.
function prioritize(links) {
  const isPdf = (l) => /\.pdf(\?|$)/i.test(l.url) || /\bpdf\b/i.test(l.label);
  const rank = (l) => (isPdf(l) ? 0 : 2) + (l.hidden ? 1 : 0);
  return links
    .filter((l) => { try { return !ACCOUNT_LINK.test(new URL(l.url).pathname); } catch { return false; } })
    .map((l, i) => ({ l, i, r: rank(l) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.l);
}

async function pool(items, limit, fn, signal) {
  let i = 0;
  const run = async () => {
    while (i < items.length && !signal?.aborted) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * page: { url, title, text, images: [{url,label}], links: [{url,label}], isDocument? }
 * opts: { keyword, maxLinks, useOcr, signal, cache, onResult(r), onProgress(p) }
 * Returns a summary.
 */
export async function search(page, opts) {
  const { keyword, maxLinks = 50, useOcr = true, signal, cache, onResult, onProgress } = opts;
  const re = makeMatcher(keyword);
  if (!re) return null;

  const allLinks = prioritize(page.links || []);
  const links = allLinks.slice(0, maxLinks);
  const images = useOcr ? page.images || [] : [];
  const stats = {
    matches: 0, sources: new Set(), imagesDone: 0, imagesTotal: images.length,
    linksDone: 0, linksTotal: links.length, linksFound: allLinks.length,
    failed: [], skipped: 0, ocrPages: 0,
  };
  const active = new Map(); // url -> status text
  const progress = () => onProgress?.({ ...stats, active: [...active.values()] });

  const emit = (base, text, n, via) => {
    for (const m of findMatches(text, re)) {
      stats.matches++;
      stats.sources.add(base.url + "#" + (n ?? ""));
      onResult?.({ ...base, page: n, via, ...m });
    }
  };

  // 1. Text of the current page.
  if (page.text) emit({ source: "page", kind: "html", url: page.url, label: page.title || "This page" }, page.text, null, "text");

  const docOpts = (base, labelForStatus) => ({
    useOcr, signal,
    onPage: (p) => emit({ ...base, kind: p.kind || base.kind }, p.text, p.n, p.via),
    onOcrPage: (n, total) => {
      stats.ocrPages++;
      active.set(base.url, `OCR ${labelForStatus} p.${n}/${total}`);
      progress();
    },
  });

  // 1b. The current tab is itself a PDF (Chrome's PDF viewer has no DOM to read).
  if (page.isDocument) {
    const base = { source: "page", kind: "pdf", url: page.url, label: page.title || "This document" };
    active.set(page.url, "Reading this document");
    progress();
    try { await getDoc(page.url, docOpts(base, "this document"), cache); }
    catch (e) { if (e.name === "AbortError") throw e; stats.failed.push({ url: page.url, error: e.message }); }
    active.delete(page.url);
  }

  progress();

  // 2. Images on the page (OCR) and 3. linked pages, run together.
  const imageTask = pool(images, OCR_WORKERS, async (img, i) => {
    const base = { source: "image", kind: "image", url: img.url, label: img.label || `Image ${i + 1}` };
    try {
      const key = `v${CACHE_VERSION}:img:${img.url}`;
      let text = (await cache.get(key))?.text;
      if (text == null) {
        active.set(img.url, `OCR image ${i + 1}/${images.length}`);
        progress();
        const res = await fetch(img.url, { signal, credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await ocr(await res.blob(), signal);
        await cache.set(key, { text });
      }
      emit(base, text, null, "ocr");
    } catch (e) {
      if (e.name === "AbortError" || signal?.aborted) return;
      stats.failed.push({ url: img.url, error: e.message });
    } finally {
      active.delete(img.url);
      stats.imagesDone++;
      progress();
    }
  }, signal);

  const linkTask = pool(links, DOWNLOAD_CONCURRENCY, async (link) => {
    const short = shortName(link);
    const base = { source: "link", kind: "html", url: link.url, label: link.label || short };
    active.set(link.url, `Reading ${short}`);
    progress();
    try {
      const doc = await getDoc(link.url, docOpts(base, short), cache);
      if (doc.kind === "skip") stats.skipped++;
    } catch (e) {
      if (e.name === "AbortError" || signal?.aborted) return;
      stats.failed.push({ url: link.url, error: e.message });
    } finally {
      active.delete(link.url);
      stats.linksDone++;
      progress();
    }
  }, signal);

  await Promise.all([imageTask, linkTask]);
  if (signal?.aborted) throw abortError();
  return { ...stats, sources: stats.sources.size, active: [] };
}

// ---------- Link scanner (for the Cmd-F find bar) ----------
//
// Text extraction does not depend on the keyword, so one download per URL
// serves every keystroke. Jobs are shared between scans; a new scan for a
// longer keyword just re-reads the pages already extracted.

const jobs = new Map(); // key -> job
const queue = [];       // jobs waiting to start
let running = 0;

function makeJob(key, item, useOcr, cache) {
  const job = { key, item, pages: [], listeners: new Set(), waiters: 0, started: false, done: false, error: null };
  job.finished = new Promise((r) => (job.resolve = r));
  job.run = async () => {
    const onPage = (p) => { job.pages.push(p); job.listeners.forEach((l) => l(p)); };
    if (item.type === "image") {
      const ck = `v${CACHE_VERSION}:img:${item.url}`;
      let text = (await cache.get(ck))?.text;
      if (text == null) {
        const res = await fetch(item.url, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await ocr(await res.blob());
        await cache.set(ck, { text });
      }
      onPage({ n: null, text, via: "ocr", kind: "image" });
    } else {
      const doc = await getDoc(item.url, { useOcr, onPage }, cache);
      job.kind = doc.kind;
    }
  };
  return job;
}

function pump() {
  while (running < DOWNLOAD_CONCURRENCY && queue.length) {
    const job = queue.shift();
    if (job.waiters === 0) { jobs.delete(job.key); continue; } // nobody wants it any more
    job.started = true;
    running++;
    job.run()
      .catch((e) => { job.error = e; jobs.delete(job.key); }) // failed jobs are retried next time
      .finally(() => { job.done = true; running--; job.resolve(); pump(); });
  }
}

function getJob(item, useOcr, cache) {
  const key = `${item.type}|${useOcr ? "ocr" : "plain"}|${item.url}`;
  let job = jobs.get(key);
  if (!job) {
    job = makeJob(key, item, useOcr, cache);
    jobs.set(key, job);
    queue.push(job);
  }
  return job;
}

/**
 * Finds which links and images contain the keyword. Reports each one once,
 * with its first match: onHit({ url, type, kind, page, via, before, match, after }).
 * opts: { keyword, links: [{url,label}], images: [{url}], useOcr, maxLinks, signal,
 *         cache, onHit, onProgress({ done, total }) }
 */
export async function scanLinks(opts) {
  const { keyword, useOcr = true, maxLinks = 50, signal, cache, onHit, onProgress } = opts;
  const re = makeMatcher(keyword);
  if (!re) return { hits: 0, done: 0, total: 0 };
  const items = [
    ...(useOcr ? (opts.images || []).map((i) => ({ ...i, type: "image" })) : []),
    ...prioritize(opts.links || []).slice(0, maxLinks).map((l) => ({ ...l, type: "link" })),
  ];
  let done = 0, hits = 0, failed = 0;
  const progress = () => onProgress?.({ done, total: items.length });
  progress();

  // Promise executors run now, so every waiter is registered before pump().
  const waits = items.map((item) => new Promise((resolve) => {
    const job = getJob(item, useOcr, cache);
    job.waiters++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      job.listeners.delete(check);
      job.waiters--;
      if (job.error) failed++;
      done++;
      progress();
      resolve();
    };
    const check = (p) => {
      if (finished) return;
      const m = findMatches(p.text, re)[0];
      if (!m) return;
      hits++;
      onHit?.({ url: item.url, type: item.type, kind: p.kind || "html", page: p.n, via: p.via, ...m });
      finish();
    };
    for (const p of job.pages) check(p);
    if (finished) return;
    job.listeners.add(check);
    job.finished.then(finish);
    signal?.addEventListener("abort", finish, { once: true });
  }));
  pump();
  await Promise.all(waits);
  return { hits, failed, done, total: items.length };
}

function shortName(link) {
  try {
    const u = new URL(link.url);
    const file = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || u.hostname);
    return file.length > 50 ? file.slice(0, 47) + "…" : file;
  } catch { return link.url; }
}
