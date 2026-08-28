#!/usr/bin/env sh
set -eu

usage() {
  echo "Usage: $0 <api-origin> <allowed-web-origin>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage

api_origin="${1%/}"
allowed_origin="${2%/}"

case "$api_origin" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "API origin must use HTTPS outside localhost." >&2; exit 2 ;;
esac
case "$allowed_origin" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "Allowed Web origin must be an HTTP(S) origin." >&2; exit 2 ;;
esac

temporary_directory="$(mktemp -d)"
headers="$temporary_directory/headers"
body="$temporary_directory/body"
trap 'rm -f "$headers" "$body"; rmdir "$temporary_directory"' EXIT

assert_sanitized() {
  if grep -Eiq 'stack|sqlstate|node_modules|/workspace/|select[[:space:]].*[[:space:]]from' "$body"; then
    echo "Security response leaked implementation details." >&2
    exit 1
  fi
}

status="$(curl --silent --show-error --dump-header "$headers" --output "$body" \
  --write-out '%{http_code}' "$api_origin/health/live")"
[ "$status" = "200" ] || { echo "Health endpoint returned $status." >&2; exit 1; }
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$headers"
grep -Eiq '^x-frame-options:[[:space:]]*(SAMEORIGIN|DENY)' "$headers"
grep -Eiq '^content-security-policy:' "$headers"
grep -Eiq '^permissions-policy:.*camera=\(\).*microphone=\(\)' "$headers"
grep -Eiq '^cache-control:.*no-store' "$headers"
case "$api_origin" in
  https://*) grep -Eiq '^strict-transport-security:' "$headers" ;;
esac

status="$(curl --silent --show-error --dump-header "$headers" --output "$body" \
  --write-out '%{http_code}' "$api_origin/api/v1/auth/sessions/current")"
[ "$status" = "401" ] || { echo "Protected session endpoint returned $status." >&2; exit 1; }
assert_sanitized

status="$(curl --silent --show-error --output "$body" --write-out '%{http_code}' \
  --request POST "$api_origin/api/v1/auth/password-resets" \
  --header 'Content-Type: application/json' \
  --header 'Origin: https://attacker.invalid' \
  --data '{"email":"security@example.test"}')"
[ "$status" = "403" ] || { echo "Untrusted Origin returned $status." >&2; exit 1; }
assert_sanitized

status="$(curl --silent --show-error --output "$body" --write-out '%{http_code}' \
  --request POST "$api_origin/api/v1/auth/sessions" \
  --header 'Content-Type: application/json' \
  --header "Origin: $allowed_origin" \
  --data '{"email":')"
[ "$status" = "400" ] || { echo "Malformed JSON returned $status." >&2; exit 1; }
assert_sanitized

rate_limited=false
attempt=1
while [ "$attempt" -le 12 ]; do
  status="$(curl --silent --show-error --output "$body" --write-out '%{http_code}' \
    --request POST "$api_origin/api/v1/auth/sessions" \
    --header 'Content-Type: application/json' \
    --header "Origin: $allowed_origin" \
    --data '{"email":"security-probe@example.test","password":"invalid-security-probe"}')"
  assert_sanitized
  if [ "$status" = "429" ]; then
    rate_limited=true
    break
  fi
  [ "$status" = "401" ] || { echo "Invalid login returned $status." >&2; exit 1; }
  attempt=$((attempt + 1))
done
[ "$rate_limited" = "true" ] || { echo "Login rate limit was not enforced." >&2; exit 1; }

echo "Focused security smoke passed: $api_origin"
