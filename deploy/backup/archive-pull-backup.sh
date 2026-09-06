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
  -C \
  -T \
  -i "$SSH_KEY" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=2 \
  -o StrictHostKeyChecking=yes \
  "$ARCHIVE_USER@$ARCHIVE_HOST" texas-holdem-backup-v4 > "$incoming"

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
account = payload.get("account") if version in (2, 3, 4) else payload
runtime = payload.get("runtime") if version in (2, 3, 4) else None
archive = payload.get("archive") if version in (2, 3, 4) else None
analysis = payload.get("analysis") if version == 4 else None
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

if analysis is not None:
    if not isinstance(analysis, dict) or analysis.get("version") != 1 or not isinstance(analysis.get("events"), list):
        raise SystemExit("backup payload contains invalid hand analysis archive")
    card_pattern = re.compile(r"^(?:[2-9TJQKA][shdc]|BLANK)$")
    for event in analysis["events"]:
        if (not isinstance(event, dict)
                or event.get("analysisVersion") != 1
                or not isinstance(event.get("id"), str)
                or event.get("id") != event.get("handId")
                or not isinstance(event.get("createdAt"), str)
                or not isinstance(event.get("actions"), list)
                or not isinstance(event.get("players"), list)
                or len(event["actions"]) > 500
                or not 2 <= len(event["players"]) <= 8):
            raise SystemExit("backup payload contains an invalid hand analysis event")
        community = event.get("communityCards", [])
        if (not isinstance(community, list) or len(community) > 5
                or any(not isinstance(card, str) or not card_pattern.fullmatch(card) for card in community)):
            raise SystemExit("hand analysis contains invalid community cards")
        replacements = event.get("holeCardReplacements", [])
        if not isinstance(replacements, list) or len(replacements) > 64:
            raise SystemExit("hand analysis contains invalid hole-card replacements")
        for replacement in replacements:
            if (not isinstance(replacement, dict)
                    or not isinstance(replacement.get("userId"), str)
                    or replacement.get("cardIndex") not in {0, 1}
                    or not isinstance(replacement.get("discarded"), str)
                    or not card_pattern.fullmatch(replacement["discarded"])
                    or not isinstance(replacement.get("replacement"), str)
                    or not card_pattern.fullmatch(replacement["replacement"])):
                raise SystemExit("hand analysis contains an invalid hole-card replacement")
        for index, action in enumerate(event["actions"], start=1):
            if (not isinstance(action, dict)
                    or action.get("sequence") != index
                    or action.get("street") not in {"preflop", "flop", "turn", "river"}
                    or action.get("action") not in {"fold", "check", "call", "bet", "raise", "all-in"}
                    or not isinstance(action.get("userId"), str)):
                raise SystemExit("hand analysis contains an invalid action")
        for player in event["players"]:
            cards = player.get("holeCards", []) if isinstance(player, dict) else None
            starting_cards = player.get("startingHoleCards", cards) if isinstance(player, dict) else None
            if (not isinstance(player, dict)
                    or not isinstance(player.get("userId"), str)
                    or not isinstance(cards, list)
                    or len(cards) != 2
                    or any(not isinstance(card, str) or not card_pattern.fullmatch(card) for card in cards)
                    or not isinstance(starting_cards, list)
                    or len(starting_cards) != 2
                    or any(not isinstance(card, str) or not card_pattern.fullmatch(card) for card in starting_cards)):
                raise SystemExit("hand analysis contains invalid player cards")

logs = payload.get("logs") if version in (3, 4) else None
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
archive = payload.get("archive") if payload.get("backupVersion") in (2, 3, 4) else None
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

analysis_root="$ARCHIVE_ROOT/archive/analysis/hands"
database_root="$ARCHIVE_ROOT/database"
install -d -m 700 "$analysis_root" "$database_root"
python3 - "$latest_file" "$analysis_root" "$database_root/texas-holdem-analytics.sqlite3" <<'PY'
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
analysis = payload.get("analysis") if payload.get("backupVersion") == 4 else None
events = analysis.get("events", []) if isinstance(analysis, dict) else []
json_root = Path(sys.argv[2])
database_path = Path(sys.argv[3])

connection = sqlite3.connect(database_path)
connection.execute("PRAGMA foreign_keys = ON")
connection.execute("PRAGMA journal_mode = DELETE")
connection.execute("PRAGMA synchronous = FULL")
connection.executescript("""
CREATE TABLE IF NOT EXISTS hands (
  hand_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  room_code TEXT NOT NULL,
  room_name TEXT NOT NULL,
  hand_number INTEGER NOT NULL,
  room_mode TEXT NOT NULL,
  leaderboard_eligible INTEGER NOT NULL,
  small_blind INTEGER NOT NULL,
  big_blind INTEGER NOT NULL,
  action_seconds INTEGER NOT NULL,
  button_seat INTEGER NOT NULL,
  small_blind_seat INTEGER NOT NULL,
  big_blind_seat INTEGER NOT NULL,
  community_cards_json TEXT NOT NULL,
  finished_reason TEXT NOT NULL,
  pot_awarded INTEGER NOT NULL,
  time_extension_fees INTEGER NOT NULL,
  winners_json TEXT NOT NULL,
  analysis_version INTEGER NOT NULL,
  hole_card_replacements_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hand_players (
  hand_id TEXT NOT NULL REFERENCES hands(hand_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  is_bot INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  starting_stack INTEGER NOT NULL,
  ending_stack INTEGER NOT NULL,
  net_chip_change INTEGER NOT NULL,
  total_committed INTEGER NOT NULL,
  starting_hole_cards_json TEXT NOT NULL,
  hole_cards_json TEXT NOT NULL,
  folded INTEGER NOT NULL,
  folded_at_street TEXT,
  all_in INTEGER NOT NULL,
  reached_showdown INTEGER NOT NULL,
  publicly_revealed INTEGER NOT NULL,
  won_pot_amount INTEGER NOT NULL,
  hand_name TEXT,
  best_five_cards_json TEXT NOT NULL,
  opponents_beaten_json TEXT NOT NULL,
  PRIMARY KEY (hand_id, user_id)
);
CREATE TABLE IF NOT EXISTS hand_actions (
  hand_id TEXT NOT NULL REFERENCES hands(hand_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  street TEXT NOT NULL,
  action TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  source TEXT NOT NULL,
  automatic INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  button_seat INTEGER NOT NULL,
  community_cards_json TEXT NOT NULL,
  pot_before INTEGER NOT NULL,
  pot_after INTEGER NOT NULL,
  current_bet_before INTEGER NOT NULL,
  current_bet_after INTEGER NOT NULL,
  min_raise_before INTEGER NOT NULL,
  player_bet_before INTEGER NOT NULL,
  player_bet_after INTEGER NOT NULL,
  to_call_before INTEGER NOT NULL,
  effective_stack_before INTEGER NOT NULL,
  stack_before INTEGER NOT NULL,
  stack_after INTEGER NOT NULL,
  total_committed_before INTEGER NOT NULL,
  total_committed_after INTEGER NOT NULL,
  amount_committed INTEGER NOT NULL,
  raise_to INTEGER,
  is_aggressive INTEGER NOT NULL,
  is_full_raise INTEGER NOT NULL,
  all_in_kind TEXT,
  all_in_after INTEGER NOT NULL,
  folded_after INTEGER NOT NULL,
  active_player_count_before INTEGER NOT NULL,
  all_in_player_count_before INTEGER NOT NULL,
  seconds_remaining_before INTEGER,
  PRIMARY KEY (hand_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_hands_created_at ON hands(created_at);
CREATE INDEX IF NOT EXISTS idx_hand_players_user ON hand_players(user_id, hand_id);
CREATE INDEX IF NOT EXISTS idx_hand_actions_user ON hand_actions(user_id, hand_id, sequence);
CREATE INDEX IF NOT EXISTS idx_hand_actions_street_action ON hand_actions(street, action);
CREATE VIEW IF NOT EXISTS player_strategy_summary AS
WITH per_hand AS (
  SELECT
    p.hand_id,
    p.user_id,
    p.username,
    h.created_at,
    p.net_chip_change,
    p.reached_showdown,
    CASE WHEN p.won_pot_amount > 0 THEN 1 ELSE 0 END AS won_hand,
    COUNT(a.sequence) AS action_count,
    SUM(CASE WHEN a.is_aggressive = 1 THEN 1 ELSE 0 END) AS aggressive_actions,
    SUM(CASE WHEN a.action = 'call' OR (a.action = 'all-in' AND a.all_in_kind = 'call') THEN 1 ELSE 0 END) AS call_actions,
    SUM(CASE WHEN a.source = 'timeout' THEN 1 ELSE 0 END) AS timeout_actions,
    MAX(CASE WHEN a.street = 'preflop'
      AND a.source IN ('player', 'bot')
      AND (a.action IN ('call', 'bet', 'raise') OR a.action = 'all-in') THEN 1 ELSE 0 END) AS vpip_hand,
    MAX(CASE WHEN a.street = 'preflop'
      AND a.source IN ('player', 'bot')
      AND a.is_aggressive = 1 THEN 1 ELSE 0 END) AS pfr_hand
  FROM hand_players p
  JOIN hands h ON h.hand_id = p.hand_id
  LEFT JOIN hand_actions a ON a.hand_id = p.hand_id AND a.user_id = p.user_id
  GROUP BY p.hand_id, p.user_id
), per_user AS (
  SELECT
    user_id,
    COUNT(*) AS hands,
    SUM(vpip_hand) AS vpip_hands,
    SUM(pfr_hand) AS pfr_hands,
    SUM(reached_showdown) AS showdown_hands,
    SUM(won_hand) AS won_hands,
    SUM(action_count) AS action_count,
    SUM(aggressive_actions) AS aggressive_actions,
    SUM(call_actions) AS call_actions,
    SUM(timeout_actions) AS timeout_actions,
    SUM(net_chip_change) AS net_chip_change
  FROM per_hand
  GROUP BY user_id
)
SELECT
  u.user_id,
  (SELECT recent.username FROM per_hand recent
    WHERE recent.user_id = u.user_id
    ORDER BY recent.created_at DESC, recent.hand_id DESC LIMIT 1) AS username,
  u.hands,
  u.vpip_hands,
  ROUND(100.0 * u.vpip_hands / u.hands, 2) AS vpip_pct,
  u.pfr_hands,
  ROUND(100.0 * u.pfr_hands / u.hands, 2) AS pfr_pct,
  u.showdown_hands,
  ROUND(100.0 * u.showdown_hands / u.hands, 2) AS showdown_pct,
  u.won_hands,
  ROUND(100.0 * u.won_hands / u.hands, 2) AS won_hand_pct,
  u.action_count,
  u.aggressive_actions,
  u.call_actions,
  CASE WHEN u.call_actions = 0 THEN NULL
    ELSE ROUND(1.0 * u.aggressive_actions / u.call_actions, 2) END AS aggression_factor,
  u.timeout_actions,
  u.net_chip_change
FROM per_user u;
""")

def as_int(value, default=0):
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default

def as_bool(value):
    return 1 if value is True else 0

for event in events:
    event_id = str(event.get("id", ""))
    if not re.fullmatch(r"[0-9a-fA-F-]{8,80}", event_id):
        continue
    try:
        created = datetime.fromisoformat(str(event["createdAt"]).replace("Z", "+00:00")).astimezone(timezone.utc)
    except (KeyError, TypeError, ValueError):
        continue
    target_dir = json_root / f"{created:%Y}" / f"{created:%m}"
    target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = target_dir / f"{event_id}.json"
    if not target.exists():
        temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(event, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)

    settings = event.get("settings") if isinstance(event.get("settings"), dict) else {}
    with connection:
        cursor = connection.execute(
            """INSERT OR IGNORE INTO hands VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                event_id,
                event_id,
                str(event.get("createdAt", "")),
                str(event.get("roomCode", "")),
                str(event.get("roomName", "")),
                as_int(event.get("handNumber")),
                str(event.get("roomMode", "classic")),
                0 if event.get("leaderboardEligible") is False else 1,
                as_int(settings.get("smallBlind")),
                as_int(settings.get("bigBlind")),
                as_int(settings.get("actionSeconds")),
                as_int(event.get("buttonSeat")),
                as_int(event.get("smallBlindSeat")),
                as_int(event.get("bigBlindSeat")),
                json.dumps(event.get("communityCards", []), ensure_ascii=False, separators=(",", ":")),
                str(event.get("finishedReason", "")),
                as_int(event.get("potAwarded")),
                as_int(event.get("timeExtensionFees")),
                json.dumps(event.get("winners", []), ensure_ascii=False, separators=(",", ":")),
                as_int(event.get("analysisVersion"), 1),
                json.dumps(event.get("holeCardReplacements", []), ensure_ascii=False, separators=(",", ":")),
            ),
        )
        if cursor.rowcount == 0:
            continue
        connection.executemany(
            """INSERT INTO hand_players VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(
                event_id,
                str(player.get("userId", "")),
                str(player.get("username", "")),
                as_bool(player.get("isBot")),
                as_int(player.get("seat")),
                as_int(player.get("startingStack")),
                as_int(player.get("endingStack")),
                as_int(player.get("netChipChange")),
                as_int(player.get("totalCommitted")),
                json.dumps(player.get("startingHoleCards", player.get("holeCards", [])), ensure_ascii=False, separators=(",", ":")),
                json.dumps(player.get("holeCards", []), ensure_ascii=False, separators=(",", ":")),
                as_bool(player.get("folded")),
                player.get("foldedAtStreet"),
                as_bool(player.get("allIn")),
                as_bool(player.get("reachedShowdown")),
                as_bool(player.get("publiclyRevealed")),
                as_int(player.get("wonPotAmount")),
                player.get("handName"),
                json.dumps(player.get("bestFiveCardIds", []), ensure_ascii=False, separators=(",", ":")),
                json.dumps(player.get("opponentsBeaten", []), ensure_ascii=False, separators=(",", ":")),
            ) for player in event.get("players", [])],
        )
        connection.executemany(
            """INSERT INTO hand_actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(
                event_id,
                as_int(action.get("sequence")),
                str(action.get("at", "")),
                str(action.get("userId", "")),
                str(action.get("street", "")),
                str(action.get("action", "")),
                str(action.get("requestedAction", "")),
                str(action.get("source", "")),
                as_bool(action.get("automatic")),
                as_int(action.get("seat")),
                as_int(action.get("buttonSeat")),
                json.dumps(action.get("communityCards", []), ensure_ascii=False, separators=(",", ":")),
                as_int(action.get("potBefore")),
                as_int(action.get("potAfter")),
                as_int(action.get("currentBetBefore")),
                as_int(action.get("currentBetAfter")),
                as_int(action.get("minRaiseBefore")),
                as_int(action.get("playerBetBefore")),
                as_int(action.get("playerBetAfter")),
                as_int(action.get("toCallBefore")),
                as_int(action.get("effectiveStackBefore")),
                as_int(action.get("stackBefore")),
                as_int(action.get("stackAfter")),
                as_int(action.get("totalCommittedBefore")),
                as_int(action.get("totalCommittedAfter")),
                as_int(action.get("amountCommitted")),
                action.get("raiseTo"),
                as_bool(action.get("isAggressive")),
                as_bool(action.get("isFullRaise")),
                action.get("allInKind"),
                as_bool(action.get("allInAfter")),
                as_bool(action.get("foldedAfter")),
                as_int(action.get("activePlayerCountBefore")),
                as_int(action.get("allInPlayerCountBefore")),
                action.get("secondsRemainingBefore"),
            ) for action in event.get("actions", [])],
        )

connection.close()
os.chmod(database_path, 0o600)
PY

find "$SNAPSHOT_ROOT" -type f \( -name 'texashold-*.json' -o -name 'texashold-*.json.sha256' -o -name 'texas-holdem-state-*.json' -o -name 'texas-holdem-state-*.json.sha256' \) -mtime "+$RETENTION_DAYS" -delete
find "$SNAPSHOT_ROOT" -mindepth 1 -type d -empty -delete
