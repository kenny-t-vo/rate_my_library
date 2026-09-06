// Normalisation ported from build.py. The album id must stay byte-identical
// across both versions or saved ratings orphan, so md5 and every regex here
// mirror the Python exactly. lib/verify-ids.md records how that is checked.

// ---- md5 -------------------------------------------------------------
// SubtleCrypto has no md5, and the id scheme predates this port.
function md5(str) {
  const enc = new TextEncoder().encode(str);
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

  const len = enc.length;
  const withOne = len + 1;
  const blocks = Math.ceil((withOne + 8) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(enc);
  buf[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(blocks * 64 - 8, bits >>> 0, true);
  dv.setUint32(blocks * 64 - 4, Math.floor(bits / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let b = 0; b < blocks; b++) {
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(b * 64 + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16)      { F = (B & C) | (~B & D);         g = i; }
      else if (i < 32) { F = (D & B) | (~D & C);         g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D;                  g = (3 * i + 5) % 16; }
      else             { F = C ^ (B | ~D);               g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const hex = n => [0,1,2,3].map(i => ((n >>> (i*8)) & 255).toString(16).padStart(2,"0")).join("");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

// ---- edition suffixes ------------------------------------------------
const EDITION_WORDS =
  "remaster(?:ed|s)?|deluxe|expanded|anniversary|edition|reissue|bonus\\s+track|" +
  "super\\s+deluxe|legacy|explicit|clean|mono|stereo|collector'?s|" +
  "special\\s+edition|\\d{4}\\s+mix|remix(?:ed)?\\s+edition|japan(?:ese)?\\s+edition";

const BRACKETED = new RegExp("\\s*[\\(\\[\\{]\\s*[^()\\[\\]{}]*\\b(?:" + EDITION_WORDS + ")\\b[^()\\[\\]{}]*[\\)\\]\\}]\\s*$", "i");
const DASHED    = new RegExp("\\s+[-\u2013\u2014]\\s+[^-\u2013\u2014]*\\b(?:" + EDITION_WORDS + ")\\b[^-\u2013\u2014]*$", "i");
const COLONED   = new RegExp(":\\s*[^:]*\\b(?:" + EDITION_WORDS + ")\\b[^:]*$", "i");
const ANNIV     = /\s+\d+(?:st|nd|rd|th)\s+anniversary(?:\s+edition)?\s*$/i;

export function stripEdition(title) {
  let prev = null, s = title;
  while (prev !== s) {
    prev = s;
    s = s.replace(BRACKETED, "").trim();
    s = s.replace(DASHED, "").trim();
    s = s.replace(COLONED, "").trim();
    s = s.replace(ANNIV, "").trim();
    s = s.replace(/[ \-\u2013\u2014,:;]+$/, "");
  }
  return s.trim() ? s : title;
}

// Strip Latin diacritics but leave CJK marks alone; stripping every combining
// mark turns Japanese dakuten into the wrong kana.
export function foldAccents(s) {
  const out = [];
  for (const ch of s.normalize("NFD")) {
    if (/\p{M}/u.test(ch)) {
      if (out.length && out[out.length - 1].codePointAt(0) < 128) continue;
      out.push(ch);
    } else out.push(ch);
  }
  return out.join("").normalize("NFC");
}

// Album ids are md5(normKey(artist)|normKey(album)), so saved ratings depend
// on this function. Changing it renames every id.
export function normKey(s) {
  const orig = s;
  s = foldAccents(s.normalize("NFKC")).toLowerCase();
  s = s.replace(/&/g, "and");
  s = s.replace(/[\u2018\u2019\u02bc']/g, "");
  s = s.replace(/[\u201c\u201d"]/g, "");
  s = s.replace(/[^\p{L}\p{N}\s_]/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.startsWith("the ")) s = s.slice(4);
  if (!s) return "\u0000" + orig.toLowerCase().trim();   // titles that are pure punctuation
  return s;
}

const TRACK_SUFFIX = /\s*[-\u2013\u2014(\[]\s*[^-\u2013\u2014()\[\]]*\b(?:remaster(?:ed)?|remix|edit|version|mono|stereo|live|demo|instrumental|acoustic|radio\s+edit|album\s+version|single\s+version|bonus|deluxe|\d{4}\s+mix)\b[^-\u2013\u2014()\[\]]*[\)\]]?\s*$/i;

export function normTrack(t) {
  let prev = null, s = t;
  while (prev !== s) { prev = s; s = s.replace(TRACK_SUFFIX, "").trim(); }
  return s.trim() ? s : t;
}

export const albumId = (artist, album) =>
  md5(normKey(artist) + "|" + normKey(stripEdition(album))).slice(0, 12);

export { md5 };
