#!/usr/bin/env bash
set -euo pipefail

root="${TICKETFORGE_ROOT:-/opt/ticketforge}"
env_file="$root/.env"
compose_file="$root/infra/compose/docker-compose.prod.yml"
last_good_file="$root/.last_good_tag"
last_good_prefix_file="$root/.last_good_image_prefix"
tag="${1:-}"

if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; then
  printf 'Usage: %s <image-tag> [service ...]\n' "$0" >&2
  exit 2
fi
if [[ ! -r "$env_file" ]]; then
  printf 'Missing deployment env file: %s\n' "$env_file" >&2
  exit 1
fi

previous_tag="$(cat "$last_good_file" 2>/dev/null || awk -F= '$1 == "TAG" { print $2; exit }' "$env_file")"
stored_previous_prefix="$(cat "$last_good_prefix_file" 2>/dev/null || awk -F= '$1 == "IMAGE_PREFIX" { print $2; exit }' "$env_file")"
image_prefix="${IMAGE_PREFIX:-${stored_previous_prefix:-ticketforge}}"
previous_prefix="${PREVIOUS_IMAGE_PREFIX:-${stored_previous_prefix:-ticketforge}}"
if [[ "$previous_tag" == "$tag" ]]; then
  printf 'Use a new deployment tag; %s is already the last healthy tag.\n' "$tag" >&2
  exit 2
fi
skip_image_pull="${SKIP_IMAGE_PULL:-0}"
if [[ "$skip_image_pull" != 0 && "$skip_image_pull" != 1 ]]; then
  printf 'SKIP_IMAGE_PULL must be 0 or 1.\n' >&2
  exit 2
fi
services=(auth catalog booking payment notification gateway)
declare -A migration_for=(
  [auth]=migrate-auth
  [catalog]=migrate-catalog
  [booking]=migrate-booking
  [payment]=migrate-payment
  [notification]=migrate-notification
)
selected_services=("${@:2}")
if ((${#selected_services[@]} == 0)); then
  selected_services=("${services[@]}")
fi

declare -A selected=()
for service in "${selected_services[@]}"; do
  case "$service" in
    auth|catalog|booking|payment|notification|gateway) ;;
    *)
      printf 'Unknown service: %s\n' "$service" >&2
      exit 2
      ;;
  esac
  if [[ -n "${selected[$service]:-}" ]]; then
    printf 'Unknown or duplicate service: %s\n' "$service" >&2
    exit 2
  fi
  selected["$service"]=1
done

compose() {
  local active_tag="$1"
  local active_prefix="$2"
  shift
  shift
  TAG="$active_tag" IMAGE_PREFIX="$active_prefix" docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

service_state_dir="$root/.last_good_services"
mkdir -p "$service_state_dir"
chmod 0700 "$service_state_dir"
read_service_state() {
  local service="$1"
  local field="$2"
  local fallback="$3"
  local path="$service_state_dir/$service.$field"
  if [[ -r "$path" ]]; then
    cat "$path"
  else
    printf '%s' "$fallback"
  fi
}
write_service_state() {
  local service="$1"
  local field="$2"
  local value="$3"
  local path="$service_state_dir/$service.$field"
  local temporary_file
  temporary_file="$(mktemp "$path.XXXXXX")"
  printf '%s\n' "$value" > "$temporary_file"
  chmod 0600 "$temporary_file"
  mv -f "$temporary_file" "$path"
}

verify_local_images() {
  local active_tag="$1"
  local active_prefix="$2"
  local include_migrations="${3:-0}"
  local service
  for service in "${selected_services[@]}"; do
    docker image inspect "${active_prefix}/ticketforge-${service}:${active_tag}" >/dev/null
    if [[ -n "${migration_for[$service]:-}" && "$include_migrations" == 1 ]]; then
      docker image inspect "${active_prefix}/ticketforge-${service}-migrate:${active_tag}" >/dev/null
    fi
  done
}

declare -A previous_tag_for=()
declare -A previous_prefix_for=()
declare -A previously_running=()
for service in "${services[@]}"; do
  previous_tag_for["$service"]="$(read_service_state "$service" tag "$previous_tag")"
  previous_prefix_for["$service"]="$(read_service_state "$service" prefix "$previous_prefix")"
  if [[ ! "${previous_tag_for[$service]}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ||
    ! "${previous_prefix_for[$service]}" =~ ^[A-Za-z0-9./_-]+$ ]]; then
    printf 'Invalid saved image state for service %s.\n' "$service" >&2
    exit 1
  fi
  write_service_state "$service" tag "${previous_tag_for[$service]}"
  write_service_state "$service" prefix "${previous_prefix_for[$service]}"
  if [[ -n "$(compose "${previous_tag_for[$service]}" "${previous_prefix_for[$service]}" ps --status running --quiet "$service")" ]]; then
    previously_running["$service"]=1
  else
    previously_running["$service"]=0
  fi
done

rollback() {
  if [[ -n "$previous_tag" && "$previous_tag" != "$tag" ]]; then
    printf 'Deployment failed; restoring selected services to their last known images.\n' >&2
    local service
    for service in "${selected_services[@]}"; do
      if [[ "${previously_running[$service]}" == 1 ]]; then
        if [[ "$skip_image_pull" == 0 ]]; then
          compose "${previous_tag_for[$service]}" "${previous_prefix_for[$service]}" pull "$service" || return 1
        fi
        compose "${previous_tag_for[$service]}" "${previous_prefix_for[$service]}" \
          up --detach --no-build --no-deps --wait --wait-timeout 120 "$service" || return 1
      else
        compose "$tag" "$image_prefix" stop "$service" || return 1
      fi
    done
  fi
}

if [[ "$skip_image_pull" == 1 ]]; then
  verify_local_images "$tag" "$image_prefix" 1
  for service in "${selected_services[@]}"; do
    docker image inspect "${previous_prefix_for[$service]}/ticketforge-${service}:${previous_tag_for[$service]}" >/dev/null
  done
else
  images=()
  for service in "${selected_services[@]}"; do
    images+=("$service")
    if [[ -n "${migration_for[$service]:-}" ]]; then
      images+=("${migration_for[$service]}")
    fi
  done
  if ! compose "$tag" "$image_prefix" pull "${images[@]}"; then
    exit 1
  fi
fi

if ((${#selected_services[@]} < ${#services[@]})); then
  for service in "${selected_services[@]}"; do
    if [[ -n "${migration_for[$service]:-}" ]] &&
      ! compose "$tag" "$image_prefix" run --rm --no-deps "${migration_for[$service]}"; then
      rollback
      exit 1
    fi
    if ! compose "$tag" "$image_prefix" up --detach --no-build --no-deps \
      --wait --wait-timeout 180 "$service"; then
      rollback
      exit 1
    fi
  done
elif ! compose "$tag" "$image_prefix" up --detach --no-build --wait --wait-timeout 180 "${selected_services[@]}"; then
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

for service in "${selected_services[@]}"; do
  write_service_state "$service" tag "$tag"
  write_service_state "$service" prefix "$image_prefix"
done
for pair in "$last_good_prefix_file:$image_prefix" "$last_good_file:$tag"; do
  file="${pair%%:*}"
  value="${pair#*:}"
  temporary_file="$(mktemp "$file.XXXXXX")"
  printf '%s\n' "$value" > "$temporary_file"
  chmod 0600 "$temporary_file"
  mv -f "$temporary_file" "$file"
done
printf 'Deployment %s is healthy.\n' "$tag"