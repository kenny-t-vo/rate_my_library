#!/usr/bin/env python3
"""
build.py - Turn a Last.fm scrobble CSV into a ranked, deduplicated album database.

Stage 1: parse + aggregate + merge edition variants  -> data/albums.json
Stage 2: fetch cover art (CAA -> iTunes -> Deezer)   -> data/art/*.jpg
Stage 3 (optional): resolve direct RateYourMusic URLs via MusicBrainz

Stdlib only. Run with /usr/bin/python3 (has working CA certs on macOS).
"""
import csv, json, os, re, sys, time, argparse, collections, hashlib, threading, unicodedata, zipfile, glob as _glob
import urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
ART  = os.path.join(DATA, "art")
UA   = {"User-Agent": "AlbumRater/1.0 ( personal-offline-use )"}

# ---------------------------------------------------------------- normalizing

# Edition cruft in a *trailing* bracket/paren group, e.g. "Bloom (Deluxe Edition)"
EDITION_WORDS = (r"remaster(?:ed|s)?|deluxe|expanded|anniversary|edition|reissue|bonus\s+track|"
                 r"super\s+deluxe|legacy|explicit|clean|mono|stereo|collector'?s|"
                 r"special\s+edition|\d{4}\s+mix|remix(?:ed)?\s+edition|japan(?:ese)?\s+edition")
BRACKETED = re.compile(r"\s*[\(\[\{]\s*[^()\[\]{}]*\b(?:%s)\b[^()\[\]{}]*[\)\]\}]\s*$" % EDITION_WORDS, re.I)
# Spotify's dash style, e.g. "Romantico - 2022 Remaster"
DASHED    = re.compile(r"\s+[-–—]\s+[^-–—]*\b(?:%s)\b[^-–—]*$" % EDITION_WORDS, re.I)
# Trailing bare year-remaster with no keyword, e.g. "Album (2011)" -- deliberately NOT stripped.

def strip_edition(title):
    """Conservatively remove edition/remaster suffixes. Never empties the string."""
    prev = None
    s = title
    while prev != s:
        prev = s
        s = BRACKETED.sub("", s).strip()
        s = DASHED.sub("", s).strip()
        s = re.sub(r"\s+\d+(?:st|nd|rd|th)\s+anniversary(?:\s+edition)?\s*$", "", s, flags=re.I).strip()
        s = s.rstrip(" -–—,:;")
    return s if s.strip() else title

def fold_accents(s):
    """Strip Latin diacritics (Cafe/Cafe) but leave CJK marks alone -
    naively stripping every combining mark would turn Japanese dakuten into
    the wrong kana."""
    out = []
    for ch in unicodedata.normalize("NFD", s):
        if unicodedata.combining(ch):
            if out and ord(out[-1]) < 128:
                continue
            out.append(ch)
        else:
            out.append(ch)
    return unicodedata.normalize("NFC", "".join(out))

def norm_key(s):
    """Aggressive key used only for grouping (never displayed).

    NOTE: album ids - and therefore saved ratings - are md5(norm_key(artist)|
    norm_key(album)). Changing this function renames every id and orphans
    existing ratings, so do not touch it casually.
    """
    orig = s
    s = fold_accents(s).lower()
    s = s.replace("&", "and")
    s = re.sub(r"[‘’ʼ']", "", s)      # apostrophes
    s = re.sub(r"[“”\"]", "", s)
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE) # punctuation -> space
    s = re.sub(r"\s+", " ", s).strip()
    if s.startswith("the "): s = s[4:]
    if not s:                      # titles made only of punctuation (e.g. Morse code)
        return "\x00" + orig.lower().strip()
    return s

TRACK_SUFFIX = re.compile(
    r"\s*[-–—(\[]\s*[^-–—()\[\]]*\b(?:remaster(?:ed)?|remix|edit|version|mono|stereo|"
    r"live|demo|instrumental|acoustic|radio\s+edit|album\s+version|single\s+version|"
    r"bonus|deluxe|\d{4}\s+mix)\b[^-–—()\[\]]*[\)\]]?\s*$", re.I)

def norm_track(t):
    prev = None
    s = t
    while prev != s:
        prev = s
        s = TRACK_SUFFIX.sub("", s).strip()
    return s if s.strip() else t

# ---------------------------------------------------------------- sources

SPOTIFY_MIN_MS = 30000   # Last.fm scrobbles at 30s; match it so counts compare

def _iso_to_epoch(t):
    if not t:
        return 0
    t = t.replace("Z", "+0000").replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S%z", "%Y-%m-%d %H:%M%z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return int(time.mktime(time.strptime(t, fmt))) if "%z" not in fmt \
                   else int(time.mktime(time.strptime(t, fmt)))
        except ValueError:
            continue
    return 0

def read_lastfm_csv(path, **kw):
    """Last.fm scrobble export. Carries MusicBrainz ids, which is why its cover
    art and RateYourMusic coverage are the best of the three sources."""
    with open(path, newline="", encoding="utf-8") as f:
        for d in csv.DictReader(f):
            artist = (d.get("artist") or "").strip()
            album  = (d.get("album")  or "").strip()
            if not artist or not album:
                continue
            try:
                ts = int(d.get("uts") or 0)
            except ValueError:
                ts = 0
            yield (artist, album, (d.get("track") or "").strip(), ts,
                   (d.get("album_mbid") or "").strip(), (d.get("artist_mbid") or "").strip())

def _spotify_files(path):
    """Accept the raw zip, the unzipped folder, or a single json file."""
    if os.path.isdir(path):
        out = []
        for root, _, names in os.walk(path):
            for n in names:
                if n.lower().endswith(".json") and "audio" in n.lower():
                    out.append(os.path.join(root, n))
        if not out:   # fall back to every json in the folder
            for root, _, names in os.walk(path):
                out += [os.path.join(root, n) for n in names if n.lower().endswith(".json")]
        return sorted(out)
    return [path]

def _spotify_records(path):
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".json")]
            audio = [n for n in names if "audio" in n.lower()]
            for n in sorted(audio or names):
                try:
                    data = json.loads(z.read(n).decode("utf-8", "replace"))
                except Exception:
                    continue
                if isinstance(data, list):
                    for r in data:
                        yield r
        return
    for fp in _spotify_files(path):
        try:
            with open(fp, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        if isinstance(data, list):
            for r in data:
                yield r

def read_spotify_history(path, min_ms=SPOTIFY_MIN_MS, **kw):
    """Spotify 'Extended streaming history' export.

    Field names have changed across export generations, so every key is looked
    up through a list of aliases. The short 'Account data' export is rejected
    by the caller because it carries no album name at all.

    ms_played lets us drop skips, which Last.fm cannot do: a track abandoned
    after four seconds is not a play.
    """
    TRACK  = ("master_metadata_track_name", "trackName", "track_name")
    ARTIST = ("master_metadata_album_artist_name", "artistName", "artist_name")
    ALBUM  = ("master_metadata_album_album_name", "albumName", "album_name")
    WHEN   = ("ts", "endTime", "end_time", "timestamp")
    MS     = ("ms_played", "msPlayed", "ms")

    def pick(r, keys):
        for k in keys:
            v = r.get(k)
            if v not in (None, ""):
                return v
        return None

    for r in _spotify_records(path):
        if not isinstance(r, dict):
            continue
        if pick(r, ("episode_name", "spotify_episode_uri", "audiobook_title")):
            continue                                    # podcasts and audiobooks
        artist = (pick(r, ARTIST) or "").strip()
        album  = (pick(r, ALBUM)  or "").strip()
        track  = (pick(r, TRACK)  or "").strip()
        if not artist or not album:
            continue
        try:
            ms = int(pick(r, MS) or 0)
        except (TypeError, ValueError):
            ms = 0
        if ms and ms < min_ms:
            continue                                    # skipped, not played
        yield (artist, album, track, _iso_to_epoch(pick(r, WHEN)), "", "")

def detect_source(path):
    low = path.lower()
    if low.endswith(".csv"):
        return "lastfm"
    if low.endswith(".zip") or low.endswith(".json") or os.path.isdir(path):
        return "spotify"
    return "lastfm"

READERS = {"lastfm": read_lastfm_csv, "spotify": read_spotify_history}

# ---------------------------------------------------------------- aggregation

def build_albums(src_path, min_plays, source="lastfm", min_ms=SPOTIFY_MIN_MS):
    plays        = collections.Counter()                       # (artistkey, albumkey) -> plays
    variants     = collections.defaultdict(collections.Counter)# grp -> raw album title -> plays
    artist_names = collections.defaultdict(collections.Counter)# artistkey -> raw artist -> plays
    tracks       = collections.defaultdict(collections.Counter)# grp -> norm track -> plays
    track_names  = collections.defaultdict(dict)               # grp -> norm track -> display name
    mbids        = collections.defaultdict(collections.Counter)
    artist_mbids = collections.defaultdict(collections.Counter)
    first_ts     = {}
    last_ts      = {}
    per_year     = collections.defaultdict(collections.Counter)
    artist_plays = collections.Counter()
    total = 0

    reader = READERS.get(source, read_lastfm_csv)
    for artist, album, track, ts, am, arm in reader(src_path, min_ms=min_ms):
        total += 1
        base = strip_edition(album)
        grp  = (norm_key(artist), norm_key(base))

        plays[grp] += 1
        artist_plays[norm_key(artist)] += 1
        variants[grp][album] += 1
        artist_names[norm_key(artist)][artist] += 1

        if track:
            nt = norm_track(track)
            k  = nt.lower()
            tracks[grp][k] += 1
            # keep the shortest / cleanest display form seen
            cur = track_names[grp].get(k)
            if cur is None or len(nt) < len(cur):
                track_names[grp][k] = nt

        if am: mbids[grp][am] += 1
        if arm: artist_mbids[norm_key(artist)][arm] += 1

        if ts:
            if grp not in first_ts or ts < first_ts[grp]: first_ts[grp] = ts
            if grp not in last_ts  or ts > last_ts[grp]:  last_ts[grp]  = ts
            per_year[grp][time.strftime("%Y", time.localtime(ts))] += 1

    out = []
    for grp, n in plays.items():
        if n < min_plays:
            continue
        akey, _ = grp
        # display artist = most common raw spelling
        artist_disp = artist_names[akey].most_common(1)[0][0]
        # display album: prefer a variant that is already clean, else strip the top variant
        vs = variants[grp].most_common()
        clean = [(t, c) for t, c in vs if strip_edition(t) == t]
        album_disp = strip_edition((clean[0][0] if clean else vs[0][0]))

        tl = [{"name": track_names[grp][k], "plays": c}
              for k, c in tracks[grp].most_common()]
        ntracks = len(tl)
        out.append({
            "id": hashlib.md5(("%s|%s" % grp).encode("utf-8")).hexdigest()[:12],
            "artist": artist_disp,
            "album": album_disp,
            "plays": n,
            "tracks": tl,
            "distinct_tracks": ntracks,
            "spins": round(n / ntracks, 2) if ntracks else 0,
            "top_track": tl[0]["name"] if tl else "",
            "top_track_plays": tl[0]["plays"] if tl else 0,
            "mbid": mbids[grp].most_common(1)[0][0] if mbids[grp] else "",
            "rgid": "",
            "artist_mbid": artist_mbids[akey].most_common(1)[0][0] if artist_mbids[akey] else "",
            "first": first_ts.get(grp, 0),
            "last":  last_ts.get(grp, 0),
            "years": dict(per_year[grp]),
            "artist_plays": artist_plays[akey],
            "variants": [t for t, _ in vs] if len(vs) > 1 else [],
            "art": None,
            "art_src": "",
            "rym": "",
        })

    out.sort(key=lambda a: -a["plays"])
    for i, a in enumerate(out):
        a["rank"] = i + 1
    return out, total

# ---------------------------------------------------------------- cover art

_lock = threading.Lock()
_stats = collections.Counter()

def _get(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")

def _mk(s):
    """Comparison key for verifying a search result really is the album we asked for."""
    s = fold_accents(s).lower()
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if s.startswith("the "): s = s[4:]
    return s

def _same(a, b, strict=True):
    a, b = _mk(a), _mk(b)
    if not a or not b:
        return False
    if a == b:
        return True
    if strict:
        # allow "Big Thief" vs "Big Thief & Friends", not "Alvvays" vs "Always Played the Blues"
        lo, hi = sorted((a, b), key=len)
        return hi.startswith(lo + " ") and len(lo) >= max(4, 0.45 * len(hi))
    return a in b or b in a


def _verify(a, artist, album):
    if not _same(a["artist"], artist):
        return False
    return _mk(strip_edition(a["album"])) == _mk(strip_edition(album))

def _try_caa(a):
    """Release id first (exact pressing), then release-group (the album as a work)."""
    targets = []
    if a.get("mbid"):
        targets.append(("release", a["mbid"]))
    if a.get("rgid"):
        targets.append(("release-group", a["rgid"]))
    for kind, ident in targets:
        for size in ("front-500", "front-250"):
            try:
                b, _ = _get("https://coverartarchive.org/%s/%s/%s" % (kind, ident, size))
                if b and len(b) > 2000:
                    return b, "caa"
            except Exception:
                pass
    return None

def _try_itunes(a):
    try:
        q = urllib.parse.urlencode({
            "term": "%s %s" % (a["artist"], a["album"]),
            "entity": "album", "limit": 8,
        })
        b, _ = _get("https://itunes.apple.com/search?" + q)
        for r in json.loads(b.decode("utf-8", "replace")).get("results", []):
            if not _verify(a, r.get("artistName", ""), r.get("collectionName", "")):
                continue
            url = (r.get("artworkUrl100") or "").replace("100x100bb", "600x600bb")
            if not url:
                continue
            img, _ = _get(url)
            if img and len(img) > 2000:
                return img, "itunes"
    except Exception:
        pass
    return None

def _try_deezer(a):
    try:
        q = urllib.parse.quote("%s %s" % (a["artist"], a["album"]))
        b, _ = _get("https://api.deezer.com/search/album?q=%s&limit=8" % q)
        for r in json.loads(b.decode("utf-8", "replace")).get("data", []):
            if not _verify(a, r.get("artist", {}).get("name", ""), r.get("title", "")):
                continue
            url = r.get("cover_big") or r.get("cover_medium")
            if not url:
                continue
            img, _ = _get(url)
            if img and len(img) > 2000:
                return img, "deezer"
    except Exception:
        pass
    return None

def fetch_art(a, force=False):
    path = os.path.join(ART, a["id"] + ".jpg")
    if os.path.exists(path) and os.path.getsize(path) > 2000 and not force:
        a["art"] = "art/%s.jpg" % a["id"]
        with _lock: _stats["cached"] += 1
        return
    for fn in (_try_caa, _try_itunes, _try_deezer):
        got = fn(a)
        if got:
            b, src = got
            with open(path, "wb") as f:
                f.write(b)
            a["art"] = "art/%s.jpg" % a["id"]
            a["art_src"] = src
            with _lock:
                _stats[src] += 1
                _stats["ok"] += 1
            return
    with _lock: _stats["miss"] += 1

def fetch_all_art(albums, workers=6, force=False):
    done = [0]
    n = len(albums)
    def work(a):
        fetch_art(a, force)
        with _lock:
            done[0] += 1
            if done[0] % 25 == 0 or done[0] == n:
                sys.stderr.write("\r  art %d/%d  ok=%d cached=%d miss=%d   "
                                 % (done[0], n, _stats['ok'], _stats['cached'], _stats['miss']))
                sys.stderr.flush()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, albums))
    sys.stderr.write("\n")
    return dict(_stats)

# ---------------------------------------------------------------- RYM links

def enrich_mbids(albums, limit=None, sleep=1.1):
    """Look up MusicBrainz ids for albums that arrived without them.

    Spotify exports carry no MusicBrainz ids at all, which would leave those
    libraries with no Cover Art Archive covers and no direct RateYourMusic
    links. One search per album at MusicBrainz's 1/sec limit, verified against
    artist and title before it is accepted, and checkpointed so it can be
    stopped and resumed.
    """
    todo = [a for a in albums if not a.get("mbid") and not a.get("rgid")]
    if limit:
        todo = todo[:limit]
    print("Looking up MusicBrainz ids for %d albums (about %.0f min)"
          % (len(todo), len(todo) * sleep / 60), file=sys.stderr)
    found = throttled = 0
    for n, a in enumerate(todo, 1):
        q = 'artist:"%s" AND releasegroup:"%s"' % (
            a["artist"].replace('"', ""), a["album"].replace('"', ""))
        url = ("https://musicbrainz.org/ws/2/release-group/?query=%s&fmt=json&limit=5"
               % urllib.parse.quote(q))
        rgs = None
        for attempt in range(3):
            try:
                b, _ = _get(url)
                rgs = json.loads(b.decode("utf-8")).get("release-groups", [])
                break
            except Exception:
                throttled += 1
                time.sleep(sleep * (attempt + 2))
        for rg in sorted(rgs or [], key=lambda r: -int(r.get("score") or 0)):
            cred = rg.get("artist-credit") or [{}]
            cname = (cred[0].get("artist") or {}).get("name", "")
            if not _verify(a, cname, rg.get("title", "")):
                continue
            a["rgid"] = rg.get("id", "")
            if not a.get("artist_mbid"):
                a["artist_mbid"] = (cred[0].get("artist") or {}).get("id", "")
            found += 1
            break
        time.sleep(sleep)
        if n % 20 == 0 or n == len(todo):
            sys.stderr.write("\r  matched %d/%d  (%d retries)  " % (found, n, throttled))
            sys.stderr.flush()
            save_albums(albums)
    sys.stderr.write("\n")
    return found

def rym_search_url(a):
    q = urllib.parse.quote_plus("%s %s" % (a["artist"], a["album"]))
    return "https://rateyourmusic.com/search?searchterm=%s&searchtype=l" % q

def resolve_rym(albums, limit=None, sleep=1.2):
    """Resolve canonical RateYourMusic album URLs via MusicBrainz.

    Uses the *browse* endpoint: one request per ARTIST returns up to 100 of that
    artist's release-groups with their url relations, instead of two requests per
    album. Resumable and checkpointed - safe to Ctrl-C and rerun.
    """
    todo = collections.OrderedDict()
    for a in albums:
        if a.get("rym") or not a.get("artist_mbid"):
            continue
        todo.setdefault(a["artist_mbid"], []).append(a)
    keys = list(todo)
    if limit:
        keys = keys[:limit]
    print("Resolving RYM links: %d artists covering %d albums (~%.0f min)"
          % (len(keys), sum(len(todo[k]) for k in keys), len(keys) * sleep / 60), file=sys.stderr)

    found = tried = 0
    for n, amb in enumerate(keys, 1):
        group = todo[amb]
        try:
            b, _ = _get("https://musicbrainz.org/ws/2/release-group"
                        "?artist=%s&inc=url-rels&limit=100&fmt=json" % amb)
            rgs = json.loads(b.decode("utf-8")).get("release-groups", [])
            index = {}
            for rg in rgs:
                links = [r.get("url", {}).get("resource", "") for r in rg.get("relations", [])]
                rym = next((u for u in links if "rateyourmusic.com" in u), "")
                if rym:
                    index[norm_key(strip_edition(rg.get("title", "")))] = rym
            for a in group:
                hit = index.get(norm_key(a["album"]))
                if hit:
                    a["rym"] = hit; found += 1
        except Exception:
            pass
        tried += len(group)
        time.sleep(sleep)
        if n % 10 == 0 or n == len(keys):
            sys.stderr.write("\r  rym artists %d/%d  albums matched %d/%d  " % (n, len(keys), found, tried))
            sys.stderr.flush()
            save_albums(albums)
    sys.stderr.write("\n")
    return found

# ---------------------------------------------------------------- io

def reindex_art(albums):
    """Self-healing: derive the art field from what is actually on disk."""
    n = 0
    for a in albums:
        p = os.path.join(ART, a["id"] + ".jpg")
        if os.path.exists(p) and os.path.getsize(p) > 2000:
            a["art"] = "art/%s.jpg" % a["id"]; n += 1
        else:
            a["art"] = None
    return n

def save_albums(albums):
    reindex_art(albums)
    tmp = os.path.join(DATA, "albums.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(albums, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(DATA, "albums.json"))

def main():
    p = argparse.ArgumentParser()
    p.add_argument("input", nargs="?",
                   help="Last.fm scrobble CSV, or a Spotify extended streaming "
                        "history (.zip, folder, or .json)")
    p.add_argument("--source", choices=["auto", "lastfm", "spotify"], default="auto")
    p.add_argument("--min-seconds", type=float, default=30.0,
                   help="Spotify only: ignore plays shorter than this (default 30s, "
                        "matching Last.fm's scrobble threshold)")
    p.add_argument("--mbids", action="store_true",
                   help="look up MusicBrainz ids for albums that lack them "
                        "(needed for cover art and RYM links on Spotify imports)")
    p.add_argument("--mbid-limit", type=int, default=None)
    p.add_argument("--min-plays", type=int, default=8,
                   help="build-time floor; keep it low, filter live in the UI (default 8)")
    p.add_argument("--no-art", action="store_true")
    p.add_argument("--art-only", action="store_true", help="refetch art for existing albums.json")
    p.add_argument("--force", action="store_true", help="with --art-only: re-download even cached covers")
    p.add_argument("--rym", action="store_true", help="resolve direct RYM links via MusicBrainz (slow)")
    p.add_argument("--rym-limit", type=int, default=None)
    p.add_argument("--reindex", action="store_true", help="just re-scan data/art and update albums.json")
    p.add_argument("--workers", type=int, default=6)
    a = p.parse_args()

    os.makedirs(ART, exist_ok=True)
    apath = os.path.join(DATA, "albums.json")

    if a.reindex:
        albums = json.load(open(apath, encoding="utf-8"))
        n = reindex_art(albums); save_albums(albums)
        print("Reindexed art: %d/%d albums have covers." % (n, len(albums))); return

    if a.mbids and not a.input:
        albums = json.load(open(apath, encoding="utf-8"))
        n = enrich_mbids(albums, a.mbid_limit); save_albums(albums)
        print("Matched %d albums to MusicBrainz." % n); return

    if a.art_only or (a.rym and not a.input):
        albums = json.load(open(apath, encoding="utf-8"))
        print("Loaded %d albums." % len(albums))
    else:
        if not a.input:
            p.error("need a listening-history file on first run "
                    "(Last.fm CSV, or a Spotify extended streaming history)")
        src = a.source if a.source != "auto" else detect_source(a.input)
        print("Reading %s as a %s export" % (a.input, src))
        albums, total = build_albums(a.input, a.min_plays, src,
                                     int(a.min_seconds * 1000))
        if not total:
            p.error("no plays with an album name were found. If this is a Spotify "
                    "export, make sure it is the EXTENDED streaming history: the "
                    "short 'Account data' download has no album names in it.")
        label = "plays" if src == "spotify" else "scrobbles"
        print("  %d %s -> %d albums with >=%d plays" % (total, label, len(albums), a.min_plays))
        if src == "spotify":
            print("  (plays under %.0fs were skipped)" % a.min_seconds)
        merged = sum(1 for x in albums if x["variants"])
        print("  %d albums had edition variants merged" % merged)
        # carry forward art + rym from a previous build
        if os.path.exists(apath):
            prev = json.load(open(apath, encoding="utf-8"))
            by_id   = {x["id"]: x for x in prev}
            by_mbid = {x["mbid"]: x for x in prev if x.get("mbid")}
            by_name = {(x["artist"].lower(), x["album"].lower()): x for x in prev}
            for x in albums:
                o = (by_id.get(x["id"]) or by_mbid.get(x.get("mbid")) or
                     by_name.get((x["artist"].lower(), x["album"].lower())))
                if o:
                    x["rym"] = o.get("rym") or ""
                    x["rgid"] = o.get("rgid", "")
                    x["art_src"] = o.get("art_src", "")
                    if not x.get("artist_mbid"):
                        x["artist_mbid"] = o.get("artist_mbid", "")
                    src = os.path.join(ART, o["id"] + ".jpg")
                    dst = os.path.join(ART, x["id"] + ".jpg")
                    if src != dst and os.path.exists(src) and not os.path.exists(dst):
                        try: os.replace(src, dst)   # id changed - carry the cached art over
                        except OSError: pass
        for x in albums:
            x["rym_search"] = rym_search_url(x)

    for x in albums:
        x.setdefault("rym_search", rym_search_url(x))

    if not a.no_art and not a.rym:
        print("Fetching cover art (CAA -> iTunes -> Deezer)...")
        st = fetch_all_art(albums, workers=a.workers, force=a.force)
        print("  art sources: %s" % dict(st))

    save_albums(albums)

    if a.mbids:
        enrich_mbids(albums, a.mbid_limit); save_albums(albums)

    if a.rym:
        n = resolve_rym(albums, a.rym_limit)
        print("  resolved %d direct RYM links" % n)
        save_albums(albums)

    have = sum(1 for x in albums if x["art"])
    print("\nWrote data/albums.json  (%d albums, %d with art, %d with direct RYM links)"
          % (len(albums), have, sum(1 for x in albums if x["rym"])))

if __name__ == "__main__":
    main()
