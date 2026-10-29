#!/usr/bin/env bash
set -euo pipefail

scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/bin"
export TICKETFORGE_BACKUP_ROOT="$work/backups" BACKUP_TEST_LOG="$work/docker.log"
export PATH="$work/bin:$PATH"
cat > "$work/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$BACKUP_TEST_LOG"
case " $* " in
  *" pg_dump --version "*) printf 'pg_dump (PostgreSQL) 16.4\n' ;;
  *" pg_dump "*)
    if [[ "${BACKUP_TEST_DUMP_FAIL:-}" == yes ]]; then exit 1; fi
    printf 'compressed dump fixture\n'
    ;;
  *" pg_restore --list "*) cat > /dev/null ;;
  *" pg_restore "*)
    cat > /dev/null
    if [[ "${BACKUP_TEST_RESTORE_FAIL:-}" == yes ]]; then exit 1; fi
    ;;
  *" sum(pg_database_size"*) printf '1024\n' ;;
  *" psql "*) printf '0\n' ;;
  *" createdb "*)
    if [[ "${BACKUP_TEST_CREATE_FAIL:-}" == yes ]]; then exit 1; fi
    ;;
  *" dropdb "*) ;;
  *) printf 'Unexpected mock Docker invocation.\n' >&2; exit 2 ;;
esac
MOCK
chmod +x "$work/bin/docker"

mkdir -p "$TICKETFORGE_BACKUP_ROOT"/{daily,weekly,archive}
printf 'retained history\n' > "$TICKETFORGE_BACKUP_ROOT/archive/history"
for day in {01..09}; do
  ln -s ../archive/history "$TICKETFORGE_BACKUP_ROOT/daily/2000-01-$day"
done
for week in {01..06}; do
  ln -s ../archive/history "$TICKETFORGE_BACKUP_ROOT/weekly/2000-W$week"
done
bash "$scripts/backup.sh"
[[ "$(find "$TICKETFORGE_BACKUP_ROOT/daily" -type l | wc -l)" -eq 7 ]]
[[ "$(find "$TICKETFORGE_BACKUP_ROOT/weekly" -type l | wc -l)" -eq 4 ]]
[[ -f "$TICKETFORGE_BACKUP_ROOT/archive/history" ]]
snapshot="$(find "$TICKETFORGE_BACKUP_ROOT/archive" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')"
[[ "$(stat -c %a "$TICKETFORGE_BACKUP_ROOT/archive/$snapshot/auth.dump")" == 600 ]]
bash "$scripts/restore-check.sh" "$snapshot"
[[ "$(grep -c ' createdb ' "$BACKUP_TEST_LOG")" -eq 5 ]]
[[ "$(grep -c ' dropdb ' "$BACKUP_TEST_LOG")" -eq 5 ]]

if BACKUP_TEST_DUMP_FAIL=yes bash "$scripts/backup.sh"; then
  printf 'Failed dump incorrectly reported success.\n' >&2; exit 1
fi
[[ "$(find "$TICKETFORGE_BACKUP_ROOT/failed" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ]]
[[ "$(find "$TICKETFORGE_BACKUP_ROOT/archive" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ]]

: > "$BACKUP_TEST_LOG"
if BACKUP_TEST_RESTORE_FAIL=yes bash "$scripts/restore-check.sh" "$snapshot"; then
  printf 'Failed restore incorrectly reported success.\n' >&2; exit 1
fi
[[ "$(grep -c ' createdb ' "$BACKUP_TEST_LOG")" -eq 1 ]]
[[ "$(grep -c ' dropdb ' "$BACKUP_TEST_LOG")" -eq 1 ]]
grep -q 'dropdb --if-exists --force -- tf_restore_' "$BACKUP_TEST_LOG"
grep -q 'timeout --kill-after=10s 600 pg_restore' "$BACKUP_TEST_LOG"

: > "$BACKUP_TEST_LOG"
if BACKUP_TEST_CREATE_FAIL=yes bash "$scripts/restore-check.sh" "$snapshot"; then
  printf 'Failed database creation incorrectly reported success.\n' >&2; exit 1
fi
[[ "$(grep -c ' dropdb ' "$BACKUP_TEST_LOG")" -eq 1 ]]

printf 'corrupt\n' >> "$TICKETFORGE_BACKUP_ROOT/archive/$snapshot/auth.dump"
: > "$BACKUP_TEST_LOG"
if bash "$scripts/restore-check.sh" "$snapshot"; then
  printf 'Corrupt dump incorrectly passed checksum verification.\n' >&2; exit 1
fi
[[ ! -s "$BACKUP_TEST_LOG" ]]
if bash "$scripts/restore-check.sh" auth; then
  printf 'Live database name incorrectly accepted as a snapshot.\n' >&2; exit 1
fi
printf 'Backup self-check passed: atomic completion, permissions, retention, history, restore cleanup, checksum and input rejection.\n'
