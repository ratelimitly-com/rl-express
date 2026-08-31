#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
TOTAL_REQUESTS="${TOTAL_REQUESTS:-20}"
CONCURRENCY="${CONCURRENCY:-10}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-5}"

for command in curl xargs; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: $command is required." >&2
    exit 1
  fi
done

for name in TOTAL_REQUESTS CONCURRENCY TIMEOUT_SECONDS; do
  value="${!name}"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: $name must be a positive integer." >&2
    exit 1
  fi
done

base="${BASE_URL%/}"
health_code="$(curl -sS -o /dev/null -m "$TIMEOUT_SECONDS" -w '%{http_code}' "$base/health" || true)"
if [[ "$health_code" != "200" ]]; then
  echo "ERROR: sample application is not ready (health status: $health_code)." >&2
  exit 1
fi

status_file="$(mktemp)"
trap 'rm -f "$status_file"' EXIT

echo "Sending $TOTAL_REQUESTS POST requests to $base/rate-demo with concurrency $CONCURRENCY."
export RATE_DEMO_URL="$base/rate-demo" TIMEOUT_SECONDS
seq "$TOTAL_REQUESTS" | xargs -P"$CONCURRENCY" -I{} bash -c '
  curl -sS -X POST -o /dev/null -m "$TIMEOUT_SECONDS" -w "%{http_code}\n" "$RATE_DEMO_URL" || echo 000
' >> "$status_file"

allowed="$(grep -c '^200$' "$status_file" || true)"
denied="$(grep -c '^429$' "$status_file" || true)"
other="$(grep -Evc '^(200|429)$' "$status_file" || true)"

echo "allowed=$allowed denied=$denied other=$other"

if (( allowed == 0 )); then
  echo "FAIL: no granted request was observed." >&2
  exit 2
fi
if (( denied == 0 )); then
  echo "FAIL: no rejected request was observed." >&2
  exit 2
fi
if (( other != 0 )); then
  echo "FAIL: unexpected HTTP statuses were observed:" >&2
  grep -Ev '^(200|429)$' "$status_file" | sort | uniq -c >&2
  exit 2
fi

echo "PASS: the sample produced both grants and resource rejections."
