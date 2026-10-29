#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  printf '%s\n' 'Run this script as root.' >&2
  exit 2
fi

site_file="${NGINX_SITE_FILE:-/etc/nginx/sites-available/default}"
snippet_file="/etc/nginx/snippets/ticketforge-api.conf"
web_snippet_file="/etc/nginx/snippets/ticketforge-web.conf"
include_line="include $snippet_file;"
backup_dir="$(mktemp -d)"
files=("$site_file" "$snippet_file" "$web_snippet_file")
for index in "${!files[@]}"; do
  if [[ -e "${files[$index]}" ]]; then
    cp --preserve=all "${files[$index]}" "$backup_dir/$index"
  fi
done

cleanup() {
  local status=$?
  for index in "${!files[@]}"; do
    if ((status != 0)); then
      if [[ -e "$backup_dir/$index" ]]; then
        cp --preserve=all "$backup_dir/$index" "${files[$index]}"
      else
        rm -f "${files[$index]}"
      fi
    fi
    rm -f "$backup_dir/$index"
  done
  rmdir "$backup_dir"
  return "$status"
}
trap cleanup EXIT

install -D -o root -g root -m 0644 "$(dirname "$0")/ticketforge-api.conf" "$snippet_file"
install -D -o root -g root -m 0644 "$(dirname "$0")/ticketforge-web.conf" "$web_snippet_file"

if ! grep -Fxq "    $include_line" "$site_file"; then
  sed -i "/^[[:space:]]*location \/ {\|^[[:space:]]*location \/\s*{/i\\    $include_line" "$site_file"
fi

nginx -t
systemctl reload nginx