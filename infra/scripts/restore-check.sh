#!/usr/bin/env bash
set -euo pipefail
umask 077

root="${TICKETFORGE_BACKUP_ROOT:-/opt/ticketforge/backups}"
name="${1:-}"
if [[ "$root" != /* || "$root" == / || -L "$root" ||
  ! "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]+$ ]]; then
  printf 'Usage: %s <snapshot-name>; root must be an absolute non-symlink directory.\n' "$0" >&2
  exit 2
fi
snapshot="$root/archive/$name"
[[ -d "$snapshot" && ! -L "$snapshot" ]] || { printf 'Snapshot not found.\n' >&2; exit 1; }
exec 9>"$root/.lock"
flock -n 9 || { printf 'Another backup or restore is running.\n' >&2; exit 1; }
databases=(auth catalog booking payment notification)
(
  cd "$snapshot"
  for database in "${databases[@]}"; do
    [[ -f "$database.dump" && ! -L "$database.dump" ]] || exit 1
  done
  sha256sum --check --strict SHA256SUMS
)

database_bytes="$(sed -n 's/^database_bytes=//p' "$snapshot/metadata")"
available_bytes="$(df --output=avail -B1 "$root" | tail -n 1 | tr -d ' ')"
if [[ ! "$database_bytes" =~ ^[0-9]+$ || ! "$available_bytes" =~ ^[0-9]+$ ]] ||
  (( available_bytes < 1073741824 + 2 * database_bytes )); then
  printf 'Insufficient space for isolated restore plus 1 GiB reserve.\n' >&2
  exit 1
fi
created=()
prefix="tf_restore_$(date -u +%Y%m%d%H%M%S)_$$_${RANDOM}_"
cleanup() {
  local status=$? database
  trap - EXIT
  for database in "${created[@]}"; do
    if [[ "$database" != "$prefix"* ]] ||
      ! timeout 60 docker exec --user postgres ticketforge-postgres \
        timeout --kill-after=5s 45 dropdb --if-exists --force -- "$database"; then
      printf 'Failed to remove scratch database %s; manual cleanup required.\n' "$database" >&2
      status=1
    fi
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
started=$SECONDS
for database in "${databases[@]}"; do
  scratch="${prefix}${database}"
  created+=("$scratch")
  docker exec --user postgres ticketforge-postgres createdb --template template0 -- "$scratch"
  timeout 630 docker exec -i --user postgres ticketforge-postgres \
    timeout --kill-after=10s 600 pg_restore --dbname "$scratch" --no-owner --no-acl --exit-on-error --single-transaction \
    < "$snapshot/$database.dump"
  # Scratch restores never run application code, relays, consumers, or email workers.
  case "$database" in
    auth)
      invariant="SELECT count(*) FROM refresh_tokens r LEFT JOIN users u ON u.id=r.user_id WHERE u.id IS NULL"
      ;;
    catalog)
      invariant="SELECT count(*) FROM events WHERE version_no < 1 OR char_length(currency) <> 3"
      ;;
    booking)
      invariant="SELECT
        (SELECT count(*) FROM seats WHERE status IN ('HELD','SOLD') AND booking_id IS NULL) +
        (SELECT count(*) FROM seats s JOIN bookings b ON b.id=s.booking_id WHERE s.status='HELD' AND b.status<>'AWAITING_PAYMENT') +
        (SELECT count(*) FROM (SELECT i.event_id,i.seat_id FROM booking_items i JOIN bookings b ON b.id=i.booking_id WHERE b.status IN ('AWAITING_PAYMENT','CONFIRMED') GROUP BY i.event_id,i.seat_id HAVING count(*)>1) duplicates)"
      ;;
    payment)
      invariant="SELECT count(*) FROM refunds r LEFT JOIN payments p ON p.id=r.payment_id WHERE p.id IS NULL OR r.amount_minor<>p.amount_minor OR p.status<>'REFUNDED'"
      ;;
    notification)
      invariant="SELECT count(*) FROM notifications n LEFT JOIN recipients r ON r.user_id=n.user_id WHERE r.user_id IS NULL"
      ;;
  esac
  violations="$(docker exec --user postgres ticketforge-postgres psql -XAt \
    --dbname "$scratch" --set ON_ERROR_STOP=1 --command "BEGIN READ ONLY; $invariant; COMMIT;" | sed '/^BEGIN$/d; /^COMMIT$/d')"
  if [[ "$violations" != 0 ]]; then
    printf '%s restore invariant failed; violations=%s.\n' "$database" "$violations" >&2
    exit 1
  fi
  printf '%s: restored, constraints loaded, invariant violations=0.\n' "$database"
done
printf 'Restore drill passed for five isolated databases in %s seconds; scratch cleanup follows.\n' "$((SECONDS-started))"
