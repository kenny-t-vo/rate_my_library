// Readers for the two supported exports. Both yield the same play record:
// {artist, album, track, ts}. Everything runs off the main thread's critical
// path by chunking, so a 120k-row file does not freeze the tab.

export const SPOTIFY_MIN_MS = 30000;   // matches Last.fm's scrobble threshold

// ---- csv -------------------------------------------------------------
// Hand-rolled because the field values contain commas and escaped quotes and
// a regex split gets them wrong.
function* csvRows(text) {
  let i = 0, field = "", row = [], inQ = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") yield row;
      row = []; i++; continue;
    }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); yield row; }
}

const HEAD_WORDS = new Set(["artist", "album", "track", "uts", "utc_time", "date", "timestamp"]);

// bare unix seconds, or "06 Sep 2026, 00:46" in whatever zone the exporter used,
// which is read as local. parsed by hand because only V8 takes that second form.
const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
                 jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function parseWhen(s) {
  s = (s || "").trim();
  if (!s) return 0;
  if (/^\d{9,11}$/.test(s)) return parseInt(s, 10);
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})[,\s]+(\d{1,2}):(\d{2})/.exec(s);
  const mo = m && MONTHS[m[2].toLowerCase()];
  if (mo !== undefined && mo !== null)
    return Math.floor(new Date(+m[3], mo, +m[1], +m[4], +m[5]).getTime() / 1000) || 0;
  const d = Date.parse(s);
  return isNaN(d) ? 0 : Math.floor(d / 1000);
}

export function readLastfmCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = csvRows(text);
  const first = rows.next().value;
  if (!first) return [];

  // Last.fm's own export is headed. The third-party exporters people actually
  // use write no header at all: artist,album,track,"06 Sep 2026, 00:46".
  let ix, pending = null;
  if (first.some(c => HEAD_WORDS.has(c.trim().toLowerCase()))) {
    ix = {};
    first.forEach((h, k) => ix[h.trim().toLowerCase()] = k);
    const need = ["artist", "album", "track"];
    if (need.some(k => ix[k] === undefined))
      throw new Error("This CSV has a header but no " +
                      need.filter(k => ix[k] === undefined).join("/") + " column.");
  } else if (first.length >= 4) {
    ix = { artist: 0, album: 1, track: 2, uts: 3 };
    pending = first;
  } else {
    throw new Error("This CSV is neither a headed Last.fm export (artist, album, track, uts) " +
                    "nor the headerless artist,album,track,date form. It has " +
                    first.length + " column" + (first.length === 1 ? "" : "s") + ".");
  }

  const out = [];
  const add = r => {
    const artist = (r[ix.artist] || "").trim();
    const album  = (r[ix.album]  || "").trim();
    if (!artist || !album) return;
    out.push({
      artist, album,
      track: (r[ix.track] || "").trim(),
      ts: parseWhen(r[ix.uts]),
      mbid: (r[ix.album_mbid] || "").trim(),
      artistMbid: (r[ix.artist_mbid] || "").trim(),
    });
  };
  if (pending) add(pending);
  for (const r of rows) add(r);
  return out;
}

// ---- spotify extended streaming history ------------------------------
const S_TRACK  = ["master_metadata_track_name", "trackName", "track_name"];
const S_ARTIST = ["master_metadata_album_artist_name", "artistName", "artist_name"];
const S_ALBUM  = ["master_metadata_album_album_name", "albumName", "album_name"];
const S_WHEN   = ["ts", "endTime", "end_time", "timestamp"];
const S_MS     = ["ms_played", "msPlayed", "ms"];
const pick = (r, keys) => { for (const k of keys) if (r[k] != null && r[k] !== "") return r[k]; return null; };

export function readSpotifyRecords(records, minMs = SPOTIFY_MIN_MS) {
  const out = [];
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (pick(r, ["episode_name", "spotify_episode_uri", "audiobook_title"])) continue;
    const artist = (pick(r, S_ARTIST) || "").trim();
    const album  = (pick(r, S_ALBUM)  || "").trim();
    if (!artist || !album) continue;
    const ms = parseInt(pick(r, S_MS) || 0, 10) || 0;
    if (ms && ms < minMs) continue;                      // skipped, not played
    const when = pick(r, S_WHEN);
    out.push({
      artist, album,
      track: (pick(r, S_TRACK) || "").trim(),
      ts: when ? Math.floor(new Date(when).getTime() / 1000) || 0 : 0,
      mbid: "", artistMbid: "",
    });
  }
  return out;
}

// ---- zip -------------------------------------------------------------
// Spotify ships the export as a zip of json files. DecompressionStream handles
// the deflate; the container itself is 60 lines of central-directory walking,
// which beats pulling in a library for one file format.
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

export async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  // end-of-central-directory, scanning back past any trailing comment
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a readable zip. Unzip it and drop the folder instead.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize  = dv.getUint32(p + 20, true);
    const nlen   = dv.getUint16(p + 28, true);
    const elen   = dv.getUint16(p + 30, true);
    const clen   = dv.getUint16(p + 32, true);
    const lho    = dv.getUint32(p + 42, true);
    const name   = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    files.push({ name, method, csize, lho });
    p += 46 + nlen + elen + clen;
  }
  const out = [];
  for (const f of files) {
    if (!/\.json$/i.test(f.name) || /\/$/.test(f.name)) continue;
    const ln = dv.getUint16(f.lho + 26, true), le = dv.getUint16(f.lho + 28, true);
    const start = f.lho + 30 + ln + le;
    const raw = buf.subarray(start, start + f.csize);
    const data = f.method === 0 ? raw : await inflateRaw(raw);
    out.push({ name: f.name, text: new TextDecoder().decode(data) });
  }
  return out;
}

// ---- entry point -----------------------------------------------------
export async function readFiles(fileList, { minMs = SPOTIFY_MIN_MS, onProgress } = {}) {
  const files = [...fileList];
  const say = m => onProgress && onProgress(m);
  const csv = files.find(f => /\.csv$/i.test(f.name));
  if (csv) {
    say("reading " + csv.name);
    return { source: "lastfm", plays: readLastfmCsv(await csv.text()) };
  }
  let jsons = [];
  const zip = files.find(f => /\.zip$/i.test(f.name));
  if (zip) {
    say("unzipping " + zip.name);
    jsons = await readZip(zip);
  } else {
    for (const f of files) if (/\.json$/i.test(f.name)) jsons.push({ name: f.name, text: await f.text() });
  }
  const audio = jsons.filter(j => /audio/i.test(j.name));
  const use = audio.length ? audio : jsons;
  const plays = [];
  let n = 0;
  for (const j of use) {
    say(`reading ${++n} of ${use.length}`);
    let data; try { data = JSON.parse(j.text); } catch { continue; }
    if (Array.isArray(data)) plays.push(...readSpotifyRecords(data, minMs));
    await new Promise(r => setTimeout(r));            // let the page paint
  }
  if (!plays.length && use.length)
    throw new Error("No plays with an album name. If this is a Spotify export, it must be the " +
                    "extended streaming history: the short Account data download has no album names.");
  return { source: "spotify", plays };
}
