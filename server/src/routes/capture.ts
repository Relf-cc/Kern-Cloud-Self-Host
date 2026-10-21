// Capture from anywhere: a tiny page for a phone's home screen
// (<STREAMS_URL>/kern/<stream>/capture#k=<secret>) that sends notes to
// a stream, which puts them in the Inbox. The secret travels in the URL
// fragment, which browsers never send to servers; the page keeps it in the
// phone's storage and removes it from the address bar. Notes typed while
// offline wait on the phone and are sent when it's back online, each with an
// idempotency key so a retry never makes a duplicate.

import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { one } from "../db.js";
import { escapeHtml } from "../mail.js";

export const capture = new Hono();

const PATH = "/kern/:id{[0-9a-f]{64}}/capture";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#18181b"/><path d="M168 136v240M168 256l152-120M200 232l128 144" stroke="#fafafa" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

async function exists(id: string) {
  return one<{ name: string }>("SELECT st.name FROM kern_stream st JOIN kern_space sp ON sp.id = st.space_id WHERE st.id = $1 AND sp.deleted_at IS NULL", [id]);
}

capture.get(`${PATH}/icon.svg`, (c) => {
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(ICON);
});

capture.get(`${PATH}/manifest.webmanifest`, async (c) => {
  const s = await exists(c.req.param("id"));
  if (!s) return c.json({ code: "not_found" }, 404);
  c.header("Content-Type", "application/manifest+json");
  return c.body(
    JSON.stringify({
      name: `Kern · ${s.name}`,
      short_name: "Kern",
      start_url: "./capture",
      scope: "./",
      display: "standalone",
      background_color: "#111111",
      theme_color: "#111111",
      icons: [{ src: "./capture/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
    }),
  );
});

capture.get(PATH, async (c) => {
  const id = c.req.param("id");
  const s = await exists(id);
  if (!s) return c.text("There's no capture page at this address.", 404);
  const nonce = randomBytes(16).toString("base64");
  c.header("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; manifest-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#111111">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Kern">
<link rel="manifest" href="./capture/manifest.webmanifest"><link rel="apple-touch-icon" href="./capture/icon.svg"><link rel="icon" href="./capture/icon.svg">
<title>Kern · ${escapeHtml(s.name)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f5;--card:#fff;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--btn:#18181b;--btn-text:#fff;--ok:#16a34a;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#111;--card:#1a1a1a;--text:#f4f4f5;--muted:#a1a1aa;--line:#2a2a2a;--btn:#f4f4f5;--btn-text:#111}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:max(20px,env(safe-area-inset-top)) 16px 32px}
h1{font-size:17px;margin:4px 0 14px;display:flex;align-items:center;gap:10px}h1 img{width:28px;height:28px;border-radius:7px}
textarea{width:100%;min-height:150px;font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;resize:vertical;outline:none}
textarea:focus{border-color:var(--muted)}
.row{display:flex;gap:10px;align-items:center;margin-top:12px}
button{appearance:none;border:0;border-radius:12px;padding:13px 20px;font:600 16px/1 inherit;background:var(--btn);color:var(--btn-text);flex:1}
button:disabled{opacity:.5}.status{font-size:14px;color:var(--muted);min-height:21px;margin-top:10px}
.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}
ul{list-style:none;padding:0;margin:22px 0 0}li{padding:10px 0;border-top:1px solid var(--line);font-size:14px;color:var(--muted);display:flex;gap:8px}
li span:first-child{flex:1;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.note{font-size:13px;color:var(--muted);margin-top:26px}
</style></head><body><main>
<h1><img src="./capture/icon.svg" alt="">${escapeHtml(s.name)}</h1>
<div id="setup" hidden><p>This page needs its private link. In Kern, open <b>Settings → Account &amp; Cloud → Capture from anywhere</b> and scan the code or open the link on this phone.</p></div>
<div id="app" hidden>
<textarea id="text" placeholder="Write a note, task or idea… The first line becomes its title." autofocus></textarea>
<div class="row"><button id="send" type="button">Send to Inbox</button></div>
<div id="status" class="status" role="status" aria-live="polite"></div>
<ul id="recent" aria-label="Recently sent"></ul>
<p class="note">Add this page to your home screen to capture in one tap. Notes typed offline are sent when you're back online.</p>
</div>
<script nonce="${nonce}">
(function(){
  var ID=${JSON.stringify(id)}, KEY="kern-capture:"+ID, QUEUE=KEY+":queue", RECENT=KEY+":recent";
  function get(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
  function put(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
  var m=/[#&]k=([A-Za-z0-9_-]+)/.exec(location.hash);
  if(m){put(KEY,m[1]);history.replaceState(null,"",location.pathname)}
  var secret=get(KEY,null);
  var $=function(i){return document.getElementById(i)};
  if(!secret){$("setup").hidden=false;return}
  $("app").hidden=false;
  var text=$("text"),send=$("send"),status=$("status");
  function say(msg,cls){status.textContent=msg;status.className="status"+(cls?" "+cls:"")}
  function uid(){var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}
  function showRecent(){var r=get(RECENT,[]),q=get(QUEUE,[]),ul=$("recent");ul.textContent="";
    q.concat(r).slice(0,8).forEach(function(it){var li=document.createElement("li"),a=document.createElement("span"),b=document.createElement("span");
      a.textContent=it.title;b.textContent=it.sent?new Date(it.sent).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):"waiting";li.appendChild(a);li.appendChild(b);ul.appendChild(li)})}
  function post(it){return fetch("/kern/"+ID,{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+secret,"idempotency-key":it.key},body:JSON.stringify({title:it.title,details:it.details})})
    .then(function(res){return res.json().catch(function(){return{}}).then(function(j){return{ok:res.ok,status:res.status,body:j}})})}
  var flushing=false;
  function flush(){if(flushing)return Promise.resolve();var q=get(QUEUE,[]);if(!q.length)return Promise.resolve();flushing=true;
    var it=q[0];return post(it).then(function(r){
      if(r.ok){q.shift();put(QUEUE,q);var rec=get(RECENT,[]);it.sent=Date.now();rec.unshift({title:it.title,sent:it.sent});put(RECENT,rec.slice(0,20));showRecent();say("Sent to your Inbox.","ok");flushing=false;return flush()}
      flushing=false;
      if(r.status===401){say("This link no longer works. Open the new one from Kern.","bad")}
      else if(r.status===422||r.status===400){q.shift();put(QUEUE,q);showRecent();say((r.body&&r.body.message)||"That note couldn't be sent.","bad")}
      else{say("Couldn't send yet - it'll be sent automatically.","bad")}
    },function(){flushing=false;say("You're offline - the note will be sent when you're back online.")})}
  send.addEventListener("click",function(){var v=text.value.trim();if(!v)return text.focus();
    var lines=v.split(/\\r?\\n/),title=lines.shift().trim().slice(0,300),details=lines.join("\\n").trim();
    var q=get(QUEUE,[]);q.push({key:uid(),title:title,details:details});put(QUEUE,q);text.value="";showRecent();say("Sending…");flush();text.focus()});
  text.addEventListener("keydown",function(e){if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();send.click()}});
  window.addEventListener("online",flush);document.addEventListener("visibilitychange",function(){if(!document.hidden)flush()});
  showRecent();flush();
})();
</script></main></body></html>`);
});
