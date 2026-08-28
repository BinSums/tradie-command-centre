/* Command Centre Core
 *
 * One private dashboard for a small business. Routines POST what they found;
 * this serves it back as cards, tiles, notes and a shared to-do list.
 *
 *   /              Home     - what needs doing, the numbers, the list
 *   /?t=reports    Reports  - every routine run, append-only, oldest kept forever
 *   /?t=<slug>     any page a routine published into the `pages` table
 *
 * Nothing in this file knows what the business sells. The name on the door comes
 * from BUSINESS_NAME in wrangler.toml. Deploy it to your own Cloudflare account
 * and the data stays in your own D1.
 *
 * Ingest (bearer INGEST_SECRET):
 *   POST /ingest           a run card
 *   POST /ingest-metrics   daily numbers
 *   POST /ingest-notes     dated recommendations
 *   POST /ingest-page      a full HTML page as a tab
 *   POST /ingest-import    a raw CSV drop
 *   POST /ingest-kb        business context for the assistant
 */

const enc = new TextEncoder();

/* ---------- crypto + session ---------- */

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}
// Constant-time compare. A plain === leaks the position of the first wrong byte
// through timing, which is enough to walk a token one character at a time.
function timingEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function getCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
async function makeSession(env) {
  const p = b64url(enc.encode(JSON.stringify({ exp: Date.now() + 30 * 24 * 3600 * 1000 })));
  return p + "." + (await hmac(env.COOKIE_SECRET, p));
}
async function validSession(env, cookie) {
  if (!cookie) return false;
  const [p, sig] = cookie.split(".");
  if (!p || !sig) return false;
  if (!timingEq(sig, await hmac(env.COOKIE_SECRET, p))) return false;
  try { return Date.now() < JSON.parse(b64urlDecode(p)).exp; } catch { return false; }
}
function bearerOk(req, env) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return !!env.INGEST_SECRET && timingEq(token, env.INGEST_SECRET);
}

/* ---------- small helpers ---------- */

const J = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json;charset=utf-8" } });
const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cfg = (env) => ({
  name: env.BUSINESS_NAME || "Command Centre",
  tz: env.TIMEZONE || "Australia/Sydney",
  cur: env.CURRENCY || "AUD",
});
// Today in the business's own timezone, not UTC. A dashboard that rolls over at
// 10am local because the server thinks in UTC is worse than no dashboard.
function localDate(env, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: cfg(env).tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

/* ---------- ingest ---------- */

async function ingestRun(req, env) {
  const b = await readJson(req);
  if (!b || !b.skill_id || !b.title) return J({ error: "skill_id and title are required" }, 400);
  // A run_at in the future is always a mistake (a bad clock, or a routine stamping
  // when it INTENDED to run). Clamp it, so the card never claims a time that has
  // not happened. Anything else is accepted as given, including backdating.
  let runAt = b.run_at ? new Date(b.run_at) : new Date();
  if (isNaN(runAt) || runAt.getTime() > Date.now() + 5 * 60 * 1000) runAt = new Date();
  await env.DB.prepare(
    "INSERT INTO runs (skill_id,title,status,summary_html,detail_html,payload,link,run_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(
    b.skill_id, b.title, ["ok", "warn", "alert", "info"].includes(b.status) ? b.status : "ok",
    b.summary_html || null, b.detail_html || null,
    b.payload ? JSON.stringify(b.payload) : null,
    /^https?:\/\//i.test(b.link || "") ? b.link : null,
    runAt.toISOString()
  ).run();
  return J({ ok: true });
}

async function ingestMetrics(req, env) {
  const b = await readJson(req);
  const rows = Array.isArray(b) ? b : b && Array.isArray(b.metrics) ? b.metrics : null;
  if (!rows) return J({ error: "expected an array of {date,key,value}" }, 400);
  const stmt = env.DB.prepare(
    "INSERT INTO metrics (date,key,value) VALUES (?,?,?) ON CONFLICT(date,key) DO UPDATE SET value=excluded.value"
  );
  const batch = [];
  for (const r of rows) {
    if (!r || !r.date || !r.key) continue;
    // Only a real number is a value. Anything else is "no data", which is a
    // different thing from zero and must not be charted as zero.
    const v = typeof r.value === "number" && isFinite(r.value) ? r.value : null;
    batch.push(stmt.bind(r.date, r.key, v));
  }
  if (batch.length) await env.DB.batch(batch);
  return J({ ok: true, written: batch.length });
}

async function ingestNotes(req, env) {
  const b = await readJson(req);
  if (!b || !Array.isArray(b.notes)) return J({ error: "expected {date, notes:[...]}" }, 400);
  const date = b.date || localDate(env);
  const areas = [...new Set(b.notes.map((n) => n && n.area).filter(Boolean))];
  const batch = [];
  // Replace wholesale per (date, area) so re-running a routine corrects its own
  // advice instead of stacking a second copy underneath the first.
  for (const a of areas) batch.push(env.DB.prepare("DELETE FROM notes WHERE date=? AND area=?").bind(date, a));
  const ins = env.DB.prepare("INSERT INTO notes (date,area,severity,title,body,metric) VALUES (?,?,?,?,?,?)");
  for (const n of b.notes) {
    if (!n || !n.area || !n.title) continue;
    batch.push(ins.bind(date, n.area, ["do-now", "watch", "good"].includes(n.severity) ? n.severity : "watch",
      n.title, n.body || null, n.metric || null));
  }
  if (batch.length) await env.DB.batch(batch);
  return J({ ok: true, date, areas });
}

async function ingestPage(req, env) {
  const b = await readJson(req);
  if (!b || !b.slug || !b.html) return J({ error: "slug and html are required" }, 400);
  if (!/^[a-z0-9-]{1,40}$/.test(b.slug)) return J({ error: "slug must be lowercase letters, digits and hyphens" }, 400);
  await env.DB.prepare(
    "INSERT INTO pages (slug,title,html,nav,sort,updated_at) VALUES (?,?,?,?,?,?) " +
    "ON CONFLICT(slug) DO UPDATE SET title=excluded.title, html=excluded.html, nav=excluded.nav, sort=excluded.sort, updated_at=excluded.updated_at"
  ).bind(b.slug, b.title || b.slug, b.html, b.nav === false ? 0 : 1, b.sort ?? 100, new Date().toISOString()).run();
  return J({ ok: true });
}

async function ingestImport(req, env) {
  const b = await readJson(req);
  if (!b || !b.source || !b.csv) return J({ error: "source and csv are required" }, 400);
  const rows = b.csv.split("\n").filter((l) => l.trim()).length - 1;
  await env.DB.prepare("INSERT INTO imports (source,filename,rows,csv,period) VALUES (?,?,?,?,?)")
    .bind(b.source, b.filename || null, rows > 0 ? rows : 0, b.csv, b.period || null).run();
  return J({ ok: true, rows });
}

async function ingestKb(req, env) {
  const b = await readJson(req);
  if (!b || !b.slug || !b.body) return J({ error: "slug and body are required" }, 400);
  await env.DB.prepare(
    "INSERT INTO kb (slug,title,body,updated) VALUES (?,?,?,datetime('now')) " +
    "ON CONFLICT(slug) DO UPDATE SET title=excluded.title, body=excluded.body, updated=datetime('now')"
  ).bind(b.slug, b.title || b.slug, b.body).run();
  return J({ ok: true });
}

/* ---------- read APIs (session-gated) ---------- */

async function apiRuns(url, env) {
  const days = Math.min(parseInt(url.searchParams.get("days") || "14", 10) || 14, 400);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id,skill_id,title,status,summary_html,link,run_at FROM runs WHERE run_at>=? ORDER BY run_at DESC, id DESC LIMIT 400"
  ).bind(since).all();
  return J(results || []);
}

async function apiRunDetail(id, env) {
  const row = await env.DB.prepare("SELECT id,skill_id,title,status,detail_html,summary_html,run_at FROM runs WHERE id=?").bind(id).first();
  return row ? J(row) : J({ error: "not found" }, 404);
}

async function apiMetrics(url, env) {
  const days = Math.min(parseInt(url.searchParams.get("days") || "60", 10) || 60, 800);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const [series, meta] = await Promise.all([
    env.DB.prepare("SELECT date,key,value FROM metrics WHERE date>=? ORDER BY date").bind(since).all(),
    env.DB.prepare("SELECT key,label,unit,better,sort,tile FROM metric_meta ORDER BY sort, key").all(),
  ]);
  return J({ series: series.results || [], meta: meta.results || [] });
}

async function apiNotes(url, env) {
  const date = url.searchParams.get("date") || null;
  // Default to the most recent day that actually has notes, not to today. A routine
  // that ran at 6am yesterday and nothing since should still show its advice rather
  // than an empty panel that reads as "all clear".
  const d = date || (await env.DB.prepare("SELECT MAX(date) AS d FROM notes").first())?.d;
  if (!d) return J({ date: null, notes: [] });
  const { results } = await env.DB.prepare(
    "SELECT id,area,severity,title,body,metric FROM notes WHERE date=? ORDER BY CASE severity WHEN 'do-now' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, area"
  ).bind(d).all();
  return J({ date: d, notes: results || [] });
}

async function apiTodos(url, env) {
  const all = url.searchParams.get("all") === "1";
  const { results } = await env.DB.prepare(
    all
      ? "SELECT id,title,detail,source,priority,due,added,done FROM todos ORDER BY done IS NOT NULL, priority, due IS NULL, due, id DESC LIMIT 300"
      : "SELECT id,title,detail,source,priority,due,added,done FROM todos WHERE done IS NULL ORDER BY priority, due IS NULL, due, id DESC LIMIT 300"
  ).all();
  return J(results || []);
}

async function apiTodoWrite(req, env) {
  const b = await readJson(req);
  if (!b) return J({ error: "bad json" }, 400);
  if (b.id && b.action === "status") {
    // `done` is a timestamp or NULL. There is no boolean column: read the NULLness.
    await env.DB.prepare("UPDATE todos SET done=? WHERE id=?").bind(b.done ? new Date().toISOString() : null, b.id).run();
    return J({ ok: true });
  }
  if (!b.title) return J({ error: "title is required" }, 400);
  // Dedupe on the exact open title. Routines re-add the same job every run; without
  // this the list grows a duplicate a day and stops being read at all.
  const dupe = await env.DB.prepare("SELECT id FROM todos WHERE title=? AND done IS NULL").bind(b.title).first();
  if (dupe) return J({ ok: true, id: dupe.id, deduped: true });
  const r = await env.DB.prepare("INSERT INTO todos (title,detail,source,priority,due) VALUES (?,?,?,?,?)")
    .bind(b.title, b.detail || null, b.source || "routine", b.priority || 2, b.due || null).run();
  return J({ ok: true, id: r.meta?.last_row_id });
}

async function apiQueue(req, env, url) {
  if (req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id,kind,body,added FROM assistant_queue WHERE done IS NULL ORDER BY id"
    ).all();
    return J(results || []);
  }
  const b = await readJson(req);
  if (!b) return J({ error: "bad json" }, 400);
  if (url.pathname.endsWith("/done")) {
    if (!b.id) return J({ error: "id is required" }, 400);
    await env.DB.prepare("UPDATE assistant_queue SET done=datetime('now') WHERE id=?").bind(b.id).run();
    return J({ ok: true });
  }
  if (!b.body) return J({ error: "body is required" }, 400);
  const r = await env.DB.prepare("INSERT INTO assistant_queue (kind,body) VALUES (?,?)")
    .bind(b.kind === "task" ? "task" : "note", b.body).run();
  return J({ ok: true, id: r.meta?.last_row_id });
}

async function apiImports(url, env) {
  const source = url.searchParams.get("source");
  const latest = url.searchParams.get("latest") === "1";
  if (source && latest) {
    const row = await env.DB.prepare("SELECT id,source,filename,rows,csv,period,added FROM imports WHERE source=? ORDER BY id DESC LIMIT 1").bind(source).first();
    return row ? J(row) : J({ error: "no import for that source" }, 404);
  }
  const { results } = await env.DB.prepare(
    "SELECT id,source,filename,rows,period,added FROM imports ORDER BY id DESC LIMIT 100"
  ).all();
  return J(results || []);
}

async function apiKb(env) {
  const { results } = await env.DB.prepare("SELECT slug,title,body,updated FROM kb ORDER BY slug").all();
  return J(results || []);
}

/* ---------- pages ---------- */

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f6f6f3;--card:#fff;--ink:#14140f;--dim:#6f6e66;--line:#e3e2da;--accent:#1f6f43;
--ok:#1f6f43;--warn:#a8730c;--alert:#b3261e;--info:#5b5a53;--radius:14px}
@media (prefers-color-scheme:dark){:root{--bg:#121210;--card:#1b1b18;--ink:#f2f1ea;--dim:#9c9a90;
--line:#2c2c27;--accent:#4bb079;--ok:#4bb079;--warn:#d59b2a;--alert:#e2685c;--info:#8b8a82}}
body{background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
-webkit-font-smoothing:antialiased;padding-bottom:env(safe-area-inset-bottom)}
a{color:inherit}
header{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line);
padding:14px 18px calc(14px + env(safe-area-inset-top)) 18px}
.brand{font-weight:650;letter-spacing:-.02em;font-size:17px}
.sub{color:var(--dim);font-size:12.5px;margin-top:1px}
nav{display:flex;gap:4px;overflow-x:auto;padding:10px 14px 0;scrollbar-width:none;-webkit-overflow-scrolling:touch}
nav::-webkit-scrollbar{display:none}
nav a{flex:0 0 auto;padding:7px 13px;border-radius:99px;font-size:13.5px;color:var(--dim);text-decoration:none;white-space:nowrap}
nav a.on{background:var(--ink);color:var(--bg);font-weight:550}
main{max-width:1080px;margin:0 auto;padding:18px 14px 60px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);font-weight:650;margin:26px 0 10px}
h2:first-child{margin-top:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:15px 17px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:10px}
.tile .k{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.tile .v{font-size:25px;font-weight:640;letter-spacing:-.03em;margin-top:5px;font-variant-numeric:tabular-nums}
.tile .d{font-size:12px;margin-top:3px;color:var(--dim)}
.up{color:var(--ok)}.down{color:var(--alert)}
.note{border-left:3px solid var(--line);padding:11px 15px;background:var(--card);border-radius:0 var(--radius) var(--radius) 0;
border-top:1px solid var(--line);border-right:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:9px}
.note.do-now{border-left-color:var(--alert)}.note.watch{border-left-color:var(--warn)}.note.good{border-left-color:var(--ok)}
.note .t{font-weight:600}
.note .b{color:var(--dim);font-size:13.5px;margin-top:3px}
.note .m{font-size:12px;color:var(--dim);margin-top:5px;font-variant-numeric:tabular-nums}
.chip{display:inline-block;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin-bottom:4px}
ul.todo{list-style:none}
ul.todo li{display:flex;gap:11px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--line)}
ul.todo li:last-child{border-bottom:0}
ul.todo input{margin-top:3px;width:17px;height:17px;accent-color:var(--accent);flex:0 0 auto}
ul.todo .x{opacity:.4;text-decoration:line-through}
.p1{color:var(--alert);font-weight:640}
.runs{display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:11px}
.run{cursor:pointer;transition:transform .08s ease}
.run:active{transform:scale(.99)}
.run .top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.run .ti{font-weight:600;font-size:14.5px}
.run .when{font-size:11.5px;color:var(--dim);white-space:nowrap}
.dot{display:inline-block;width:7px;height:7px;border-radius:99px;margin-right:6px;vertical-align:middle}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.alert{background:var(--alert)}.dot.info{background:var(--info)}
.run .sum{color:var(--dim);font-size:13px;margin-top:7px}
.run .sum ul{margin:5px 0 0 16px}
.empty{color:var(--dim);text-align:center;padding:34px 18px;font-size:14px}
/* margin:auto is what centres a native modal dialog, and the universal margin:0
   reset above strips it. Without this the modal sits flush in the top-left corner. */
dialog{border:0;padding:0;background:transparent;max-width:min(940px,94vw);width:100%;margin:auto}
dialog::backdrop{background:rgba(0,0,0,.55)}
.modal{background:var(--card);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column;max-height:88vh}
.modal .h{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 17px;border-bottom:1px solid var(--line)}
.modal iframe{border:0;width:100%;height:74vh;background:#fff}
button.x{background:var(--line);border:0;color:var(--ink);border-radius:99px;width:29px;height:29px;font-size:17px;cursor:pointer;flex:0 0 auto}
form.login{max-width:330px;margin:16vh auto;padding:0 20px}
form.login input{width:100%;padding:13px 15px;border:1px solid var(--line);border-radius:11px;background:var(--card);color:var(--ink);font-size:16px}
form.login button{width:100%;margin-top:10px;padding:13px;border:0;border-radius:11px;background:var(--ink);color:var(--bg);font-size:15px;font-weight:600;cursor:pointer}
.err{color:var(--alert);font-size:13.5px;margin-top:10px;text-align:center}
/* White, not var(--card). A routine authors these pages as plain light HTML with
   no colours of its own, so a dark frame renders black text on a dark ground.
   Matching the modal keeps every published page legible in both themes. */
iframe.page{border:0;width:100%;height:calc(100vh - 190px);background:#fff;border-radius:var(--radius);border:1px solid var(--line)}
`;

function loginPage(env, error) {
  const c = cfg(env);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.name)}</title><style>${CSS}</style></head><body>
<form class="login" method="POST" action="/login">
<div class="brand" style="text-align:center;margin-bottom:16px">${esc(c.name)}</div>
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<button type="submit">Sign in</button>
${error ? `<div class="err">${esc(error)}</div>` : ""}
</form></body></html>`,
    { status: error ? 401 : 200, headers: { "content-type": "text/html;charset=utf-8" } }
  );
}

async function shell(env, url) {
  const c = cfg(env);
  const { results: pages } = await env.DB.prepare("SELECT slug,title FROM pages WHERE nav=1 ORDER BY sort, title").all();
  const tab = url.searchParams.get("t") || "home";
  const tabs = [{ slug: "home", title: "Home" }, ...(pages || []), { slug: "reports", title: "Reports" }];
  const nav = tabs.map((t) =>
    `<a href="/?t=${esc(t.slug)}" class="${t.slug === tab ? "on" : ""}">${esc(t.title)}</a>`).join("");
  const known = tabs.some((t) => t.slug === tab);

  let body;
  if (tab === "home") {
    body = `<div id="notes"></div><div id="tiles"></div><div id="todos"></div>`;
  } else if (tab === "reports") {
    body = `<h2>Every run</h2><div class="runs" id="runs"></div>`;
  } else if (known) {
    // Published pages render in a sandboxed frame with no allow-scripts: a routine
    // writes that HTML, and it should never be able to reach the session cookie.
    body = `<iframe class="page" sandbox id="pageframe" data-slug="${esc(tab)}"></iframe>`;
  } else {
    body = `<div class="empty">No tab called "${esc(tab)}".</div>`;
  }

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f6f6f3" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#121210" media="(prefers-color-scheme:dark)">
<link rel="manifest" href="/manifest.webmanifest"><title>${esc(c.name)}</title>
<style>${CSS}</style></head><body>
<header><div class="brand">${esc(c.name)}</div><div class="sub" id="stamp">&nbsp;</div>
<nav>${nav}</nav></header>
<main>${body}</main>
<dialog id="dlg"><div class="modal"><div class="h"><b id="dt"></b><button class="x" onclick="dlg.close()">&times;</button></div>
<iframe id="df" sandbox></iframe></div></dialog>
<script>
const TAB = ${JSON.stringify(tab)}, CUR = ${JSON.stringify(c.cur)}, TZ = ${JSON.stringify(c.tz)};
const money = n => new Intl.NumberFormat('en-AU',{style:'currency',currency:CUR,maximumFractionDigits:0}).format(n);
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const get = p => fetch(p,{credentials:'same-origin'}).then(r=>r.ok?r.json():null).catch(()=>null);

function fmt(v,unit){
  if(v==null) return '--';
  if(unit==='money') return money(v);
  if(unit==='percent') return v.toFixed(1)+'%';
  if(unit==='hours') return v.toFixed(1)+'h';
  if(unit==='days') return Math.round(v)+'d';
  return new Intl.NumberFormat('en-AU').format(Math.round(v*100)/100);
}
function when(iso){
  const d = new Date(iso), now = new Date();
  const day = new Intl.DateTimeFormat('en-AU',{timeZone:TZ,day:'numeric',month:'short'}).format(d);
  const time = new Intl.DateTimeFormat('en-AU',{timeZone:TZ,hour:'numeric',minute:'2-digit'}).format(d);
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(now);
  return new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(d)===today ? time : day+' '+time;
}

async function home(){
  const [nd, md, todos] = await Promise.all([get('/api/notes'), get('/api/metrics?days=60'), get('/api/todos')]);

  const n = document.getElementById('notes');
  if(nd && nd.notes && nd.notes.length){
    n.innerHTML = '<h2>Worth your attention</h2>' + nd.notes.map(x =>
      '<div class="note '+esc(x.severity)+'"><div class="chip">'+esc(x.area)+'</div>'+
      '<div class="t">'+esc(x.title)+'</div>'+
      (x.body?'<div class="b">'+esc(x.body)+'</div>':'')+
      (x.metric?'<div class="m">'+esc(x.metric)+'</div>':'')+'</div>').join('');
    document.getElementById('stamp').textContent = 'Advice from '+nd.date;
  } else {
    n.innerHTML = '<h2>Worth your attention</h2><div class="card empty">Nothing flagged yet. Once a routine runs, what it found shows up here.</div>';
  }

  const t = document.getElementById('tiles');
  if(md && md.meta && md.meta.length){
    // Latest value per key, plus the value 7 days before it, so a tile can show
    // movement rather than a number with no sense of direction.
    const by = {};
    for(const r of md.series){ (by[r.key] = by[r.key] || []).push(r); }
    const tiles = md.meta.filter(m=>m.tile).map(m=>{
      const s = (by[m.key]||[]).filter(r=>r.value!=null);
      if(!s.length) return '';
      const last = s[s.length-1];
      const prevDate = new Date(new Date(last.date).getTime()-7*86400000).toISOString().slice(0,10);
      const prev = s.filter(r=>r.date<=prevDate).pop();
      let delta = '';
      if(prev && prev.value){
        const pc = (last.value-prev.value)/Math.abs(prev.value)*100;
        const good = m.better==='down' ? pc<0 : pc>0;
        if(Math.abs(pc)>=0.5) delta = '<div class="d '+(m.better==='flat'?'':(good?'up':'down'))+'">'+
          (pc>0?'+':'')+pc.toFixed(0)+'% vs 7d ago</div>';
      }
      return '<div class="card tile"><div class="k">'+esc(m.label)+'</div>'+
        '<div class="v">'+fmt(last.value,m.unit)+'</div>'+delta+'</div>';
    }).filter(Boolean);
    t.innerHTML = tiles.length ? '<h2>The numbers</h2><div class="tiles">'+tiles.join('')+'</div>' : '';
  }

  const box = document.getElementById('todos');
  const open = (todos||[]).filter(x=>!x.done);
  box.innerHTML = '<h2>To do'+(open.length?' ('+open.length+')':'')+'</h2>' + (open.length
    ? '<div class="card"><ul class="todo">'+open.map(x=>
        '<li><input type="checkbox" data-id="'+x.id+'"><div><div class="'+(x.priority===1?'p1':'')+'">'+esc(x.title)+'</div>'+
        (x.detail?'<div class="b" style="color:var(--dim);font-size:13px">'+esc(x.detail)+'</div>':'')+
        (x.due?'<div class="m" style="font-size:12px;color:var(--dim)">Due '+esc(x.due)+'</div>':'')+'</div></li>').join('')+'</ul></div>'
    : '<div class="card empty">Nothing on the list.</div>');
  box.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change',async()=>{
    cb.closest('li').classList.toggle('x', cb.checked);
    await fetch('/api/todo',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:+cb.dataset.id,action:'status',done:cb.checked})});
  }));
}

async function reports(){
  const rows = await get('/api/runs?days=30');
  const el = document.getElementById('runs');
  if(!rows || !rows.length){ el.outerHTML = '<div class="card empty">No runs yet.</div>'; return; }
  el.innerHTML = rows.map(r =>
    '<div class="card run" data-id="'+r.id+'" data-t="'+esc(r.title)+'">'+
    '<div class="top"><div class="ti"><span class="dot '+esc(r.status)+'"></span>'+esc(r.title)+'</div>'+
    '<div class="when">'+when(r.run_at)+'</div></div>'+
    (r.summary_html?'<div class="sum">'+r.summary_html+'</div>':'')+'</div>').join('');
  el.querySelectorAll('.run').forEach(c=>c.addEventListener('click',async()=>{
    document.getElementById('dt').textContent = c.dataset.t;
    const f = document.getElementById('df');
    // srcdoc, not src. A sandboxed iframe is a nested navigation, so a SameSite=Lax
    // session cookie is NOT sent with it and the frame would load the login page
    // instead of the report. Fetch it up here, where the cookie works, and hand the
    // HTML down. The sandbox (no allow-scripts, opaque origin) is unchanged.
    f.srcdoc = '<p style=\"font:14px system-ui;color:#888;padding:20px\">Loading...</p>';
    document.getElementById('dlg').showModal();
    const r = await fetch('/run/'+c.dataset.id,{credentials:'same-origin'});
    f.srcdoc = r.ok ? await r.text() : '<p style=\"font:14px system-ui;padding:20px\">Could not load this run.</p>';
  }));
}

async function publishedPage(){
  const f = document.getElementById('pageframe');
  if(!f) return;
  const r = await fetch('/p/'+f.dataset.slug,{credentials:'same-origin'});
  f.srcdoc = r.ok ? await r.text() : '<p style="font:14px system-ui;padding:20px">Could not load this page.</p>';
}
if(TAB==='home') home(); else if(TAB==='reports') reports(); else publishedPage();
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

/* ---------- router ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/healthz") return new Response("ok");

    if (p === "/manifest.webmanifest") {
      const c = cfg(env);
      return J({
        name: c.name, short_name: c.name.split(" ")[0], start_url: "/", display: "standalone",
        background_color: "#f6f6f3", theme_color: "#f6f6f3", icons: [],
      });
    }

    // Misconfiguration must fail loudly at the front door. Without these three the
    // dashboard would either be wide open or silently reject every routine, and both
    // look like "it just doesn't work" from the outside.
    for (const k of ["DASH_PASSWORD", "COOKIE_SECRET", "INGEST_SECRET"]) {
      if (!env[k]) {
        return new Response(
          `Setup incomplete: ${k} is not set.\n\nRun:  npx wrangler secret put ${k}\n`,
          { status: 503, headers: { "content-type": "text/plain;charset=utf-8" } }
        );
      }
    }

    /* --- ingest: bearer only, never the session cookie --- */
    const INGEST = {
      "/ingest": ingestRun, "/ingest-metrics": ingestMetrics, "/ingest-notes": ingestNotes,
      "/ingest-page": ingestPage, "/ingest-import": ingestImport, "/ingest-kb": ingestKb,
    };
    if (INGEST[p]) {
      if (request.method !== "POST") return J({ error: "POST only" }, 405);
      if (!bearerOk(request, env)) return J({ error: "bad token" }, 401);
      return INGEST[p](request, env);
    }
    // The queue and the to-do list are the two things a routine both reads and writes,
    // so they accept the bearer as well as a signed-in browser.
    if ((p === "/api/assistant-queue" || p === "/api/assistant-queue/done") && bearerOk(request, env))
      return apiQueue(request, env, url);
    if (p === "/api/todo" && request.method === "POST" && bearerOk(request, env)) return apiTodoWrite(request, env);
    if (p === "/api/todos" && request.method === "GET" && bearerOk(request, env)) return apiTodos(url, env);
    if (p === "/api/imports" && request.method === "GET" && bearerOk(request, env)) return apiImports(url, env);
    if (p === "/api/kb" && request.method === "GET" && bearerOk(request, env)) return apiKb(env);

    /* --- login --- */
    if (p === "/login") {
      if (request.method !== "POST") return loginPage(env);
      const form = await request.formData();
      if (!timingEq(String(form.get("password") || ""), env.DASH_PASSWORD)) {
        return loginPage(env, "Wrong password.");
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `cc_s=${await makeSession(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
        },
      });
    }
    if (p === "/logout") {
      return new Response(null, { status: 302, headers: { Location: "/login", "Set-Cookie": "cc_s=; Path=/; Max-Age=0" } });
    }

    /* --- everything below needs a session --- */
    if (!(await validSession(env, getCookie(request, "cc_s")))) {
      if (p.startsWith("/api/")) return J({ error: "not signed in" }, 401);
      return loginPage(env);
    }

    if (p === "/api/runs") return apiRuns(url, env);
    if (p === "/api/metrics") return apiMetrics(url, env);
    if (p === "/api/notes") return apiNotes(url, env);
    if (p === "/api/todos") return apiTodos(url, env);
    if (p === "/api/todo") return apiTodoWrite(request, env);
    if (p === "/api/assistant-queue" || p === "/api/assistant-queue/done") return apiQueue(request, env, url);
    if (p === "/api/imports") return apiImports(url, env);
    if (p === "/api/kb") return apiKb(env);

    const run = p.match(/^\/run\/(\d+)$/);
    if (run) {
      const row = await env.DB.prepare("SELECT detail_html,summary_html FROM runs WHERE id=?").bind(run[1]).first();
      if (!row) return new Response("Not found", { status: 404 });
      return new Response(row.detail_html || row.summary_html || "<p>No detail was recorded for this run.</p>", {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }

    const page = p.match(/^\/p\/([a-z0-9-]+)$/);
    if (page) {
      const row = await env.DB.prepare("SELECT html FROM pages WHERE slug=?").bind(page[1]).first();
      if (!row) return new Response("Not found", { status: 404 });
      return new Response(row.html, { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (p === "/") return shell(env, url);
    return new Response("Not found", { status: 404 });
  },
};
