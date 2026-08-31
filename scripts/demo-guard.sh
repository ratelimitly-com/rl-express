#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
REPEAT="${REPEAT:-12}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-5}"

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required." >&2
  exit 1
fi

for name in REPEAT TIMEOUT_SECONDS; do
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

allowed=0
denied=0
other=0

echo "Sending $REPEAT sequential POST requests to $base/latency-demo."
for i in $(seq 1 "$REPEAT"); do
  response_file="$(mktemp)"
  result="$(curl -sS -X POST -o "$response_file" -m "$TIMEOUT_SECONDS" -w '%{http_code} %{time_total}' "$base/latency-demo" || true)"
  code="${result%% *}"
  duration="${result#* }"

  case "$code" in
    200) ((allowed += 1)) || true ;;
    429) ((denied += 1)) || true ;;
    *) ((other += 1)) || true ;;
  esac

  printf 'request=%d status=%s duration_s=%s body=' "$i" "$code" "$duration"
  tr '\n' ' ' < "$response_file"
  printf '\n'
  rm -f "$response_file"
done

echo "allowed=$allowed denied=$denied other=$other"

if (( allowed == 0 )); then
  echo "FAIL: no granted request was observed." >&2
  exit 2
fi
if (( denied == 0 )); then
  echo "FAIL: no latency-guard rejection was observed." >&2
  exit 2
fi
if (( other != 0 )); then
  echo "FAIL: unexpected HTTP statuses were observed." >&2
  exit 2
fi

echo "PASS: measured reports caused the latency guard to reject later work."
