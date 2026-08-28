-- Command Centre Core: the business-agnostic substrate.
--
-- Everything here is about a business watching itself. Nothing in this file knows
-- what the business SELLS. Vertical tables (jobs, stock, congregation, whatever)
-- go in a separate migration so this one can be reused untouched.

-- Append-only history of every routine run. Nothing is overwritten, so the dashboard
-- can show today, last Tuesday, or the whole trail.
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id     TEXT NOT NULL,              -- stable slug, one per routine
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ok', -- ok | warn | alert | info
  summary_html TEXT,                       -- the card teaser
  detail_html  TEXT,                       -- the FULL run output, shown when opened
  payload      TEXT,                       -- optional JSON
  link         TEXT,
  run_at       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_skill_time ON runs(skill_id, run_at);
CREATE INDEX IF NOT EXISTS idx_runs_time ON runs(run_at);

-- Daily metric series. One row per (date, key). Upserted, so a re-run for the same
-- day corrects rather than duplicates. value NULL means "no data", never zero.
CREATE TABLE IF NOT EXISTS metrics (
  date  TEXT NOT NULL,
  key   TEXT NOT NULL,
  value REAL,
  PRIMARY KEY (date, key)
);
CREATE INDEX IF NOT EXISTS idx_metrics_key_date ON metrics(key, date);

-- What each metric key means, so the dashboard can label and format itself without
-- a code change every time a routine starts sending something new.
CREATE TABLE IF NOT EXISTS metric_meta (
  key    TEXT PRIMARY KEY,
  label  TEXT NOT NULL,
  unit   TEXT,                             -- money | count | percent | hours | days
  better TEXT DEFAULT 'up',                -- up | down | flat
  sort   INTEGER DEFAULT 100,
  tile   INTEGER DEFAULT 1,                -- 1 = show on Home
  grp    TEXT DEFAULT 'Numbers'            -- column heading on the Board, e.g. Money | Work
);

-- Dated recommendations at the top of Home. Replaced wholesale per (date, area) so a
-- re-run corrects rather than stacks.
CREATE TABLE IF NOT EXISTS notes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT NOT NULL,
  area     TEXT NOT NULL,                  -- free text, e.g. cash | jobs | quotes | ops
  severity TEXT NOT NULL,                  -- do-now | watch | good
  title    TEXT NOT NULL,
  body     TEXT,
  metric   TEXT                            -- the evidence, e.g. "18 days vs 30"
);
CREATE INDEX IF NOT EXISTS idx_notes_date ON notes(date);

-- The shared to-do list. Routines add, humans tick. `done` NULL means open:
-- read the NULLness, never a truthy `done` field.
CREATE TABLE IF NOT EXISTS todos (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  title    TEXT NOT NULL,
  detail   TEXT,
  source   TEXT NOT NULL DEFAULT 'routine', -- routine | human | assistant
  priority INTEGER NOT NULL DEFAULT 2,      -- 1 high, 2 normal, 3 low
  due      TEXT,
  added    TEXT NOT NULL DEFAULT (datetime('now')),
  done     TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_open ON todos(done, priority);

-- Two-way channel between the owner and the assistant. The owner types or speaks
-- something; the next routine run picks it up, acts, and marks it done.
CREATE TABLE IF NOT EXISTS assistant_queue (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL DEFAULT 'note',    -- note (context) | task (do this)
  body    TEXT NOT NULL,
  added   TEXT NOT NULL DEFAULT (datetime('now')),
  done    TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_open ON assistant_queue(done, id);

-- Full standalone pages rendered by a routine and served inside the shell as a tab.
-- This is how a rich report becomes part of the dashboard without a code change.
CREATE TABLE IF NOT EXISTS pages (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  html       TEXT NOT NULL,
  nav        INTEGER NOT NULL DEFAULT 1,   -- 1 = show as a tab
  sort       INTEGER NOT NULL DEFAULT 100,
  updated_at TEXT NOT NULL
);

-- The business context pack, mirrored from the client's own notes so the cloud
-- assistant knows what the local one knows.
CREATE TABLE IF NOT EXISTS kb (
  slug    TEXT PRIMARY KEY,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  updated TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw CSV drops from systems with no API (Tradify exports, spreadsheet saves).
-- Kept whole and dated so a routine can diff this week against last week, and so
-- "where did that number come from" always has an answer.
CREATE TABLE IF NOT EXISTS imports (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  source    TEXT NOT NULL,                 -- tradify-jobs | tradify-invoices | quotes-xlsx
  filename  TEXT,
  rows      INTEGER,
  csv       TEXT NOT NULL,
  period    TEXT,                          -- what the export covers, if known
  added     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source, added);
