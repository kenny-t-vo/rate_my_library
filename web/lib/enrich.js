// Cover art, MusicBrainz ids, tracklists and RateYourMusic links, fetched on
// demand instead of in one long batch up front.
//
// MusicBrainz allows one request a second. Fetching 2,400 tracklists eagerly
// is forty minutes with a tab held open. But play counts come entirely from
// the imported file, so the queue is rateable immediately, and you move
// through roughly one album every few seconds. Enriching what is on screen and
// a little way ahead keeps up comfortably and never fetches the hundreds of
// albums you do not reach.

import { putAlbum } from "./store.js";
import { recomputeSpins } from "./aggregate.js";

const UA_NOTE = "rate_my_library";

// one bucket per host so a slow MusicBrainz queue never stalls cover art
class Limiter {
  constructor(perSec, burst = 1) { this.gap = 1000 / perSec; this.next = 0; this.burst = burst; this.live = 0; }
  async take() {
    while (this.live >= this.burst) await new Promise(r => setTimeout(r, 40));
    this.live++;
    const wait = Math.max(0, this.next - Date.now());
    this.next = Math.max(Date.now(), this.next) + this.gap;
    if (wait) await new Promise(r => setTimeout(r, wait));
  }
  done() { this.live--; }
}
const MB  = new Limiter(1, 1);      // musicbrainz asks for one per second
const ART = new Limiter(8, 6);      // image CDNs are fine with more

async function j(url, lim) {
  await lim.take();
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { lim.done(); }
}

// ---- matching --------------------------------------------------------
// Without this check, searching "Big Thief Masterpiece" returns a Shania
// Twain cover. A rejected match means no art rather than wrong art.
const mk = s => (s || "").normalize("NFKD").toLowerCase().replace(/&/g, "and")
  .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().replace(/^the /, "");
const sameArtist = (a, b) => {
  const x = mk(a), y = mk(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [lo, hi] = x.length <= y.length ? [x, y] : [y, x];
  return hi.startsWith(lo + " ") && lo.length >= Math.max(4, 0.45 * hi.length);
};
const stripEd = s => s.replace(/\s*[\(\[][^\)\]]*\b(remaster|deluxe|expanded|edition|version)\b[^\)\]]*[\)\]]\s*$/i, "").trim();
const verify = (a, artist, album) => sameArtist(a.artist, artist) && mk(stripEd(a.album)) === mk(stripEd(album));

// ---- cover art -------------------------------------------------------
async function coverUrl(a) {
  if (a.mbid) {
    const u = `https://coverartarchive.org/release/${a.mbid}/front-500`;
    if (await ok(u)) return { url: u, src: "caa" };
  }
  if (a.rgid) {
    const u = `https://coverartarchive.org/release-group/${a.rgid}/front-500`;
    if (await ok(u)) return { url: u, src: "caa" };
  }
  try {
    const q = encodeURIComponent(`${a.artist} ${a.album}`);
    const d = await j(`https://itunes.apple.com/search?term=${q}&entity=album&limit=8`, ART);
    for (const r of d.results || []) {
      if (!verify(a, r.artistName, r.collectionName)) continue;
      if (r.artworkUrl100) return { url: r.artworkUrl100.replace("100x100bb", "600x600bb"), src: "itunes" };
    }
  } catch {}
  return null;                       // Deezer has no CORS, so it is not reachable here
}
async function ok(url) {
  await ART.take();
  try { const r = await fetch(url, { method: "GET" }); return r.ok; }
  catch { return false; } finally { ART.done(); }
}

// ---- musicbrainz -----------------------------------------------------
async function findMbid(a) {
  const q = `artist:"${a.artist.replace(/"/g, "")}" AND releasegroup:"${a.album.replace(/"/g, "")}"`;
  const d = await j(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=5`, MB);
  const rgs = (d["release-groups"] || []).sort((x, y) => (y.score || 0) - (x.score || 0));
  for (const rg of rgs) {
    const cred = (rg["artist-credit"] || [{}])[0];
    if (!verify(a, (cred.artist || {}).name || "", rg.title || "")) continue;
    return { rgid: rg.id, artist_mbid: (cred.artist || {}).id || "" };
  }
  return null;
}

async function findTracklist(a) {
  let rel;
  if (a.mbid) {
    rel = await j(`https://musicbrainz.org/ws/2/release/${a.mbid}?inc=recordings+release-groups&fmt=json`, MB);
  } else if (a.rgid) {
    const d = await j(`https://musicbrainz.org/ws/2/release?release-group=${a.rgid}&inc=recordings&limit=1&fmt=json`, MB);
    rel = (d.releases || [])[0];
  }
  if (!rel) return null;
  const tracks = (rel.media || []).flatMap(m => m.tracks || []);
  if (!tracks.length) return null;
  return {
    full_tracks: tracks.map((t, k) => ({ n: t.position || k + 1, name: t.title || "" })),
    total_tracks: tracks.length,
    discs: (rel.media || []).length,
    rgid: a.rgid || ((rel["release-group"] || {}).id || ""),
  };
}

async function findRym(a) {
  if (!a.artist_mbid) return null;
  const d = await j(`https://musicbrainz.org/ws/2/release-group?artist=${a.artist_mbid}&inc=url-rels&limit=100&fmt=json`, MB);
  const out = {};
  for (const rg of d["release-groups"] || []) {
    const url = (rg.relations || []).map(r => (r.url || {}).resource || "")
      .find(u => u.includes("rateyourmusic.com"));
    if (url) out[mk(stripEd(rg.title || ""))] = url;
  }
  return out;
}

// ---- queue -----------------------------------------------------------
const inflight = new Set();
let onUpdate = () => {};
export const setUpdateHandler = fn => { onUpdate = fn; };

// artist-level RYM results cover a whole catalogue, so cache per artist
const rymByArtist = new Map();

export async function enrich(a, { wantArt = true, wantIds = true, wantTracks = true, wantRym = true } = {}) {
  if (!a || inflight.has(a.id)) return;
  inflight.add(a.id);
  let changed = false;
  // published as each step lands. the musicbrainz steps below run at one
  // request a second, so holding the cover until they finished put it on
  // screen up to a minute late.
  const flush = async () => {
    if (!changed) return;
    changed = false;
    await putAlbum(a); onUpdate(a);
  };
  try {
    if (wantArt && !a.art && !a.art_tried) {
      const c = await coverUrl(a);
      a.art = c ? c.url : null; a.art_src = c ? c.src : ""; a.art_tried = true; changed = true;
      await flush();
    }
    if (wantIds && !a.rgid && !a.mbid && !a.mbid_tried) {
      const m = await findMbid(a);
      if (m) { a.rgid = m.rgid; a.artist_mbid = a.artist_mbid || m.artist_mbid; }
      a.mbid_tried = true; changed = true;
    }
    if (wantTracks && !a.total_tracks && !a.tracks_tried && (a.mbid || a.rgid)) {
      const t = await findTracklist(a);
      if (t) Object.assign(a, t);
      a.tracks_tried = true; recomputeSpins(a); changed = true;
    }
    if (wantRym && !a.rym && !a.rym_tried && a.artist_mbid) {
      let map = rymByArtist.get(a.artist_mbid);
      if (map === undefined) { map = await findRym(a) || {}; rymByArtist.set(a.artist_mbid, map); }
      const hit = map[mk(stripEd(a.album))];
      if (hit) a.rym = hit;
      a.rym_tried = true; changed = true;
    }
  } catch {
    a.art_tried = a.art_tried || wantArt;          // do not spin on a dead network
  } finally {
    inflight.delete(a.id);
  }
  await flush();
}

// The filmstrip shows roughly a dozen thumbnails either side of the current
// album, so cover art is fetched across that whole window. Tracklists and
// RateYourMusic links are slower and only matter for what you are about to
// rate, so they stay close to the cursor.
export function prefetch(view, i, { art = 14, deep = 4 } = {}) {
  const cur = view[i];
  if (cur) enrich(cur);
  for (let k = 1; k <= art; k++) {
    for (const a of [view[i + k], view[i - k]]) {
      if (!a) continue;
      const near = k <= deep;
      // every musicbrainz step is gated on near. ungating the id lookup put all
      // 29 albums of the art window into a 1/sec queue on every cursor move,
      // which outran the rate at which the queue drained.
      enrich(a, { wantIds: near, wantTracks: near, wantRym: near });
    }
  }
}
