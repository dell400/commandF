// Text cache in IndexedDB. Every extension page (side panel, offscreen
// document) shares the extension's origin, so they all share this cache.
const DB = "deep-find";
const STORE = "text";
const MAX_AGE = 7 * 24 * 3600 * 1000;

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}

export const idbCache = {
  async get(key) {
    try {
      const v = await run("readonly", (s) => s.get(key));
      if (!v || Date.now() - v.t > MAX_AGE) return undefined;
      return v.d;
    } catch { return undefined; }
  },
  async set(key, d) {
    try { await run("readwrite", (s) => s.put({ t: Date.now(), d }, key)); } catch {}
  },
  async count() {
    try { return await run("readonly", (s) => s.count()); } catch { return 0; }
  },
  async clear() {
    try { await run("readwrite", (s) => s.clear()); } catch {}
  },
};
