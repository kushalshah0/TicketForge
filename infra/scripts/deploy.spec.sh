#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/bin" "$root/release/infra/compose" "$root/release/infra/scripts"
printf 'TAG=previous\nIMAGE_PREFIX=ticketforge\nPUBLIC_HOSTNAME=example.test\n' > "$root/release/.env"
printf 'previous\n' > "$root/release/.last_good_tag"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$root/release/infra/scripts/smoke.sh"
chmod +x "$root/release/infra/scripts/smoke.sh"

cat > "$root/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s/%s %s\n' "${TAG:-}" "${IMAGE_PREFIX:-}" "$*" >> "$DEPLOY_LOG"
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

if FAIL_SMOKE=1 PATH="$root/bin:$PATH" TICKETFORGE_ROOT="$root/release" \
  IMAGE_PREFIX=ghcr.io/example/ticketforge bash infra/scripts/deploy.sh "$tag"; then
  printf 'Expected failed smoke test to fail deployment.\n' >&2
  exit 1
fi
[[ "$(cat "$root/release/.last_good_tag")" == previous ]]
[[ ! -e "$root/release/.last_good_image_prefix" ]]
grep -q '^previous/ticketforge compose .* up ' "$DEPLOY_LOG"
grep -q "^$tag/ghcr.io/example/ticketforge compose .* pull " "$DEPLOY_LOG"

: > "$DEPLOY_LOG"
PATH="$root/bin:$PATH" TICKETFORGE_ROOT="$root/release" \
  IMAGE_PREFIX=ghcr.io/example/ticketforge bash infra/scripts/deploy.sh "$tag"
[[ "$(cat "$root/release/.last_good_tag")" == "$tag" ]]
[[ "$(cat "$root/release/.last_good_image_prefix")" == ghcr.io/example/ticketforge ]]
grep -q "^$tag/ghcr.io/example/ticketforge compose .* migrate-notification" "$DEPLOY_LOG"
printf 'Deployment rollback and successful state update checks passed.\n'
