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
  // Reserved: a published page using one of these would shadow a built-in tab.
  if (["home", "board", "ask", "reports", "console"].includes(b.slug)) return J({ error: "that slug is reserved" }, 400);
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

/* Work out what a dropped CSV actually is from its own header row.
   The alternative is asking the person uploading to pick from a list, and the whole
   point of the upload is that somebody in the office does it in ten seconds without
   thinking. Tradify's export filenames are not stable enough to match on. */
function sniffSource(header) {
  const h = (header || "").toLowerCase();
  const has = (...names) => names.every((n) => h.includes(n));
  if (has("quote")) return "tradify-quotes";
  if (has("invoice") && !h.includes("job number")) return "tradify-invoices";
  if (h.includes("job") && (h.includes("cost") || h.includes("margin") || h.includes("profit")))
    return "tradify-job-financials";
  if (h.includes("job")) return "tradify-jobs";
  if (has("purchase order") || h.includes("bill")) return "tradify-purchases";
  return null;
}

// D1 stores the CSV whole so a routine can diff week against week. Cap it well under
// the row limit and say so plainly rather than failing with a database error.
const MAX_CSV = 700 * 1024;

async function uploadImport(req, env) {
  const b = await readJson(req);
  if (!b || typeof b.csv !== "string" || !b.csv.trim()) {
    return J({ error: "That file looks empty. Try exporting it again." }, 400);
  }
  if (b.csv.length > MAX_CSV) {
    return J({ error: "That file is larger than 700KB. Export a shorter date range and try again." }, 413);
  }
  const lines = b.csv.split("\n").filter((l) => l.trim());
  if (lines.length < 2) {
    return J({ error: "That file has no rows in it, only headings." }, 400);
  }
  const source = b.source || sniffSource(lines[0]);
  if (!source) {
    return J({
      error: "I could not tell what that export is. It should be a Jobs, Quotes, Invoices or Job Financial export from Tradify.",
    }, 400);
  }
  await env.DB.prepare("INSERT INTO imports (source,filename,rows,csv,period) VALUES (?,?,?,?,?)")
    .bind(source, b.filename || null, lines.length - 1, b.csv, b.period || null).run();
  return J({ ok: true, source, rows: lines.length - 1 });
}

// Freshness per source, for the Home panel. A routine reading stale data is the main
// failure mode of the whole system, so the age is shown where it cannot be missed.
async function apiImportStatus(env) {
  const { results } = await env.DB.prepare(
    "SELECT source, MAX(added) AS added, COUNT(*) AS n FROM imports GROUP BY source ORDER BY source"
  ).all();
  return J(results || []);
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
    env.DB.prepare("SELECT key,label,unit,better,sort,tile,grp FROM metric_meta ORDER BY sort, key").all(),
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

/* ---------- ask ----------
   A question box on the dashboard, so the owner can ask things the routines were never
   written to answer, from a phone, without opening Claude.

   It runs on Workers AI by default, which is on THEIR Cloudflare account and free on the
   plan this whole thing already uses. No second subscription and nothing to sign up for.
   Setting ANTHROPIC_API_KEY plus ASK_MODEL to a claude-* id upgrades the answers, and is
   a deliberate opt-in because it is the only part of the system that would cost money.

   The model is never asked to work anything out from raw data. It gets a compact brief
   built here from D1 and is told to answer from that alone, because the failure that
   actually matters is a confident invented number. */

function stripHtml(h) {
  return String(h || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

async function buildBrief(env) {
  const c = cfg(env);
  const today = localDate(env);
  const since = new Date(Date.now() - 70 * 86400000).toISOString().slice(0, 10);
  const [mSeries, mMeta, notes, todos, runs, imports, kb] = await Promise.all([
    env.DB.prepare("SELECT date,key,value FROM metrics WHERE date>=? AND value IS NOT NULL ORDER BY date").bind(since).all(),
    env.DB.prepare("SELECT key,label,unit,better FROM metric_meta").all(),
    env.DB.prepare("SELECT area,severity,title,body,metric,date FROM notes WHERE date=(SELECT MAX(date) FROM notes)").all(),
    env.DB.prepare("SELECT title,detail,priority,due FROM todos WHERE done IS NULL ORDER BY priority LIMIT 40").all(),
    env.DB.prepare("SELECT title,status,run_at,summary_html FROM runs ORDER BY run_at DESC LIMIT 8").all(),
    env.DB.prepare("SELECT source, MAX(added) AS added FROM imports GROUP BY source").all(),
    env.DB.prepare("SELECT title,body FROM kb ORDER BY slug LIMIT 8").all(),
  ]);

  const L = [];
  L.push(`Business: ${c.name}. Today is ${today}. Currency ${c.cur}. Timezone ${c.tz}.`);

  const meta = Object.fromEntries((mMeta.results || []).map((m) => [m.key, m]));
  const by = {};
  for (const r of mSeries.results || []) (by[r.key] = by[r.key] || []).push(r);
  const lines = [];
  for (const [k, series] of Object.entries(by)) {
    const m = meta[k] || { label: k, unit: "" };
    const last = series[series.length - 1];
    const prevDate = new Date(new Date(last.date).getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const prev = series.filter((r) => r.date <= prevDate).pop();
    lines.push(`- ${m.label}: ${last.value} (as at ${last.date})` +
      (prev ? `, was ${prev.value} on ${prev.date}` : "") +
      (m.unit ? ` [${m.unit}]` : ""));
  }
  if (lines.length) L.push("\nCURRENT NUMBERS:\n" + lines.join("\n"));

  if ((notes.results || []).length)
    L.push("\nWHAT THE ROUTINES FLAGGED (" + notes.results[0].date + "):\n" +
      notes.results.map((n) => `- [${n.severity}] ${n.title}. ${n.body || ""} ${n.metric || ""}`.trim()).join("\n"));

  if ((todos.results || []).length)
    L.push("\nOPEN TO-DO LIST:\n" + todos.results.map((t) =>
      `- ${t.title}${t.detail ? " (" + t.detail + ")" : ""}${t.due ? " due " + t.due : ""}`).join("\n"));

  if ((runs.results || []).length)
    L.push("\nRECENT REPORTS:\n" + runs.results.map((r) =>
      `- ${r.run_at.slice(0, 10)} ${r.title} [${r.status}]: ${stripHtml(r.summary_html).slice(0, 240)}`).join("\n"));

  if ((imports.results || []).length)
    L.push("\nTRADIFY UPLOADS (how current the jobs and quotes data is):\n" +
      imports.results.map((i) => `- ${i.source}: last uploaded ${i.added}`).join("\n"));

  if ((kb.results || []).length)
    L.push("\nABOUT THIS BUSINESS:\n" + kb.results.map((k) => `${k.title}: ${k.body}`.slice(0, 700)).join("\n"));

  return L.join("\n");
}

const ASK_RULES =
  "You answer questions about this business for its owner, who is reading on a phone " +
  "between jobs. Rules, in order of importance:\n" +
  "1. Answer ONLY from the brief below. If the brief does not contain the answer, say so " +
  "plainly and say what would need to be uploaded or connected for you to know. NEVER " +
  "estimate, guess or infer a number that is not there.\n" +
  "2. Be short. Two or three sentences unless asked for detail. No preamble, no bullet " +
  "lists unless comparing several things.\n" +
  "3. Quote the actual figures and their dates. If data is old, say how old.\n" +
  "4. Plain English. No jargon, no marketing tone. Write like a straight-talking bookkeeper.\n" +
  "5. If asked to do something rather than answer something, say it can be added to the " +
  "to-do list or asked of Claude directly, and do not pretend to have done it.";

async function apiAsk(req, env) {
  const b = await readJson(req);
  const q = b && typeof b.q === "string" ? b.q.trim() : "";
  if (!q) return J({ error: "Ask a question." }, 400);
  if (q.length > 600) return J({ error: "That question is too long. Try a shorter one." }, 400);

  const brief = await buildBrief(env);
  const model = String(env.ASK_MODEL || "").trim();
  const useAnthropic = /^claude-/.test(model) && !!env.ANTHROPIC_API_KEY;
  const prompt = ASK_RULES + "\n\n===== BRIEF =====\n" + brief;

  try {
    if (useAnthropic) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: 700, system: prompt, messages: [{ role: "user", content: q }] }),
      });
      const j = await r.json();
      const text = (j.content || []).map((c) => c.text).filter(Boolean).join("\n").trim();
      if (!text) return J({ error: "No answer came back. Try asking again." }, 502);
      return J({ text });
    }
    if (!env.AI) {
      return J({ error: "The question box is not switched on yet. It needs the AI binding added to wrangler.toml and a redeploy." }, 503);
    }
    const out = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      max_tokens: 700,
      messages: [{ role: "system", content: prompt }, { role: "user", content: q }],
    });
    const text = String((out && (out.response || out.result)) || "").trim();
    if (!text) return J({ error: "No answer came back. Try asking again." }, 502);
    return J({ text });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/not support|no such binding|Unimplemented|binding/i.test(m)) {
      return J({ error: "The question box needs the deployed dashboard. It does not run in local preview." }, 503);
    }
    return J({ error: "Could not reach the model just now. Try again in a moment." }, 502);
  }
}

/* The console page markup. Used by the Console tab and, with the chrome stripped,
   by the standalone /console route, so the screen in the office and the tab in the
   dashboard are literally the same page. */
const CONSOLE_BODY = (c) => `<div class="con">
  <div class="con-head">
    <div><div class="con-name">${esc((c.name || "").toUpperCase())}</div>
    <div class="con-sub" id="con-sub">Standing by</div></div>
    <div class="con-clock"><div class="con-time" id="con-time">--:--</div>
    <div class="con-date" id="con-date"></div></div>
  </div>
  <div class="con-main">
    <div class="con-col" id="con-left"></div>
    <div class="con-centre">
      <div class="con-orbwrap"><canvas id="orb" width="900" height="900"></canvas></div>
      <div class="con-state" id="con-state">Ask me anything about the business</div>
      <div class="con-ans" id="con-ans"></div>
      <div class="con-sugg" id="con-sugg"></div>
    </div>
    <div class="con-col" id="con-right"></div>
  </div>
  <div class="con-ctrl">
    <input class="con-in" id="con-q" placeholder="Who owes us the most right now?" autocomplete="off">
    <button class="con-btn pri" id="con-go">Ask</button>
    <button class="con-btn" id="con-mic" title="Speak your question">Voice</button>
  </div>
  <div class="con-foot"><span id="con-fresh">&nbsp;</span><span id="con-stamp">&nbsp;</span></div>
</div>`;

/* ---------- pages ---------- */

const CSS = `
/* ---------------------------------------------------------------------------
   Three themes, chosen by the owner and remembered in their browser:
     light  the default, charcoal and their accent on paper
     dark   the same geometry on near-black
     hud    the console: teal on deep green-black, for a screen left on
   Applied as data-theme on <html> by an inline script in the head, so there is
   no flash of the wrong theme on load.

   The console layer at the bottom of this sheet carries the look. It MUST stay
   last: same specificity means source order decides, and a rule for .card put
   above the component that redeclares it loses silently.
   --------------------------------------------------------------------------- */
:root{
  --wrap-max:1180px;
  --gut:clamp(14px,1.9vw,34px);
  --bg:#f4f6f6; --card:#fff; --soft:#ecefec; --ink:#141a16; --muted:#69736c;
  --line:#e0e5e0; --accent:#2c6039; --ok:#2c6039; --warn:#8a5c10; --alert:#9d3527;
  --pagebg:radial-gradient(122% 96% at 50% 34%,#ffffff 0%,#f7f9f7 52%,#eef2ee 100%);
  --grid:rgba(20,26,22,.018);
}
[data-theme="dark"]{
  --bg:#0e1116; --card:#161b22; --soft:#1c222b; --ink:#e6edf3; --muted:#8b98a5;
  --line:#232b36; --accent:#4f9be0; --ok:#5fbf85; --warn:#d3a24f; --alert:#e0776a;
  --pagebg:radial-gradient(122% 96% at 50% 34%,#151c26 0%,#0f141b 52%,#0a0d12 100%);
  --grid:rgba(230,237,243,.02);
}
[data-theme="hud"]{
  --bg:#071316; --card:#0b2026; --soft:#0e2a31; --ink:#c8e9f0; --muted:#5b93a3;
  --line:#144752; --accent:#3fa8bd; --ok:#4fc08a; --warn:#cfa051; --alert:#e0776a;
  --pagebg:radial-gradient(122% 96% at 50% 34%,#0f2730 0%,#081518 52%,#04090b 100%);
  --grid:rgba(200,233,240,.0196);
}
@media(min-width:1400px){:root{--wrap-max:1330px}}
@media(min-width:1700px){:root{--wrap-max:1560px}}
@media(min-width:2100px){:root{--wrap-max:1840px}}
@media(min-width:2600px){:root{--wrap-max:2200px}}

*{box-sizing:border-box;margin:0;padding:0}
html{color-scheme:light}
[data-theme="dark"],[data-theme="hud"]{color-scheme:dark}
/* The gradient is the PAGE background, not a panel's, so nothing ends in a hard
   rectangle where a surface stops. The grid is a layer of the same declaration:
   split into two rules and the more specific one silently replaces the other. */
body{
  background:
    repeating-linear-gradient(0deg,var(--grid) 0 1px,transparent 1px 46px) fixed,
    repeating-linear-gradient(90deg,var(--grid) 0 1px,transparent 1px 46px) fixed,
    var(--pagebg) fixed, var(--bg);
  color:var(--ink);min-height:100dvh;
  font:14px/1.6 var(--con-read);-webkit-font-smoothing:antialiased;
  padding-bottom:env(safe-area-inset-bottom)}
a{color:inherit}

header{position:sticky;top:0;z-index:20;backdrop-filter:blur(9px);
  background:color-mix(in srgb,var(--bg) 78%,transparent);
  border-bottom:1px solid var(--line);
  padding:13px var(--gut) 0 var(--gut);padding-top:calc(13px + env(safe-area-inset-top))}
.hrow{max-width:var(--wrap-max);margin:0 auto;display:flex;align-items:baseline;gap:14px}
.brand{font-family:var(--con-mono);font-weight:650;letter-spacing:.02em;font-size:15px}
.sub{color:var(--muted);font-size:11px;font-family:var(--con-fig);margin-left:auto;
  letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
nav{max-width:var(--wrap-max);margin:0 auto;display:flex;gap:3px;overflow-x:auto;
  padding:9px 0 0;scrollbar-width:none;justify-content:center}
nav::-webkit-scrollbar{display:none}
nav a{flex:0 0 auto;padding:7px 14px;border-radius:var(--con-r) var(--con-r) 0 0;
  font-family:var(--con-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--muted);text-decoration:none;white-space:nowrap;border:1px solid transparent;
  border-bottom:0}
nav a:hover{color:var(--ink)}
nav a.on{color:var(--ink);border-color:var(--con-line);
  background:linear-gradient(180deg,var(--con-fill1),var(--con-fill2))}
@media(max-width:900px){nav{justify-content:flex-start}}

main{max-width:var(--wrap-max);margin:0 auto;padding:22px var(--gut) 80px}
h2{font-family:var(--con-mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.16em;
  color:var(--con-label);font-weight:650;margin:26px 0 10px}
h2:first-child{margin-top:2px}
h3{font-family:var(--con-mono);font-size:13px;font-weight:650;letter-spacing:.01em;color:var(--ink)}

.seg{display:flex;gap:0;border:1px solid var(--con-line);border-radius:var(--con-r);overflow:hidden}
.seg button{background:transparent;border:0;color:var(--muted);cursor:pointer;
  font-family:var(--con-mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;
  padding:6px 10px}
.seg button:hover{color:var(--ink)}
.seg button.on{background:var(--accent);color:#fff}
[data-theme="hud"] .seg button.on,[data-theme="dark"] .seg button.on{color:#04090b}

.card{border:1px solid var(--con-line);border-radius:var(--con-r);padding:15px 17px;
  background:linear-gradient(180deg,var(--con-fill1),var(--con-fill2));position:relative}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(150px,15vw,220px),1fr));gap:10px}
.tile .k{font-family:var(--con-mono);font-size:9.5px;color:var(--con-label);
  text-transform:uppercase;letter-spacing:.16em}
.tile .v{font-family:var(--con-fig);font-size:25px;font-weight:650;letter-spacing:-.02em;
  margin-top:6px;font-variant-numeric:tabular-nums;color:var(--ink)}
.tile .d{font-family:var(--con-fig);font-size:11px;margin-top:3px;color:var(--muted);
  font-variant-numeric:tabular-nums}
.up{color:var(--ok)}.down{color:var(--alert)}

.note{border:1px solid var(--con-line);border-left-width:2px;border-radius:var(--con-r);
  padding:11px 15px;margin-bottom:9px;
  background:linear-gradient(180deg,var(--con-fill1),var(--con-fill2))}
.note.do-now{border-left-color:var(--alert)}
.note.watch{border-left-color:var(--warn)}
.note.good{border-left-color:var(--ok)}
.note .t{font-weight:600;color:var(--ink)}
.note .b{color:var(--muted);font-size:13.5px;margin-top:3px}
.note .m{font-family:var(--con-fig);font-size:11.5px;color:var(--muted);margin-top:5px;
  font-variant-numeric:tabular-nums}
.chip{display:inline-block;font-family:var(--con-mono);font-size:9.5px;text-transform:uppercase;
  letter-spacing:.16em;color:var(--con-label);margin-bottom:4px}

ul.todo{list-style:none}
ul.todo li{display:flex;gap:11px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--line)}
ul.todo li:last-child{border-bottom:0}
ul.todo input{margin-top:3px;width:17px;height:17px;accent-color:var(--accent);flex:0 0 auto}
ul.todo .x{opacity:.4;text-decoration:line-through}
.p1{color:var(--alert);font-weight:640}

.runs{display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(280px,23vw,420px),1fr));gap:11px}
.run{cursor:pointer;transition:transform .08s ease}
.run:active{transform:scale(.99)}
.run .top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.run .ti{font-family:var(--con-mono);font-weight:650;font-size:13px}
.run .when{font-family:var(--con-fig);font-size:10.5px;color:var(--muted);white-space:nowrap;
  font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:7px;height:7px;border-radius:99px;margin-right:7px;vertical-align:middle}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}
.dot.alert{background:var(--alert)}.dot.info{background:var(--muted)}
.run .sum{color:var(--muted);font-size:13px;margin-top:7px}
.run .sum ul{margin:5px 0 0 16px}
.empty{color:var(--muted);text-align:center;padding:34px 18px;font-size:13.5px}

.imp{display:flex;flex-direction:column;gap:11px}
.imp .row{display:flex;justify-content:space-between;gap:12px;align-items:baseline;
  padding:9px 0;border-bottom:1px solid var(--line)}
.imp .row:last-of-type{border-bottom:0}
.imp .row b{font-family:var(--con-mono);font-weight:600;font-size:12px;
  text-transform:uppercase;letter-spacing:.12em}
.imp .age{font-family:var(--con-fig);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.imp .age.fresh{color:var(--ok)}.imp .age.old{color:var(--warn)}.imp .age.stale{color:var(--alert)}
.drop{border:1px dashed var(--con-line);border-radius:var(--con-r);padding:20px 18px;
  text-align:center;cursor:pointer;transition:border-color .12s}
.drop:hover,.drop.over{border-color:var(--accent)}
.drop b{display:block;font-family:var(--con-mono);font-size:12px;text-transform:uppercase;
  letter-spacing:.12em;color:var(--ink);margin-bottom:4px}
.drop span{font-size:12.5px;color:var(--muted)}
.drop input{display:none}
.msg{font-size:13px;padding:9px 12px;border-radius:var(--con-r);margin-top:2px}
.msg.good{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.msg.bad{background:color-mix(in srgb,var(--alert) 14%,transparent);color:var(--alert)}

.ask{display:flex;flex-direction:column;gap:12px}
.ask .box{display:flex;gap:8px}
.ask textarea{flex:1;min-height:52px;max-height:170px;padding:12px 14px;
  border:1px solid var(--con-line);border-radius:var(--con-r);background:var(--bg);
  color:var(--ink);font:15px/1.5 var(--con-read);resize:vertical}
.ask textarea:focus{outline:1px solid var(--accent);outline-offset:1px}
.ask button.go{flex:0 0 auto;align-self:flex-end;padding:12px 18px;border:0;
  border-radius:var(--con-r);background:var(--accent);color:#fff;
  font-family:var(--con-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
  font-weight:650;cursor:pointer}
[data-theme="hud"] .ask button.go,[data-theme="dark"] .ask button.go{color:#04090b}
.ask button.go:disabled{opacity:.45;cursor:default}
.ask .sugg{display:flex;flex-wrap:wrap;gap:7px}
.ask .sugg button{background:transparent;border:1px solid var(--con-line);color:var(--muted);
  border-radius:99px;padding:7px 13px;font-size:12.5px;cursor:pointer;text-align:left;
  font-family:var(--con-read)}
.ask .sugg button:hover{color:var(--ink);border-color:var(--accent)}
.ask .ans{white-space:pre-wrap;line-height:1.62;font-size:15px}
.ask .ans.err{color:var(--alert)}
.ask .qline{font-family:var(--con-fig);font-size:12px;color:var(--muted);margin-bottom:7px}

.board{background:transparent;color:var(--ink);display:flex;flex-direction:column;gap:16px}
.board .grp{font-family:var(--con-mono);letter-spacing:.16em;font-size:9.5px;
  text-transform:uppercase;color:var(--con-label);margin-bottom:9px;font-weight:650}
.board .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(clamp(220px,20vw,340px),1fr));
  gap:14px;align-items:start}
.board .pane{border:1px solid var(--con-line);border-radius:var(--con-r);padding:13px 15px 15px;
  background:linear-gradient(180deg,var(--con-fill1),var(--con-fill2));position:relative}
.board .mrow{display:flex;justify-content:space-between;align-items:baseline;
  font-size:13.5px;margin:9px 0 4px;gap:10px}
.board .ml{font-family:var(--con-mono);color:var(--con-label);font-size:9.5px;
  letter-spacing:.16em;text-transform:uppercase;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
.board .mv{font-family:var(--con-fig);color:var(--ink);font-weight:700;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.board .mv i{font-style:normal;font-size:10.5px;font-weight:500;margin-left:6px}
.board .mv i.up{color:var(--ok)}.board .mv i.dn{color:var(--alert)}
.board .bar{height:4px;background:var(--soft);border-radius:2px;overflow:hidden}
.board .fl{height:100%;background:var(--ok);border-radius:2px;transition:width .5s ease}
.board .fl.warn{background:var(--warn)}
.board .fl.bad{background:var(--alert)}
.board .flag{border-left:2px solid var(--line);padding:7px 0 7px 11px;margin-bottom:9px}
.board .flag:last-child{margin-bottom:0}
.board .flag.now{border-left-color:var(--alert)}
.board .flag.watch{border-left-color:var(--warn)}
.board .flag.good{border-left-color:var(--ok)}
.board .flag b{display:block;font-size:13px;font-weight:600;line-height:1.35}
.board .flag span{display:block;font-family:var(--con-fig);font-size:11px;color:var(--muted);
  font-variant-numeric:tabular-nums;margin-top:2px}
.board .todo{font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line);
  display:flex;gap:9px;align-items:baseline}
.board .todo:last-child{border-bottom:0}
.board .todo em{font-style:normal;color:var(--alert);font-family:var(--con-mono);
  font-size:9px;letter-spacing:.12em}
.board .foot{display:flex;justify-content:space-between;font-family:var(--con-mono);
  font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--con-label);
  border-top:1px solid var(--line);padding-top:11px}
.board .none{color:var(--muted);font-size:12.5px}

dialog{border:0;padding:0;background:transparent;max-width:min(940px,94vw);width:100%;margin:auto}
dialog::backdrop{background:rgba(0,0,0,.6)}
.modal{background:var(--card);border:1px solid var(--con-line);border-radius:var(--con-r);
  overflow:hidden;display:flex;flex-direction:column;max-height:88vh}
.modal .h{display:flex;justify-content:space-between;align-items:center;gap:12px;
  padding:13px 17px;border-bottom:1px solid var(--con-line)}
.modal .h b{font-family:var(--con-mono);font-size:12px;text-transform:uppercase;letter-spacing:.12em}
.modal iframe{border:0;width:100%;height:74vh;background:#fff}
button.x{background:var(--soft);border:0;color:var(--ink);border-radius:99px;width:29px;
  height:29px;font-size:17px;cursor:pointer;flex:0 0 auto}

form.login{max-width:340px;margin:16vh auto;padding:0 20px}
form.login .card{padding:24px 22px}
form.login input{width:100%;padding:13px 15px;border:1px solid var(--con-line);
  border-radius:var(--con-r);background:var(--bg);color:var(--ink);font-size:16px}
form.login button{width:100%;margin-top:10px;padding:13px;border:0;border-radius:var(--con-r);
  background:var(--accent);color:#fff;font-family:var(--con-mono);font-size:11px;
  letter-spacing:.16em;text-transform:uppercase;font-weight:650;cursor:pointer}
[data-theme="hud"] form.login button,[data-theme="dark"] form.login button{color:#04090b}
.err{color:var(--alert);font-size:13px;margin-top:10px;text-align:center}

iframe.page{border:0;width:100%;height:calc(100dvh - 200px);background:#fff;
  border-radius:var(--con-r);border:1px solid var(--con-line)}

/* ---------------------------------------------------------------------------
   THE CONSOLE LAYER. Keep this last in the sheet.
   Mono for chrome, sans for prose: labels, numbers, buttons and headings carry
   the look, but a sentence set in tracked mono wraps to five lines in a card
   that fits it on two.
   The glowing tick sits on TOP-LEVEL panels only. On all forty surfaces a
   signature becomes wallpaper.
   --------------------------------------------------------------------------- */
:root{
  --con-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --con-fig:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --con-read:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --con-r:6px;
  --con-line:#dfe3ea; --con-fill1:#ffffff; --con-fill2:#fafbfc;
  --con-label:#6b7686; --con-glow:none;
}
[data-theme="dark"]{
  --con-line:#243040; --con-fill1:rgba(22,27,34,.72); --con-fill2:rgba(14,17,22,.72);
  --con-label:#8b98a5; --con-glow:0 0 8px var(--accent);
}
[data-theme="hud"]{
  --con-line:#175059; --con-fill1:rgba(11,33,40,.6); --con-fill2:rgba(6,18,22,.6);
  --con-label:#58b7c9; --con-glow:0 0 8px var(--accent);
}
main > .card::before,.board .pane::before,.tiles .card::before{
  content:"";position:absolute;left:-1px;top:9px;width:2px;height:34px;
  background:var(--accent);box-shadow:var(--con-glow);border-radius:2px;opacity:.9}
.tiles .card::before,.board .pane::before{height:22px;top:7px}

/* ---------------------------------------------------------------------------
   THE CONSOLE PAGE. Three columns with the assistant in the middle: numbers
   down the left, the orb and the input in the centre, transcript and to-do
   down the right. Built to be left running on a screen in the office.
   Grid rows are minmax(0,1fr) so the two list panels can actually scroll
   inside their columns instead of stretching the page.
   --------------------------------------------------------------------------- */
.con{min-height:100dvh;display:flex;flex-direction:column;position:relative;z-index:2}
.con-head{display:flex;align-items:flex-start;justify-content:space-between;
  gap:16px;padding:18px 26px 4px}
.con-name{font-family:var(--con-mono);font-size:19px;font-weight:800;letter-spacing:.34em;
  color:var(--ink);text-shadow:var(--con-glow)}
.con-sub{font-family:var(--con-mono);font-size:9px;letter-spacing:.26em;color:var(--con-label);
  text-transform:uppercase;margin-top:4px}
.con-clock{text-align:right;font-family:var(--con-fig);font-variant-numeric:tabular-nums}
.con-time{font-size:22px;font-weight:700;color:var(--ink);letter-spacing:.04em}
.con-date{font-size:9px;letter-spacing:.26em;color:var(--con-label);margin-top:3px;text-transform:uppercase}
.con-main{display:grid;grid-template-columns:300px 1fr 300px;gap:14px;
  grid-template-rows:minmax(0,1fr);padding:8px 26px 0;flex:1;align-items:stretch;min-height:0}
.con-col{min-height:0;display:flex;flex-direction:column;gap:12px;overflow:visible}
.con-centre{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
  min-width:0;max-width:100%}
.con-orbwrap{position:relative;width:min(58vh,100%,520px);aspect-ratio:1;margin-top:-6px}
.con-orbwrap canvas{width:100%;height:100%;display:block}
.con-state{font-family:var(--con-mono);font-size:9.5px;letter-spacing:.24em;text-transform:uppercase;
  color:var(--con-label);margin-top:2px;min-height:14px}
.con-ans{margin-top:14px;max-width:min(560px,92%);text-align:center;font-size:14.5px;
  line-height:1.62;color:var(--ink);white-space:pre-wrap}
.con-ans.err{color:var(--alert)}
.con-sugg{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:16px;
  max-width:min(620px,94%)}
.con-sugg button{background:transparent;border:1px solid var(--con-line);color:var(--muted);
  border-radius:99px;padding:7px 13px;font-size:12px;cursor:pointer;font-family:var(--con-read)}
.con-sugg button:hover{color:var(--ink);border-color:var(--accent)}
.con-vrow{display:flex;justify-content:space-between;align-items:center;gap:9px;
  font-size:11.5px;padding:5px 0}
.con-vrow span{font-family:var(--con-mono);font-size:9px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--con-label)}
.con-sw{background:transparent;border:1px solid var(--con-line);color:var(--con-label);
  font-family:var(--con-mono);font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;
  padding:5px 10px;border-radius:99px;cursor:pointer}
.con-sw.on{background:var(--accent);border-color:var(--accent);color:#fff}
[data-theme="hud"] .con-sw.on,[data-theme="dark"] .con-sw.on{color:#04090b}
.con-vsel{background:var(--bg);border:1px solid var(--con-line);color:var(--ink);
  font-family:var(--con-read);font-size:11px;padding:4px 6px;border-radius:4px;max-width:150px}
.con-run{display:flex;gap:8px;align-items:baseline;padding:5px 0;
  border-bottom:1px solid var(--line);font-size:11.5px}
.con-run:last-child{border-bottom:0}
.con-run .dot{width:6px;height:6px;margin:0;flex:0 0 auto}
.con-run .rt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.con-run .rw{font-family:var(--con-fig);font-size:10px;color:var(--con-label);flex:0 0 auto}
.con-pane{border:1px solid var(--con-line);border-radius:var(--con-r);
  background:linear-gradient(180deg,var(--con-fill1),var(--con-fill2));
  padding:12px 14px;position:relative;display:flex;flex-direction:column;min-height:0}
.con-pane::before{content:"";position:absolute;left:-1px;top:9px;width:2px;height:26px;
  background:var(--accent);box-shadow:var(--con-glow);border-radius:2px;opacity:.9}
.con-pane > h4{font-family:var(--con-mono);font-size:9px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--con-label);font-weight:650;margin-bottom:9px;flex:0 0 auto}
.con-grow{flex:1 1 0;overflow-y:auto;scrollbar-width:none;min-height:0}
.con-grow::-webkit-scrollbar{display:none}
.con-mrow{display:flex;justify-content:space-between;align-items:baseline;gap:9px;
  font-size:13px;margin:8px 0 4px}
.con-ml{font-family:var(--con-mono);font-size:9px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--con-label);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.con-mv{font-family:var(--con-fig);font-weight:700;font-variant-numeric:tabular-nums;
  color:var(--ink);white-space:nowrap}
.con-mv i{font-style:normal;font-size:10px;font-weight:500;margin-left:5px}
.con-mv i.up{color:var(--ok)}.con-mv i.dn{color:var(--alert)}
.con-bar{height:3px;background:var(--soft);border-radius:2px;overflow:hidden}
.con-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .5s ease}
.con-fill.warn{background:var(--warn)}.con-fill.bad{background:var(--alert)}
.con-line{font-size:11.5px;line-height:1.62;padding:5px 0;border-bottom:1px solid var(--line);
  display:flex;gap:8px;align-items:baseline}
.con-line:last-child{border-bottom:0}
.con-line em{font-style:normal;font-family:var(--con-mono);font-size:8.5px;letter-spacing:.12em;
  color:var(--con-label);flex:0 0 auto;padding-top:1px}
.con-line em.now{color:var(--alert)}
.con-line em.you{color:var(--accent)}
.con-flag{border-left:2px solid var(--line);padding:6px 0 6px 10px;margin-bottom:8px}
.con-flag:last-child{margin-bottom:0}
.con-flag.do-now{border-left-color:var(--alert)}
.con-flag.watch{border-left-color:var(--warn)}
.con-flag.good{border-left-color:var(--ok)}
.con-flag b{display:block;font-size:12.5px;font-weight:600;line-height:1.35}
.con-flag span{display:block;font-family:var(--con-fig);font-size:10.5px;color:var(--muted);
  font-variant-numeric:tabular-nums;margin-top:2px}
.con-ctrl{display:flex;gap:10px;padding:14px 26px 22px;align-items:center;flex-wrap:wrap}
.con-in{flex:1;min-width:150px;background:var(--bg);border:1px solid var(--con-line);
  color:var(--ink);font-family:var(--con-read);font-size:13.5px;padding:11px 14px;
  border-radius:var(--con-r);outline:none}
.con-in:focus{border-color:var(--accent)}
.con-btn{background:transparent;border:1px solid var(--con-line);color:var(--con-label);
  font-family:var(--con-mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;
  padding:11px 15px;border-radius:var(--con-r);cursor:pointer}
.con-btn:hover{color:var(--ink);border-color:var(--accent)}
.con-btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
[data-theme="hud"] .con-btn.pri,[data-theme="dark"] .con-btn.pri{color:#04090b}
.con-btn:disabled{opacity:.4;cursor:default}
.con-foot{font-family:var(--con-mono);font-size:9px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--con-label);padding:0 26px 18px;display:flex;justify-content:space-between;gap:12px}
.con-none{color:var(--muted);font-size:11.5px}
@media(min-width:1500px){
  .con-main{grid-template-columns:minmax(320px,min(22vw,560px)) 1fr minmax(320px,min(22vw,560px))}
  .con-orbwrap{width:min(62vh,100%,620px)}
  .con-ml,.con-pane > h4{font-size:10.5px}
}
/* Below the three-column width the orb is the first thing to go: on a phone the
   numbers and the list are what somebody actually wants. */
@media(max-width:1080px){
  .con-main{grid-template-columns:1fr;grid-template-rows:auto;gap:12px;padding:8px 16px 0}
  .con-orbwrap{width:min(38vh,300px)}
  .con-grow{max-height:340px}
  .con-head,.con-ctrl,.con-foot{padding-left:16px;padding-right:16px}
}
`;

/* Runs before the stylesheet paints, so the chosen theme is on <html> from the
   first frame and there is no flash of the wrong one. Single-quoted on the
   outside: a backtick in here would end the CSS template literal above. */
const THEME_BOOT = '<script>(function(){try{var t=localStorage.getItem("cc-theme");if(t&&t!=="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();</scr'+'ipt>';

function loginPage(env, error) {
  const c = cfg(env);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(c.name)}</title>` + THEME_BOOT + `<style>${CSS}</style></head><body>
<form class="login" method="POST" action="/login"><div class="card">
<div class="brand" style="text-align:center;margin-bottom:15px">${esc(c.name)}</div>
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<button type="submit">Sign in</button>
${error ? `<div class="err">${esc(error)}</div>` : ""}
</div></form></body></html>`,
    { status: error ? 401 : 200, headers: { "content-type": "text/html;charset=utf-8" } }
  );
}

async function shell(env, url, solo) {
  const c = cfg(env);
  const { results: pages } = await env.DB.prepare("SELECT slug,title FROM pages WHERE nav=1 ORDER BY sort, title").all();
  const tab = solo ? "board" : (url.searchParams.get("t") || "home");
  const tabs = [{ slug: "home", title: "Home" }, { slug: "board", title: "Console" }, { slug: "ask", title: "Ask" }, ...(pages || []), { slug: "reports", title: "Reports" }];
  const nav = tabs.map((t) =>
    `<a href="/?t=${esc(t.slug)}" class="${t.slug === tab ? "on" : ""}">${esc(t.title)}</a>`).join("");
  const known = tabs.some((t) => t.slug === tab);

  let body;
  if (tab === "home") {
    body = `<div id="notes"></div><div id="tiles"></div><div id="todos"></div><div id="imports"></div>`;
  } else if (tab === "board") {
    body = CONSOLE_BODY(c);
  } else if (tab === "ask") {
    body = `<h2>Ask about the business</h2><div class="card ask">
<div class="box"><textarea id="q" placeholder="Who owes us the most right now?" rows="2"></textarea>
<button class="go" id="go">Ask</button></div>
<div class="sugg" id="sugg"></div>
<div id="ans"></div></div>`;
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
<link rel="manifest" href="/manifest.webmanifest"><title>${esc(c.name)}</title>` + THEME_BOOT + `
<style>${CSS}</style>${solo ? "<style>main{padding:0;max-width:none}</style>" : ""}</head><body>
${solo ? "" : `<header><div class="hrow"><div class="brand">${esc(c.name)}</div>
<div class="seg" id="themes" role="group" aria-label="Theme">
<button type="button" data-t="light">Light</button>
<button type="button" data-t="dark">Dark</button>
<button type="button" data-t="hud">Console</button></div>
<div class="sub" id="stamp">&nbsp;</div></div>
<nav>${nav}</nav></header>`}
<main>${body}</main>
<dialog id="dlg"><div class="modal"><div class="h"><b id="dt"></b><button class="x" onclick="dlg.close()">&times;</button></div>
<iframe id="df" sandbox></iframe></div></dialog>
<script>
const TAB = ${JSON.stringify(tab)}, CUR = ${JSON.stringify(c.cur)}, TZ = ${JSON.stringify(c.tz)};

/* Theme is the owner's choice and is remembered per browser, not per device or account:
   the person on the office screen wants the console, the same person on their phone in
   the ute usually does not. */
(function(){
  var seg = document.getElementById('themes');
  if(!seg) return;
  function cur(){ try{ return localStorage.getItem('cc-theme') || 'light'; }catch(e){ return 'light'; } }
  function paint(t){
    if(t==='light') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    seg.querySelectorAll('button').forEach(function(b){ b.classList.toggle('on', b.dataset.t===t); });
  }
  seg.querySelectorAll('button').forEach(function(b){
    b.addEventListener('click', function(){
      try{ localStorage.setItem('cc-theme', b.dataset.t); }catch(e){}
      paint(b.dataset.t);
    });
  });
  paint(cur());
})();
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

// Shared by the imports panel and the Board.
// The age is the important part: stale numbers presented as current are the one way
// this dashboard can quietly lie, so freshness is shown before anything else.
const SRC_LABEL = {
  'tradify-jobs':'Jobs', 'tradify-quotes':'Quotes', 'tradify-invoices':'Invoices',
  'tradify-job-financials':'Job financials', 'tradify-purchases':'Purchases and bills'
};
function ageOf(iso){
  const d = Math.floor((Date.now() - new Date(iso.replace(' ','T')+'Z').getTime())/86400000);
  if(d <= 0) return ['today','fresh'];
  if(d === 1) return ['yesterday','fresh'];
  if(d <= 7) return [d+' days ago','fresh'];
  if(d <= 21) return [d+' days ago','old'];
  return [d+' days ago','stale'];
}

async function imports(){
  const box = document.getElementById('imports');
  if(!box) return;
  const rows = await get('/api/import-status') || [];
  const list = rows.length
    ? rows.map(r=>{ const [txt,cls] = ageOf(r.added);
        return '<div class="row"><b>'+esc(SRC_LABEL[r.source]||r.source)+'</b>'+
               '<span class="age '+cls+'">'+txt+'</span></div>'; }).join('')
    : '<div class="row"><span style="color:var(--dim);font-size:13.5px">Nothing uploaded yet. '+
      'The jobs and quotes numbers stay empty until you drop an export in.</span></div>';

  box.innerHTML = '<h2>Tradify exports</h2><div class="card imp">'+list+
    '<label class="drop" id="drop"><b>Add an export</b>'+
    '<span>Drop a CSV here, or click to choose one. It works out which export it is.</span>'+
    '<input type="file" id="file" accept=".csv,text/csv"></label>'+
    '<div id="msg"></div></div>';

  const drop = document.getElementById('drop');
  const file = document.getElementById('file');
  const msg  = document.getElementById('msg');
  const say = (t,ok)=>{ msg.innerHTML = '<div class="msg '+(ok?'good':'bad')+'">'+esc(t)+'</div>'; };

  async function send(f){
    if(!f) return;
    if(!/\.csv$/i.test(f.name)){ say('That is not a CSV. In Tradify choose the export option, not print or PDF.',false); return; }
    say('Reading '+f.name+'...', true);
    let text;
    try { text = await f.text(); } catch(e){ say('Could not read that file. Try downloading it again.',false); return; }
    const r = await fetch('/api/import-upload',{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({filename:f.name, csv:text})});
    let j={}; try{ j = await r.json(); }catch(e){}
    if(r.ok){ say('Saved '+(j.rows||0)+' rows as '+(SRC_LABEL[j.source]||j.source)+'. Monday\u2019s report will use it.', true); imports(); }
    else { say(j.error || 'That did not upload. Try again in a moment.', false); }
  }

  file.addEventListener('change', ()=> send(file.files[0]));
  ['dragenter','dragover'].forEach(e=>drop.addEventListener(e, ev=>{ev.preventDefault();drop.classList.add('over');}));
  ['dragleave','drop'].forEach(e=>drop.addEventListener(e, ev=>{ev.preventDefault();drop.classList.remove('over');}));
  drop.addEventListener('drop', ev=> send(ev.dataTransfer.files[0]));
}

// Deliberately answers from the same figures the cards are built from, so the box and
// the dashboard can never disagree. The suggestions exist because a blank text field is
// the fastest way to make somebody close a page.
const SUGGESTIONS = [
  'Who owes us the most right now?',
  'How is cash tracking compared to last week?',
  'What should I chase today?',
  'Are we quoting more or less than a month ago?',
  'How old is my jobs data?'
];

function ask(){
  const q = document.getElementById('q'), go = document.getElementById('go'),
        ans = document.getElementById('ans'), sugg = document.getElementById('sugg');
  if(!q) return;
  sugg.innerHTML = SUGGESTIONS.map(t=>'<button type="button">'+esc(t)+'</button>').join('');
  sugg.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    q.value = b.textContent; send();
  }));

  async function send(){
    const text = q.value.trim();
    if(!text) return;
    go.disabled = true;
    ans.innerHTML = '<div class="qline">'+esc(text)+'</div><div class="ans" style="color:var(--dim)">Thinking...</div>';
    try{
      const r = await fetch('/api/ask',{method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json'},body:JSON.stringify({q:text})});
      const j = await r.json();
      ans.innerHTML = '<div class="qline">'+esc(text)+'</div>'+
        '<div class="ans'+(r.ok?'':' err')+'">'+esc(r.ok ? j.text : (j.error||'That did not work.'))+'</div>';
    }catch(e){
      ans.innerHTML = '<div class="ans err">Could not reach the dashboard. Check your connection.</div>';
    }
    go.disabled = false;
  }

  go.addEventListener('click', send);
  // Enter sends, shift+enter makes a new line. On a phone the button is the obvious path,
  // but on a laptop nobody wants to reach for the mouse to ask a question.
  q.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); }});
  q.focus();
}

/* THE CONSOLE. Numbers left, the assistant in the middle, what needs attention and
   the list right. Everything on one screen because the point is to leave it running
   and glance at it, not to click through it. */

var conBusy = false, conTurns = [];

/* The orb is drawn rather than an image, so it responds to state and stays sharp on a
   wall screen. The drawn radius is 0.90 of the half-width on purpose: the outer
   decorations carry a shadowBlur, and at a full half-width radius that bloom is
   clipped against the canvas edge in a ring right around the orb. No CSS can fix
   that, because it happens in canvas space at draw time. */
function orb(){
  var cv = document.getElementById('orb'); if(!cv) return;
  var ctx = cv.getContext('2d'), W = cv.width, R = W/2*0.90, C = W/2;
  var t = 0, energy = 0;
  var css = getComputedStyle(document.documentElement);
  function tone(n,f){ return (css.getPropertyValue(n)||'').trim() || f; }

  function draw(){
    var accent = tone('--accent','#3fa8bd'), label = tone('--con-label','#58b7c9');
    ctx.clearRect(0,0,W,W);
    energy += ((conBusy?1:0) - energy) * 0.06;
    t += 0.0035 + energy*0.018;

    var pulse = 1 + Math.sin(t*2.2)*0.02 + energy*0.06;
    var cr = R*0.66*pulse;
    var g = ctx.createRadialGradient(C,C,cr*0.06,C,C,cr);
    g.addColorStop(0, accent);
    g.addColorStop(0.30, accent+'aa');
    g.addColorStop(0.62, accent+'3a');
    g.addColorStop(1, accent+'00');
    ctx.globalAlpha = 0.38 + energy*0.30;
    ctx.beginPath(); ctx.arc(C,C,cr,0,Math.PI*2); ctx.fillStyle = g; ctx.fill();

    /* A complete rim, so there is always a sphere there even when the arcs are on
       the far side. Without it the thing reads as a few loose strokes. */
    ctx.globalAlpha = 0.5 + energy*0.3;
    ctx.beginPath(); ctx.arc(C,C,R*0.955,0,Math.PI*2);
    ctx.strokeStyle = accent; ctx.lineWidth = W/420;
    ctx.shadowBlur = W/26; ctx.shadowColor = accent; ctx.stroke();
    ctx.shadowBlur = 0;

    /* Three arcs, each with its own phase and direction, so they sit apart rather
       than bunching and never look like one rigid object turning. */
    var arcs = [[0.955, 1.00, 2.1, 0.85, 0.0],
                [0.870, -0.61, 1.5, 0.60, 2.3],
                [0.760, 0.37, 1.0, 0.42, 4.4]];
    for(var i=0;i<arcs.length;i++){
      var a = arcs[i], from = t*a[1] + a[4];
      ctx.beginPath();
      ctx.arc(C, C, R*a[0], from, from + a[2]);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = a[3] * (0.6 + energy*0.4);
      ctx.lineWidth = W/230; ctx.lineCap = 'round';
      ctx.shadowBlur = W/28; ctx.shadowColor = accent;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    ctx.strokeStyle = label; ctx.lineWidth = Math.max(1.4, W/560);
    for(var k=0;k<60;k++){
      var ang = (k/60)*Math.PI*2 - Math.PI/2, lng = (k%5===0) ? R*0.062 : R*0.03;
      ctx.globalAlpha = (k%5===0) ? 0.75 : 0.34;
      ctx.beginPath();
      ctx.moveTo(C+Math.cos(ang)*R, C+Math.sin(ang)*R);
      ctx.lineTo(C+Math.cos(ang)*(R-lng), C+Math.sin(ang)*(R-lng));
      ctx.stroke();
    }

    ctx.globalAlpha = 0.30 + energy*0.35;
    ctx.strokeStyle = accent; ctx.lineWidth = W/300;
    ctx.setLineDash([W/90, W/45]);
    ctx.beginPath(); ctx.arc(C,C,R*0.60, -t*0.8, -t*0.8 + Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  draw();
}

function conClock(){
  var now = new Date();
  var a = document.getElementById('con-time'), b = document.getElementById('con-date');
  if(a) a.textContent = new Intl.DateTimeFormat('en-AU',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
  if(b) b.textContent = new Intl.DateTimeFormat('en-AU',{timeZone:TZ,weekday:'long',day:'numeric',month:'long'}).format(now);
}

function conSay(who, text){
  conTurns.push({who:who, text:text});
  if(conTurns.length > 40) conTurns.shift();
  var box = document.getElementById('con-log');
  if(!box) return;
  box.innerHTML = conTurns.map(function(x){
    return '<div class="con-line"><em class="'+(x.who==='you'?'you':'')+'">'+
      (x.who==='you'?'YOU':'CC')+'</em><span>'+esc(x.text)+'</span></div>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function conLoad(){
  const [md, nd, todos, imps, runs] = await Promise.all([
    get('/api/metrics?days=90'), get('/api/notes'), get('/api/todos'),
    get('/api/import-status'), get('/api/runs?days=14')
  ]);

  const by = {};
  for(const r of ((md&&md.series)||[])) if(r.value!=null) (by[r.key]=by[r.key]||[]).push(r);
  const groups = {};
  for(const m of ((md&&md.meta)||[])){
    const ser = by[m.key]; if(!ser || !ser.length) continue;
    const last = ser[ser.length-1];
    const peak = Math.max.apply(null, ser.map(r=>Math.abs(r.value)));
    const cap = peak > 0 ? peak*1.1 : 1;
    const pd = new Date(new Date(last.date).getTime()-7*86400000).toISOString().slice(0,10);
    const prev = ser.filter(r=>r.date<=pd).pop();
    let delta = '';
    if(prev && prev.value){
      const pc = (last.value-prev.value)/Math.abs(prev.value)*100;
      if(Math.abs(pc)>=0.5){
        const good = m.better==='down' ? pc<0 : pc>0;
        delta = '<i class="'+(m.better==='flat'?'':(good?'up':'dn'))+'">'+(pc>0?'+':'')+pc.toFixed(0)+'%</i>';
      }
    }
    /* The bar shows where a number sits against its own recent range, which needs a
       range to exist. On a new install every metric is its own peak, so a full bar
       is meaningless and on a down-is-good metric it paints day one bright red.
       Below four readings there is no history to place it against, so no bar. */
    const ratio = Math.max(0, Math.min(1, Math.abs(last.value)/cap));
    const hasRange = ser.length >= 4;
    let cls = 'con-fill';
    if(hasRange && m.better==='down') cls += ratio>0.8 ? ' bad' : (ratio>0.55 ? ' warn' : '');
    const bar = hasRange
      ? '<div class="con-bar"><div class="'+cls+'" style="width:'+(ratio*100).toFixed(1)+'%"></div></div>'
      : '';
    const gname = m.grp || 'Numbers';
    (groups[gname] = groups[gname]||[]).push(
      '<div><div class="con-mrow"><span class="con-ml">'+esc(m.label)+'</span>'+
      '<span class="con-mv">'+fmt(last.value,m.unit)+delta+'</span></div>'+bar+'</div>');
  }
  const numPanes = Object.keys(groups).map(g=>
      '<div class="con-pane"><h4>'+esc(g)+'</h4><div>'+groups[g].join('')+'</div></div>').join('')
    || '<div class="con-pane"><h4>Numbers</h4><div class="con-none">Nothing yet. The first report fills this in.</div></div>';

  // Upload freshness sits with the numbers, not buried in a tab, because a stale
  // upload is the one thing that makes the numbers above it quietly wrong.
  const upPane = '<div class="con-pane"><h4>Tradify uploads</h4><div>'+
    ((imps||[]).length
      ? imps.map(i=>{ const a = ageOf(i.added);
          return '<div class="con-mrow"><span class="con-ml">'+esc(SRC_LABEL[i.source]||i.source)+
                 '</span><span class="con-mv" style="font-size:11.5px;color:var(--'+
                 (a[1]==='fresh'?'ok':a[1]==='old'?'warn':'alert')+')">'+esc(a[0])+'</span></div>'; }).join('')
      : '<div class="con-none">Nothing uploaded yet. Jobs and quotes stay empty until you drop an export on the Home tab.</div>')+
    '</div></div>';

  const voicePane = '<div class="con-pane"><h4>Audio</h4>'+
    '<div class="con-vrow"><span>Speak answers</span>'+
      '<button class="con-sw" id="con-speak">Off</button></div>'+
    '<div class="con-vrow"><span>Voice</span>'+
      '<select class="con-vsel" id="con-voice"></select></div>'+
    '<div class="con-vrow"><span>Microphone</span>'+
      '<span id="con-micstate" style="color:var(--muted);letter-spacing:0;text-transform:none;font-family:var(--con-read);font-size:11.5px">Checking</span></div>'+
    '</div>';

  document.getElementById('con-left').innerHTML = numPanes + upPane + voicePane;

  const flags = ((nd&&nd.notes)||[]).slice(0,4).map(n=>
    '<div class="con-flag '+esc(n.severity)+'"><b>'+esc(n.title)+'</b>'+
    (n.metric?'<span>'+esc(n.metric)+'</span>':'')+'</div>').join('');
  const open = (todos||[]).filter(t=>!t.done);
  const logWas = document.getElementById('con-log');
  const keep = logWas ? logWas.innerHTML : '';
  document.getElementById('con-right').innerHTML =
    '<div class="con-pane" style="flex:0 0 auto"><h4>Needs attention</h4><div>'+
      (flags || '<div class="con-none">Nothing flagged.</div>')+'</div></div>'+
    '<div class="con-pane" style="flex:1 1 0"><h4>To do'+(open.length?' ('+open.length+')':'')+'</h4>'+
      '<div class="con-grow">'+(open.length
        ? open.map(t=>'<div class="con-line"><em class="'+(t.priority===1?'now':'')+'">'+
            (t.priority===1?'NOW':'--')+'</em><span>'+esc(t.title)+'</span></div>').join('')
        : '<div class="con-none">Nothing on the list.</div>')+'</div></div>'+
    '<div class="con-pane" style="flex:1 1 0"><h4>Transcript</h4>'+
      '<div class="con-grow" id="con-log">'+(keep || '<div class="con-none">Nothing asked yet.</div>')+'</div></div>'+
    '<div class="con-pane" style="flex:0 0 auto"><h4>Latest reports</h4><div>'+
      ((runs||[]).length
        ? runs.slice(0,5).map(r=>'<div class="con-run"><span class="dot '+esc(r.status)+'"></span>'+
            '<span class="rt">'+esc(r.title)+'</span><span class="rw">'+when(r.run_at)+'</span></div>').join('')
        : '<div class="con-none">No reports yet.</div>')+'</div></div>';

  const oldest = (imps||[]).map(i=>i.added).sort()[0];
  document.getElementById('con-fresh').textContent =
    oldest ? 'Tradify uploaded '+ageOf(oldest)[0] : 'No Tradify upload yet';
  document.getElementById('con-stamp').textContent = 'Refreshes every two minutes';
  conSpeakInit();
  var ms = document.getElementById('con-micstate');
  if(ms) ms.textContent = (window.SpeechRecognition || window.webkitSpeechRecognition)
    ? 'Ready' : 'Not supported in this browser';
}

/* Speaking the answer is the difference between a dashboard you read and one you can
   use with your hands full, which on a work site is most of the time. Off by default:
   a screen in an office that talks unprompted is a screen somebody mutes forever. */
var conSpeak = false, conVoice = null;
function conSpeakInit(){
  var btn = document.getElementById('con-speak'), sel = document.getElementById('con-voice');
  if(!btn || !sel) return;
  if(!('speechSynthesis' in window)){
    btn.disabled = true; btn.textContent = 'N/A'; sel.disabled = true; return;
  }
  try{ conSpeak = localStorage.getItem('cc-speak') === '1'; }catch(e){}
  btn.classList.toggle('on', conSpeak); btn.textContent = conSpeak ? 'On' : 'Off';
  btn.addEventListener('click', function(){
    conSpeak = !conSpeak;
    try{ localStorage.setItem('cc-speak', conSpeak ? '1' : '0'); }catch(e){}
    btn.classList.toggle('on', conSpeak); btn.textContent = conSpeak ? 'On' : 'Off';
    if(!conSpeak && window.speechSynthesis) speechSynthesis.cancel();
  });
  function fill(){
    var vs = speechSynthesis.getVoices().filter(function(v){ return /^en/i.test(v.lang); });
    if(!vs.length) return;
    var saved = null; try{ saved = localStorage.getItem('cc-voice'); }catch(e){}
    sel.innerHTML = vs.map(function(v){
      return '<option value="'+esc(v.name)+'"'+(v.name===saved?' selected':'')+'>'+esc(v.name)+'</option>';
    }).join('');
    conVoice = vs.filter(function(v){ return v.name === (saved || sel.value); })[0] || vs[0];
  }
  fill();
  speechSynthesis.onvoiceschanged = fill;
  sel.addEventListener('change', function(){
    try{ localStorage.setItem('cc-voice', sel.value); }catch(e){}
    conVoice = speechSynthesis.getVoices().filter(function(v){ return v.name === sel.value; })[0] || null;
  });
}
function conSpeakOut(text){
  if(!conSpeak || !('speechSynthesis' in window) || !text) return;
  try{
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    if(conVoice) u.voice = conVoice;
    u.rate = 1.02;
    speechSynthesis.speak(u);
  }catch(e){}
}

/* A blank text field is the fastest way to make somebody close a page, and these
   double as a hint about what it can actually answer. */
const CON_SUGGESTIONS = [
  'Who owes us the most right now?',
  'How is cash tracking against last week?',
  'What should I chase today?',
  'Are we quoting more or less than a month ago?',
  'How old is my jobs data?',
  'What finished last week but has not been invoiced?'
];

function consolePage(){
  if(!document.getElementById('orb')) return;
  orb(); conClock(); conLoad();
  setInterval(conClock, 20000);
  setInterval(conLoad, 120000);

  const q = document.getElementById('con-q'), go = document.getElementById('con-go'),
        ans = document.getElementById('con-ans'), st = document.getElementById('con-state'),
        sub = document.getElementById('con-sub'), mic = document.getElementById('con-mic'),
        sugg = document.getElementById('con-sugg');

  sugg.innerHTML = CON_SUGGESTIONS.map(t=>'<button type="button">'+esc(t)+'</button>').join('');
  sugg.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    q.value = b.textContent; send();
  }));

  async function send(){
    const text = q.value.trim(); if(!text || conBusy) return;
    conBusy = true; go.disabled = true;
    if(sugg) sugg.innerHTML = '';
    q.value = ''; conSay('you', text);
    st.textContent = 'Thinking'; sub.textContent = 'Working';
    ans.className = 'con-ans'; ans.textContent = '';
    try{
      const r = await fetch('/api/ask',{method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json'},body:JSON.stringify({q:text})});
      const j = await r.json();
      const out = r.ok ? j.text : (j.error||'That did not work.');
      ans.className = 'con-ans' + (r.ok?'':' err');
      ans.textContent = out;
      conSay('cc', out);
      if(r.ok) conSpeakOut(out);
      st.textContent = r.ok ? 'Answered' : 'Could not answer';
    }catch(e){
      ans.className = 'con-ans err';
      ans.textContent = 'Could not reach the dashboard.';
      st.textContent = 'Offline';
    }
    sub.textContent = 'Standing by';
    conBusy = false; go.disabled = false; q.focus();
  }

  go.addEventListener('click', send);
  q.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); send(); }});

  /* Voice is a convenience, not a dependency: a browser without it just loses the button. */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ mic.style.display = 'none'; }
  else {
    let rec = null, on = false;
    mic.addEventListener('click', ()=>{
      if(on && rec){ rec.stop(); return; }
      rec = new SR(); rec.lang = 'en-AU'; rec.interimResults = false;
      rec.onstart = ()=>{ on = true; mic.textContent = 'Listening'; st.textContent = 'Listening'; };
      rec.onerror = ()=>{ st.textContent = 'Could not hear that'; };
      rec.onend = ()=>{ on = false; mic.textContent = 'Voice'; };
      rec.onresult = (e)=>{ q.value = e.results[0][0].transcript; send(); };
      try{ rec.start(); }catch(err){ st.textContent = 'Microphone not available'; }
    });
  }
  q.focus();
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
if(TAB==='home'){ home(); imports(); }
else if(TAB==='board'){ consolePage(); }
else if(TAB==='ask') ask();
else if(TAB==='reports') reports();
else publishedPage();
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
    if (p === "/api/import-status" && request.method === "GET" && bearerOk(request, env)) return apiImportStatus(env);
    // Cloud routines have no local disk, so they post the CSV in over the bearer too.
    if (p === "/api/import-upload" && request.method === "POST" && bearerOk(request, env)) return uploadImport(request, env);
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
    if (p === "/api/import-status") return apiImportStatus(env);
    if (p === "/api/ask" && request.method === "POST") return apiAsk(request, env);
    if (p === "/api/import-upload" && request.method === "POST") return uploadImport(request, env);
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

    // The wall-screen version: same page, no header and no tab rail.
    if (p === "/console") return shell(env, url, true);
    if (p === "/") return shell(env, url);
    return new Response("Not found", { status: 404 });
  },
};
