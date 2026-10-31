#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/bin" "$root/release/infra/compose" "$root/release/infra/scripts"
printf 'TAG=previous\nPUBLIC_HOSTNAME=example.test\n' > "$root/release/.env"
printf 'previous\n' > "$root/release/.last_good_tag"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$root/release/infra/scripts/smoke.sh"
chmod +x "$root/release/infra/scripts/smoke.sh"

cat > "$root/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s/%s %s\n' "${TAG:-}" "${IMAGE_PREFIX:-}" "$*" >> "$DEPLOY_LOG"
if [[ "$*" == *"image inspect"* && -n "${FAIL_IMAGE_INSPECT:-}" &&
  "$*" == *"$FAIL_IMAGE_INSPECT"* ]]; then
  exit 1
fi
if [[ "$*" == *"ps --status running --quiet"* ]]; then
  printf 'container-id\n'
fi
MOCK

cat > "$root/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf '401'
MOCK

cat > "$root/bin/timeout" <<'MOCK'
#!/usr/bin/env bash
if [[ "${FAIL_SMOKE:-0}" == 1 ]]; then exit 1; fi
shift
exec "$@"
MOCK

chmod +x "$root/bin/"*
export DEPLOY_LOG="$root/docker.log"
tag=0123456789abcdef0123456789abcdef01234567
local_tag=20261030-db-recovery

if FAIL_SMOKE=1 PATH="$root/bin:$PATH" TICKETFORGE_ROOT="$root/release" \
  IMAGE_PREFIX=ghcr.io/example/ticketforge bash infra/scripts/deploy.sh "$tag"; then
  printf 'Expected failed smoke test to fail deployment.\n' >&2
  exit 1
fi
[[ "$(cat "$root/release/.last_good_tag")" == previous ]]
[[ ! -e "$root/release/.last_good_image_prefix" ]]
grep -q '^previous/ticketforge compose .* up ' "$DEPLOY_LOG"
grep -q '^previous/ticketforge compose .* --no-deps .* auth$' "$DEPLOY_LOG"
grep -q "^$tag/ghcr.io/example/ticketforge compose .* pull " "$DEPLOY_LOG"

: > "$DEPLOY_LOG"
PATH="$root/bin:$PATH" TICKETFORGE_ROOT="$root/release" \
  IMAGE_PREFIX=ghcr.io/example/ticketforge bash infra/scripts/deploy.sh "$tag"
[[ "$(cat "$root/release/.last_good_tag")" == "$tag" ]]
[[ "$(cat "$root/release/.last_good_image_prefix")" == ghcr.io/example/ticketforge ]]
grep -q "^$tag/ghcr.io/example/ticketforge compose .* migrate-notification" "$DEPLOY_LOG"

: > "$DEPLOY_LOG"
if FAIL_IMAGE_INSPECT="ticketforge/ticketforge-notification-migrate:$local_tag" \
  SKIP_IMAGE_PULL=1 PATH="$root/bin:$PATH" TICKETFORGE_ROOT="$root/release" \
  IMAGE_PREFIX=ticketforge PREVIOUS_IMAGE_PREFIX=ticketforge \
  bash infra/scripts/deploy.sh "$local_tag"; then
  printf 'Expected missing local migration image to block deployment.\n' >&2
  exit 1
fi
[[ "$(cat "$root/release/.last_good_tag")" == "$tag" ]]
! grep -q ' compose .* up ' "$DEPLOY_LOG"

: > "$DEPLOY_LOG"
if FAIL_SMOKE=1 SKIP_IMAGE_PULL=1 PATH="$root/bin:$PATH" \
  TICKETFORGE_ROOT="$root/release" IMAGE_PREFIX=ticketforge \
  PREVIOUS_IMAGE_PREFIX=ticketforge \
  bash infra/scripts/deploy.sh local-rollback; then
  printf 'Expected local-image smoke failure to fail deployment.\n' >&2
  exit 1
fi
[[ "$(cat "$root/release/.last_good_tag")" == "$tag" ]]
! grep -q ' compose .* pull ' "$DEPLOY_LOG"
grep -q '^0123456789abcdef0123456789abcdef01234567/ghcr.io/example/ticketforge compose .* up ' "$DEPLOY_LOG"

: > "$DEPLOY_LOG"
SKIP_IMAGE_PULL=1 PATH="$root/bin:$PATH" TICKETFORGE_ROOT="$root/release" \
  IMAGE_PREFIX=ticketforge PREVIOUS_IMAGE_PREFIX=ticketforge \
  bash infra/scripts/deploy.sh "$local_tag"
[[ "$(cat "$root/release/.last_good_tag")" == "$local_tag" ]]
! grep -q ' compose .* pull ' "$DEPLOY_LOG"
grep -q "image inspect ticketforge/ticketforge-notification-migrate:$local_tag" "$DEPLOY_LOG"

service_tag=1111111111111111111111111111111111111111
: > "$DEPLOY_LOG"
PATH="$root/bin:$PATH" TICKETFORGE_ROOT="$root/release" \
  IMAGE_PREFIX=ticketforge bash infra/scripts/deploy.sh "$service_tag" booking
[[ "$(cat "$root/release/.last_good_services/booking.tag")" == "$service_tag" ]]
[[ "$(cat "$root/release/.last_good_services/auth.tag")" == "$local_tag" ]]
grep -q "^$service_tag/ticketforge compose .* pull booking migrate-booking$" "$DEPLOY_LOG"
grep -q "^$service_tag/ticketforge compose .* run --rm --no-deps migrate-booking$" "$DEPLOY_LOG"
grep -q "^$service_tag/ticketforge compose .* up .* --no-deps .* booking$" "$DEPLOY_LOG"
! grep -Eq ' compose .* (pull|run|up) .* (auth|catalog|payment|notification|gateway)( |$)' "$DEPLOY_LOG"

failed_service_tag=2222222222222222222222222222222222222222
: > "$DEPLOY_LOG"
if FAIL_SMOKE=1 PATH="$root/bin:$PATH" TICKETFORGE_ROOT="$root/release" \
  IMAGE_PREFIX=ticketforge bash infra/scripts/deploy.sh "$failed_service_tag" booking; then
  printf 'Expected selected-service smoke failure to fail deployment.\n' >&2
  exit 1
fi
[[ "$(cat "$root/release/.last_good_services/booking.tag")" == "$service_tag" ]]
grep -q "^$service_tag/ticketforge compose .* up .* --no-deps .* booking$" "$DEPLOY_LOG"
! grep -Eq ' compose .* (pull|run|up) .* (auth|catalog|payment|notification|gateway)( |$)' "$DEPLOY_LOG"
printf 'Deployment rollback and successful state update checks passed.\n'
