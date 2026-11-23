// Hidden extension page. The find bar on a web page cannot download from
// other sites or run the OCR engine, so it connects here through a port.
//
// Port messages in:  { type: "scan", id, keyword, links, images, useOcr, maxLinks }
//                    { type: "cancel" }
// Port messages out: { type: "hit", id, hit } { type: "progress", id, done, total }
//                    { type: "done", id, hits, failed, done, total }
import { scanLinks } from "./engine.js";
import { idbCache } from "./idbcache.js";

export function attach(port) {
  let controller = null;
  const post = (m) => { try { port.postMessage(m); } catch {} };

  port.onMessage.addListener((msg) => {
    if (msg?.type === "cancel") { controller?.abort(); return; }
    if (msg?.type !== "scan") return;
    controller?.abort();
    const ctrl = (controller = new AbortController());
    const id = msg.id;
    scanLinks({
      ...msg,
      signal: ctrl.signal,
      cache: idbCache,
      onHit: (hit) => !ctrl.signal.aborted && post({ type: "hit", id, hit }),
      onProgress: (p) => !ctrl.signal.aborted && post({ type: "progress", id, ...p }),
    }).then((s) => { if (!ctrl.signal.aborted) post({ type: "done", id, ...s }); });
  });
  port.onDisconnect.addListener(() => controller?.abort());
}

if (globalThis.chrome?.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "deep-find") attach(port);
  });
}
