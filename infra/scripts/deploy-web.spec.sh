#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
tag_one=0123456789abcdef0123456789abcdef01234567
tag_two=abcdef0123456789abcdef0123456789abcdef01
source_one="/tmp/ticketforge-web-$tag_one"
source_two="/tmp/ticketforge-web-$tag_two"
trap 'rm -rf -- "$root" "$source_one" "$source_two"' EXIT

mkdir -p "$source_one" "$source_two"
printf 'first\n' > "$source_one/index.html"
printf 'second\n' > "$source_two/index.html"

TICKETFORGE_WEB_ROOT="$root/web" bash infra/scripts/deploy-web.sh "$source_one" "$tag_one"
[[ -L "$root/web/ticketforge" ]]
[[ "$(cat "$root/web/ticketforge/index.html")" == first ]]

TICKETFORGE_WEB_ROOT="$root/web" bash infra/scripts/deploy-web.sh "$source_two" "$tag_two"
[[ "$(cat "$root/web/ticketforge/index.html")" == second ]]
[[ "$(cat "$root/web/.ticketforge-releases/$tag_one/index.html")" == first ]]
printf 'Web release staging and atomic switching checks passed.\n'
