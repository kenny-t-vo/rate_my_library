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

export function readLastfmCsv(text) {
  const rows = csvRows(text);
  const head = rows.next().value;
  if (!head) return [];
  const ix = {};
  head.forEach((h, k) => ix[h.trim().toLowerCase()] = k);
  const need = ["artist", "album", "track"];
  if (need.some(k => ix[k] === undefined))
    throw new Error("This CSV has no " + need.filter(k => ix[k] === undefined).join("/") +
                    " column. A Last.fm export needs artist, album, track and uts.");
  const out = [];
  for (const r of rows) {
    const artist = (r[ix.artist] || "").trim();
    const album  = (r[ix.album]  || "").trim();
    if (!artist || !album) continue;
    out.push({
      artist, album,
      track: (r[ix.track] || "").trim(),
      ts: parseInt(r[ix.uts] || "0", 10) || 0,
      mbid: (r[ix.album_mbid] || "").trim(),
      artistMbid: (r[ix.artist_mbid] || "").trim(),
    });
  }
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
