import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RoomManager } from "../server/rooms.js";
import { FixedWindowRateLimiter } from "../server/security.js";
import { Store } from "../server/store.js";

function socket(userId, username, id = `socket-${userId}`) {
  return {
    id,
    data: { user: { id: userId, username } },
    join() {},
    leave() {},
  };
}

function managerFixture() {
  const io = {
    emit() {},
    to() { return { emit() {} }; },
  };
  const store = { addHistory() {} };
  const manager = new RoomManager(io, store);
  const host = socket("host", "安全测试房主");
  const created = manager.createRoom(host, {
    name: "服务端权威测试",
    settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  return { manager, host, room: manager.rooms.get(created.room.code) };
}

test("session tokens are hashed at rest", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-security-"));
  try {
    const store = new Store(dataDir);
    const user = store.register("令牌安全测试", "local-test-password");
    const session = store.createSession(user.id);
    const persisted = readFileSync(path.join(dataDir, "hot", "texashold.json"), "utf8");

    assert.equal(persisted.includes(session.token), false);
    assert.match(persisted, /"tokenHash"/);
    assert.equal(store.userForToken(session.token)?.id, user.id);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("legacy root data migrates into the bounded application-server hot directory", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-migration-"));
  try {
    const legacy = {
      users: [{ id: "legacy-user", username: "旧数据玩家", passwordHash: "unused", createdAt: new Date().toISOString() }],
      sessions: [],
      histories: [],
    };
    writeFileSync(path.join(dataDir, "texashold.json"), JSON.stringify(legacy), { mode: 0o600 });
    writeFileSync(path.join(dataDir, "runtime-rooms.json"), JSON.stringify({ version: 1, rooms: [] }), { mode: 0o600 });

    const store = new Store(dataDir);

    assert.equal(store.data.users[0].id, "legacy-user");
    assert.equal(existsSync(path.join(dataDir, "hot", "texashold.json")), true);
    assert.equal(existsSync(path.join(dataDir, "hot", "runtime-rooms.json")), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("settlement history is copied into a capacity-bounded local archive ring", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-archive-"));
  try {
    const store = new Store(dataDir, { archiveMaxBytes: 900, minFreeBytes: 1 });
    for (let index = 0; index < 20; index += 1) {
      store.addHistory({
        userId: "archive-user",
        roomCode: "TST2",
        roomName: "归档容量测试",
        handNumber: index + 1,
        chipChange: index,
        result: "结束",
        detail: "高牌",
      });
    }
    const legacyProvider = String.fromCharCode(78, 97, 115);
    const legacyArchiveTimestamp = "2026-08-26T11:59:30.000Z";
    writeFileSync(path.join(dataDir, "replication-state.json"), JSON.stringify({
      [`last${legacyProvider}PullAt`]: legacyArchiveTimestamp,
    }), { mode: 0o600 });

    const status = store.storageStatus();
    assert.equal("hotDir" in status, false);
    assert.equal("dataDir" in status, false);
    assert.equal("path" in status, false);
    assert.ok(status.archiveEvents > 0);
    assert.ok(status.archiveBytes <= status.archiveMaxBytes);
    assert.ok(status.archiveDroppedEvents > 0);
    assert.equal(status.lastArchivePullAt, legacyArchiveTimestamp);
    assert.equal(status.mode, "local-hot-archive-ring");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("all remote joins start as spectators even when player mode is forged", () => {
  const { manager, room } = managerFixture();
  const attacker = socket("guest", "请求玩家席的访客");
  const joined = manager.joinRoom(attacker, { code: room.code, mode: "player" });

  assert.equal(joined.joinedAs, "spectator");
  assert.equal(joined.room.self.role, "spectator");
  assert.equal(joined.room.self.stack, 0);
  assert.equal(joined.room.self.seat, null);
});

test("forged card state is rejected and an action token cannot be replayed", () => {
  const { manager, host, room } = managerFixture();
  manager.addBot(host);
  manager.setReady(host, { ready: true });
  manager.startGame(host);

  const initialView = room.game.viewFor("host");
  const initialCards = [...room.game.players.find((player) => player.userId === "host").hand];
  const initialVersion = room.game.stateVersion;
  const action = initialView.legal.canCheck ? "check" : "call";
  const validPayload = {
    action,
    handId: initialView.handId,
    actionToken: initialView.actionToken,
  };

  assert.equal("deck" in initialView, false);
  assert.equal(room.game.viewFor("observer", true).actionToken, null);
  assert.throws(
    () => manager.gameAction(host, { ...validPayload, cards: ["As", "Ah"], stack: 999999 }),
    /无权提交或修改牌局状态/,
  );
  assert.deepEqual(room.game.players.find((player) => player.userId === "host").hand, initialCards);
  assert.equal(room.game.stateVersion, initialVersion);

  manager.gameAction(host, validPayload);
  assert.throws(() => manager.gameAction(host, validPayload), /操作已过期/);
  assert.deepEqual(room.game.players.find((player) => player.userId === "host").hand, initialCards);
});

test("fixed-window limiter rejects flooding and resets after its window", () => {
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.consume("player", 1000).allowed, true);
  assert.equal(limiter.consume("player", 1001).allowed, true);
  assert.equal(limiter.consume("player", 1002).allowed, false);
  assert.equal(limiter.consume("player", 2000).allowed, true);
});
