#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_ENV_FILE="${TEXAS_HOLDEM_ARCHIVE_ENV_FILE:-$SCRIPT_DIR/archive.env}"
if [[ -f "$ARCHIVE_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ARCHIVE_ENV_FILE"; set +a
fi
ARCHIVE_ROOT="${TEXAS_HOLDEM_ARCHIVE_ROOT:-}"
ARCHIVE_USER="${TEXAS_HOLDEM_ARCHIVE_USER:-}"
ARCHIVE_HOST="${TEXAS_HOLDEM_ARCHIVE_HOST:-}"
SSH_KEY="${TEXAS_HOLDEM_ARCHIVE_KEY:-}"
RETENTION_DAYS="${TEXAS_HOLDEM_ARCHIVE_RETENTION_DAYS:-90}"

if [[ -z "$ARCHIVE_ROOT" || -z "$ARCHIVE_USER" || -z "$ARCHIVE_HOST" || -z "$SSH_KEY" ]]; then
  echo "Set TEXAS_HOLDEM_ARCHIVE_ROOT, TEXAS_HOLDEM_ARCHIVE_USER, TEXAS_HOLDEM_ARCHIVE_HOST and TEXAS_HOLDEM_ARCHIVE_KEY in $ARCHIVE_ENV_FILE or the shell environment." >&2
  exit 66
fi
if [[ ! "$ARCHIVE_USER" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]]; then
  echo "TEXAS_HOLDEM_ARCHIVE_USER contains unsupported characters." >&2
  exit 64
fi
if [[ ! "$ARCHIVE_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
  echo "TEXAS_HOLDEM_ARCHIVE_HOST must be a hostname or address without a scheme or port." >&2
  exit 64
fi
if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ || "$RETENTION_DAYS" -lt 1 || "$RETENTION_DAYS" -gt 3650 ]]; then
  echo "TEXAS_HOLDEM_ARCHIVE_RETENTION_DAYS must be between 1 and 3650." >&2
  exit 64
fi
if [[ ! -f "$SSH_KEY" ]]; then
  echo "Remote archive SSH key is missing: $SSH_KEY" >&2
  exit 66
fi
SNAPSHOT_ROOT="$ARCHIVE_ROOT/backups"
LATEST_ROOT="$ARCHIVE_ROOT/latest"
STATE_ROOT="$ARCHIVE_ROOT/.state"
LOG_ROOT="$ARCHIVE_ROOT/logs/app"

case "$ARCHIVE_ROOT" in
  /*/texas-holdem) ;;
  *)
    echo "Refusing archive root that is not an absolute path ending in /texas-holdem: $ARCHIVE_ROOT" >&2
    exit 64
    ;;
esac

umask 077
install -d -m 700 "$ARCHIVE_ROOT" "$SNAPSHOT_ROOT" "$LATEST_ROOT" "$STATE_ROOT" "$LOG_ROOT"
exec 9>"$STATE_ROOT/backup.lock"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) another backup is already running"
  exit 0
fi

incoming="$(mktemp "$STATE_ROOT/incoming.XXXXXX")"
cleanup() {
  rm -f "$incoming"
}
trap cleanup EXIT

ssh \
  -T \
  -i "$SSH_KEY" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=2 \
  -o StrictHostKeyChecking=yes \
  "$ARCHIVE_USER@$ARCHIVE_HOST" texas-holdem-backup-v3 > "$incoming"

python3 - "$incoming" "$LOG_ROOT" <<'PY'
import base64
import binascii
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
log_root = Path(sys.argv[2]).resolve()
payload = json.loads(path.read_text(encoding="utf-8"))
if not isinstance(payload, dict):
    raise SystemExit("backup payload must be a JSON object")
version = payload.get("backupVersion")
account = payload.get("account") if version in (2, 3) else payload
runtime = payload.get("runtime") if version in (2, 3) else None
archive = payload.get("archive") if version in (2, 3) else None
if not isinstance(account, dict):
    raise SystemExit("backup payload is missing account data")
for key in ("users", "sessions", "histories"):
    if not isinstance(account.get(key), list):
        raise SystemExit(f"backup payload is missing list: {key}")
if any("token" in session for session in account["sessions"] if isinstance(session, dict)):
    raise SystemExit("backup payload contains a plaintext session token")
if runtime is not None:
    if not isinstance(runtime, dict) or runtime.get("version") not in (1, 2, 3) or not isinstance(runtime.get("rooms"), list):
        raise SystemExit("backup payload contains invalid runtime room state")
if archive is not None:
    if not isinstance(archive, dict) or archive.get("version") != 1 or not isinstance(archive.get("events"), list):
        raise SystemExit("backup payload contains invalid archive ring")
    for event in archive["events"]:
        if not isinstance(event, dict) or not isinstance(event.get("id"), str) or not isinstance(event.get("createdAt"), str):
            raise SystemExit("backup payload contains an invalid archive event")

logs = payload.get("logs") if version == 3 else None
if logs is not None:
    if not isinstance(logs, dict) or logs.get("version") != 1 or not isinstance(logs.get("segments"), list):
        raise SystemExit("backup payload contains invalid application logs")
    if len(logs["segments"]) > 64:
        raise SystemExit("backup payload contains too many application log segments")
    encoded_total = sum(len(segment.get("content", "")) for segment in logs["segments"] if isinstance(segment, dict))
    if encoded_total > 80 * 1024 * 1024:
        raise SystemExit("backup payload application logs exceed the transfer limit")
    allowed_domains = {"auth", "lobby", "room", "game", "action", "spectator", "hextech", "rebuy", "settlement", "deploy"}
    sensitive_keys = {"password", "passwd", "passphrase", "authorization", "cookie", "token", "secret", "card", "cards", "deck", "hand", "holecard", "holecards", "skillresult", "privateresult", "offer", "offers"}

    def normalized_key(value):
        return re.sub(r"[-_]", "", str(value)).lower()

    def validate_redaction(value):
        if isinstance(value, dict):
            for key, child in value.items():
                normalized = normalized_key(key)
                if normalized in {"handid", "handnumber", "skillid", "characterid"}:
                    validate_redaction(child)
                    continue
                if (normalized in sensitive_keys or any(marker in normalized for marker in ("password", "passwd", "passphrase", "authorization", "cookie", "token", "secret"))):
                    if child != "[REDACTED]":
                        raise SystemExit(f"application log contains an unredacted sensitive field: {key}")
                else:
                    validate_redaction(child)
        elif isinstance(value, list):
            for child in value:
                validate_redaction(child)

    for segment in logs["segments"]:
        if not isinstance(segment, dict) or set(segment) != {"name", "sha256", "encoding", "content"}:
            raise SystemExit("backup payload contains an invalid application log segment")
        name = segment["name"]
        digest = segment["sha256"]
        if not isinstance(name, str) or not re.fullmatch(r"application-[A-Za-z0-9_-]+-\d+-\d+\.jsonl", name):
            raise SystemExit("backup payload contains an unsafe application log filename")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise SystemExit("backup payload contains an invalid application log digest")
        if segment["encoding"] != "base64" or not isinstance(segment["content"], str):
            raise SystemExit("backup payload contains an unsupported application log encoding")
        try:
            decoded = base64.b64decode(segment["content"], validate=True)
        except (binascii.Error, ValueError) as error:
            raise SystemExit("backup payload contains malformed base64 application logs") from error
        if hashlib.sha256(decoded).hexdigest() != digest:
            raise SystemExit("application log SHA-256 verification failed")
        if len(decoded) > 8 * 1024 * 1024:
            raise SystemExit("an application log segment exceeds the size limit")
        first_timestamp = None
        for raw_line in decoded.splitlines():
            if not raw_line.strip():
                continue
            try:
                record = json.loads(raw_line)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise SystemExit("application log segment is not valid JSONL") from error
            if not isinstance(record, dict) or record.get("domain") not in allowed_domains or record.get("level") not in {"trace", "debug", "info", "warn", "error", "fatal"}:
                raise SystemExit("application log segment contains an invalid record")
            validate_redaction(record)
            if first_timestamp is None:
                try:
                    first_timestamp = datetime.fromisoformat(str(record["ts"]).replace("Z", "+00:00")).astimezone(timezone.utc)
                except (KeyError, TypeError, ValueError):
                    first_timestamp = datetime.now(timezone.utc)
        if first_timestamp is None:
            continue
        target_dir = (log_root / f"{first_timestamp:%Y}" / f"{first_timestamp:%m}" / f"{first_timestamp:%d}").resolve()
        if log_root not in target_dir.parents:
            raise SystemExit("refusing unsafe application log target")
        target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        target = target_dir / f"{digest}-{name}"
        if not target.exists():
            temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            temporary.write_bytes(decoded)
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)

# Long-term logs are materialized separately. Excluding the transport member
# keeps account/runtime snapshot hashes stable when only logs changed.
payload.pop("logs", None)
temporary_payload = path.with_name(f".{path.name}.{os.getpid()}.validated")
temporary_payload.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
os.chmod(temporary_payload, 0o600)
os.replace(temporary_payload, path)
PY

current_hash="$(sha256sum "$incoming" | awk '{print $1}')"
latest_file="$LATEST_ROOT/texas-holdem-state.json"
latest_hash=""
if [ -f "$latest_file" ]; then
  latest_hash="$(sha256sum "$latest_file" | awk '{print $1}')"
fi

if [ "$current_hash" = "$latest_hash" ]; then
  echo "$(date -u +%FT%TZ) unchanged sha256=$current_hash"
else
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  snapshot_dir="$SNAPSHOT_ROOT/$(date -u +%Y/%m/%d)"
  snapshot_file="$snapshot_dir/texas-holdem-state-$timestamp.json"
  install -d -m 700 "$snapshot_dir"
  mv "$incoming" "$snapshot_file"
  chmod 600 "$snapshot_file"
  trap - EXIT

  printf '%s  %s\n' "$current_hash" "$(basename "$snapshot_file")" > "$snapshot_file.sha256"
  chmod 600 "$snapshot_file.sha256"
  latest_tmp="$LATEST_ROOT/.texas-holdem-state.json.tmp.$$"
  cp "$snapshot_file" "$latest_tmp"
  chmod 600 "$latest_tmp"
  mv "$latest_tmp" "$latest_file"
  printf '%s  %s\n' "$current_hash" "texas-holdem-state.json" > "$LATEST_ROOT/texas-holdem-state.sha256"
  chmod 600 "$LATEST_ROOT/texas-holdem-state.sha256"
  echo "$(date -u +%FT%TZ) saved $snapshot_file sha256=$current_hash"
fi

archive_root="$ARCHIVE_ROOT/archive/hands"
install -d -m 700 "$archive_root"
python3 - "$latest_file" "$archive_root" <<'PY'
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
archive = payload.get("archive") if payload.get("backupVersion") in (2, 3) else None
events = archive.get("events", []) if isinstance(archive, dict) else []
root = Path(sys.argv[2])
for event in events:
    event_id = str(event.get("id", ""))
    if not re.fullmatch(r"[0-9a-fA-F-]{8,80}", event_id):
        continue
    try:
        created = datetime.fromisoformat(str(event["createdAt"]).replace("Z", "+00:00")).astimezone(timezone.utc)
    except (KeyError, TypeError, ValueError):
        continue
    target_dir = root / f"{created:%Y}" / f"{created:%m}"
    target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = target_dir / f"{event_id}.json"
    if target.exists():
        continue
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(event, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
PY

find "$SNAPSHOT_ROOT" -type f \( -name 'texashold-*.json' -o -name 'texashold-*.json.sha256' -o -name 'texas-holdem-state-*.json' -o -name 'texas-holdem-state-*.json.sha256' \) -mtime "+$RETENTION_DAYS" -delete
find "$SNAPSHOT_ROOT" -mindepth 1 -type d -empty -delete
