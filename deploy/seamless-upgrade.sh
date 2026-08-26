#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PROJECT_NAME="${TEXAS_HOLDEM_PROJECT_NAME:-texas-holdem}"
ENV_FILE="${TEXAS_HOLDEM_ENV_FILE:-$SCRIPT_DIR/production.env}"
COMPOSE_FILE="${TEXAS_HOLDEM_COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.production.yml}"
APP_IMAGE="${APP_IMAGE:-friends-holdem:production}"
HEALTH_URL="${TEXAS_HOLDEM_HEALTH_URL:-http://127.0.0.1:7790/api/health}"
HEALTH_TIMEOUT_SECONDS="${TEXAS_HOLDEM_HEALTH_TIMEOUT_SECONDS:-60}"
ALLOW_LEGACY_UPGRADE="${TEXAS_HOLDEM_ALLOW_LEGACY_UPGRADE:-0}"
SKIP_BUILD="${TEXAS_HOLDEM_SKIP_BUILD:-0}"

compose=(
  docker compose
  --project-name "$PROJECT_NAME"
  --env-file "$ENV_FILE"
  -f "$COMPOSE_FILE"
)

health_payload() {
  curl --fail --silent --show-error --max-time 4 "$HEALTH_URL"
}

health_is_recoverable() {
  local payload="$1"
  grep -q '"seamlessRestart":true' <<<"$payload" \
    && grep -q '"recoverable":true' <<<"$payload" \
    && grep -q '"persistenceHealthy":true' <<<"$payload"
}

wait_for_healthy_release() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local payload=""
  while (( SECONDS < deadline )); do
    if payload="$(health_payload 2>/dev/null)" && health_is_recoverable "$payload"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_any_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local payload=""
  while (( SECONDS < deadline )); do
    if payload="$(health_payload 2>/dev/null)" && grep -q '"ok":true' <<<"$payload"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if [[ ! -f "$ENV_FILE" || ! -f "$COMPOSE_FILE" ]]; then
  echo "Upgrade configuration is missing" >&2
  exit 66
fi
if [[ "$SKIP_BUILD" != "0" && "$SKIP_BUILD" != "1" ]]; then
  echo "TEXAS_HOLDEM_SKIP_BUILD must be 0 or 1" >&2
  exit 64
fi

current_container="$("${compose[@]}" ps -q texas-holdem)"
rollback_tag=""
current_recoverable=0
if [[ -n "$current_container" ]]; then
  current_health="$(health_payload 2>/dev/null || true)"
  if health_is_recoverable "$current_health"; then
    current_recoverable=1
  elif grep -q '"seamlessRestart":true' <<<"$current_health"; then
    echo "Current runtime snapshot is unhealthy; refusing to replace the service." >&2
    exit 74
  else
    if [[ "$ALLOW_LEGACY_UPGRADE" != "1" ]]; then
      echo "Current release cannot preserve an active hand. Deploy this first recovery-capable release only after every hand has ended, then rerun with TEXAS_HOLDEM_ALLOW_LEGACY_UPGRADE=1." >&2
      exit 75
    fi
    echo "Legacy upgrade override accepted; operator confirmed that no hand is in progress."
  fi
  current_image_id="$(docker inspect --format '{{.Image}}' "$current_container")"
  rollback_tag="friends-holdem:rollback-$(date -u +%Y%m%dT%H%M%SZ)"
  docker image tag "$current_image_id" "$rollback_tag"
fi

if [[ "$SKIP_BUILD" == "1" ]]; then
  if ! docker image inspect "$APP_IMAGE" >/dev/null 2>&1; then
    echo "The requested prebuilt image is not loaded: $APP_IMAGE" >&2
    exit 66
  fi
  echo "Using the prebuilt replacement image while the current service remains available..."
else
  echo "Building replacement image while the current service remains available..."
  APP_IMAGE="$APP_IMAGE" "${compose[@]}" build texas-holdem
fi

echo "Replacing the service; the old process will checkpoint active rooms before exit..."
replacement_started=1
if ! APP_IMAGE="$APP_IMAGE" "${compose[@]}" up -d --no-build --force-recreate texas-holdem; then
  replacement_started=0
fi

if [[ "$replacement_started" == "1" ]] && wait_for_healthy_release; then
  echo "Upgrade complete. Active rooms are recoverable and the service is healthy."
  [[ -z "$rollback_tag" ]] || echo "Rollback image retained as $rollback_tag"
  exit 0
fi

echo "Replacement did not become healthy; starting the retained rollback image..." >&2
if [[ -z "$rollback_tag" ]]; then
  echo "No previous image is available for rollback." >&2
  exit 1
fi

docker image tag "$rollback_tag" "$APP_IMAGE"
APP_IMAGE="$APP_IMAGE" "${compose[@]}" up -d --no-build --force-recreate texas-holdem
if { [[ "$current_recoverable" == "1" ]] && wait_for_healthy_release; } \
  || { [[ "$current_recoverable" == "0" ]] && wait_for_any_health; }; then
  echo "Rollback completed successfully." >&2
else
  echo "Rollback also failed health verification; inspect the container logs and persistent data before retrying." >&2
fi
exit 1
