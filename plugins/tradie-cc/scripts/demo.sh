#!/usr/bin/env bash
# Run the dashboard on this machine with realistic made-up data, so it can be shown to
# someone before they commit to installing anything. Touches nothing in the cloud and
# needs no Cloudflare account.
#
#   bash scripts/demo.sh      then http://127.0.0.1:8799  (password: demo)
#
# Everything it writes goes in a scratch copy, never into the plugin folder itself:
# a local plugin install copies whatever is sitting there straight to the client.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../worker" && pwd)"
SEED="$(cd "$(dirname "$0")" && pwd)/demo-seed.sql"
RUN="${TMPDIR:-/tmp}/cc-demo"

rm -rf "$RUN"; mkdir -p "$RUN"
cp "$SRC/worker.js" "$SRC/schema.sql" "$RUN/"
sed -e 's/__WORKER_NAME__/cc-demo/' -e 's/__BUSINESS_NAME__/Demo Landscaping/' \
    -e 's|__TIMEZONE__|Australia/Sydney|' -e 's/__CURRENCY__/AUD/' \
    -e 's/__DB_NAME__/cc-demo-db/' -e 's/__DB_ID__/local-demo/' \
    "$SRC/wrangler.toml.template" > "$RUN/wrangler.toml"
cat > "$RUN/.dev.vars" <<'EOF'
DASH_PASSWORD=demo
COOKIE_SECRET=demo-cookie-secret-local-only
INGEST_SECRET=demo-ingest-secret-local-only
EOF

cd "$RUN"
echo "Building the local database..."
npx --yes wrangler@latest d1 execute cc-demo-db --local --file=schema.sql >/dev/null
npx --yes wrangler@latest d1 execute cc-demo-db --local --file="$SEED" >/dev/null

echo
echo "  Dashboard:  http://127.0.0.1:8799"
echo "  Password:   demo"
echo "  Scratch:    $RUN"
echo
npx --yes wrangler@latest dev --local --port 8799
