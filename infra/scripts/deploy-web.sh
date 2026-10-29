#!/usr/bin/env bash
set -euo pipefail

source_dir="${1:-}"
tag="${2:-}"
if [[ ! "$source_dir" =~ ^/tmp/ticketforge-web-[0-9a-f]{40}$ ||
  ! "$tag" =~ ^[0-9a-f]{40}$ ||
  ! -d "$source_dir" ]]; then
  printf 'Usage: %s /tmp/ticketforge-web-<git-sha> <git-sha>\n' "$0" >&2
  exit 2
fi

web_root="${TICKETFORGE_WEB_ROOT:-/srv/web}"
if [[ "$web_root" != /* || "$web_root" == / || -L "$web_root" ]]; then
  printf 'Web root must be an absolute, non-symlink directory other than /.\n' >&2
  exit 2
fi
release_root="$web_root/.ticketforge-releases"
stage="$release_root/.incomplete-$tag"
release="$release_root/$tag"
current="$web_root/ticketforge"
temporary_link="$web_root/.ticketforge-$tag"
legacy_directory=''

if [[ -e "$release" || -e "$temporary_link" ]]; then
  printf 'Web release already exists for %s.\n' "$tag" >&2
  exit 1
fi

install -d -m 0755 "$release_root"
cleanup() {
  local status=$?
  rm -rf -- "$stage" "$temporary_link"
  if ((status != 0)) && [[ -n "$legacy_directory" && ! -e "$current" ]]; then
    mv -- "$legacy_directory" "$current"
  fi
  return "$status"
}
trap cleanup EXIT

install -d -m 0755 "$stage"
rsync -rlt --delete --chown=root:root "$source_dir/" "$stage/"
mv -- "$stage" "$release"

if [[ -d "$current" && ! -L "$current" ]]; then
  legacy_directory="$release_root/legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  mv -- "$current" "$legacy_directory"
fi

ln -s ".ticketforge-releases/$tag" "$temporary_link"
mv -Tf -- "$temporary_link" "$current"
printf 'Web release %s is active.\n' "$tag"
