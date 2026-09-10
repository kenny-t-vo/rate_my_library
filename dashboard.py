#!/usr/bin/env python3
"""Static output pages: out/dashboard.html and out/rym-queue.html.

Same visual language as the rater: white, Times, hyperlink blue and purple,
hairline rules, monospace numerics.
"""
import os, json, time, html

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT  = os.path.join(HERE, "out")

# Standalone pages opened from disk, so the tokens are inlined rather than
# imported from web/assets/type.css, and they carry no woff2: display falls
# back to Times. Values are copied from type.css and must track it. Figures use
# the body face with tabular-nums, as they do in the app.
CSS = """
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#fff;--fg:#111;--dim:#6f6f6f;--faint:#9a9a9a;--rule:#dcdcdc;--wash:#f2f2f7;
  --blue:#0000ee;--purple:#551a8b;
  --body:"Plantin","Plantin MT Pro","Times New Roman",Times,"Liberation Serif","Hiragino Mincho ProN","Yu Mincho",serif;
  --display:"Times New Roman",Times,serif;
  --t1:22px;--t2:16px;--t3:14px;--t4:12.5px;--t5:11px;--t6:10.5px;
  --s1:6px;--s2:12px;--s3:22px;--s4:40px;--s5:72px;
  --track:-.01em;--track-lbl:.09em;--hair:1px}
body{background:var(--bg);color:var(--fg);font:var(--t3)/1.5 var(--body);
  letter-spacing:var(--track);padding:var(--s5) var(--s4) calc(var(--s5) * 1.6);
  -webkit-font-smoothing:antialiased}
.wrap{max-width:940px;margin:0 auto}
.mono{font-variant-numeric:tabular-nums}
.rule{border:0;border-top:var(--hair) solid var(--fg);margin:0}
.rule.thin{border-top-color:var(--rule)}
.lbl{font:var(--t6)/1 var(--body);letter-spacing:var(--track-lbl);color:var(--faint)}
header{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:var(--s1)}
h1{font:var(--t1)/1.1 var(--display);font-weight:400;letter-spacing:-.018em;
  margin:var(--s3) 0 var(--s1)}
.sub{color:var(--dim);font-size:var(--t3);margin-bottom:var(--s4)}
.stats{display:flex;gap:var(--s5);padding:var(--s3) 0;margin-bottom:var(--s1)}
.stat b{display:block;font:400 var(--t1)/1 var(--body);font-variant-numeric:tabular-nums;
  margin-bottom:var(--s1)}
.hist{padding:var(--s3) 0}
.hrow{display:grid;grid-template-columns:74px 1fr 42px;gap:var(--s2);align-items:center;height:20px}
.hrow i{display:block;height:8px;background:var(--blue);min-width:var(--hair)}
.hrow .v{font:var(--t5)/1 var(--body);font-variant-numeric:tabular-nums;
  color:var(--fg);text-align:right}
.hrow .n{font:var(--t5)/1 var(--body);font-variant-numeric:tabular-nums;color:var(--dim)}
table{width:100%;border-collapse:collapse;margin-top:var(--s1)}
td{padding:var(--s2) var(--s2) var(--s2) 0;border-bottom:var(--hair) solid var(--rule);
  vertical-align:middle}
.rk{width:38px;font:var(--t5)/1 var(--body);font-variant-numeric:tabular-nums;
  color:var(--faint);text-align:right;padding-right:var(--s2)}
.ar{width:56px}
.ar img{width:46px;height:46px;object-fit:cover;display:block;background:var(--wash)}
.al{font-size:var(--t3)}
.al a{color:var(--blue);text-decoration:underline;text-underline-offset:2px}
.al a:visited{color:var(--purple)}
.by{color:var(--dim);font-size:var(--t4)}
.row .by{margin-left:2px}
.note{color:var(--dim);font-size:var(--t4);font-style:italic;
  margin-top:calc(var(--s1) / 2);max-width:46ch}
.st{white-space:nowrap;font-size:var(--t2);width:96px}
.num{font:var(--t4)/1 var(--body);font-variant-numeric:tabular-nums;color:var(--dim);
  text-align:right;white-space:nowrap;width:70px}
a{color:var(--blue);text-decoration:underline;text-underline-offset:2px}
a:visited{color:var(--purple)}
footer{margin-top:var(--s4);padding-top:var(--s2)}
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

    doc = """<!doctype html><meta charset="utf-8"><title>rate-my-library</title>
<style>%s</style><div class="wrap">
<header><span class="lbl">rate-my-library.</span><span class="lbl">%s</span></header><hr class="rule">
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

    doc = """<!doctype html><meta charset="utf-8"><title>rate-my-library / rym</title>
<style>%s
.row{display:grid;grid-template-columns:30px 34px 1fr 104px 54px;gap:var(--s2);
 align-items:baseline;padding:var(--s1) calc(var(--s1) * .8);
 border-bottom:var(--hair) solid var(--rule)}
.row:hover{background:var(--wash)}
/* the current row is outlined rather than tinted: the palette has one tint and
   hover already spends it */
.row.cur{outline:var(--hair) solid var(--blue)}
.row.done{opacity:.4}
.row.done .ck{color:var(--blue)}
.ck{cursor:pointer;font-size:var(--t4);color:var(--dim);user-select:none}
.kind{font-size:var(--t6);color:var(--dim);text-align:right;letter-spacing:var(--track-lbl)}
.bar{position:sticky;top:0;background:var(--bg);padding:var(--s2) 0;display:flex;
 gap:var(--s3);align-items:baseline;border-bottom:var(--hair) solid var(--fg);
 z-index:2;flex-wrap:wrap}
button{font:inherit;font-size:var(--t3);background:none;border:0;color:var(--blue);
 cursor:pointer;text-decoration:underline;text-underline-offset:2px;padding:0}
button:hover{text-decoration-thickness:2px}
.pill{font:var(--t5)/1 var(--body);font-variant-numeric:tabular-nums;color:var(--dim)}
.help{margin-top:var(--s4);padding-top:var(--s2);border-top:var(--hair) solid var(--rule);
 color:var(--dim);font-size:var(--t3)}
kbd{font:var(--t6)/1 var(--body);border:var(--hair) solid var(--rule);
 padding:calc(var(--s1) / 3) calc(var(--s1) * .8);color:var(--fg)}
</style><div class="wrap">
<header><span class="lbl">rate-my-library.</span><span class="lbl">transfer queue.</span></header><hr class="rule">
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
