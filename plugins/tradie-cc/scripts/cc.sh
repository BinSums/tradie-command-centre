#!/usr/bin/env bash
# Talk to the Command Centre. Every call goes through here so no token is ever
# typed on a command line, pasted into a prompt, or left in shell history.
#
#   cc.sh post   /ingest  payload.json     bearer POST from a file (the normal way)
#   cc.sh postj  /api/todo '{"title":"x"}' bearer POST, inline JSON, short bodies only
#   cc.sh get    /api/runs                 bearer GET
#
# Reads CC_URL and CC_TOKEN from ~/.command-centre/env, written by /tradie-cc:setup.
set -euo pipefail

# Two homes for the same two values. On a laptop they live in a file written by setup.
# In a cloud routine there is no home directory and no setup has ever run there, so they
# arrive as environment variables set on the cloud environment. Environment wins if both
# are present, because that is the deliberate, per-run one.
ENV_FILE="${CC_ENV_FILE:-$HOME/.command-centre/env}"
if [[ -z "${CC_URL:-}" || -z "${CC_TOKEN:-}" ]]; then
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
  fi
fi

if [[ -z "${CC_URL:-}" || -z "${CC_TOKEN:-}" ]]; then
  echo "CC_URL and CC_TOKEN are not set." >&2
  echo "On this machine they come from $ENV_FILE, written by /tradie-cc:setup." >&2
  echo "In a cloud routine they must be set as environment variables on the environment." >&2
  exit 1
fi

verb="${1:-}"; path="${2:-}"; arg="${3:-}"

# A browser user-agent on purpose. Cloudflare's edge will 403 a raw scripted POST,
# especially a large HTML body, and that failure looks exactly like a bad token.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

case "$verb" in
  post)
    [[ -f "$arg" ]] || { echo "No such file: $arg" >&2; exit 1; }
    curl -sS -X POST "$CC_URL$path" -H "Authorization: Bearer $CC_TOKEN" \
      -H "content-type: application/json" -A "$UA" --data-binary "@$arg" ;;
  postj)
    curl -sS -X POST "$CC_URL$path" -H "Authorization: Bearer $CC_TOKEN" \
      -H "content-type: application/json" -A "$UA" -d "$arg" ;;
  get)
    curl -sS "$CC_URL$path" -H "Authorization: Bearer $CC_TOKEN" -A "$UA" ;;
  *)
    echo "Usage: cc.sh {post|postj|get} <path> [file|json]" >&2; exit 1 ;;
esac
