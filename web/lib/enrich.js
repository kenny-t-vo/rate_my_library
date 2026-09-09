// Cover art, MusicBrainz ids, tracklists and RateYourMusic links, fetched on
// demand instead of in one long batch up front.
//
// Cover art and tracklists both come from iTunes, which answers in about 300ms
// and takes no key. MusicBrainz is 2s a request behind a one-per-second queue
// and degrades sharply when pushed, so it is reached for only what nothing else
// carries: RateYourMusic links.
//
// Play counts come entirely from the imported file, so the queue is rateable
// immediately. Enriching what is on screen and a little way ahead keeps up with
// rating and never fetches the hundreds of albums you do not reach.

import { putAlbum } from "./store.js";
import { recomputeSpins } from "./aggregate.js";

const UA_NOTE = "rate-my-library";

// one bucket per host so a slow MusicBrainz queue never stalls cover art
class Limiter {
  constructor(perSec, burst = 1, timeout = 10000) {
    this.gap = 1000 / perSec; this.next = 0; this.burst = burst; this.live = 0;
    this.timeout = timeout;
  }
  async take() {
    while (this.live >= this.burst) await new Promise(r => setTimeout(r, 40));
    this.live++;
    const wait = Math.max(0, this.next - Date.now());
    this.next = Math.max(Date.now(), this.next) + this.gap;
    if (wait) await new Promise(r => setTimeout(r, wait));
  }
  done() { this.live--; }
}
// timeouts stop one stalled request wedging an album: enrich holds inflight for
// its whole run, and nothing retries an album it thinks is already in progress.
const MB  = new Limiter(1, 1, 25000);   // one a second, and it does take seconds
const ART = new Limiter(8, 6, 10000);   // itunes answers in about 300ms

async function j(url, lim) {
  await lim.take();
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" },
                                 signal: AbortSignal.timeout(lim.timeout) });
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
// Cover Art Archive needs an id, so it is reachable before the MusicBrainz
// lookup only for imports that carried one. enrich() calls this again once a
// lookup has produced an id, which is how iTunes misses get covered.
async function caaArt(a) {
  for (const [kind, id] of [["release", a.mbid], ["release-group", a.rgid]]) {
    if (!id) continue;
    const u = `https://coverartarchive.org/${kind}/${id}/front-500`;
    if (await ok(u)) return { url: u, src: "caa" };
  }
  return null;
}

async function coverUrl(a) {
  const caa = await caaArt(a);
  if (caa) return caa;
  try {
    const hit = await itunesAlbum(a);
    if (hit) {
      a.itid = hit.collectionId;     // reused for the tracklist
      if (hit.artworkUrl100)
        return { url: hit.artworkUrl100.replace("100x100bb", "600x600bb"), src: "itunes" };
    }
  } catch {}
  return null;                       // Deezer has no CORS, so it is not reachable here
}

// An artist's own catalogue, cached for the session. Free-text search ranks a
// real album below unrelated singles often enough that it alone finds 27% of a
// library; asking the artist for their releases instead takes that to 52%.
// Whole Lotta Red is not in fifteen results for "Playboi Carti Whole Lotta Red"
// and is the second entry in Playboi Carti's catalogue.
const catByArtist = new Map();

async function itunesCatalog(a, knownId) {
  const key = mk(a.artist);
  if (catByArtist.has(key)) return catByArtist.get(key);
  let id = knownId;
  if (!id) {
    const s = await j(`https://itunes.apple.com/search?term=${encodeURIComponent(a.artist)}` +
                      `&entity=musicArtist&limit=3`, ART);
    id = ((s.results || []).find(r => sameArtist(a.artist, r.artistName)) || {}).artistId;
  }
  let cols = [];
  if (id) {
    const c = await j(`https://itunes.apple.com/lookup?id=${id}&entity=album&limit=200`, ART);
    cols = (c.results || []).filter(r => r.wrapperType === "collection")
      .map(r => ({ collectionId: r.collectionId, collectionName: r.collectionName,
                   artistName: r.artistName, artworkUrl100: r.artworkUrl100,
                   trackCount: r.trackCount }));
  }
  catByArtist.set(key, cols);
  return cols;
}

// A deluxe reissue and the album proper carry the same name and both verify.
// The smaller one is the album, and its track count is what album spins divide
// by, so a 19-track Souvlaki deluxe must not stand in for the 10-track record.
function bestHit(a, rows) {
  const hits = rows.filter(r => verify(a, r.artistName, r.collectionName));
  hits.sort((x, y) => (x.trackCount || 1e6) - (y.trackCount || 1e6));
  return hits[0] || null;
}

async function itunesAlbum(a) {
  const q = encodeURIComponent(`${a.artist} ${a.album}`);
  const d = await j(`https://itunes.apple.com/search?term=${q}&entity=album&limit=15`, ART);
  const res = d.results || [];
  const hit = bestHit(a, res);
  if (hit) return hit;
  // a miss usually still returns the right artist under some other release, and
  // that carries the id, which saves the search the catalogue would need
  const sib = res.find(r => sameArtist(a.artist, r.artistName));
  return bestHit(a, await itunesCatalog(a, sib && sib.artistId));
}
async function ok(url) {
  await ART.take();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ART.timeout) });
    return r.ok;
  } catch { return false; } finally { ART.done(); }
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

// One request, no key, ~300ms, and the collection id already came back with the
// cover. MusicBrainz needs a search plus a release fetch, each behind the 1/sec
// queue, so this is tried first and MusicBrainz only covers what iTunes missed.
async function itunesTracks(a) {
  const d = await j(`https://itunes.apple.com/lookup?id=${a.itid}&entity=song&limit=300`, ART);
  const songs = (d.results || []).filter(r => r.wrapperType === "track" && r.kind === "song");
  if (!songs.length) return null;
  songs.sort((x, y) => (x.discNumber || 1) - (y.discNumber || 1) ||
                       (x.trackNumber || 0) - (y.trackNumber || 0));
  return {
    full_tracks: songs.map((t, k) => ({ n: t.trackNumber || k + 1, name: t.trackName || "" })),
    total_tracks: songs.length,
    discs: Math.max(1, ...songs.map(t => t.discNumber || 1)),
  };
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
    if (wantTracks && !a.total_tracks && !a.tracks_tried && a.itid) {
      const t = await itunesTracks(a);
      if (t) {
        Object.assign(a, t);
        a.tracks_tried = true; recomputeSpins(a); changed = true;
        await flush();
      }
    }
    // only RateYourMusic links need MusicBrainz now, and they hang off the
    // artist id, so this runs after art and tracklists are already on screen
    if (wantIds && !a.rgid && !a.mbid && !a.mbid_tried) {
      const m = await findMbid(a);
      if (m) { a.rgid = m.rgid; a.artist_mbid = a.artist_mbid || m.artist_mbid; }
      a.mbid_tried = true; changed = true;
    }
    // iTunes does not have everything — it returns no Whole Lotta Red for
    // Playboi Carti, only singles by other artists. Cover Art Archive covers
    // those, but only now that the lookup above has an id to ask with.
    if (wantArt && !a.art && !a.caa_tried && (a.mbid || a.rgid)) {
      const c = await caaArt(a);
      if (c) { a.art = c.url; a.art_src = c.src; }
      a.caa_tried = true; changed = true;
      await flush();
    }
    if (wantTracks && !a.total_tracks && !a.tracks_tried && (a.mbid || a.rgid)) {
      const t = await findTracklist(a);
      if (t) Object.assign(a, t);
      a.tracks_tried = true; recomputeSpins(a); changed = true;
      await flush();
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
// album, so iTunes art covers that whole window and tracklists a little of it.
//
// Only the album under the cursor touches MusicBrainz. Measured at 2s a request
// and up to 18s when pushed, nine of those per cursor move stalled the window:
// nine albums sat mid-enrich for the better part of a minute each. One album at
// a time is inside what MusicBrainz allows at any speed a person can rate.
let lastI = -1;
const ID_AHEAD = 3;     // albums ahead of the cursor allowed a MusicBrainz lookup

export function prefetch(view, i, { art = 14, tracks = 4 } = {}) {
  const cur = view[i];
  if (cur) enrich(cur);
  // the window leans the way you are travelling. symmetric, half the budget
  // went to albums behind the cursor, whose covers are already fetched and on
  // screen, while the ones about to arrive were still queued.
  const dir = lastI >= 0 && i < lastI ? -1 : 1;
  lastI = i;
  const behind = Math.ceil(art / 3);
  for (let k = 1; k <= art; k++) {
    for (const [a, ahead] of [[view[i + dir * k], true], [view[i - dir * k], false]]) {
      if (!a || (!ahead && k > behind)) continue;
      // iTunes has no entry for a good half of a library like this — no Whole
      // Lotta Red, little classical, few anime soundtracks. Cover Art Archive
      // has them but needs an id, and ids cost a MusicBrainz request a second.
      // So that budget goes only to albums iTunes has already failed on.
      const needsId = ahead && k <= ID_AHEAD && a.art_tried && !a.art && !a.mbid_tried;
      enrich(a, { wantIds: needsId, wantRym: false, wantTracks: k <= tracks });
    }
  }
}
