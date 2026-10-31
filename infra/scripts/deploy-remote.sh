#!/usr/bin/env bash
set -euo pipefail

root="${1:-}"
image_prefix="${2:-}"
tag="${3:-}"
shift 3 || true

if [[ ! "$root" =~ ^/opt/ticketforge-release-[A-Za-z0-9_.-]+$ ||
  ! "$image_prefix" =~ ^ghcr\.io/[a-z0-9][a-z0-9-]*$ ||
  ! "$tag" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Usage: %s <release-root> <ghcr-owner-prefix> <git-sha>\n' "$0" >&2
  exit 2
fi

IFS= read -r registry_token || [[ -n "${registry_token:-}" ]]
if [[ -z "${registry_token:-}" ]]; then
  printf 'GHCR read token is required on standard input.\n' >&2
  exit 1
fi

docker_config="$(mktemp -d /run/ticketforge-docker.XXXXXX)"
chmod 0700 "$docker_config"
cleanup() {
  docker --config "$docker_config" logout ghcr.io >/dev/null 2>&1 || true
  rm -rf -- "$docker_config"
}
trap cleanup EXIT

registry_owner="${image_prefix#ghcr.io/}"
printf '%s' "$registry_token" | docker --config "$docker_config" login ghcr.io \
  --username "$registry_owner" --password-stdin
unset registry_token

if [[ ! -r "$root/.env" ]]; then
  printf 'Protected deployment env file is missing at %s/.env\n' "$root" >&2
  exit 1
fi

DOCKER_CONFIG="$docker_config" TICKETFORGE_ROOT="$root" IMAGE_PREFIX="$image_prefix" \
  bash "$root/infra/scripts/deploy.sh" "$tag" "$@"
