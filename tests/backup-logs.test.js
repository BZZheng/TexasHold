import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(".");

function filesBelow(root) {
  const results = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else results.push(target);
    }
  }
  visit(root);
  return results;
}

test("the restricted server export delivers verified, redacted JSONL segments to the remote archive", () => {
  const root = mkdtempSync(path.join(tmpdir(), "friends-holdem-log-export-"));
  try {
    const dataRoot = path.join(root, "data");
    const logArchive = path.join(dataRoot, "logs", "archive-ring");
    mkdirSync(path.join(dataRoot, "hot"), { recursive: true });
    mkdirSync(path.join(dataRoot, "archive-ring"), { recursive: true });
    mkdirSync(logArchive, { recursive: true });
    writeFileSync(path.join(dataRoot, "hot", "texashold.json"), JSON.stringify({
      users: [], sessions: [], histories: [],
    }));
    writeFileSync(path.join(dataRoot, "hot", "runtime-rooms.json"), JSON.stringify({
      version: 3, rooms: [],
    }));
    writeFileSync(path.join(dataRoot, "archive-ring", "history-events.json"), JSON.stringify({
      version: 1, events: [],
    }));
    const segmentName = "application-test-20260826100000000-1.jsonl";
    const segmentContent = `${JSON.stringify({
      ts: "2026-08-26T10:00:00.000Z",
      level: "warn",
      domain: "auth",
      event: "login_rejected",
      eventId: "event-1",
      service: "friends-holdem",
      environment: "test",
      release: "test",
      instanceId: "test",
      requestId: "request-1",
      password: "[REDACTED]",
      actionToken: "[REDACTED]",
    })}\n`;
    writeFileSync(path.join(logArchive, segmentName), segmentContent, { mode: 0o600 });

    const exported = spawnSync("sh", [path.join(projectRoot, "deploy", "backup", "export-data.sh")], {
      cwd: projectRoot,
      env: { ...process.env, TEXAS_HOLDEM_DATA_ROOT: dataRoot },
      encoding: "utf8",
    });
    assert.equal(exported.status, 0, exported.stderr);
    const payload = JSON.parse(exported.stdout);
    assert.equal(payload.backupVersion, 3);
    assert.equal(payload.logs.segments.length, 1);
    const encodedSegment = payload.logs.segments[0];
    assert.equal(encodedSegment.name, segmentName);
    assert.equal(
      crypto.createHash("sha256").update(Buffer.from(encodedSegment.content, "base64")).digest("hex"),
      encodedSegment.sha256,
    );

    const fakeBin = path.join(root, "bin");
    mkdirSync(fakeBin);
    const fakeSsh = path.join(fakeBin, "ssh");
    writeFileSync(fakeSsh, [
      "#!/bin/sh",
      "case \"$*\" in *texas-holdem-backup-v3*) ;; *) exit 64 ;; esac",
      "exec /bin/cat -- \"$FAKE_SSH_PAYLOAD\"",
      "",
    ].join("\n"));
    chmodSync(fakeSsh, 0o700);
    const fakeFlock = path.join(fakeBin, "flock");
    writeFileSync(fakeFlock, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeFlock, 0o700);
    const exportFile = path.join(root, "export.json");
    writeFileSync(exportFile, exported.stdout, { mode: 0o600 });
    const keyFile = path.join(root, "backup-key");
    writeFileSync(keyFile, "test-only\n", { mode: 0o600 });
    const archiveRoot = path.join(root, "remote-archive", "texas-holdem");

    const pulled = spawnSync("bash", [path.join(projectRoot, "deploy", "backup", "archive-pull-backup.sh")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_SSH_PAYLOAD: exportFile,
        TEXAS_HOLDEM_ARCHIVE_ENV_FILE: path.join(root, "missing-archive.env"),
        TEXAS_HOLDEM_ARCHIVE_ROOT: archiveRoot,
        TEXAS_HOLDEM_ARCHIVE_USER: "archive-reader",
        TEXAS_HOLDEM_ARCHIVE_HOST: "archive.example.com",
        TEXAS_HOLDEM_ARCHIVE_KEY: keyFile,
      },
      encoding: "utf8",
    });
    assert.equal(pulled.status, 0, pulled.stderr);
    const archivedLogs = filesBelow(path.join(archiveRoot, "logs", "app"));
    assert.equal(
      archivedLogs.length,
      1,
      `stdout=${pulled.stdout}\narchive files=${filesBelow(archiveRoot).join(",")}`,
    );
    assert.equal(readFileSync(archivedLogs[0], "utf8"), segmentContent);
    assert.equal(readFileSync(archivedLogs[0], "utf8").includes("test-only-password"), false);

    const latest = JSON.parse(readFileSync(path.join(archiveRoot, "latest", "texas-holdem-state.json"), "utf8"));
    assert.equal(latest.backupVersion, 3);
    assert.equal("logs" in latest, false, "transport logs must not churn state snapshots");

    const unsafeRecord = `${JSON.stringify({
      ts: "2026-08-26T10:01:00.000Z",
      level: "error",
      domain: "auth",
      event: "unsafe_probe",
      password: "must-never-reach-archive",
    })}\n`;
    const unsafePayload = structuredClone(payload);
    unsafePayload.logs.segments = [{
      name: "application-test-20260826100100000-2.jsonl",
      sha256: crypto.createHash("sha256").update(unsafeRecord).digest("hex"),
      encoding: "base64",
      content: Buffer.from(unsafeRecord).toString("base64"),
    }];
    const unsafeExportFile = path.join(root, "unsafe-export.json");
    writeFileSync(unsafeExportFile, JSON.stringify(unsafePayload), { mode: 0o600 });
    const rejected = spawnSync("bash", [path.join(projectRoot, "deploy", "backup", "archive-pull-backup.sh")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_SSH_PAYLOAD: unsafeExportFile,
        TEXAS_HOLDEM_ARCHIVE_ENV_FILE: path.join(root, "missing-archive.env"),
        TEXAS_HOLDEM_ARCHIVE_ROOT: archiveRoot,
        TEXAS_HOLDEM_ARCHIVE_USER: "archive-reader",
        TEXAS_HOLDEM_ARCHIVE_HOST: "archive.example.com",
        TEXAS_HOLDEM_ARCHIVE_KEY: keyFile,
      },
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /unredacted sensitive field: password/);
    assert.equal(filesBelow(path.join(archiveRoot, "logs", "app")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
