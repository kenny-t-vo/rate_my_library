#!/usr/bin/env python3
"""
rate.py - local rating server for rate_my_library.

Persistence is three layers deep:
  data/ratings.json    live state, rewritten atomically on every change
  data/history.jsonl   append-only log of every change (audit + recovery)
  data/snapshots/      named + automatic save states; restore is itself undoable

    /usr/bin/python3 rate.py [--port 8777] [--no-open]
"""
import json, os, csv, sys, argparse, threading, webbrowser, html, time, subprocess, glob, re
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

from dashboard import write_dashboard, write_rym_queue

HERE  = os.path.dirname(os.path.abspath(__file__))
DATA  = os.path.join(HERE, "data")
OUT   = os.path.join(HERE, "out")
SNAPS = os.path.join(DATA, "snapshots")
RATINGS = os.path.join(DATA, "ratings.json")
HISTORY = os.path.join(DATA, "history.jsonl")
CONFIG  = os.path.join(DATA, "config.json")

NOTE_MAX      = 500
AUTOSNAP_EVERY = 100
SNAP_KEEP      = 12

_lock = threading.Lock()
_rev  = [0]          # bumped on every write; lets a client detect another tab
_albums_cache = [None, 0.0]

DEFAULT_CONFIG = {
    "minPlays": 15, "minTracks": 3, "sort": "plays", "show": "all",
    "autoAdvance": True, "showCarousel": True, "confirmExclude": False,
}

# ------------------------------------------------------------------ storage

def _read_json(path, fallback):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback

def _write_json(path, obj, indent=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
    os.replace(tmp, path)

def load_ratings(): return _read_json(RATINGS, {})
def save_ratings(r):
    _write_json(RATINGS, r, indent=1)
    _rev[0] += 1

def load_config():
    c = dict(DEFAULT_CONFIG); c.update(_read_json(CONFIG, {})); return c
def save_config(c):
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in c.items() if k in DEFAULT_CONFIG})
    _write_json(CONFIG, merged, indent=1)
    return merged

def log_event(ev):
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(HISTORY, "a", encoding="utf-8") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    except Exception:
        pass

def albums():
    """Cached read of albums.json, invalidated by mtime (a rebuild may replace it)."""
    p = os.path.join(DATA, "albums.json")
    try:
        m = os.path.getmtime(p)
    except OSError:
        return []
    if _albums_cache[0] is None or m != _albums_cache[1]:
        _albums_cache[0] = _read_json(p, [])
        _albums_cache[1] = m
    return _albums_cache[0]

# ------------------------------------------------------------------ snapshots

def snap_list():
    out = []
    for p in sorted(glob.glob(os.path.join(SNAPS, "*.json")), reverse=True):
        try:
            d = _read_json(p, {})
            out.append({
                "file":  os.path.basename(p),
                "name":  d.get("name", "?"),
                "kind":  d.get("kind", "manual"),
                "ts":    d.get("ts", int(os.path.getmtime(p))),
                "rated": d.get("rated", len([v for v in d.get("ratings", {}).values()
                                             if v.get("rating")])),
            })
        except Exception:
            pass
    return out

def snap_create(name, kind="manual"):
    r = load_ratings()
    ts = int(time.time())
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", (name or "snapshot")).strip("-")[:40] or "snapshot"
    fn = "%d-%s-%s.json" % (ts, kind, safe)
    _write_json(os.path.join(SNAPS, fn), {
        "name": name or "snapshot", "kind": kind, "ts": ts,
        "rated": len([v for v in r.values() if v.get("rating")]),
        "ratings": r,
    })
    # prune automatic snapshots only; manual ones are the user's to delete
    autos = sorted([p for p in glob.glob(os.path.join(SNAPS, "*-auto-*.json"))], reverse=True)
    for p in autos[SNAP_KEEP:]:
        try: os.remove(p)
        except OSError: pass
    return fn

def snap_restore(fn):
    p = os.path.join(SNAPS, os.path.basename(fn))
    d = _read_json(p, None)
    if not d or "ratings" not in d:
        return None
    snap_create("before restore", kind="auto")   # restoring is itself undoable
    save_ratings(d["ratings"])
    log_event({"t": int(time.time()), "op": "restore", "file": os.path.basename(fn)})
    return d

# ------------------------------------------------------------------ exports

def _stars(v):
    return "★" * int(v) + ("½" if (v - int(v)) >= .5 else "")

def rated_rows():
    r = load_ratings()
    al = {a["id"]: a for a in albums()}
    rows = []
    for aid, rec in r.items():
        a = al.get(aid)
        if a and rec.get("rating") and not rec.get("excluded"):
            rows.append((float(rec["rating"]), a, rec))
    rows.sort(key=lambda x: (-x[0], -x[1]["plays"]))
    return rows

def export_csv():
    rows = rated_rows()
    cols = ["artist","album","rating","rating_10","plays","album_spins","distinct_tracks",
            "top_track","top_track_plays","first_played","last_played","play_rank",
            "note","flagged","rym_url","mbid","id"]
    os.makedirs(OUT, exist_ok=True)
    tmp = os.path.join(OUT, "ratings.csv.tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader()
        for v, a, rec in rows:
            w.writerow({
                "artist": a["artist"], "album": a["album"], "rating": v,
                "rating_10": int(round(v * 2)), "plays": a["plays"],
                "album_spins": a["spins"], "distinct_tracks": a["distinct_tracks"],
                "top_track": a["top_track"], "top_track_plays": a["top_track_plays"],
                "first_played": time.strftime("%Y-%m-%d", time.localtime(a["first"])) if a["first"] else "",
                "last_played":  time.strftime("%Y-%m-%d", time.localtime(a["last"]))  if a["last"]  else "",
                "play_rank": a["rank"], "note": rec.get("note", ""),
                "flagged": "yes" if rec.get("flag") else "",
                "rym_url": a.get("rym") or a.get("rym_search", ""), "mbid": a.get("mbid", ""),
                "id": a["id"],
            })
    os.replace(tmp, os.path.join(OUT, "ratings.csv"))
    return len(rows)

def export_json():
    rows = rated_rows()
    _write_json(os.path.join(OUT, "ratings.json"), [{
        "artist": a["artist"], "album": a["album"], "rating": v,
        "note": rec.get("note", ""), "flagged": bool(rec.get("flag")),
        "plays": a["plays"], "spins": a["spins"], "tracks": a["distinct_tracks"],
        "rym": a.get("rym") or a.get("rym_search", ""), "mbid": a.get("mbid", ""),
    } for v, a, rec in rows], indent=1)

def export_markdown():
    rows = rated_rows()
    lines = ["# rate_my_library", "",
             "%d albums · mean %.2f" % (len(rows),
                sum(v for v, _, _ in rows) / len(rows) if rows else 0), ""]
    cur = None
    for v, a, rec in rows:
        if v != cur:
            cur = v; lines += ["", "## %s  (%.1f)" % (_stars(v), v), ""]
        line = "- **%s** by %s" % (a["album"], a["artist"])
        if rec.get("note"): line += "  \n  _%s_" % rec["note"].replace("\n", " ")
        lines.append(line)
    with open(os.path.join(OUT, "ratings.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

def export_all():
    os.makedirs(OUT, exist_ok=True)
    n = export_csv(); export_json(); export_markdown()
    write_dashboard(); write_rym_queue()
    return n

# ------------------------------------------------------------------ http

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        if self.path.startswith("/data/art/"):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    # ---- helpers -------------------------------------------------------
    def _apply(self, r, item):
        """Apply one change to the ratings map. Returns the event to log."""
        aid = item.get("id")
        if not aid:
            return None
        if item.get("clear"):
            r.pop(aid, None)
            return {"op": "clear", "id": aid}
        rec = dict(r.get(aid, {}))
        ev = {"op": "set", "id": aid}
        for k in ("rating", "skip", "excluded", "flag"):
            if k in item:
                rec[k] = item[k]; ev[k] = item[k]
        if "note" in item:
            note = (item["note"] or "")[:NOTE_MAX]
            if note: rec["note"] = note
            else: rec.pop("note", None)
            ev["note"] = len(note)
        rec["ts"] = int(time.time())
        r[aid] = rec
        return ev

    # ---- GET -----------------------------------------------------------
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/":
            self.path = "/ui/index.html"; return super().do_GET()
        if p == "/api/state":
            with _lock:
                return self._json({"ratings": load_ratings(), "config": load_config(),
                                   "rev": _rev[0], "noteMax": NOTE_MAX})
        if p == "/api/albums":
            return self._json(albums())
        if p == "/api/snapshots":
            with _lock:
                return self._json({"snapshots": snap_list()})
        if p == "/api/export":
            with _lock:
                n = export_all()
            return self._json({"ok": True, "rows": n, "dir": OUT})
        if p == "/api/ping":
            return self._json({"ok": True, "rev": _rev[0]})
        if p.startswith("/art/"):
            self.path = "/data" + p; return super().do_GET()
        return super().do_GET()

    # ---- POST ----------------------------------------------------------
    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:
            return self._json({"ok": False, "err": "bad json"}, 400)
        p = self.path.split("?")[0]

        if p in ("/api/rate", "/api/batch"):
            items = body.get("items") or [body]
            with _lock:
                r = load_ratings()
                before = len([v for v in r.values() if v.get("rating")])
                for it in items:
                    ev = self._apply(r, it)
                    if ev: log_event(dict(ev, t=int(time.time())))
                save_ratings(r)
                after = len([v for v in r.values() if v.get("rating")])
                # rolling automatic save state every N ratings
                if after // AUTOSNAP_EVERY > before // AUTOSNAP_EVERY and after:
                    snap_create("%d rated" % after, kind="auto")
            return self._json({"ok": True, "count": after, "rev": _rev[0]})

        if p == "/api/config":
            with _lock:
                return self._json({"ok": True, "config": save_config(body or {})})

        if p == "/api/snapshots":
            with _lock:
                fn = snap_create(body.get("name") or "manual save")
                return self._json({"ok": True, "file": fn, "snapshots": snap_list()})

        if p == "/api/snapshots/restore":
            with _lock:
                d = snap_restore(body.get("file", ""))
            if not d:
                return self._json({"ok": False, "err": "not found"}, 404)
            return self._json({"ok": True, "ratings": d["ratings"], "rev": _rev[0]})

        if p == "/api/snapshots/delete":
            fp = os.path.join(SNAPS, os.path.basename(body.get("file", "")))
            try: os.remove(fp)
            except OSError: pass
            with _lock:
                return self._json({"ok": True, "snapshots": snap_list()})

        if p == "/api/import":
            path = os.path.expanduser((body.get("path") or "").strip())
            if not path or not os.path.exists(path):
                return self._json({"ok": False, "err": "file not found: %s" % path}, 400)
            src = (body.get("source") or "auto").strip()
            threading.Thread(target=_run_import, args=(path, src), daemon=True).start()
            return self._json({"ok": True, "started": True})

        if p == "/api/job":
            return self._json(_job)

        return self._json({"ok": False}, 404)

# ------------------------------------------------------------------ import job

_job = {"running": False, "step": "", "log": "", "done": False}

def _run_import(path, source="auto"):
    _job.update(running=True, done=False, step="reading listening history", log="")
    py = "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else sys.executable
    build = os.path.join(HERE, "build.py")
    try:
        cmd = [py, build, path, "--min-plays", "8", "--no-art"]
        if source and source != "auto":
            cmd += ["--source", source]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE, timeout=1800)
        _job["log"] = (r.stdout or "") + (r.stderr or "")
        if r.returncode != 0:
            _job["step"] = "failed"
            _job.update(running=False, done=True)
            return
        _albums_cache[0] = None
        _job["step"] = "fetching cover art"
        subprocess.Popen([py, build, "--art-only", "--workers", "8"],
                         cwd=HERE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _job["step"] = "cover art is downloading in the background"
    except Exception as e:
        _job["log"] = str(e); _job["step"] = "failed"
    _job.update(running=False, done=True)

# ------------------------------------------------------------------ entry

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    if not os.path.exists(os.path.join(DATA, "albums.json")):
        sys.exit("No data/albums.json - run build.py with your scrobble CSV first.")
    os.makedirs(SNAPS, exist_ok=True)
    r = load_ratings()
    url = "http://127.0.0.1:%d/" % a.port
    print("rate_my_library  %d albums, %d rated" % (len(albums()),
          len([v for v in r.values() if v.get('rating')])))
    print("  -> %s   (every change is saved; Ctrl-C to stop)" % url)
    if not a.no_open:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        with _lock:
            n = export_all()
            snap_create("session end", kind="auto")
        print("\nSaved %d ratings -> out/ (csv, json, md, dashboard, rym-queue)" % n)

if __name__ == "__main__":
    main()
