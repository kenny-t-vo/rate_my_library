// IndexedDB. Everything the app knows lives here and nothing leaves the
// browser: no account, no server, no request carrying your listening history.

// keeps the underscore the project was renamed away from. this string is where
// every existing browser's ratings live; changing it opens an empty database.
// web/app.js passes the same literal to deleteDatabase.
const DB = "rate_my_library", VER = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB, VER);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains("albums"))    d.createObjectStore("albums", { keyPath: "id" });
      if (!d.objectStoreNames.contains("ratings"))   d.createObjectStore("ratings", { keyPath: "id" });
      if (!d.objectStoreNames.contains("snapshots")) d.createObjectStore("snapshots", { keyPath: "ts" });
      if (!d.objectStoreNames.contains("kv"))        d.createObjectStore("kv", { keyPath: "k" });
    };
    rq.onsuccess = () => { _db = rq.result; res(_db); };
    rq.onerror = () => rej(rq.error);
  });
}

const tx = async (names, mode, fn) => {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(names, mode);
    let out;
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    out = fn(...names.map(n => t.objectStore(n)));
  });
};
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const getKV = async (k, fb = null) => {
  const d = await open();
  const r = await req(d.transaction("kv").objectStore("kv").get(k));
  return r ? r.v : fb;
};
export const setKV = (k, v) => tx(["kv"], "readwrite", s => s.put({ k, v }));

export async function allAlbums() {
  const d = await open();
  return req(d.transaction("albums").objectStore("albums").getAll());
}
export async function putAlbums(list) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction("albums", "readwrite"), s = t.objectStore("albums");
    for (const a of list) s.put(a);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}
export const putAlbum = a => tx(["albums"], "readwrite", s => s.put(a));
export const clearAlbums = () => tx(["albums"], "readwrite", s => s.clear());

export async function allRatings() {
  const d = await open();
  const rows = await req(d.transaction("ratings").objectStore("ratings").getAll());
  const out = {};
  for (const r of rows) { const { id, ...rest } = r; out[id] = rest; }
  return out;
}
export const putRating = (id, rec) => tx(["ratings"], "readwrite", s => s.put({ id, ...rec }));
export const delRating = id => tx(["ratings"], "readwrite", s => s.delete(id));
export async function putRatings(map) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction("ratings", "readwrite"), s = t.objectStore("ratings");
    for (const [id, rec] of Object.entries(map)) s.put({ id, ...rec });
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

export async function snapshots() {
  const d = await open();
  const rows = await req(d.transaction("snapshots").objectStore("snapshots").getAll());
  return rows.sort((a, b) => b.ts - a.ts);
}
export async function snapshot(name, kind = "manual") {
  const ratings = await allRatings();
  const rec = { ts: Date.now(), name, kind,
                rated: Object.values(ratings).filter(v => v.rating).length, ratings };
  await tx(["snapshots"], "readwrite", s => s.put(rec));
  const all = await snapshots();
  const autos = all.filter(s => s.kind === "auto").slice(12);
  if (autos.length) await tx(["snapshots"], "readwrite", s => autos.forEach(a => s.delete(a.ts)));
  return rec;
}
export async function restoreSnapshot(ts) {
  const d = await open();
  const rec = await req(d.transaction("snapshots").objectStore("snapshots").get(ts));
  if (!rec) return null;
  await snapshot("before restore", "auto");        // a restore is itself undoable
  await tx(["ratings"], "readwrite", s => s.clear());
  await putRatings(rec.ratings);
  return rec.ratings;
}
export const delSnapshot = ts => tx(["snapshots"], "readwrite", s => s.delete(ts));

export async function usage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
