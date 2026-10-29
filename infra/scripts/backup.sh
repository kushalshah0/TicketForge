#!/usr/bin/env bash
set -euo pipefail
umask 077

root="${TICKETFORGE_BACKUP_ROOT:-/opt/ticketforge/backups}"
if [[ "$root" != /* || "$root" == / || -L "$root" ]]; then
  printf 'Backup root must be an absolute, non-symlink directory other than /.\n' >&2
  exit 2
fi
install -d -m 0700 "$root" "$root/archive" "$root/daily" "$root/weekly" "$root/failed"
exec 9>"$root/.lock"
flock -n 9 || { printf 'Another backup or restore is running.\n' >&2; exit 1; }

databases=(auth catalog booking payment notification)
database_bytes="$(docker exec --user postgres ticketforge-postgres psql -XAt \
  --dbname postgres --set ON_ERROR_STOP=1 \
  --command "SELECT sum(pg_database_size(datname)) FROM pg_database WHERE datname IN ('auth','catalog','booking','payment','notification')")"
available_bytes="$(df --output=avail -B1 "$root" | tail -n 1 | tr -d ' ')"
if [[ ! "$database_bytes" =~ ^[0-9]+$ || ! "$available_bytes" =~ ^[0-9]+$ ]] ||
  (( available_bytes < 1073741824 + 2 * database_bytes )); then
  printf 'Insufficient space: require 1 GiB reserve plus twice the database size.\n' >&2
  exit 1
fi

started="$(date -u +%FT%TZ)"
stage="$(mktemp -d "$root/.incomplete-XXXXXXXX")"
name="$(date -u +%Y%m%dT%H%M%SZ)-${stage##*-}"
preserve_failure() {
  local status=$?
  if [[ -n "$stage" ]]; then
    mv -- "$stage" "$root/failed/$name"
    printf 'Backup incomplete; evidence retained in failed/%s.\n' "$name" >&2
  fi
  exit "$status"
}
trap preserve_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for database in "${databases[@]}"; do
  timeout 630 docker exec --user postgres ticketforge-postgres \
    timeout --kill-after=10s 600 pg_dump --dbname "$database" --format custom --compress 6 --lock-wait-timeout 10s \
    > "$stage/$database.dump"
  timeout 60 docker exec -i --user postgres ticketforge-postgres \
    pg_restore --list < "$stage/$database.dump" > /dev/null
done
(
  cd "$stage"
  sha256sum -- *.dump > SHA256SUMS
)
printf 'started_utc=%s\ncompleted_utc=%s\ndatabase_bytes=%s\nformat=pg_dump custom compressed\n' \
  "$started" "$(date -u +%FT%TZ)" "$database_bytes" > "$stage/metadata"
docker exec --user postgres ticketforge-postgres pg_dump --version >> "$stage/metadata"
sync -f "$stage"
mv -- "$stage" "$root/archive/$name"
stage=''

update_view() {
  local directory="$1" key="$2" replace="$3" link temporary
  link="$directory/$key"
  if [[ -e "$link" && ! -L "$link" ]]; then
    printf 'Refusing to overwrite non-symlink retention entry: %s\n' "$link" >&2
    return 1
  fi
  if [[ "$replace" == yes || ! -L "$link" ]]; then
    temporary="$directory/.${name}.link"
    ln -s "../archive/$name" "$temporary"
    mv -T -- "$temporary" "$link"
  fi
}
update_view "$root/daily" "$(date -u +%F)" yes
update_view "$root/weekly" "$(date -u +%G-W%V)" no
for view in daily weekly; do
  keep=7
  [[ "$view" == weekly ]] && keep=4
  mapfile -t links < <(find "$root/$view" -mindepth 1 -maxdepth 1 -type l -printf '%f\n' | LC_ALL=C sort -r)
  for ((index=keep; index<${#links[@]}; index++)); do
    entry="${links[index]}"
    if [[ "$entry" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ || "$entry" =~ ^[0-9]{4}-W[0-9]{2}$ ]]; then
      unlink -- "$root/$view/$entry"
    fi
  done
done
printf 'Backup complete: %s/archive/%s (five databases; all older snapshots preserved).\n' "$root" "$name"
