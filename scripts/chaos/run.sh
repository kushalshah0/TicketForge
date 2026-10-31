#!/usr/bin/env bash
set -euo pipefail

[[ "$EUID" -eq 0 ]] || { echo 'Run on VM as root.' >&2; exit 2; }
config=/opt/ticketforge-readiness-20261029-1/compose.json
root=/opt/ticketforge-readiness-20261029-1
source=/tmp/ticketforge-publish-scan-20261029
dependencies=/tmp/ticketforge-readiness-repeat-20261029-3/node_modules
project=tf-readiness-20261029
scenario="${1:-}"
case "$scenario" in
  booking-crash) target=booking ;;
  broker-outage) target=rabbitmq ;;
  payment-outage) target=payment ;;
  database-restart) target=postgres ;;
  duplicate-delivery) target=booking ;;
  *) echo 'Specify booking-crash, broker-outage, payment-outage, database-restart, or duplicate-delivery.' >&2; exit 2 ;;
esac
id="$(docker compose -f "$config" ps --quiet "$target")"
[[ -n "$id" ]] || { echo 'Isolated target is not running.' >&2; exit 1; }
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id")" == "$project" ]]
[[ "$(docker inspect --format '{{.Name}}' "$id")" == "/$project-$target-1" ]]
probe() {
  docker run --rm --network "${project}_default" --ip 172.30.29.250 \
    --memory 256m --cpus 0.25 --env-file "$root/.env" -e READINESS_PROJECT="$project" \
    -v "$source:/workspace:ro" -v "$root:/fixtures" -w /workspace \
    -v "$dependencies:/workspace/node_modules:ro" \
    node:22.22.3-bookworm-slim node scripts/chaos/probe.mjs "$1"
}
healthy() {
  local i
  for i in {1..120}; do
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$id")" == healthy ]]; then return; fi
    sleep 1
  done
  echo "Isolated $target did not recover." >&2
  return 1
}
restore() {
  local status=$?
  local running
  trap - EXIT
  if ! running="$(docker inspect --format '{{.State.Running}}' "$id")"; then
    echo "Could not inspect isolated $target during recovery." >&2
    status=1
  elif [[ "$running" != true ]] && ! docker start "$id" >/dev/null; then
    echo "Failed to restart isolated $target; manual recovery required." >&2
    status=1
  fi
  if ! healthy; then status=1; fi
  sleep 10
  if ! docker run --rm --network "${project}_default" --memory 512m --cpus 0.25 \
    --env-file "$root/audit.env" -v "$source:/workspace:ro" \
    -v "$dependencies:/workspace/node_modules:ro" -w /workspace \
    node:22.22.3-bookworm-slim node scripts/audit.mjs; then
    status=1
  fi
  if [[ "$status" -eq 0 ]]; then
    echo "PASS $scenario: recovery assertions and integrity audit passed."
  fi
  exit "$status"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
healthy
probe refresh-tokens
case "$scenario" in
  booking-crash)
    probe hold
    probe pay-slow
    docker kill "$id" >/dev/null
    docker start "$id" >/dev/null
    healthy
    probe confirmed
    ;;
  broker-outage)
    docker stop --time 20 "$id" >/dev/null
    probe hold
    sleep 120
    probe outbox-pending
    docker start "$id" >/dev/null
    healthy
    probe expired
    probe outbox-drained
    ;;
  payment-outage)
    docker stop --time 20 "$id" >/dev/null
    probe hold
    sleep 900
    docker start "$id" >/dev/null
    healthy
    probe expired
    ;;
  database-restart)
    probe hold
    docker restart --time 20 "$id" >/dev/null
    healthy
    probe database-recovered
    ;;
  duplicate-delivery)
    probe hold
    probe pay-duplicate
    probe confirmed
    probe replay
    ;;
esac
