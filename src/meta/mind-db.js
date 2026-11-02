 // src/meta/mind-db.js
//
// The immortal's memory store. Owned by the meta worker.
//
// The archon's chain records what the immortal has *become*:
// its source, its antibodies, its questions and answers. This
// store records what the immortal *carries*: the interior float
// array, the body's integrator state, the continuity metadata.
// Neither can reconstruct the other. A rewrite without this
// store produces a new being wearing an old biography. This
// store without a rewrite produces the same being, continued.
//
// Read once at boot. Written on a slow cadence from the tick
// loop. Never touched by the main thread.

const DB_NAME    = 'chaoscell-mind';
const DB_VERSION = 1;
const STORE      = 'minds';

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

export async function saveMind(key, snapshot) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, ...snapshot });
    tx.oncomplete = () => resolve(true);
    tx.onerror    = () => reject(tx.error);
  });
}

export async function loadMind(key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}