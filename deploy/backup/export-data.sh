#!/bin/sh
set -eu

DATA_ROOT="${TEXAS_HOLDEM_DATA_ROOT:-/srv/texas-holdem/data}"
ACCOUNT_FILE="${TEXAS_HOLDEM_ACCOUNT_FILE:-$DATA_ROOT/hot/texashold.json}"
RUNTIME_FILE="${TEXAS_HOLDEM_RUNTIME_FILE:-$DATA_ROOT/hot/runtime-rooms.json}"
ARCHIVE_FILE="${TEXAS_HOLDEM_ARCHIVE_FILE:-$DATA_ROOT/archive-ring/history-events.json}"
ANALYSIS_FILE="${TEXAS_HOLDEM_ANALYSIS_FILE:-$DATA_ROOT/archive-ring/hand-analysis-events.json}"
REPLICATION_FILE="${TEXAS_HOLDEM_REPLICATION_FILE:-$DATA_ROOT/replication-state.json}"
LOG_ARCHIVE_DIR="${TEXAS_HOLDEM_LOG_ARCHIVE_DIR:-$DATA_ROOT/logs/archive-ring}"
LOG_RETRY_WINDOW_SECONDS="${TEXAS_HOLDEM_LOG_RETRY_WINDOW_SECONDS:-300}"
LEGACY_PROVIDER_SEGMENT="$(printf '\116\141\163')"

if [ ! -f "$ACCOUNT_FILE" ] && [ -f "$DATA_ROOT/texashold.json" ]; then
  ACCOUNT_FILE="$DATA_ROOT/texashold.json"
fi
if [ ! -f "$RUNTIME_FILE" ] && [ -f "$DATA_ROOT/runtime-rooms.json" ]; then
  RUNTIME_FILE="$DATA_ROOT/runtime-rooms.json"
fi

if [ ! -f "$ACCOUNT_FILE" ] || [ ! -r "$ACCOUNT_FILE" ]; then
  echo "Texas Hold'em data file is not available" >&2
  exit 66
fi

# The explicit original command is a capability handshake. An older archive
# puller sends no command and continues receiving the version-2 state payload.
# Version 3 receives logs; version 4 also receives private hand-analysis
# records. The fixed-command archive account remains the only caller allowed
# to advance the replication heartbeat.
log_export_enabled=0
analysis_export_enabled=0
if [ -z "${SSH_CONNECTION:-}" ] || [ "${SSH_ORIGINAL_COMMAND:-}" = "texas-holdem-backup-v4" ]; then
  log_export_enabled=1
  analysis_export_enabled=1
elif [ "${SSH_ORIGINAL_COMMAND:-}" = "texas-holdem-backup-v3" ]; then
  log_export_enabled=1
fi
backup_version=2
if [ "$log_export_enabled" -eq 1 ]; then backup_version=3; fi
if [ "$analysis_export_enabled" -eq 1 ]; then backup_version=4; fi

# Version 3 adds bounded, rotated JSONL log segments. Logs are never read by
# the game request path: a restricted archive account pulls completed segments
# and verifies their SHA-256 before atomically archiving them.
printf '{"backupVersion":%s,"account":' "$backup_version"
/bin/cat -- "$ACCOUNT_FILE"
printf ',"runtime":'
if [ -f "$RUNTIME_FILE" ] && [ -r "$RUNTIME_FILE" ]; then
  /bin/cat -- "$RUNTIME_FILE"
else
  printf 'null'
fi
printf ',"archive":'
if [ -f "$ARCHIVE_FILE" ] && [ -r "$ARCHIVE_FILE" ]; then
  /bin/cat -- "$ARCHIVE_FILE"
else
  printf '{"version":1,"events":[]}'
fi
if [ "$analysis_export_enabled" -eq 1 ]; then
  printf ',"analysis":'
  if [ -f "$ANALYSIS_FILE" ] && [ -r "$ANALYSIS_FILE" ]; then
    /bin/cat -- "$ANALYSIS_FILE"
  else
    printf '{"version":1,"events":[]}'
  fi
fi
if [ "$log_export_enabled" -eq 1 ]; then
  printf ',"logs":{"version":1,"segments":['
  first_log_segment=1
  log_since_epoch=0
  case "$LOG_RETRY_WINDOW_SECONDS" in
    ''|*[!0-9]*) LOG_RETRY_WINDOW_SECONDS=300 ;;
  esac
  legacy_log_field="last${LEGACY_PROVIDER_SEGMENT}LogPullAt"
  if [ -f "$REPLICATION_FILE" ] && grep -Eq "\"(lastArchiveLogPullAt|${legacy_log_field})\"" "$REPLICATION_FILE"; then
    replication_epoch="$(stat -c %Y "$REPLICATION_FILE" 2>/dev/null || printf '0')"
    if [ "$replication_epoch" -gt "$LOG_RETRY_WINDOW_SECONDS" ]; then
      log_since_epoch=$((replication_epoch - LOG_RETRY_WINDOW_SECONDS))
    fi
  fi
  if [ -d "$LOG_ARCHIVE_DIR" ]; then
    for log_file in "$LOG_ARCHIVE_DIR"/application-*.jsonl; do
      [ -f "$log_file" ] || continue
      [ ! -L "$log_file" ] || continue
      log_name="$(basename -- "$log_file")"
      case "$log_name" in
        application-*.jsonl) ;;
        *) continue ;;
      esac
      case "$log_name" in
        *[!A-Za-z0-9_.-]*) continue ;;
      esac
      log_mtime="$(stat -c %Y "$log_file" 2>/dev/null || printf '0')"
      [ "$log_mtime" -ge "$log_since_epoch" ] || continue
      log_sha256="$(sha256sum "$log_file" | awk '{print $1}')"
      if [ "$first_log_segment" -eq 0 ]; then printf ','; fi
      first_log_segment=0
      printf '{"name":"%s","sha256":"%s","encoding":"base64","content":"' "$log_name" "$log_sha256"
      base64 < "$log_file" | tr -d '\n'
      printf '"}'
    done
  fi
  printf ']}'
fi
printf '}\n'

if [ -n "${SSH_CONNECTION:-}" ]; then
  pulled_at="$(date -u +%FT%TZ)"
  replication_temp="$REPLICATION_FILE.$$.tmp"
  umask 077
  if [ "$log_export_enabled" -eq 1 ]; then
    protocol="backup-v3-logs"
    if [ "$analysis_export_enabled" -eq 1 ]; then protocol="backup-v4-analysis"; fi
    printf '{"lastArchivePullAt":"%s","lastArchiveLogPullAt":"%s","transport":"restricted-ssh","protocol":"%s"}\n' "$pulled_at" "$pulled_at" "$protocol" > "$replication_temp"
  else
    printf '{"lastArchivePullAt":"%s","transport":"restricted-ssh","protocol":"backup-v2"}\n' "$pulled_at" > "$replication_temp"
  fi
  chown --reference="$DATA_ROOT" "$replication_temp"
  chmod 600 "$replication_temp"
  mv "$replication_temp" "$REPLICATION_FILE"
fi
