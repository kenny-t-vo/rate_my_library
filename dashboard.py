#!/usr/bin/env python3
"""Static output pages: out/dashboard.html and out/rym-queue.html.

Same visual language as the rater: white, Times, hyperlink blue and purple,
hairline rules, monospace numerics.
"""
import os, json, time, html

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT  = os.path.join(HERE, "out")

CSS = """
*{box-sizing:border-box;margin:0;padding:0}
:root{--fg:#111;--dim:#6b6b6b;--rule:#d8d8d8;--blue:#0000ee;--purple:#551a8b;--hl:#0000ee}
body{background:#fff;color:var(--fg);
  font:14px/1.45 "Times New Roman",Times,"Liberation Serif","Hiragino Mincho ProN","Yu Mincho",serif;
  padding:52px 40px 120px;-webkit-font-smoothing:antialiased}
.wrap{max-width:940px;margin:0 auto}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.rule{border:0;border-top:1px solid var(--fg);margin:0}
.rule.thin{border-top:1px solid var(--rule)}
.lbl{font:10.5px/1 "Times New Roman",Times,serif;letter-spacing:.09em;text-transform:lowercase;color:var(--dim)}
header{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:9px}
h1{font-size:30px;font-weight:400;letter-spacing:-.015em;line-height:1.05;margin:26px 0 6px}
.sub{color:var(--dim);font-size:14px;margin-bottom:34px}
.stats{display:flex;gap:52px;padding:20px 0;margin-bottom:6px}
.stat b{display:block;font:400 22px/1 ui-monospace,Menlo,monospace;letter-spacing:-.02em;margin-bottom:7px}
.hist{padding:22px 0 26px}
.hrow{display:grid;grid-template-columns:74px 1fr 42px;gap:14px;align-items:center;height:20px}
.hrow i{display:block;height:8px;background:var(--blue);min-width:1px}
.hrow .v{font:11px/1 ui-monospace,Menlo,monospace;color:var(--fg);text-align:right;letter-spacing:.04em}
.hrow .n{font:11px/1 ui-monospace,Menlo,monospace;color:var(--dim)}
table{width:100%;border-collapse:collapse;margin-top:8px}
td{padding:10px 10px 10px 0;border-bottom:1px solid var(--rule);vertical-align:middle}
.rk{width:38px;font:11px/1 ui-monospace,Menlo,monospace;color:var(--dim);text-align:right;padding-right:14px}
.ar{width:56px}.ar img{width:46px;height:46px;object-fit:cover;display:block;background:#f0f0f0}
.al{font-size:14px}.al a{color:var(--blue);text-decoration:underline}
.al a:visited{color:var(--purple)}
.by{color:var(--dim);font-size:12.5px}
.row .by{margin-left:2px}
.note{color:var(--dim);font-size:13px;font-style:italic;margin-top:3px;max-width:46ch}
.st{white-space:nowrap;font-size:15px;width:96px}
.num{font:12px/1 ui-monospace,Menlo,monospace;color:var(--dim);text-align:right;white-space:nowrap;width:70px}
a{color:var(--blue)}a:visited{color:var(--purple)}
footer{margin-top:44px;padding-top:11px}
"""

def _stars(v):
    return "★" * int(v) + ("½" if (v - int(v)) >= .5 else "")

def _load(name, fb):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fb

def _rows():
    r  = _load("ratings.json", {})
    al = {a["id"]: a for a in _load("albums.json", [])}
    out = []
    for aid, rec in r.items():
        a = al.get(aid)
        if a and rec.get("rating") and not rec.get("excluded"):
            out.append((float(rec["rating"]), a, rec))
    out.sort(key=lambda x: (-x[0], -x[1]["plays"]))
    return out

def write_dashboard():
    rows = _rows()
    n = len(rows)
    avg = sum(v for v, _, _ in rows) / n if n else 0
    dist = {}
    for v, _, _ in rows:
        dist[v] = dist.get(v, 0) + 1
    mx = max(dist.values()) if dist else 1

    hist = "".join(
        '<div class="hrow"><span class="v">%s&nbsp;%.1f</span>'
        '<i style="width:%.2f%%"></i><span class="n">%d</span></div>'
        % (_stars(k), k, 100.0 * dist.get(k, 0) / mx, dist.get(k, 0))
        for k in [x / 2 for x in range(10, 0, -1)] if dist.get(k))

    body = "".join(
        '<tr><td class="rk">%d</td><td class="ar">%s</td>'
        '<td><div class="al"><a href="%s" target="_blank" rel="noopener">%s</a></div>'
        '<div class="by">%s</div>%s</td>'
        '<td class="st">%s</td><td class="num">%s<br>%.0f</td></tr>'
        % (i + 1,
           ('<img loading="lazy" src="../data/%s" alt="">' % a["art"]) if a.get("art") else "",
           html.escape(a.get("rym") or a.get("rym_search", ""), quote=True),
           html.escape(a["album"]), html.escape(a["artist"]),
           ('<div class="note">%s</div>' % html.escape(rec["note"])) if rec.get("note") else "",
           "%s&nbsp;<span class='num'>%.1f</span>" % (_stars(v), v),
           "{:,}".format(a["plays"]), a["spins"])
        for i, (v, a, rec) in enumerate(rows))

    doc = """<!doctype html><meta charset="utf-8"><title>rate_my_library</title>
<style>%s</style><div class="wrap">
<header><span class="lbl">rate_my_library.</span><span class="lbl">%s</span></header><hr class="rule">
<h1>ratings.</h1><div class="sub">%d albums rated from your listening history</div>
<hr class="rule thin">
<div class="stats">
 <div class="stat"><b>%d</b><span class="lbl">rated</span></div>
 <div class="stat"><b>%.2f</b><span class="lbl">mean</span></div>
 <div class="stat"><b>%s</b><span class="lbl">plays covered</span></div>
 <div class="stat"><b>%d</b><span class="lbl">with notes</span></div>
</div>
<hr class="rule thin"><div class="hist">%s</div><hr class="rule">
<table>%s</table>
<footer><hr class="rule thin"><span class="lbl">end of list</span></footer>
</div>""" % (CSS, time.strftime("%d.%m.%Y"), n, n, avg,
             "{:,}".format(sum(a["plays"] for _, a, _ in rows)),
             sum(1 for _, _, rec in rows if rec.get("note")),
             hist, body)
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, "dashboard.html")
    with open(p, "w", encoding="utf-8") as f:
        f.write(doc)
    return p

def write_rym_queue():
    rows = _rows()
    direct = sum(1 for _, a, _ in rows if a.get("rym"))
    items = "".join(
        '<div class="row" data-id="%s" data-url="%s">'
        '<span class="ck mono">[ ]</span>'
        '<span class="rk mono">%d</span>'
        '<span class="al"><a href="%s" target="_blank" rel="noopener">%s</a>'
        '<span class="by"> &middot; %s</span></span>'
        '<span class="st">%s <span class="mono">%.1f</span></span>'
        '<span class="kind mono">%s</span></div>'
        % (a["id"], html.escape(a.get("rym") or a.get("rym_search", ""), quote=True), i + 1,
           html.escape(a.get("rym") or a.get("rym_search", ""), quote=True),
           html.escape(a["album"]), html.escape(a["artist"]),
           _stars(v), v, "direct" if a.get("rym") else "search")
        for i, (v, a, _) in enumerate(rows))

    doc = """<!doctype html><meta charset="utf-8"><title>rate_my_library / rym</title>
<style>%s
.row{display:grid;grid-template-columns:30px 34px 1fr 104px 54px;gap:12px;align-items:baseline;
 padding:7px 6px;border-bottom:1px solid var(--rule)}
.row:hover{background:#f6f6f6}
.row.cur{background:#eef;outline:1px solid var(--blue)}
.row.done{opacity:.4}
.row.done .ck{color:var(--blue)}
.ck{cursor:pointer;font-size:12px;color:var(--dim);user-select:none}
.kind{font-size:10px;color:var(--dim);text-align:right;letter-spacing:.08em}
.bar{position:sticky;top:0;background:#fff;padding:13px 0;display:flex;gap:20px;align-items:baseline;
 border-bottom:1px solid var(--fg);z-index:2;flex-wrap:wrap}
button{font:inherit;font-size:14px;background:none;border:0;color:var(--blue);cursor:pointer;
 text-decoration:underline;padding:0}
button:hover{color:var(--purple)}
.pill{font:11px/1 ui-monospace,Menlo,monospace;color:var(--dim);letter-spacing:.05em}
.help{margin-top:34px;padding-top:12px;border-top:1px solid var(--rule);color:var(--dim);font-size:14px}
kbd{font:11px ui-monospace,Menlo,monospace;border:1px solid var(--rule);padding:1px 5px;color:var(--fg)}
</style><div class="wrap">
<header><span class="lbl">rate_my_library.</span><span class="lbl">transfer queue.</span></header><hr class="rule">
<h1>rateyourmusic.</h1>
<div class="sub">Your ratings, highest first. <b>direct</b> opens the album page. <b>search</b> opens a prefilled RYM search
for that album. Ticks are saved in this browser.</div>
<div class="bar">
 <button id="opennext">Open next unticked &rarr;</button>
 <button id="toggle">Hide ticked</button>
 <span class="pill"><b id="ndone">0</b> / %d entered</span>
 <span class="pill">%d direct links</span>
</div>
<div id="list">%s</div>
<div class="help"><kbd>Enter</kbd> open next in a background tab &nbsp;
<kbd>Space</kbd> tick and advance &nbsp; <kbd>J</kbd>/<kbd>K</kbd> move.<br><br>
RYM has no public API and blocks scripted rating, so the final click is yours.
This page just removes the searching and keeps your place.</div>
<footer><hr class="rule thin"><span class="lbl">end of queue</span></footer></div>
<script>
const LS="rym.entered.v1";
let done=new Set(JSON.parse(localStorage.getItem(LS)||"[]")),cur=0,hide=false;
const rows=[...document.querySelectorAll(".row")];
const save=()=>{try{localStorage.setItem(LS,JSON.stringify([...done]))}catch(e){}};
function paint(){rows.forEach((r,n)=>{const d=done.has(r.dataset.id);
 r.classList.toggle("done",d);r.classList.toggle("cur",n===cur);
 r.querySelector(".ck").textContent=d?"[x]":"[ ]";
 r.style.display=(hide&&d)?"none":"grid";});
 document.getElementById("ndone").textContent=done.size;}
function nextUn(f){for(let n=f;n<rows.length;n++)if(!done.has(rows[n].dataset.id))return n;return -1;}
function openNext(){const n=nextUn(cur);if(n<0){alert("All entered.");return;}
 cur=n;paint();rows[n].scrollIntoView({block:"center",behavior:"smooth"});
 window.open(rows[n].dataset.url,"_blank","noopener");}
rows.forEach((r,n)=>{r.querySelector(".ck").onclick=e=>{e.stopPropagation();
 const id=r.dataset.id;done.has(id)?done.delete(id):done.add(id);save();paint();};
 r.onclick=()=>{cur=n;paint();};});
document.getElementById("opennext").onclick=openNext;
document.getElementById("toggle").onclick=e=>{hide=!hide;
 e.target.textContent=hide?"Show all":"Hide ticked";paint();};
addEventListener("keydown",e=>{
 if(/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName))return;
 const k=e.key.toLowerCase();
 if(e.key==="Enter"){e.preventDefault();openNext();}
 else if(e.key===" "){e.preventDefault();done.add(rows[cur].dataset.id);save();
  const n=nextUn(cur);if(n>=0)cur=n;paint();rows[cur].scrollIntoView({block:"center",behavior:"smooth"});}
 else if(k==="j"){cur=Math.min(rows.length-1,cur+1);paint();rows[cur].scrollIntoView({block:"center"});}
 else if(k==="k"){cur=Math.max(0,cur-1);paint();rows[cur].scrollIntoView({block:"center"});}});
paint();
</script>""" % (CSS, len(rows), direct, items)
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, "rym-queue.html")
    with open(p, "w", encoding="utf-8") as f:
        f.write(doc)
    return p
