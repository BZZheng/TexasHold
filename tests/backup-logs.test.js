import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
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
    const analysisEvent = {
      id: "11111111-1111-4111-8111-111111111111",
      analysisVersion: 1,
      createdAt: "2026-08-26T10:00:02.000Z",
      handId: "11111111-1111-4111-8111-111111111111",
      roomCode: "TST2",
      roomName: "分析归档测试",
      handNumber: 1,
      roomMode: "classic",
      leaderboardEligible: true,
      settings: { smallBlind: 5, bigBlind: 10, actionSeconds: 30 },
      buttonSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      communityCards: ["As", "Kh", "2c", "7d", "9s"],
      finishedReason: "showdown",
      potAwarded: 40,
      timeExtensionFees: 0,
      holeCardReplacements: [],
      winners: [{ userId: "a", username: "玩家 A", amount: 40, handName: "一对" }],
      players: [
        {
          userId: "a", username: "玩家 A", isBot: false, seat: 0,
          startingStack: 2000, endingStack: 2020, netChipChange: 20, totalCommitted: 20,
          startingHoleCards: ["Ah", "Qc"], holeCards: ["Ah", "Qc"], folded: false, foldedAtStreet: null, allIn: false,
          reachedShowdown: true, publiclyRevealed: true, wonPotAmount: 40, handName: "一对",
          bestFiveCardIds: ["As", "Ah", "Kh", "Qc", "9s"], opponentsBeaten: ["b"],
        },
        {
          userId: "b", username: "玩家 B", isBot: false, seat: 1,
          startingStack: 2000, endingStack: 1980, netChipChange: -20, totalCommitted: 20,
          startingHoleCards: ["Jd", "Tc"], holeCards: ["Jd", "Tc"], folded: false, foldedAtStreet: null, allIn: false,
          reachedShowdown: true, publiclyRevealed: true, wonPotAmount: 0, handName: null,
          bestFiveCardIds: ["As", "Kh", "Jd", "Tc", "9s"], opponentsBeaten: [],
        },
      ],
      actions: [{
        sequence: 1, at: "2026-08-26T10:00:01.000Z", userId: "a", street: "preflop",
        action: "call", requestedAction: "call", source: "player", automatic: false,
        seat: 0, buttonSeat: 0, communityCards: [], potBefore: 15, potAfter: 20,
        currentBetBefore: 10, currentBetAfter: 10, minRaiseBefore: 10,
        playerBetBefore: 5, playerBetAfter: 10, toCallBefore: 5, effectiveStackBefore: 2000,
        stackBefore: 1995, stackAfter: 1990, totalCommittedBefore: 5,
        totalCommittedAfter: 10, amountCommitted: 5, raiseTo: null, isAggressive: false,
        isFullRaise: false, allInKind: null, allInAfter: false, foldedAfter: false,
        activePlayerCountBefore: 2, allInPlayerCountBefore: 0, secondsRemainingBefore: 27,
      }],
    };
    writeFileSync(path.join(dataRoot, "archive-ring", "hand-analysis-events.json"), JSON.stringify({
      version: 1, events: [analysisEvent],
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
    assert.equal(payload.backupVersion, 4);
    assert.equal(payload.analysis.events.length, 1);
    assert.deepEqual(payload.analysis.events[0].players[0].holeCards, ["Ah", "Qc"]);
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
      "case \"$*\" in *texas-holdem-backup-v4*) ;; *) exit 64 ;; esac",
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
    assert.equal(latest.backupVersion, 4);
    assert.equal("logs" in latest, false, "transport logs must not churn state snapshots");
    assert.equal(latest.analysis.events.length, 1);
    const analysisFiles = filesBelow(path.join(archiveRoot, "archive", "analysis", "hands"));
    assert.equal(analysisFiles.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(analysisFiles[0], "utf8")).players[1].holeCards, ["Jd", "Tc"]);
    const databasePath = path.join(archiveRoot, "database", "texas-holdem-analytics.sqlite3");
    assert.equal(existsSync(databasePath), true);
    const databaseProbe = spawnSync("python3", ["-c", [
      "import json, sqlite3, sys",
      "db=sqlite3.connect(sys.argv[1])",
      "summary=db.execute(\"select hands, vpip_hands, pfr_hands, net_chip_change from player_strategy_summary where user_id='a'\").fetchone()",
      "print(json.dumps({'hands':db.execute('select count(*) from hands').fetchone()[0], 'players':db.execute('select count(*) from hand_players').fetchone()[0], 'actions':db.execute('select count(*) from hand_actions').fetchone()[0], 'cards':json.loads(db.execute(\"select hole_cards_json from hand_players where user_id='a'\").fetchone()[0]), 'summary':summary}))",
    ].join(";"), databasePath], { encoding: "utf8" });
    assert.equal(databaseProbe.status, 0, databaseProbe.stderr);
    assert.deepEqual(JSON.parse(databaseProbe.stdout), {
      hands: 1, players: 2, actions: 1, cards: ["Ah", "Qc"], summary: [1, 1, 0, 20],
    });

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
