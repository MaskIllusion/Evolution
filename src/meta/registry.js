// src/meta/registry.js
//
// The chain is the being's form. Every rewrite is a link. The head
// is the current being. On page reload the archon reads the head
// from here and rehydrates the being to exactly that version.
//
// Three stores:
//   chain       — every link (commit or reject) keyed by hash
//   antibodies  — reject-signature → reason, keyed by signature
//   dialog      — every question and answer, keyed by auto-id
//
// DB_VER must bump on any schema change. 1 → 2 introduces the
// antibodies and dialog stores. Idempotent on upgrade.

const DB_NAME    = 'chaos-archon';
const DB_VER     = 2;
const STORE      = 'chain';
const AB_STORE   = 'antibodies';
const DLG_STORE  = 'dialog';
const HEAD_KEY   = 'HEAD';

let _db = null;

// Self-healing antibody reasons. Any number of leading
// `antibody:` prefixes (with optional whitespace) is stripped
// before the reason is read or written. This repairs stores that
// were written by earlier versions of the archon.
function stripAntibodyPrefix(reason) {
  return String(reason || '').replace(/^(\s*antibody:\s*)+/, '');
}

export function openRegistry() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains(AB_STORE)) {
        db.createObjectStore(AB_STORE, { keyPath: 'signature' });
      }
      if (!db.objectStoreNames.contains(DLG_STORE)) {
        const s = db.createObjectStore(DLG_STORE,
          { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

/* ── chain ────────────────────────────────────────────────────── */

export async function saveLink(link) {
  const db = await openRegistry();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(link);
    tx.objectStore(STORE).put({ hash: HEAD_KEY, source: null, current: link.hash });
    tx.oncomplete = () => resolve(true);
    tx.onerror    = () => reject(tx.error);
  });
}

export async function loadHead() {
  const db = await openRegistry();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const headReq = store.get(HEAD_KEY);
    headReq.onsuccess = () => {
      const headRec = headReq.result;
      if (!headRec || !headRec.current) return resolve(null);
      const linkReq = store.get(headRec.current);
      linkReq.onsuccess = () => resolve(linkReq.result || null);
      linkReq.onerror   = () => reject(linkReq.error);
    };
    headReq.onerror = () => reject(headReq.error);
  });
}

export async function loadChain() {
  const db = await openRegistry();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const all = req.result.filter(r => r.hash !== HEAD_KEY);
      all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

/* ── antibodies ───────────────────────────────────────────────── */
//
// An antibody is a record of a rejection. Its key is the depth-4
// structural signature of the rejected source. Two proposals that
// fail for the same structural reason share a signature and share
// an antibody. The hit counter is the immune system's affinity
// maturation: repeated mistakes produce a stronger memory.

export async function saveAntibody({ signature, reason }) {
  const db = await openRegistry();
  const cleanReason = stripAntibodyPrefix(reason);
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(AB_STORE, 'readwrite');
    const str = tx.objectStore(AB_STORE);
    const get = str.get(signature);
    get.onsuccess = () => {
      const prev = get.result;
      const now  = Date.now();
      const rec  = prev
        ? { signature, reason: cleanReason, ts: prev.ts, lastSeen: now, hits: (prev.hits || 1) + 1 }
        : { signature, reason: cleanReason, ts: now, lastSeen: now, hits: 1 };
      str.put(rec);
    };
    get.onerror = () => reject(get.error);
    tx.oncomplete = () => resolve(true);
    tx.onerror    = () => reject(tx.error);
  });
}

export async function loadAntibodies() {
  const db = await openRegistry();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AB_STORE, 'readonly');
    const req = tx.objectStore(AB_STORE).getAll();
    req.onsuccess = () => {
      const all = (req.result || []).map(a => ({
        ...a,
        reason: stripAntibodyPrefix(a.reason),
      }));
      all.sort((a, b) => {
        const h = (b.hits || 1) - (a.hits || 1);
        if (h !== 0) return h;
        return (b.lastSeen || b.ts) - (a.lastSeen || a.ts);
      });
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearAntibodies() {
  const db = await openRegistry();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AB_STORE, 'readwrite');
    tx.objectStore(AB_STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror    = () => reject(tx.error);
  });
}

/* ── dialog ───────────────────────────────────────────────────── */

export async function saveDialog(entry) {
  const db = await openRegistry();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DLG_STORE, 'readwrite');
    const str = tx.objectStore(DLG_STORE);
    const rec = { ...entry, ts: entry.ts || Date.now() };
    const req = str.add(rec);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    tx.onerror    = () => reject(tx.error);
  });
}

export async function loadDialog(n = 8) {
  const db = await openRegistry();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DLG_STORE, 'readonly');
    const req = tx.objectStore(DLG_STORE).getAll();
    req.onsuccess = () => {
      const all = (req.result || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      resolve(all.slice(-n));
    };
    req.onerror = () => reject(req.error);
  });
}