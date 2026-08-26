import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StructuredLogger,
  sanitizeLogError,
  socketLogDomain,
} from "../server/logger.js";

function loggerFixture(root, options = {}) {
  return new StructuredLogger({
    hotDir: path.join(root, "logs", "hot"),
    archiveDir: path.join(root, "logs", "archive-ring"),
    stdout: false,
    flushIntervalMs: 60_000,
    archiveSyncIntervalMs: 60_000,
    instanceId: "test-instance",
    ...options,
  });
}

test("structured JSONL logs keep correlation IDs and redact credentials, cards, private results, and stacks", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "friends-holdem-logger-"));
  const logger = loggerFixture(root);
  try {
    const error = new Error("Bearer secret-session-value failed");
    error.stack = "Error: fh_session=raw-cookie\n    at /Users/private-name/project/server.js:20:1";
    logger.warn("action", "action_rejected", {
      requestId: "req-1",
      roomCode: "ABCD",
      handId: "hand-public-id",
      userId: "user-1",
      password: "plain-password",
      actionToken: "raw-action-token",
      cards: ["As", "Ah"],
      skillResult: { target: "secret" },
      error,
    });
    await logger.flush();

    const content = readFileSync(path.join(root, "logs", "hot", "application.jsonl"), "utf8");
    const record = JSON.parse(content.trim());
    assert.equal(record.level, "warn");
    assert.equal(record.domain, "action");
    assert.equal(record.requestId, "req-1");
    assert.equal(record.roomCode, "ABCD");
    assert.equal(record.handId, "hand-public-id");
    assert.equal(record.password, "[REDACTED]");
    assert.equal(record.actionToken, "[REDACTED]");
    assert.equal(record.cards, "[REDACTED]");
    assert.equal(record.skillResult, "[REDACTED]");
    assert.doesNotMatch(content, /plain-password|raw-action-token|secret-session-value|raw-cookie|private-name|\"As\"|\"Ah\"/);
    assert.match(record.error.stack, /Users\/<user>/);
  } finally {
    await logger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the non-blocking queue is bounded and reports dropped entries", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "friends-holdem-logger-queue-"));
  const logger = loggerFixture(root, { queueMaxEntries: 2 });
  try {
    logger.info("lobby", "one");
    logger.info("room", "two");
    logger.info("game", "three");
    assert.equal(logger.status().queuedEntries, 2);
    assert.equal(logger.status().droppedEntries, 1);
    await logger.flush();
    const lines = readFileSync(path.join(root, "logs", "hot", "application.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).event), ["two", "three"]);
  } finally {
    await logger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("JSONL rotation applies both file-count and byte capacity without blocking new writes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "friends-holdem-logger-rotation-"));
  let now = 1_700_000_000_000;
  const logger = loggerFixture(root, {
    fileMaxBytes: 1024 * 1024,
    archiveMaxBytes: 1024 * 1024,
    archiveMaxFiles: 2,
    rotateIntervalMs: 1,
    now: () => now,
  });
  try {
    for (let index = 0; index < 5; index += 1) {
      logger.info("game", "state_transition", { index });
      await logger.flush();
      now += 2;
    }
    const status = logger.status();
    assert.ok(status.archivedFiles <= 2);
    assert.ok(status.archiveBytes <= status.archiveMaxBytes);
    assert.ok(status.archiveDroppedFiles >= 2);
    assert.equal(status.fileHealthy, true);
    assert.ok(readdirSync(path.join(root, "logs", "archive-ring")).length <= 2);
  } finally {
    await logger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable push archive degrades health only and later catches up atomically", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "friends-holdem-logger-archive-"));
  const externalArchiveDir = path.join(root, "remote-archive", "logs");
  const readyFile = path.join(root, "remote-archive", ".texashold-archive-ready");
  const logger = loggerFixture(root, {
    archiveMode: "push",
    externalArchiveDir,
    archiveReadyFile: readyFile,
  });
  try {
    logger.info("deploy", "archive_resilience_probe", { requestId: "req-archive" });
    await logger.flush();
    await assert.doesNotReject(logger.syncArchive());
    assert.equal(logger.status().archive.state, "unavailable");
    assert.equal(logger.status().archive.lastError, "archive_sync_failed");
    assert.equal(JSON.stringify(logger.status()).includes(root), false);
    assert.equal(logger.status().fileHealthy, true);

    mkdirSync(externalArchiveDir, { recursive: true, mode: 0o700 });
    writeFileSync(readyFile, "ready\n", { mode: 0o600 });
    await logger.syncArchive();
    assert.equal(logger.status().archive.state, "healthy");
    assert.ok(logger.status().archive.lastSuccessAt);
    assert.equal(
      existsSync(path.join(externalArchiveDir, "application-test-instance-current.jsonl")),
      true,
    );
  } finally {
    await logger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull-mode health follows the archive replication heartbeat and becomes stale", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "friends-holdem-logger-pull-"));
  const replicationFile = path.join(root, "replication-state.json");
  let now = Date.parse("2026-08-26T12:00:00.000Z");
  writeFileSync(replicationFile, JSON.stringify({
    lastArchiveLogPullAt: "2026-08-26T11:59:30.000Z",
  }));
  const logger = loggerFixture(root, {
    archiveMode: "pull",
    replicationStateFile: replicationFile,
    archiveStaleAfterMs: 60_000,
    now: () => now,
  });
  try {
    await logger.syncArchive();
    assert.equal(logger.status().archive.state, "healthy");
    now += 120_000;
    await logger.syncArchive();
    assert.equal(logger.status().archive.state, "stale");
    assert.ok(logger.status().archive.lastSuccessAt);
  } finally {
    await logger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull-mode accepts the legacy provider-specific replication field", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "friends-holdem-logger-legacy-pull-"));
  const replicationFile = path.join(root, "replication-state.json");
  const legacyProvider = String.fromCharCode(78, 97, 115);
  writeFileSync(replicationFile, JSON.stringify({
    [`last${legacyProvider}LogPullAt`]: "2026-08-26T11:59:30.000Z",
  }));
  const logger = loggerFixture(root, {
    archiveMode: "pull",
    replicationStateFile: replicationFile,
    archiveStaleAfterMs: 60_000,
    now: () => Date.parse("2026-08-26T12:00:00.000Z"),
  });
  try {
    await logger.syncArchive();
    assert.equal(logger.status().archive.state, "healthy");
  } finally {
    await logger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("socket events are assigned to stable functional log domains", () => {
  assert.equal(socketLogDomain("lobby:list"), "lobby");
  assert.equal(socketLogDomain("room:create"), "room");
  assert.equal(socketLogDomain("room:start"), "game");
  assert.equal(socketLogDomain("game:action"), "action");
  assert.equal(socketLogDomain("game:watch-player"), "spectator");
  assert.equal(socketLogDomain("hextech:skill-command"), "hextech");
  assert.equal(socketLogDomain("game:rebuy"), "rebuy");
  assert.equal(socketLogDomain("room:final-settlement"), "settlement");
  assert.doesNotMatch(JSON.stringify(sanitizeLogError(new Error("safe"))), /undefined/);
});
