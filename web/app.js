// The desktop build talked to a small Python server. Here the same functions
// read and write IndexedDB instead, so the app is the whole product and the
// listening history never leaves the tab.
import { aggregate, recomputeSpins, rymSearch } from "./lib/aggregate.js";
import { readFiles } from "./lib/parse.js";
import * as DB from "./lib/store.js";
import { prefetch, setUpdateHandler } from "./lib/enrich.js";

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const KEYMAP={"1":.5,"2":1,"3":1.5,"4":2,"5":2.5,"6":3,"7":3.5,"8":4,"9":4.5,"0":5};
const SCALE=[.5,1,1.5,2,2.5,3,3.5,4,4.5,5];
const KEYFOR={0.5:"1",1:"2",1.5:"3",2:"4",2.5:"5",3:"6",3.5:"7",4:"8",4.5:"9",5:"0"};

let ALL=[], VIEW=[], R={}, CFG={}, i=0, rev=0, NOTEMAX=500;
let undoS=[], redoS=[], byArtist=new Map();
const sess={start:Date.now(), n:0};

const nf=n=>n.toLocaleString();
// plenty of these names are ordinary words (Duster, Grouper, Glare, Julie),
// so the query carries a little context or the results are about dusting cloths
const artistSearch=n=>"https://www.google.com/search?q="+encodeURIComponent(n+" music");
// no reliable streaming ids in the data, so these are searches. one click from
// the album or track page on whichever service you use.
const SERVICES={
  spotify:{label:"spotify", url:q=>"https://open.spotify.com/search/"+encodeURIComponent(q)},
  apple:  {label:"apple music", url:q=>"https://music.apple.com/search?term="+encodeURIComponent(q)},
  youtube:{label:"youtube", url:q=>"https://music.youtube.com/search?q="+encodeURIComponent(q)},
  google: {label:"google", url:q=>"https://www.google.com/search?q="+encodeURIComponent(q)}};
const listen=q=>{const sv=SERVICES[CFG.listenOn]; return sv?sv.url(q):null;};
const ntrk=s=>s.toLowerCase().normalize("NFKD").replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
const stars=v=>v?"★".repeat(Math.floor(v))+((v%1)?"½":""):"☆☆☆☆☆";
const fdate=t=>t?new Date(t*1000).toLocaleDateString(undefined,{year:"numeric",month:"short"}):"";
function toast(m,ms){clearTimeout(toast._t);const t=$("#toast");t.textContent=m;t.classList.add("on");
  toast._t=setTimeout(()=>t.classList.remove("on"),ms||1500);}

/* ── saving ─────────────────────────────────────────────────────── */
// Nothing to retry and nothing to lose: a rating is in IndexedDB before the
// next keystroke lands. The indicator stays because other tabs can still
// write, and because "saved" is worth showing.
const Q={pend:[],busy:false,fail:0};
let saveTimer=null;
function push(op){
  if(op.clear) DB.delRating(op.id).catch(()=>{});
  else{const {id,...rec}=op; DB.putRating(id,rec).catch(()=>{});}
  chan&&chan.postMessage({t:"rate",id:op.id});
  paintSave();
}
function paintSave(){
  const el=$("#save"), t=$("#saveT");
  el.classList.remove("pend","err");
  t.textContent="saved";
  clearTimeout(saveTimer);
  el.classList.add("pend"); t.textContent="saving";
  saveTimer=setTimeout(()=>{el.classList.remove("pend");t.textContent="saved";},260);
}
const chan = "BroadcastChannel" in window ? new BroadcastChannel("rml") : null;
if(chan) chan.onmessage=e=>{
  if(e.data&&e.data.t==="rate"){
    $("#bannerT").textContent="Ratings changed in another tab. Reload to see them.";
    $("#banner").classList.add("on");
  }
};

/* ── boot ────────────────────────────────────────────────────────── */
async function boot(){
  CFG=await DB.getKV("config",null)||{minPlays:10,minTracks:2,sort:"plays",show:"all",
    autoAdvance:true,showCarousel:true,confirmExclude:false,listenOn:"spotify",fullTracklist:true};
  ALL=await DB.allAlbums();
  R=await DB.allRatings();
  if(!ALL.length){showWelcome();return;}
  startApp();
}
function startApp(){
  $("#welcome").classList.remove("on");
  byArtist=new Map();
  ALL.forEach(x=>{const k=x.artist.toLowerCase();
    if(!byArtist.has(k))byArtist.set(k,[]); byArtist.get(k).push(x);});
  $("#sMin").max=Math.min(300,Math.max(...ALL.map(x=>x.plays)));
  buildScale(); syncSettings(); if(!bound)bind(); apply(true);
  setUpdateHandler(a=>{
    const k=ALL.findIndex(x=>x.id===a.id); if(k>=0)ALL[k]=a;
    const v=VIEW.findIndex(x=>x.id===a.id); if(v>=0)VIEW[v]=a;
    if(VIEW[i]&&VIEW[i].id===a.id)render(); else if(v>=0)paintStripThumb(v,a);
  });
  prefetch(VIEW,i);
}
let bound=false;

/* ── filtering / sorting ─────────────────────────────────────────── */
function hash(s){let h=2166136261;for(let n=0;n<s.length;n++){h^=s.charCodeAt(n);h=Math.imul(h,16777619);}return h>>>0;}
function apply(resume){
  const cur=VIEW[i]&&VIEW[i].id;
  VIEW=ALL.filter(a=>{const r=R[a.id]||{};
    if(r.excluded)return false;
    if(a.plays<CFG.minPlays||a.distinct_tracks<CFG.minTracks)return false;
    if(CFG.show==="unrated"&&r.rating)return false;
    if(CFG.show==="rated"&&!r.rating)return false;
    if(CFG.show==="flagged"&&!r.flag)return false;
    if(CFG.show==="noted"&&!r.note)return false;
    return true;});
  ({plays:()=>VIEW.sort((x,y)=>y.plays-x.plays),
    spins:()=>VIEW.sort((x,y)=>y.spins-x.spins),
    breadth:()=>VIEW.sort((x,y)=>y.distinct_tracks-x.distinct_tracks||y.plays-x.plays),
    recent:()=>VIEW.sort((x,y)=>y.last-x.last),
    discovered:()=>VIEW.sort((x,y)=>x.first-y.first),
    artist:()=>VIEW.sort((x,y)=>x.artist.toLowerCase().localeCompare(y.artist.toLowerCase())||y.plays-x.plays),
    random:()=>VIEW.sort((x,y)=>hash(x.id)-hash(y.id))}[CFG.sort]||(()=>{}))();
  $("#sCount").textContent=VIEW.length+" albums match";
  if(resume){const k=VIEW.findIndex(a=>!(R[a.id]||{}).rating); i=k<0?0:k;}
  else if(cur){const k=VIEW.findIndex(a=>a.id===cur); if(k>=0)i=k;}
  i=Math.max(0,Math.min(i,VIEW.length-1));
  render(); buildStrip();
}

/* ── render ──────────────────────────────────────────────────────── */
function buildScale(){
  $("#scale").innerHTML=SCALE.map(v=>
    `<div class="cell" data-v="${v}"><span class="k">${KEYFOR[v]}</span>
     <span class="v">${v.toFixed(1)}</span></div>`).join("");
  $$("#scale .cell").forEach(c=>c.onclick=()=>rate(+c.dataset.v));
}
function render(){
  const empty=!VIEW.length;
  $("#title").textContent = empty?"nothing matches":VIEW[i].album;
  if(empty){
    $("#artist").textContent=""; $("#artist").removeAttribute("href"); $("#tags").innerHTML=""; $("#tracks").innerHTML="";
    $("#rym").innerHTML="";
    $("#meta").innerHTML=""; $("#years").innerHTML=""; $("#calib").textContent=
      "loosen the cutoff in settings to bring albums back.";
    $("#coverImg").removeAttribute("src"); paintChrome(); return;
  }
  const a=VIEW[i], r=R[a.id]||{};

  $("#pos").textContent=`${i+1} of ${VIEW.length}`;
  $("#posAlt").textContent=`#${a.rank} by plays in library`;
  const ar=$("#artist"); ar.textContent=a.artist; ar.href=artistSearch(a.artist);

  const cov=$("#cover"), img=$("#coverImg");
  cov.classList.toggle("none",!a.art);
  if(a.art){ cov.classList.add("load");
    img.onload=()=>cov.classList.remove("load");
    img.onerror=()=>{cov.classList.add("none");cov.classList.remove("load");img.removeAttribute("src");};
    img.src=a.art;
  } else img.removeAttribute("src");

  const tags=[];
  if(a.distinct_tracks<=2)tags.push(['warn','likely a single']);
  if(r.flag)tags.push(['hot','flagged to revisit']);
  if(r.skip)tags.push(['','skipped']);
  if(a.variants&&a.variants.length)tags.push(['',a.variants.length+' editions merged']);
  $("#tags").innerHTML=tags.map(([c,t])=>`<span class="tag ${c}">${t}</span>`).join("");

  const direct=!!a.rym;
  const lu=listen(`${a.artist} ${a.album}`), sv=SERVICES[CFG.listenOn];
  $("#rym").innerHTML=`<a href="${esc(direct?a.rym:a.rym_search)}" target="_blank" rel="noopener">`
    +`rateyourmusic</a> <span class="lbl">enter</span>`
    +(lu?` <a href="${esc(lu)}" target="_blank" rel="noopener" style="margin-left:14px">`
        +`${esc(sv.label)}</a> <span class="lbl">L</span>`:"");

  // artist calibration - what did I give this artist's other records?
  const sib=(byArtist.get(a.artist.toLowerCase())||[])
    .filter(x=>x.id!==a.id&&(R[x.id]||{}).rating)
    .sort((x,y)=>(R[y.id].rating)-(R[x.id].rating));
  $("#calib").innerHTML = sib.length
    ? `you rated ${sib.length} other ${sib.length===1?"record":"records"} by ${esc(a.artist)}: `
      + sib.slice(0,5).map(x=>`<b>${R[x.id].rating.toFixed(1)}</b> ${esc(x.album)}`).join(" · ")
      + (sib.length>5?" and more":"")
    : "";

  const v=r.rating||0;
  $("#stars").textContent=stars(v);
  $$("#scale .cell").forEach(c=>c.classList.toggle("on",+c.dataset.v===v));

  const nb=$("#noteBox");
  if(document.activeElement!==nb){ nb.value=r.note||""; }
  nb.classList.toggle("has",!!(r.note));
  countNote();

  $("#lisSum").textContent=nf(a.plays)+" plays";
  $("#meta").innerHTML=[
    ["plays",nf(a.plays)],["album spins",a.spins.toFixed(1)+(a.spins_basis==="heard"?" ~":"")],
    ["tracks heard",a.distinct_tracks],["top track",a.top_track_plays+"×"],
    ["first",fdate(a.first)],["last",fdate(a.last)],
    ["artist total",nf(a.artist_plays)]
  ].map(([k,val])=>`<dt>${k}</dt><dd>${esc(String(val))}</dd>`).join("");

  const ys=a.years||{}, yk=Object.keys(ys).sort(), ym=Math.max(1,...Object.values(ys));
  $("#ctx").style.visibility = yk.length>1 ? "visible" : "hidden";
  $("#years").innerHTML=yk.map(y=>
    `<div class="r${ys[y]===ym?" top":""}"><span>${y}</span><span>${ys[y]}</span>
     <i style="width:${(100*ys[y]/ym).toFixed(1)}%"></i></div>`).join("");

  const heard=new Map(a.tracks.map(t=>[ntrk(t.name),t.plays]));
  const full=CFG.fullTracklist&&a.full_tracks&&a.full_tracks.length?a.full_tracks:null;
  let rows;
  if(full){
    const used=new Set();
    rows=full.map(ft=>{const k=ntrk(ft.name),p=heard.get(k)||0; if(p)used.add(k);
      return {n:ft.n,name:ft.name,plays:p};});
    // anything played that is not on this pressing: bonus tracks, other edition
    a.tracks.forEach(t=>{if(!used.has(ntrk(t.name)))rows.push({n:null,name:t.name,plays:t.plays});});
  } else rows=a.tracks.map((t,k)=>({n:k+1,name:t.name,plays:t.plays}));
  const tm=Math.max(1,...rows.map(r=>r.plays));
  const topName=a.tracks.length?ntrk(a.tracks[0].name):null;
  $("#trkSum").textContent = a.total_tracks
    ? `${a.distinct_tracks} of ${a.total_tracks} heard` : `${a.distinct_tracks} heard`;
  $("#tracks").innerHTML=rows.map(r=>{
    const u=r.plays===0, url=listen(`${a.artist} ${r.name}`);
    const name=url?`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(r.name)}</a>`
                  :esc(r.name);
    return `<div class="trk${ntrk(r.name)===topName&&!u?" top":""}${u?" unheard":""}">
     <span class="n">${r.n==null?"·":r.n}</span>
     <span class="t" title="${esc(r.name)}">${name}</span>
     <span class="c">${u?"":r.plays}</span>
     ${u?"":`<i class="bar" style="width:calc((100% - 62px) * ${(r.plays/tm).toFixed(3)})"></i>`}
     </div>`;}).join("");

  paintChrome(); moveStrip(); prefetch(VIEW,i);
  for(let k=1;k<=8;k++){const nx=VIEW[i+k]; if(nx&&nx.art)(new Image()).src=nx.art;}
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

function paintChrome(){
  const all=Object.values(R), done=all.filter(x=>x.rating).length;
  const inV=VIEW.filter(x=>(R[x.id]||{}).rating).length;
  $("#hcount").textContent=`${nf(done)} / ${nf(VIEW.length)}`;
  $("#prog i").style.width=(100*inV/Math.max(1,VIEW.length))+"%";
  $("#stat").textContent=`${inV} rated in view · ${VIEW.length-inV} to go`;

  const mins=(Date.now()-sess.start)/60000;
  const rate=sess.n/Math.max(mins,.4);
  const left=VIEW.length-inV;
  $("#sessK").innerHTML=[
    ["rated now",sess.n],["per minute",sess.n?rate.toFixed(1):""],
    ["est. remaining",sess.n&&rate>.05?(left/rate<90?Math.round(left/rate)+" min":(left/rate/60).toFixed(1)+" hr"):""],
    ["flagged",all.filter(x=>x.flag).length],
    ["notes",all.filter(x=>x.note).length],
    ["hidden",all.filter(x=>x.excluded).length]
  ].map(([k,v])=>`<dt>${k}</dt><dd>${v}</dd>`).join("");

  const d={}; all.forEach(x=>{if(x.rating)d[x.rating]=(d[x.rating]||0)+1;});
  const mx=Math.max(1,...Object.values(d));
  $("#distr").innerHTML=SCALE.slice().reverse().map(v=>{
    const c=d[v]||0;
    return `<div class="r"><span>${v.toFixed(1)}</span><span>${c||""}</span>
     <i style="width:${c?(100*c/mx).toFixed(1):0}%"></i></div>`;}).join("");

  $("#navQ").innerHTML=[
    ["unrated","unrated"],["all","everything"],["rated","rated"],
    ["flagged","flagged"],["noted","with notes"]
  ].map(([k,t])=>{
    const n=ALL.filter(a=>{const r=R[a.id]||{};
      if(r.excluded)return false;
      if(a.plays<CFG.minPlays||a.distinct_tracks<CFG.minTracks)return false;
      return k==="all"?true:k==="unrated"?!r.rating:k==="rated"?!!r.rating:
             k==="flagged"?!!r.flag:!!r.note;}).length;
    return `<div><span class="t">~</span><a class="lnk${CFG.show===k?" on":""}"
      data-show="${k}">${t}</a><kbd>${n}</kbd></div>`;}).join("");
  $$("#navQ a").forEach(el=>el.onclick=()=>{CFG.show=el.dataset.show;saveCfg();syncSettings();apply(false);});
}

/* ── filmstrip ───────────────────────────────────────────────────── */
function buildStrip(){
  if(!CFG.showCarousel){$("#strip").style.display="none";return;}
  $("#strip").style.display="";
  $("#stripInner").innerHTML=VIEW.map((a,n)=>{
    const r=R[a.id]||{};
    return `<div class="th${r.rating?" rated":""}" data-n="${n}" data-r="${r.rating?r.rating.toFixed(1):""}"
      title="${esc(a.artist)}: ${esc(a.album)}">${a.art?`<img loading="lazy" src="${esc(a.art)}" alt="">`:""}</div>`;
  }).join("");
  $$("#stripInner .th").forEach(el=>el.onclick=()=>{i=+el.dataset.n;render();});
  moveStrip();
}
function moveStrip(){
  if(!CFG.showCarousel)return;
  const strip=$("#strip"), inner=$("#stripInner"), el=inner.children[i];
  if(!el)return;
  [...inner.children].forEach((n,k)=>n.classList.toggle("cur",k===i));
  // reading offsetLeft forces layout, so this needs no animation frame. it must
  // not use one: rAF never fires in a background tab and the strip would then
  // sit wherever it was left.
  // instant, not smooth: the strip is a position indicator, and an animation
  // lagging behind fast keypresses reads worse than none at all
  strip.scrollTo({left:el.offsetLeft-strip.clientWidth/2+el.offsetWidth/2,
                  behavior:"instant"});
}
function paintStripThumb(n,a){
  const el=$("#stripInner").children[n]; if(!el)return;
  if(a.art&&!el.querySelector("img"))
    el.innerHTML=`<img loading="lazy" src="${esc(a.art)}" alt="">`;
}

/* ── actions ─────────────────────────────────────────────────────── */
function snapshot(id){const r=R[id]; return r?JSON.parse(JSON.stringify(r)):null;}
function commit(id,prev,next,quiet){
  undoS.push({id,prev}); redoS.length=0;
  if(next===null){delete R[id]; push({id,clear:true});}
  else {R[id]=next; push(Object.assign({id},next));}
  if(!quiet)paintChrome();
}
function rate(v){
  if(!VIEW.length)return;
  const a=VIEW[i], prev=snapshot(a.id);
  commit(a.id,prev,Object.assign({},R[a.id],{rating:v,skip:false}),true);
  sess.n++;
  $("#last").textContent=`${stars(v)} ${v.toFixed(1)} · ${a.album}`;
  if(CFG.autoAdvance){
    if(CFG.show==="unrated"||CFG.show==="flagged"||CFG.show==="noted"){apply(false);}
    else next(true);
  } else render();
  markStrip(a.id,v);
}
function markStrip(id,v){
  if(!CFG.showCarousel)return;
  const n=VIEW.findIndex(x=>x.id===id); if(n<0)return;
  const el=$$("#stripInner .th")[n]; if(!el)return;
  el.classList.add("rated"); el.dataset.r=v.toFixed(1);
}
function next(silent){ if(i<VIEW.length-1){i++;render();} else {render(); if(!silent)toast("end of queue");} }
function prev(){ if(i>0){i--;render();} }
function undo(){
  const h=undoS.pop(); if(!h){toast("nothing to undo");return;}
  redoS.push({id:h.id,prev:snapshot(h.id)});
  if(h.prev){R[h.id]=h.prev; push(Object.assign({id:h.id},h.prev));}
  else {delete R[h.id]; push({id:h.id,clear:true});}
  apply(false);
  const k=VIEW.findIndex(a=>a.id===h.id); if(k>=0)i=k;
  render(); buildStrip(); toast("undone");
}
function redo(){
  const h=redoS.pop(); if(!h){toast("nothing to redo");return;}
  undoS.push({id:h.id,prev:snapshot(h.id)});
  if(h.prev){R[h.id]=h.prev; push(Object.assign({id:h.id},h.prev));}
  else {delete R[h.id]; push({id:h.id,clear:true});}
  apply(false);
  const k=VIEW.findIndex(a=>a.id===h.id); if(k>=0)i=k;
  render(); buildStrip(); toast("redone");
}
function toggleFlag(){ if(!VIEW.length)return; const a=VIEW[i], r=R[a.id]||{};
  commit(a.id,snapshot(a.id),Object.assign({},r,{flag:!r.flag}));
  render(); toast(r.flag?"unflagged":"flagged to revisit"); }
function skip(){ if(!VIEW.length)return; const a=VIEW[i];
  commit(a.id,snapshot(a.id),Object.assign({},R[a.id],{skip:true}),true); next(); }
function exclude(){
  if(!VIEW.length)return; const a=VIEW[i];
  if(CFG.confirmExclude&&!confirm(`Hide “${a.album}” from the queue?`))return;
  commit(a.id,snapshot(a.id),Object.assign({},R[a.id],{excluded:true}),true);
  apply(false); buildStrip(); toast("hidden · U to undo");
}
function clearRating(){ if(!VIEW.length)return; const a=VIEW[i];
  commit(a.id,snapshot(a.id),null); render(); buildStrip(); toast("cleared"); }
function jumpUnrated(){const k=VIEW.findIndex((a,n)=>n>i&&!(R[a.id]||{}).rating);
  const j=k<0?VIEW.findIndex(a=>!(R[a.id]||{}).rating):k;
  if(j<0){toast("everything here is rated");return;} i=j; render();}
function randomUnrated(){const c=VIEW.map((a,n)=>[a,n]).filter(([a])=>!(R[a.id]||{}).rating);
  if(!c.length){toast("everything here is rated");return;}
  i=c[Math.floor(Math.random()*c.length)][1]; render();}
function openRym(){ if(!VIEW.length)return; const a=VIEW[i];
  window.open(a.rym||a.rym_search,"_blank","noopener"); }
function openArtist(){ if(!VIEW.length)return;
  window.open(artistSearch(VIEW[i].artist),"_blank","noopener"); }
function copyName(){ if(!VIEW.length)return; const a=VIEW[i];
  const s=`${a.artist} - ${a.album}`;
  (navigator.clipboard?navigator.clipboard.writeText(s):Promise.reject())
    .then(()=>toast("copied · "+s)).catch(()=>toast("copy blocked by the browser")); }

/* ── notes ───────────────────────────────────────────────────────── */
function countNote(){
  const n=$("#noteBox").value.length, el=$("#noteCount");
  el.textContent=n+" / "+NOTEMAX; el.classList.toggle("over",n>=NOTEMAX);
}
function saveNote(){
  if(!VIEW.length)return;
  const a=VIEW[i], t=$("#noteBox").value.slice(0,NOTEMAX).trim();
  const cur=(R[a.id]||{}).note||"";
  if(t===cur)return;
  commit(a.id,snapshot(a.id),Object.assign({},R[a.id],{note:t}));
  $("#noteBox").classList.toggle("has",!!t);
}

/* ── settings / config ───────────────────────────────────────────── */
function saveCfg(){ DB.setKV("config",CFG).catch(()=>{}); }
function syncSettings(){
  $("#sMin").value=CFG.minPlays; $("#oMin").textContent=CFG.minPlays;
  $("#sTrk").value=CFG.minTracks; $("#oTrk").textContent=CFG.minTracks;
  $("#sSort").value=CFG.sort; $("#sShow").value=CFG.show;
  [["tAdv","autoAdvance"],["tCar","showCarousel"],["tConf","confirmExclude"],
   ["tFull","fullTracklist"]]
    .forEach(([el,k])=>{const e=$("#"+el); if(!e)return;
      e.classList.toggle("on",!!CFG[k]); e.textContent=CFG[k]?"on":"off";});
  if($("#sListen"))$("#sListen").value=CFG.listenOn||"";
}

/* ── snapshots ───────────────────────────────────────────────────── */
async function loadSnaps(){
  const list=await DB.snapshots();
  $("#snapList").innerHTML=list.map(sn=>
    `<div class="snap"><span>${esc(sn.name)}</span>
      <span class="m">${sn.kind}</span><span class="m">${sn.rated} rated</span>
      <span class="m">${new Date(sn.ts).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</span>
      <a class="lnk" data-rs="${sn.ts}">restore</a></div>`).join("")
    || '<div class="lbl">no save states yet</div>';
  $$("#snapList a[data-rs]").forEach(el=>el.onclick=async()=>{
    if(!confirm("Restore this save state? Your current ratings are snapshotted first."))return;
    const rec=await DB.restoreSnapshot(+el.dataset.rs);
    if(rec){R=rec;undoS=[];redoS=[];apply(false);buildStrip();closeAll();toast("restored");}
  });
}

/* ── overlays ────────────────────────────────────────────────────── */
const anyOv=()=>!!$(".ov.on");
function closeAll(){$$(".ov").forEach(o=>o.classList.remove("on"));}
function openOv(id){closeAll();$("#"+id).classList.add("on");
  if(id==="ovSnap")loadSnaps();
  if(id==="ovFind"){$("#findI").value="";find("");$("#findI").focus();}}

function find(q){
  q=q.trim().toLowerCase();
  const el=$("#findR");
  if(!q){el.innerHTML="";return;}
  const hits=ALL.filter(a=>(a.artist+" "+a.album).toLowerCase().includes(q))
    .sort((x,y)=>y.plays-x.plays).slice(0,40);
  el.innerHTML=hits.map(a=>{const r=R[a.id]||{};
    return `<div class="ri" data-id="${a.id}">
      <img loading="lazy" src="${a.art?esc(a.art):""}" alt="">
      <div><div class="a">${esc(a.album)}</div><div class="b">${esc(a.artist)}</div></div>
      <div class="c">${nf(a.plays)} plays${r.rating?" · "+r.rating.toFixed(1):""}</div></div>`;
  }).join("")||'<div class="lbl" style="padding:12px 4px">no match</div>';
  $$("#findR .ri").forEach(e=>e.onclick=()=>goto(e.dataset.id));
}
function goto(id){
  let k=VIEW.findIndex(a=>a.id===id);
  if(k<0){const a=ALL.find(x=>x.id===id);
    if(a){CFG.minPlays=Math.min(CFG.minPlays,a.plays);
      CFG.minTracks=Math.min(CFG.minTracks,a.distinct_tracks);CFG.show="all";
      saveCfg();syncSettings();apply(false);buildStrip();
      k=VIEW.findIndex(x=>x.id===id);toast("filters relaxed to reach it");}}
  if(k>=0){i=k;closeAll();render();}
}

/* ── binding ─────────────────────────────────────────────────────── */
function bind(){
  bound=true;
  $$("nav .lnk").forEach(el=>el.onclick=()=>openOv(el.dataset.ov));
  $$(".ov").forEach(o=>o.onclick=e=>{if(e.target===o)closeAll();});
  ["setClose","snapClose","outClose","keysClose","aboutClose"].forEach(id=>$("#"+id).onclick=closeAll);

  $("#findI").oninput=e=>find(e.target.value);
  $("#findI").onkeydown=e=>{if(e.key==="Enter"){const f=$("#findR .ri");if(f)goto(f.dataset.id);}};

  const upd=()=>{CFG.minPlays=+$("#sMin").value;CFG.minTracks=+$("#sTrk").value;
    CFG.sort=$("#sSort").value;CFG.show=$("#sShow").value;
    saveCfg();syncSettings();apply(false);buildStrip();};
  ["sMin","sTrk"].forEach(id=>$("#"+id).oninput=upd);
  ["sSort","sShow"].forEach(id=>$("#"+id).onchange=upd);
  [["tAdv","autoAdvance"],["tCar","showCarousel"],["tConf","confirmExclude"],
   ["tFull","fullTracklist"]]
    .forEach(([el,k])=>{const e=$("#"+el); if(!e)return; e.onclick=()=>{CFG[k]=!CFG[k];saveCfg();syncSettings();
      if(k==="showCarousel")buildStrip(); else render();};});
  if($("#sListen"))$("#sListen").onchange=()=>{CFG.listenOn=$("#sListen").value;saveCfg();render();};

  const nb=$("#noteBox");
  nb.oninput=countNote;
  nb.onfocus=()=>{$("#noteWrap").classList.add("editing");countNote();};
  nb.onblur=()=>{$("#noteWrap").classList.remove("editing");saveNote();};
  nb.onkeydown=e=>{
    if(e.key==="Escape"||(e.key==="Enter"&&(e.metaKey||e.ctrlKey))){e.preventDefault();
      saveNote();nb.blur();}
    e.stopPropagation();
  };

  $("#snapGo").onclick=async()=>{
    const name=$("#snapName").value.trim()||"manual save";
    await DB.snapshot(name);
    $("#snapName").value=""; loadSnaps(); toast("save state written");
  };
  $("#expGo").onclick=()=>{const n=downloadAll();
    $("#expMsg").textContent=n?`${n} ratings downloaded`:"nothing rated yet";};
  $("#expDash").onclick=e=>{e.preventDefault();openDoc(dashboardHTML());};
  $("#expRym").onclick=e=>{e.preventDefault();openDoc(rymQueueHTML());};
  $("#impGo").onclick=()=>$("#impFile").click();
  $("#impFile").onchange=e=>importFiles(e.target.files);
  $("#impRatings").onchange=e=>importRatings(e.target.files[0]);
  $("#bannerR").onclick=e=>{e.preventDefault();location.reload();};
  $("#menu").onclick=()=>toggleDrawer();
  $("#ratGo").onclick=()=>$("#impRatings").click();
  $("#wipeGo").onclick=async()=>{
    if(!confirm("Erase the library and every rating in this browser? This cannot be undone."))return;
    // underscore intentional, see the DB constant in lib/store.js
    indexedDB.deleteDatabase("rate_my_library"); location.reload();};
  // a filter tap on mobile should close the drawer it was tapped in
  $(".colL").addEventListener("click",e=>{
    if(e.target.closest("a")&&innerWidth<=820)toggleDrawer(false);});
  $("#scrim").onclick=()=>toggleDrawer(false);

  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"){ if(anyOv()){closeAll();return;} }
    const ae=document.activeElement;
    if(ae&&/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))return;
    if(e.metaKey||e.ctrlKey||e.altKey)return;
    if(anyOv()&&e.key!=="?")return;
    if(e.repeat&&(e.key in KEYMAP))return;
    if(e.key in KEYMAP){e.preventDefault();rate(KEYMAP[e.key]);return;}
    const k=e.key.toLowerCase();
    if(e.key==="Tab"&&!e.shiftKey){e.preventDefault();jumpUnrated();return;}
    if(e.key==="T"){randomUnrated();return;}
    switch(k){
      case "arrowright":case " ":e.preventDefault();next();break;
      case "arrowleft":e.preventDefault();prev();break;
      case "arrowdown":e.preventDefault();i=Math.min(VIEW.length-1,i+10);render();break;
      case "arrowup":e.preventDefault();i=Math.max(0,i-10);render();break;
      case "u":case "backspace":e.preventDefault();undo();break;
      case "r":redo();break;
      case "c":clearRating();break;
      case "s":skip();break;
      case "x":exclude();break;
      case "f":toggleFlag();break;
      case "y":copyName();break;
      case "w":openArtist();break;
      case "l":{if(!VIEW.length)break;const u=listen(`${VIEW[i].artist} ${VIEW[i].album}`);
        if(u)window.open(u,"_blank","noopener"); else toast("listen links are off");break;}
      case "enter":openRym();break;
      case "n":e.preventDefault();$("#noteBox").focus();break;
      case "/":e.preventDefault();openOv("ovFind");break;
      case ",":openOv("ovSet");break;
      case "g":openOv("ovSnap");break;
      case "e":openOv("ovOut");break;
      case "?":closeAll();openOv("ovKeys");break;
    }
  });
}

boot();
/* ── import ─────────────────────────────────────────────────────────── */
function showWelcome(){
  $("#welcome").classList.add("on");
  const drop=$("#drop"), pick=$("#pick");
  drop.onclick=()=>pick.click();
  pick.onchange=e=>importFiles(e.target.files,true);
  ["dragenter","dragover"].forEach(t=>drop.addEventListener(t,e=>{
    e.preventDefault();drop.classList.add("over");}));
  ["dragleave","drop"].forEach(t=>drop.addEventListener(t,e=>{
    e.preventDefault();drop.classList.remove("over");}));
  drop.addEventListener("drop",e=>importFiles(e.dataTransfer.files,true));
  $("#pickr").onchange=e=>importRatings(e.target.files[0],true);
  $("#wMin").oninput=e=>$("#woMin").textContent=e.target.value;
  $("#wTrk").oninput=e=>$("#woTrk").textContent=e.target.value;
}

async function importFiles(files,first){
  if(!files||!files.length)return;
  const say=m=>{const el=first?$("#wstatus"):$("#impMsg");el.classList.remove("err");el.textContent=m;};
  const fail=m=>{const el=first?$("#wstatus"):$("#impMsg");el.classList.add("err");el.textContent=m;};
  try{
    say("reading");
    const {source,plays}=await readFiles(files,{onProgress:say});
    if(!plays.length)return fail("no plays with an album name in that file");
    say(`${plays.length.toLocaleString()} plays, grouping`);
    await new Promise(r=>setTimeout(r,16));
    const minPlays=first?+$("#wMin").value:1;
    const albums=aggregate(plays,{minPlays:Math.min(minPlays,8)});
    if(!albums.length)return fail("nothing cleared the play cutoff");
    // ratings are keyed by artist and album, so an existing library's scores
    // survive a fresh export of the same account
    const keep=await DB.allRatings();
    if(Object.keys(keep).length) await DB.snapshot("before import","auto");
    const prev=new Map((await DB.allAlbums()).map(a=>[a.id,a]));
    for(const a of albums){
      const o=prev.get(a.id);
      if(o){a.art=o.art;a.art_src=o.art_src;a.art_tried=o.art_tried;a.rym=o.rym;
        a.rym_tried=o.rym_tried;a.rgid=o.rgid||a.rgid;a.mbid=a.mbid||o.mbid;
        a.artist_mbid=a.artist_mbid||o.artist_mbid;a.full_tracks=o.full_tracks;
        a.total_tracks=o.total_tracks;a.tracks_tried=o.tracks_tried;recomputeSpins(a);}
    }
    say("saving");
    await DB.clearAlbums(); await DB.putAlbums(albums);
    if(first){CFG.minPlays=+$("#wMin").value;CFG.minTracks=+$("#wTrk").value;await DB.setKV("config",CFG);}
    await DB.setKV("meta",{source,importedAt:Date.now(),plays:plays.length,albums:albums.length});
    ALL=albums; R=await DB.allRatings();
    startApp();
    toast(`${albums.length.toLocaleString()} albums from ${plays.length.toLocaleString()} plays`,2600);
  }catch(e){ fail(String(e.message||e)); }
}

async function importRatings(file,first){
  if(!file)return;
  const say=m=>{const el=first?$("#wstatus"):$("#ratMsg");el.textContent=m;};
  try{
    const data=JSON.parse(await file.text());
    // accepts ratings.json from the CLI, or this app's own export
    const map=data.ratings&&typeof data.ratings==="object"?data.ratings
      :Array.isArray(data)?Object.fromEntries(data.filter(r=>r.id).map(r=>[r.id,
        {rating:r.rating,note:r.note||"",flag:!!r.flagged}])):data;
    const rows=Object.entries(map).filter(([k,v])=>v&&typeof v==="object");
    if(!rows.length)return say("no ratings found in that file");
    if(Object.keys(await DB.allRatings()).length) await DB.snapshot("before ratings import","auto");
    await DB.putRatings(Object.fromEntries(rows));
    R=await DB.allRatings();
    const known=new Set(ALL.map(a=>a.id));
    const matched=rows.filter(([k])=>known.has(k)).length;
    say(`${rows.length} loaded, ${matched} matched to albums here`);
    if(ALL.length){apply(false);buildStrip();}
    toast(`${matched} ratings restored`,2400);
  }catch(e){ say("could not read that file"); }
}

/* ── export ─────────────────────────────────────────────────────────── */
const ratedRows=()=>Object.entries(R).map(([id,rec])=>[rec,ALL.find(a=>a.id===id)])
  .filter(([rec,a])=>a&&rec.rating&&!rec.excluded)
  .sort((x,y)=>y[0].rating-x[0].rating||y[1].plays-x[1].plays);
const starStr=v=>"★".repeat(Math.floor(v))+((v%1)?"½":"");
const dl=(name,text,type)=>{const b=new Blob([text],{type:type||"text/plain;charset=utf-8"});
  const u=URL.createObjectURL(b),a=document.createElement("a");
  a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
const openDoc=html=>{const w=window.open("","_blank");
  if(!w)return toast("allow popups to open that");w.document.write(html);w.document.close();};

function downloadAll(){
  const rows=ratedRows(); if(!rows.length)return 0;
  const cols=["artist","album","rating","rating_10","plays","album_spins","distinct_tracks",
    "total_tracks","top_track","top_track_plays","first_played","last_played","play_rank",
    "note","flagged","rym_url","mbid","id"];
  const q=v=>{v=v==null?"":String(v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;};
  const d=t=>t?new Date(t*1000).toISOString().slice(0,10):"";
  const csv=[cols.join(",")].concat(rows.map(([rec,a])=>[a.artist,a.album,rec.rating,
    Math.round(rec.rating*2),a.plays,a.spins,a.distinct_tracks,a.total_tracks||"",
    a.top_track,a.top_track_plays,d(a.first),d(a.last),a.rank,rec.note||"",
    rec.flag?"yes":"",a.rym||a.rym_search,a.mbid||"",a.id].map(q).join(","))).join("\n");
  dl("ratings.csv",csv,"text/csv;charset=utf-8");
  dl("ratings.json",JSON.stringify({exported:new Date().toISOString(),
    ratings:Object.fromEntries(rows.map(([rec,a])=>[a.id,rec]))},null,1),"application/json");
  let md=[`# rate-my-library`,"",`${rows.length} albums · mean ${
    (rows.reduce((s,[r])=>s+r.rating,0)/rows.length).toFixed(2)}`,""],cur=null;
  for(const [rec,a] of rows){
    if(rec.rating!==cur){cur=rec.rating;md.push("",`## ${starStr(cur)}  (${cur.toFixed(1)})`,"");}
    md.push(`- **${a.album}** by ${a.artist}`+(rec.note?`  \n  _${rec.note.replace(/\n/g," ")}_`:""));
  }
  dl("ratings.md",md.join("\n")+"\n","text/markdown;charset=utf-8");
  return rows.length;
}

const DOC_CSS=`*{box-sizing:border-box;margin:0;padding:0}
:root{--fg:#111;--dim:#6b6b6b;--rule:#d8d8d8;--blue:#0000ee;--purple:#551a8b}
body{background:#fff;color:var(--fg);font:14px/1.45 "Times New Roman",Times,serif;
padding:52px 40px 120px}.wrap{max-width:940px;margin:0 auto}
.lbl{font:10.5px/1 "Times New Roman",Times,serif;letter-spacing:.09em;color:var(--dim)}
hr{border:0;border-top:1px solid var(--fg);margin:0}hr.thin{border-top-color:var(--rule)}
h1{font-size:30px;font-weight:400;letter-spacing:-.015em;margin:26px 0 6px}
.sub{color:var(--dim);margin-bottom:34px}
.stats{display:flex;gap:52px;padding:20px 0}
.stat b{display:block;font:400 22px/1 ui-monospace,Menlo,monospace;margin-bottom:7px}
.hrow{display:grid;grid-template-columns:74px 1fr 42px;gap:14px;align-items:center;height:20px}
.hrow i{display:block;height:8px;background:var(--blue)}
.hrow .v,.hrow .n{font:11px/1 ui-monospace,Menlo,monospace}.hrow .n{color:var(--dim)}
table{width:100%;border-collapse:collapse;margin-top:8px}
td{padding:10px 10px 10px 0;border-bottom:1px solid var(--rule);vertical-align:middle}
.rk{width:38px;font:11px/1 ui-monospace,Menlo,monospace;color:var(--dim);text-align:right;padding-right:14px}
img{width:46px;height:46px;object-fit:cover;display:block;background:#f0f0f0}
.al{font-size:14px}.by{color:var(--dim);font-size:12.5px}
.note{color:var(--dim);font-size:12px;font-style:italic;margin-top:3px;max-width:46ch}
.num{font:12px/1 ui-monospace,Menlo,monospace;color:var(--dim);text-align:right;white-space:nowrap}
a{color:var(--blue)}a:visited{color:var(--purple)}`;

function dashboardHTML(){
  const rows=ratedRows(), n=rows.length;
  const avg=n?rows.reduce((s,[r])=>s+r.rating,0)/n:0;
  const dist={}; rows.forEach(([r])=>dist[r.rating]=(dist[r.rating]||0)+1);
  const mx=Math.max(1,...Object.values(dist));
  const hist=[5,4.5,4,3.5,3,2.5,2,1.5,1,.5].filter(v=>dist[v]).map(v=>
    `<div class="hrow"><span class="v">${starStr(v)}&nbsp;${v.toFixed(1)}</span>
     <i style="width:${(100*dist[v]/mx).toFixed(1)}%"></i><span class="n">${dist[v]}</span></div>`).join("");
  const body=rows.map(([rec,a],k)=>
    `<tr><td class="rk">${k+1}</td><td style="width:56px">${a.art?`<img loading="lazy" src="${esc(a.art)}">`:""}</td>
     <td><div class="al"><a href="${esc(a.rym||a.rym_search)}" target="_blank" rel="noopener">${esc(a.album)}</a></div>
     <div class="by">${esc(a.artist)}</div>${rec.note?`<div class="note">${esc(rec.note)}</div>`:""}</td>
     <td style="white-space:nowrap;width:96px">${starStr(rec.rating)} <span class="num">${rec.rating.toFixed(1)}</span></td>
     <td class="num" style="width:70px">${a.plays.toLocaleString()}<br>${Math.round(a.spins)}</td></tr>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>rate-my-library</title><style>${DOC_CSS}</style>
<div class="wrap"><div style="display:flex;justify-content:space-between"><span class="lbl">rate-my-library.</span>
<span class="lbl">${new Date().toLocaleDateString()}</span></div><hr>
<h1>ratings.</h1><div class="sub">${n} albums rated from your listening history</div><hr class="thin">
<div class="stats"><div class="stat"><b>${n}</b><span class="lbl">rated</span></div>
<div class="stat"><b>${avg.toFixed(2)}</b><span class="lbl">mean</span></div>
<div class="stat"><b>${rows.reduce((s,[,a])=>s+a.plays,0).toLocaleString()}</b><span class="lbl">plays covered</span></div>
<div class="stat"><b>${rows.filter(([r])=>r.note).length}</b><span class="lbl">with notes</span></div></div>
<hr class="thin"><div style="padding:22px 0">${hist}</div><hr><table>${body}</table></div>`;
}

function rymQueueHTML(){
  const rows=ratedRows(), direct=rows.filter(([,a])=>a.rym).length;
  const items=rows.map(([rec,a],k)=>
    `<div class="row" data-id="${a.id}" data-url="${esc(a.rym||a.rym_search)}">
     <span class="ck">[ ]</span><span class="rk">${k+1}</span>
     <span class="al"><a href="${esc(a.rym||a.rym_search)}" target="_blank" rel="noopener">${esc(a.album)}</a>
     <span class="by"> &middot; ${esc(a.artist)}</span></span>
     <span style="white-space:nowrap">${starStr(rec.rating)} <span class="num">${rec.rating.toFixed(1)}</span></span>
     <span class="num">${a.rym?"direct":"search"}</span></div>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>rate-my-library / rym</title><style>${DOC_CSS}
.row{display:grid;grid-template-columns:30px 34px 1fr 104px 54px;gap:12px;align-items:baseline;
padding:7px 6px;border-bottom:1px solid var(--rule)}
.row:hover{background:#f6f6f6}.row.cur{background:#eef;outline:1px solid var(--blue)}
.row.done{opacity:.4}.ck{cursor:pointer;font:12px ui-monospace,Menlo,monospace;color:var(--dim)}
.row.done .ck{color:var(--blue)}button{font:inherit;background:none;border:0;color:var(--blue);
cursor:pointer;text-decoration:underline;padding:0}</style>
<div class="wrap"><div style="display:flex;justify-content:space-between"><span class="lbl">rate-my-library.</span>
<span class="lbl">transfer queue.</span></div><hr>
<h1>rateyourmusic.</h1><div class="sub"><b>direct</b> opens the album page. <b>search</b> opens a
prefilled RYM search. Ticks are saved in this browser. ${direct} of ${rows.length} are direct.</div>
<div style="position:sticky;top:0;background:#fff;padding:13px 0;border-bottom:1px solid var(--fg);display:flex;gap:20px">
<button id="next">Open next unticked &rarr;</button><span class="lbl"><b id="nd">0</b> / ${rows.length} entered</span></div>
${items}
<div style="margin-top:34px;padding-top:12px;border-top:1px solid var(--rule);color:var(--dim)">
Enter opens the next in a background tab, Space ticks and advances, J and K move.<br><br>
RYM has no public API and blocks scripted rating, so the last click is yours.</div></div>
<script>
const K="rml.rym.entered";let done=new Set(JSON.parse(localStorage.getItem(K)||"[]")),cur=0;
const rows=[...document.querySelectorAll(".row")];
const save=()=>{try{localStorage.setItem(K,JSON.stringify([...done]))}catch(e){}};
function paint(){rows.forEach((r,n)=>{const d=done.has(r.dataset.id);
 r.classList.toggle("done",d);r.classList.toggle("cur",n===cur);
 r.querySelector(".ck").textContent=d?"[x]":"[ ]";});
 document.getElementById("nd").textContent=done.size;}
const un=f=>{for(let n=f;n<rows.length;n++)if(!done.has(rows[n].dataset.id))return n;return -1;};
function open_(){const n=un(cur);if(n<0)return alert("All entered.");cur=n;paint();
 rows[n].scrollIntoView({block:"center",behavior:"smooth"});window.open(rows[n].dataset.url,"_blank","noopener");}
rows.forEach((r,n)=>{r.querySelector(".ck").onclick=e=>{e.stopPropagation();
 const id=r.dataset.id;done.has(id)?done.delete(id):done.add(id);save();paint();};
 r.onclick=()=>{cur=n;paint();};});
document.getElementById("next").onclick=open_;
addEventListener("keydown",e=>{const k=e.key.toLowerCase();
 if(e.key==="Enter"){e.preventDefault();open_();}
 else if(e.key===" "){e.preventDefault();done.add(rows[cur].dataset.id);save();
  const n=un(cur);if(n>=0)cur=n;paint();rows[cur].scrollIntoView({block:"center",behavior:"smooth"});}
 else if(k==="j"){cur=Math.min(rows.length-1,cur+1);paint();rows[cur].scrollIntoView({block:"center"});}
 else if(k==="k"){cur=Math.max(0,cur-1);paint();rows[cur].scrollIntoView({block:"center"});}});
paint();
<\/script>`;
}

/* ── mobile drawer ──────────────────────────────────────────────────── */
function toggleDrawer(force){
  const on=force===undefined?!$(".colL").classList.contains("on"):force;
  $(".colL").classList.toggle("on",on);
  $("#scrim").classList.toggle("on",on);
}
