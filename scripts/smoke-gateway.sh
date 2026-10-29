#!/usr/bin/env bash
set -euo pipefail

gateway_url="${GATEWAY_URL:-http://127.0.0.1:3000}"
customer_token="${SMOKE_CUSTOMER_TOKEN:-}"

if [[ -z "$customer_token" ]]; then
  printf '%s\n' 'Set SMOKE_CUSTOMER_TOKEN to a valid customer access token.' >&2
  exit 2
fi

request_status() {
  local method="$1"
  local path="$2"
  shift 2
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --request "$method" "$gateway_url$path" "$@"
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL %s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
  printf 'PASS %s: %s\n' "$label" "$actual"
}

assert_status 401 "$(request_status GET /api/bookings)" 'unauthenticated request'
assert_status 403 "$(request_status GET /api/organizer/events \
  --header "Authorization: Bearer $customer_token")" 'wrong-role request'

limited_status=''
for attempt in {1..11}; do
  limited_status="$(request_status POST /api/auth/login \
    --header 'Content-Type: application/json' --data '{}')"
done
assert_status 429 "$limited_status" 'auth rate limit'

if [[ "${EXPECT_DOWNSTREAM_FAILURE:-false}" == 'true' ]]; then
  assert_status 503 "$(request_status GET /api/events)" 'downstream unavailable'
fi