#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DEPLOY_ENV_FILE="${TEXAS_HOLDEM_DEPLOY_ENV_FILE:-$SCRIPT_DIR/deploy.env}"
if [[ -f "$DEPLOY_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$DEPLOY_ENV_FILE"; set +a
fi
SERVER_HOST="${TEXAS_HOLDEM_SERVER_HOST:-}"
SERVER_USER="${TEXAS_HOLDEM_SERVER_USER:-}"
SERVER_KEY="${TEXAS_HOLDEM_SERVER_KEY:-}"
REMOTE_ROOT="${TEXAS_HOLDEM_SERVER_ROOT:-/srv/texas-holdem}"
ALLOW_LEGACY_UPGRADE="${TEXAS_HOLDEM_ALLOW_LEGACY_UPGRADE:-0}"
PUBLIC_HEALTH_URL="${TEXAS_HOLDEM_PUBLIC_HEALTH_URL:-https://play.example.com/api/health}"
PRODUCTION_ENV_FILE="${TEXAS_HOLDEM_PRODUCTION_ENV_FILE:-deploy/production.env}"
PREBUILT_IMAGE_FILE="${TEXAS_HOLDEM_PREBUILT_IMAGE_FILE:-}"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
REMOTE_RELEASE="$REMOTE_ROOT/releases/$RELEASE_ID"
SSH_DEST="$SERVER_USER@$SERVER_HOST"
SSH_OPTS=(-i "$SERVER_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

if [[ -z "$SERVER_HOST" || -z "$SERVER_USER" || -z "$SERVER_KEY" ]]; then
  echo "Set TEXAS_HOLDEM_SERVER_HOST, TEXAS_HOLDEM_SERVER_USER and TEXAS_HOLDEM_SERVER_KEY in $DEPLOY_ENV_FILE or the shell environment." >&2
  exit 66
fi
if [[ ! "$SERVER_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
  echo "TEXAS_HOLDEM_SERVER_HOST must be a hostname or address without a scheme or port." >&2
  exit 64
fi
if [[ ! "$SERVER_USER" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]]; then
  echo "TEXAS_HOLDEM_SERVER_USER contains unsupported characters." >&2
  exit 64
fi
if [[ ! "$REMOTE_ROOT" =~ ^/[A-Za-z0-9._/-]+$ || "/$REMOTE_ROOT/" == *"/../"* ]]; then
  echo "TEXAS_HOLDEM_SERVER_ROOT must be a safe absolute path." >&2
  exit 64
fi
if [[ "$ALLOW_LEGACY_UPGRADE" != "0" && "$ALLOW_LEGACY_UPGRADE" != "1" ]]; then
  echo "TEXAS_HOLDEM_ALLOW_LEGACY_UPGRADE must be 0 or 1." >&2
  exit 64
fi
if [[ ! -f "$SERVER_KEY" ]]; then
  echo "Remote server SSH key is missing: $SERVER_KEY" >&2
  exit 66
fi
if [[ "$PRODUCTION_ENV_FILE" != /* ]]; then
  PRODUCTION_ENV_FILE="$PROJECT_ROOT/$PRODUCTION_ENV_FILE"
fi
if [[ ! -f "$PRODUCTION_ENV_FILE" ]]; then
  echo "Missing production environment file: $PRODUCTION_ENV_FILE" >&2
  exit 66
fi
if [[ -n "$PREBUILT_IMAGE_FILE" ]]; then
  if [[ "$PREBUILT_IMAGE_FILE" != /* ]]; then
    PREBUILT_IMAGE_FILE="$PROJECT_ROOT/$PREBUILT_IMAGE_FILE"
  fi
  if [[ ! -f "$PREBUILT_IMAGE_FILE" ]]; then
    echo "Prebuilt image archive is missing: $PREBUILT_IMAGE_FILE" >&2
    exit 66
  fi
fi
PRODUCTION_ENV_DIR="$(cd -- "$(dirname -- "$PRODUCTION_ENV_FILE")" && pwd)"
PRODUCTION_ENV_FILE="$PRODUCTION_ENV_DIR/$(basename -- "$PRODUCTION_ENV_FILE")"
case "$PRODUCTION_ENV_FILE" in
  "$PROJECT_ROOT"/*) PRODUCTION_ENV_RELATIVE="${PRODUCTION_ENV_FILE#"$PROJECT_ROOT"/}" ;;
  *) echo "Production environment file must stay inside the project root so it can be transferred safely." >&2; exit 64 ;;
esac
if [[ ! "$PRODUCTION_ENV_RELATIVE" =~ ^[A-Za-z0-9._/-]+$ || "/$PRODUCTION_ENV_RELATIVE/" == *"/../"* ]]; then
  echo "Production environment path contains unsafe characters: $PRODUCTION_ENV_RELATIVE" >&2
  exit 64
fi

cd "$PROJECT_ROOT"
npm run check

ssh "${SSH_OPTS[@]}" "$SSH_DEST" \
  "install -d -m 755 '$REMOTE_RELEASE' '$REMOTE_ROOT/releases' && install -d -m 700 '$REMOTE_ROOT/data'"

# Publish the reviewed commit, never the ambient worktree. This keeps ignored
# configuration, runtime data, credentials and unrelated untracked files out of
# the release even when an operator deploys from a dirty checkout.
git archive --format=tar.gz HEAD \
  | ssh "${SSH_OPTS[@]}" "$SSH_DEST" "tar -xzf - -C '$REMOTE_RELEASE'"

# Transfer only the explicitly selected runtime environment with private mode;
# Local deploy.env and optional archive credentials never enter a release archive.
scp "${SSH_OPTS[@]}" "$PRODUCTION_ENV_FILE" "$SSH_DEST:$REMOTE_RELEASE/$PRODUCTION_ENV_RELATIVE"
ssh "${SSH_OPTS[@]}" "$SSH_DEST" "chmod 600 '$REMOTE_RELEASE/$PRODUCTION_ENV_RELATIVE'"

skip_remote_build=0
if [[ -n "$PREBUILT_IMAGE_FILE" ]]; then
  case "$PREBUILT_IMAGE_FILE" in
    *.gz|*.tgz) gzip -dc -- "$PREBUILT_IMAGE_FILE" ;;
    *) cat -- "$PREBUILT_IMAGE_FILE" ;;
  esac | ssh "${SSH_OPTS[@]}" "$SSH_DEST" "docker load >/dev/null"
  skip_remote_build=1
fi

ssh "${SSH_OPTS[@]}" "$SSH_DEST" 'bash -s' -- "$REMOTE_RELEASE" "$REMOTE_ROOT" "$ALLOW_LEGACY_UPGRADE" "$PRODUCTION_ENV_RELATIVE" "$skip_remote_build" <<'REMOTE_SCRIPT'
set -euo pipefail
release_dir="$1"
remote_root="$2"
allow_legacy_upgrade="$3"
production_env_relative="$4"
skip_remote_build="$5"
cd "$release_dir"
TEXAS_HOLDEM_ENV_FILE="$release_dir/$production_env_relative" \
TEXAS_HOLDEM_COMPOSE_FILE="$release_dir/docker-compose.production.yml" \
TEXAS_HOLDEM_HEALTH_URL="http://127.0.0.1:7790/api/health" \
TEXAS_HOLDEM_ALLOW_LEGACY_UPGRADE="$allow_legacy_upgrade" \
TEXAS_HOLDEM_SKIP_BUILD="$skip_remote_build" \
APP_IMAGE="friends-holdem:production" \
  "$release_dir/deploy/seamless-upgrade.sh"
install -d -m 755 "$remote_root/bin"
install -m 755 "$release_dir/deploy/backup/export-data.sh" "$remote_root/bin/texas-holdem-backup-export"
# Existing restricted SSH keys may still point at the conventional system
# location from an earlier deployment. Refresh that already-provisioned path
# as well so the external puller and the application heartbeat stay on the
# same protocol, without creating or changing privileged SSH configuration.
if [ -x /usr/local/sbin/texas-holdem-backup-export ]; then
  install -m 755 "$release_dir/deploy/backup/export-data.sh" /usr/local/sbin/texas-holdem-backup-export
fi
ln -sfn "$release_dir" "$remote_root/current"
REMOTE_SCRIPT

curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL"
printf '\nTexasHold remote deployment is healthy (%s).\n' "$PUBLIC_HEALTH_URL"
