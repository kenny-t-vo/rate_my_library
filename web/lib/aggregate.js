// Turns a flat list of plays into the album records the app renders.
// Ported from build_albums() in build.py; the grouping key and id must match
// so a library built here and one built by the CLI are interchangeable.

import { normKey, normTrack, stripEdition, md5 } from "./normalize.js";

const top = m => { let bk = null, bv = -1; for (const [k, v] of m) if (v > bv) { bv = v; bk = k; } return bk; };
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

export const rymSearch = (artist, album) =>
  "https://rateyourmusic.com/search?searchterm=" +
  encodeURIComponent(artist + " " + album).replace(/%20/g, "+") + "&searchtype=l";

export function aggregate(plays, { minPlays = 8, onProgress } = {}) {
  const G = new Map();
  const artistPlays = new Map(), artistNames = new Map(), artistMbids = new Map();

  for (let n = 0; n < plays.length; n++) {
    if (onProgress && n % 20000 === 0) onProgress(n / plays.length);
    const p = plays[n];
    const ak = normKey(p.artist);
    const key = ak + " " + normKey(stripEdition(p.album));

    let g = G.get(key);
    if (!g) {
      g = { ak, plays: 0, variants: new Map(), tracks: new Map(), trackNames: new Map(),
            mbids: new Map(), first: 0, last: 0, years: new Map() };
      G.set(key, g);
    }
    g.plays++;
    bump(g.variants, p.album);
    bump(artistPlays, ak);
    if (!artistNames.has(ak)) artistNames.set(ak, new Map());
    bump(artistNames.get(ak), p.artist);

    if (p.track) {
      const nt = normTrack(p.track), lk = nt.toLowerCase();
      bump(g.tracks, lk);
      const cur = g.trackNames.get(lk);
      if (cur === undefined || nt.length < cur.length) g.trackNames.set(lk, nt);
    }
    if (p.mbid) bump(g.mbids, p.mbid);
    if (p.artistMbid) {
      if (!artistMbids.has(ak)) artistMbids.set(ak, new Map());
      bump(artistMbids.get(ak), p.artistMbid);
    }
    if (p.ts) {
      if (!g.first || p.ts < g.first) g.first = p.ts;
      if (p.ts > g.last) g.last = p.ts;
      bump(g.years, String(new Date(p.ts * 1000).getFullYear()));
    }
  }

  const out = [];
  for (const g of G.values()) {
    if (g.plays < minPlays) continue;
    const artist = top(artistNames.get(g.ak));
    const vs = [...g.variants.entries()].sort((a, b) => b[1] - a[1]);
    // prefer a variant that is already clean, so the display title is not a
    // stripped remaster string when a plain one exists
    const clean = vs.filter(([t]) => stripEdition(t) === t);
    const album = stripEdition((clean[0] || vs[0])[0]);
    const tracks = [...g.tracks.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, c]) => ({ name: g.trackNames.get(k), plays: c }));

    out.push({
      id: md5(normKey(artist) + "|" + normKey(album)).slice(0, 12),
      artist, album,
      plays: g.plays,
      tracks,
      distinct_tracks: tracks.length,
      spins: tracks.length ? +(g.plays / tracks.length).toFixed(2) : 0,
      spins_basis: "heard",
      top_track: tracks.length ? tracks[0].name : "",
      top_track_plays: tracks.length ? tracks[0].plays : 0,
      mbid: g.mbids.size ? top(g.mbids) : "",
      rgid: "",
      artist_mbid: artistMbids.has(g.ak) ? top(artistMbids.get(g.ak)) : "",
      first: g.first, last: g.last,
      years: Object.fromEntries(g.years),
      artist_plays: artistPlays.get(g.ak),
      variants: vs.length > 1 ? vs.map(v => v[0]) : [],
      art: null, art_src: "", rym: "",
      rym_search: rymSearch(artist, album),
    });
  }
  out.sort((a, b) => b.plays - a.plays);
  out.forEach((a, n) => a.rank = n + 1);
  return out;
}

// Divide by the album's own length where known, heard tracks otherwise. A
// heard count above the fetched total means bonus tracks or another pressing,
// so the larger number wins.
export function recomputeSpins(a) {
  const total = a.total_tracks || 0;
  const basis = total ? Math.max(total, a.distinct_tracks) : a.distinct_tracks;
  a.spins_basis = total ? "album" : "heard";
  a.spins = basis ? +(a.plays / basis).toFixed(2) : 0;
  return a;
}
