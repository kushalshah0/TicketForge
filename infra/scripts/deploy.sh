#!/usr/bin/env bash
set -euo pipefail

root="${TICKETFORGE_ROOT:-/opt/ticketforge}"
env_file="$root/.env"
compose_file="$root/infra/compose/docker-compose.prod.yml"
last_good_file="$root/.last_good_tag"
last_good_prefix_file="$root/.last_good_image_prefix"
tag="${1:-}"

if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; then
  printf 'Usage: %s <image-tag>\n' "$0" >&2
  exit 2
fi
if [[ ! -r "$env_file" ]]; then
  printf 'Missing deployment env file: %s\n' "$env_file" >&2
  exit 1
fi

previous_tag="$(cat "$last_good_file" 2>/dev/null || awk -F= '$1 == "TAG" { print $2; exit }' "$env_file")"
previous_prefix="$(cat "$last_good_prefix_file" 2>/dev/null || awk -F= '$1 == "IMAGE_PREFIX" { print $2; exit }' "$env_file")"
image_prefix="${IMAGE_PREFIX:-${previous_prefix:-ticketforge}}"
previous_prefix="${previous_prefix:-$image_prefix}"
if [[ "$previous_tag" == "$tag" ]]; then
  printf 'Use a new deployment tag; %s is already the last healthy tag.\n' "$tag" >&2
  exit 2
fi
services=(auth catalog booking payment notification gateway)
compose() {
  local active_tag="$1"
  local active_prefix="$2"
  shift
  shift
  TAG="$active_tag" IMAGE_PREFIX="$active_prefix" docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

previous_services=()
new_services=()
for service in "${services[@]}"; do
  if [[ -n "$(compose "$previous_tag" "$previous_prefix" ps --status running --quiet "$service")" ]]; then
    previous_services+=("$service")
  else
    new_services+=("$service")
  fi
done

rollback() {
  if [[ -n "$previous_tag" && "$previous_tag" != "$tag" ]]; then
    printf 'Deployment failed; restoring tag %s\n' "$previous_tag" >&2
    if ((${#new_services[@]})); then
      compose "$tag" "$image_prefix" stop "${new_services[@]}" || return 1
    fi
    if ((${#previous_services[@]})); then
      compose "$previous_tag" "$previous_prefix" pull "${previous_services[@]}" || return 1
      compose "$previous_tag" "$previous_prefix" up --detach --no-build --no-deps --wait --wait-timeout 120 "${previous_services[@]}" || return 1
    fi
  fi
}

if ! compose "$tag" "$image_prefix" pull "${services[@]}" migrate-auth migrate-catalog migrate-booking migrate-payment migrate-notification; then
  exit 1
fi
if ! compose "$tag" "$image_prefix" up --detach --no-build --wait --wait-timeout 180 "${services[@]}"; then
  rollback
  exit 1
fi
public_hostname="$(awk -F= '$1 == "PUBLIC_HOSTNAME" { print $2; exit }' "$env_file")"
auth_status=''
for attempt in {1..15}; do
  auth_status="$(curl --silent --connect-timeout 5 --max-time 10 --resolve "${public_hostname}:443:127.0.0.1" \
    --output /dev/null --write-out '%{http_code}' \
    --header 'Content-Type: application/json' \
    --data '{}' "https://${public_hostname}/api/auth/login" 2>/dev/null || true)"
  [[ "$auth_status" == '401' ]] && break
  sleep 1
done
if [[ "$auth_status" != '401' ]]; then
  printf 'Auth route did not become ready; got HTTP %s\n' "${auth_status:-no response}" >&2
  rollback
  exit 1
fi
if ! PUBLIC_HOSTNAME="$(awk -F= '$1 == "PUBLIC_HOSTNAME" { print $2; exit }' "$env_file")" \
  timeout 180 "$root/infra/scripts/smoke.sh"; then
  rollback
  exit 1
fi

for pair in "$last_good_prefix_file:$image_prefix" "$last_good_file:$tag"; do
  file="${pair%%:*}"
  value="${pair#*:}"
  temporary_file="$(mktemp "$file.XXXXXX")"
  printf '%s\n' "$value" > "$temporary_file"
  chmod 0600 "$temporary_file"
  mv -f "$temporary_file" "$file"
done
printf 'Deployment %s is healthy.\n' "$tag"