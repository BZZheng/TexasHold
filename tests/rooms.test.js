import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HoldemGame } from "../server/game.js";
import { RoomManager } from "../server/rooms.js";

function fixture() {
  const io = {
    emit() {},
    to() { return { emit() {} }; },
  };
  const store = { addHistory() {} };
  const socket = {
    id: "socket-host",
    data: { user: { id: "host", username: "补筹测试玩家" } },
    join() {},
    leave() {},
    on() {},
  };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(socket, {
    name: "补筹队列测试",
    settings: {
      maxPlayers: 8,
      initialChips: 2000,
      smallBlind: 5,
      bigBlind: 10,
      allowRebuy: true,
      rebuyAmount: 2000,
      maxRebuys: 3,
    },
  });
  const room = manager.rooms.get(created.room.code);
  room.game = { stage: "finished", viewFor: () => null };
  const member = room.members.get("host");
  member.stack = 0;
  member.ready = false;
  return { manager, room, member, socket };
}

test("a waiting room with no active game survives a runtime restart", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-waiting-restart-"));
  const runtimeFile = path.join(dataDir, "runtime-rooms.json");
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const socket = {
    id: "socket-waiting-restart",
    data: { user: { id: "waiting-host", username: "等待房间恢复玩家" } },
    join() {},
    leave() {},
    on() {},
  };
  let manager;
  let restored;

  try {
    manager = new RoomManager(io, store, { runtimeFile });
    const created = manager.createRoom(socket, {
      name: "等待开局恢复测试",
      settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
    });
    manager.shutdown();
    manager = null;

    restored = new RoomManager(io, store, { runtimeFile });
    const room = restored.rooms.get(created.room.code);
    assert.ok(room);
    assert.equal(room.game, null);
    assert.equal(room.hostUserId, "waiting-host");
    assert.equal(room.members.get("waiting-host").stack, 2000);
  } finally {
    manager?.shutdown();
    restored?.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a room with at most one human player is dissolved after two hours", () => {
  const socketEvents = [];
  const io = {
    emit() {},
    to(socketId) {
      return { emit(event, payload) { socketEvents.push({ socketId, event, payload }); } };
    },
  };
  const store = { addHistory() {} };
  const host = {
    id: "socket-expiring-host",
    data: { user: { id: "expiring-host", username: "超时房主" } },
    join() {}, leave() {}, on() {},
  };
  const manager = new RoomManager(io, store, { singlePlayerRoomTtlMs: 2 * 60 * 60 * 1000 });
  const created = manager.createRoom(host, {
    name: "单人超时测试",
    settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  manager.addBot(host);
  const room = manager.rooms.get(created.room.code);
  const now = Date.now();
  room.singlePlayerSince = new Date(now - (2 * 60 * 60 * 1000)).toISOString();

  assert.deepEqual(manager.sweepExpiredRooms(now), [room.code]);
  assert.equal(manager.rooms.has(room.code), false);
  assert.equal(manager.userRooms.has(host.data.user.id), false);
  assert.ok(socketEvents.some(({ event, payload }) => (
    event === "room:expired" && payload.roomCode === room.code
  )));
  manager.shutdown();
});

test("room chip settings reject values outside the approved five-point unit", () => {
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const socket = {
    id: "socket-chip-settings",
    data: { user: { id: "chip-settings-host", username: "筹码设置房主" } },
    join() {},
    leave() {},
    on() {},
  };
  const manager = new RoomManager(io, store);

  assert.throws(
    () => manager.createRoom(socket, {
      name: "非法筹码设置",
      settings: { initialChips: 2000, smallBlind: 4, bigBlind: 10 },
    }),
    /小盲.*5 的倍数|小盲需要是/,
  );
  assert.throws(
    () => manager.createRoom(socket, {
      name: "非法筹码设置",
      settings: { initialChips: 2001, smallBlind: 5, bigBlind: 10 },
    }),
    /初始筹码必须是 5 的倍数/,
  );
  manager.shutdown();
});

test("a player can leave for the lobby, rejoin between hands, and ready again", () => {
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const host = {
    id: "socket-return-host",
    data: { user: { id: "return-host", username: "留守房主" } },
    join() {}, leave() {}, on() {},
  };
  const returningPlayer = {
    id: "socket-return-player",
    data: { user: { id: "return-player", username: "重返玩家" } },
    join() {}, leave() {}, on() {},
  };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(host, {
    name: "返回大厅回归测试",
    settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });

  manager.joinRoom(returningPlayer, { code: created.room.code, mode: "player" });
  manager.requestSeat(returningPlayer, { seat: 3 });
  manager.approveSeat(host, { userId: "return-player" });
  manager.setReady(returningPlayer, { ready: true });
  manager.leaveRoom(returningPlayer);

  const rejoined = manager.joinRoom(returningPlayer, { code: created.room.code, mode: "player" });
  assert.equal(rejoined.joinedAs, "player");
  assert.equal(rejoined.room.self.role, "player");
  assert.equal(rejoined.room.self.seat, 3);
  assert.equal(rejoined.room.self.stack, 2000);
  assert.equal(rejoined.room.self.ready, false);

  manager.setReady(returningPlayer, { ready: true });
  assert.equal(manager.rooms.get(created.room.code).members.get("return-player").ready, true);
  manager.shutdown();
});

test("only the host can kick another human player between hands", () => {
  const directedEvents = [];
  const io = {
    emit() {},
    to(socketId) {
      return { emit(event, payload) { directedEvents.push({ socketId, event, payload }); } };
    },
  };
  const store = { addHistory() {} };
  const host = { id: "socket-kick-host", data: { user: { id: "kick-host", username: "踢人房主" } }, join() {}, leave() {}, on() {} };
  const guest = { id: "socket-kick-guest", data: { user: { id: "kick-guest", username: "待踢玩家" } }, join() {}, leave() {}, on() {} };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(host, {
    name: "房主管理测试",
    settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  manager.joinRoom(guest, { code: created.room.code, mode: "player" });
  manager.requestSeat(guest, { seat: 2 });
  manager.approveSeat(host, { userId: "kick-guest" });

  assert.throws(() => manager.kickMember(guest, { userId: "kick-host" }), /只有房主/);
  assert.throws(() => manager.kickMember(host, { userId: "kick-host" }), /不能将自己踢出/);
  manager.kickMember(host, { userId: "kick-guest" });

  const room = manager.rooms.get(created.room.code);
  assert.equal(room.members.has("kick-guest"), false);
  assert.equal(manager.userRooms.has("kick-guest"), false);
  assert.equal(room.settlement.accounts.get("kick-guest").exitCashOut, 2000);
  assert.equal(directedEvents.some((entry) => entry.socketId === guest.id && entry.event === "room:kicked"), true);
  manager.shutdown();
});

test("an active hand participant cannot be kicked until the hand ends", () => {
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const host = { id: "socket-live-kick-host", data: { user: { id: "live-kick-host", username: "开局房主" } }, join() {}, leave() {}, on() {} };
  const guest = { id: "socket-live-kick-guest", data: { user: { id: "live-kick-guest", username: "参局玩家" } }, join() {}, leave() {}, on() {} };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(host, { settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 } });
  manager.joinRoom(guest, { code: created.room.code, mode: "player" });
  manager.requestSeat(guest, { seat: 1 });
  manager.approveSeat(host, { userId: "live-kick-guest" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  assert.throws(() => manager.kickMember(host, { userId: "live-kick-guest" }), /牌局进行中不能踢出参局玩家/);
  assert.equal(manager.rooms.get(created.room.code).members.has("live-kick-guest"), true);
  manager.shutdown();
});

test("the host can transfer ownership to a connected seated human player", () => {
  const directedEvents = [];
  const io = {
    emit() {},
    to(socketId) { return { emit(event, payload) { directedEvents.push({ socketId, event, payload }); } }; },
  };
  const store = { addHistory() {} };
  const host = { id: "socket-transfer-host", data: { user: { id: "transfer-host", username: "原房主" } }, join() {}, leave() {}, on() {} };
  const guest = { id: "socket-transfer-guest", data: { user: { id: "transfer-guest", username: "新房主" } }, join() {}, leave() {}, on() {} };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(host, { settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 } });
  manager.joinRoom(guest, { code: created.room.code, mode: "player" });
  manager.requestSeat(guest, { seat: 1 });
  manager.approveSeat(host, { userId: guest.data.user.id });

  manager.transferHost(host, { userId: guest.data.user.id });
  const room = manager.rooms.get(created.room.code);
  assert.equal(room.hostUserId, guest.data.user.id);
  assert.throws(() => manager.addBot(host), /只有房主/);
  assert.doesNotThrow(() => manager.addBot(guest));
  assert.equal(directedEvents.some((entry) => entry.socketId === guest.id && entry.event === "room:host-transferred"), true);
  manager.shutdown();
});

test("a busted player rebuys into the next-hand queue and confirms a seat", () => {
  const { manager, room, member, socket } = fixture();

  manager.rebuy(socket, { accept: true });
  assert.equal(member.role, "spectator");
  assert.equal(member.pendingRebuy, 2000);
  assert.equal(member.rebuyCount, 1);
  assert.equal(member.seatRequest, true);
  assert.equal(member.requestedSeat, 0);
  assert.equal(room.settlement.accounts.get(member.userId).buyIn, 4000);

  manager.deferSeat(socket);
  assert.equal(member.role, "spectator");
  assert.equal(member.pendingRebuy, 2000);
  assert.equal(member.seatRequest, false);

  manager.requestSeat(socket, { seat: 3 });
  assert.equal(member.requestedSeat, 3);
  manager.confirmNextSeat(socket);

  assert.equal(member.role, "player");
  assert.equal(member.seat, 3);
  assert.equal(member.pendingRebuy, 2000);
  assert.equal(member.ready, false);
});

test("declining a rebuy moves the busted player to spectator mode", () => {
  const { manager, member, socket } = fixture();

  manager.rebuy(socket, { accept: false });

  assert.equal(member.role, "spectator");
  assert.equal(member.seat, null);
  assert.equal(member.pendingRebuy, 0);
  assert.equal(member.seatRequest, false);
});

test("a seated player below 500 chips can top up without leaving their seat", () => {
  const { manager, room, member, socket } = fixture();
  member.stack = 495;
  member.ready = true;

  manager.rebuy(socket, { accept: true });
  assert.equal(member.role, "player");
  assert.equal(member.seat, 0);
  assert.equal(member.stack, 495);
  assert.equal(member.pendingRebuy, 2000);
  assert.equal(member.ready, true);
  assert.equal(room.settlement.accounts.get(member.userId).buyIn, 4000);

  manager.addBot(socket);
  manager.startGame(socket);
  assert.equal(member.pendingRebuy, 0);
  assert.equal(member.stack, 2495);
  assert.equal(room.game.players.find((player) => player.userId === member.userId).startingStack, 2495);
  manager.shutdown();
});

test("a player with 500 or more chips cannot top up", () => {
  const { manager, member, socket } = fixture();
  member.stack = 500;
  assert.throws(() => manager.rebuy(socket, { accept: true }), /低于 500/);
  assert.equal(member.pendingRebuy, 0);
  manager.shutdown();
});

test("spectators can switch live hand perspectives but cannot select the mystery player", () => {
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const host = { id: "socket-watch-host", data: { user: { id: "watch-host", username: "观战房主" } }, join() {}, leave() {}, on() {} };
  const spectator = { id: "socket-watch-guest", data: { user: { id: "watch-guest", username: "观战好友" } }, join() {}, leave() {}, on() {} };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(host, {
    name: "切换观战测试",
    settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  manager.addBot(host);
  manager.setReady(host, { ready: true });
  manager.startGame(host);
  manager.joinRoom(spectator, { code: created.room.code });

  const room = manager.rooms.get(created.room.code);
  const mysteryUserId = room.game.spectatorMysteryUserId;
  const watchable = room.game.players.find((player) => player.userId !== mysteryUserId);
  const watched = manager.watchPlayer(spectator, { userId: watchable.userId }).room;

  assert.equal(room.members.get("watch-guest").spectatorFocusUserId, watchable.userId);
  assert.equal(watched.game.spectatorView.focusUserId, watchable.userId);
  assert.equal(watched.game.players.find((player) => player.userId === watchable.userId).cards.length, 2);
  assert.equal(watched.game.players.find((player) => player.userId === mysteryUserId).cards.length, 0);
  assert.throws(
    () => manager.watchPlayer(spectator, { userId: mysteryUserId }),
    /神秘玩家的手牌不可观看/,
  );
  assert.throws(
    () => manager.watchPlayer(host, { userId: watchable.userId }),
    /只有观战者或本局已弃牌的玩家可以切换观看视角/,
  );
  manager.shutdown();
});

test("folded players can switch spectator perspectives while retaining their own hand", () => {
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const host = { id: "socket-fold-watch-host", data: { user: { id: "fold-watch-host", username: "弃牌房主" } }, join() {}, leave() {}, on() {} };
  const guest = { id: "socket-fold-watch-guest", data: { user: { id: "fold-watch-guest", username: "隐藏手牌玩家" } }, join() {}, leave() {}, on() {} };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(host, {
    name: "弃牌观战测试",
    settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  manager.joinRoom(guest, { code: created.room.code });
  manager.requestSeat(guest, { seat: 1 });
  manager.approveSeat(host, { userId: guest.data.user.id });
  manager.addBot(host);
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  const bot = room.game.players.find((player) => player.isBot);
  room.game.spectatorMysteryUserId = bot.userId;
  const selfPlayer = room.game.players.find((player) => player.userId === host.data.user.id);
  const ownCards = [...selfPlayer.hand];
  selfPlayer.folded = true;
  const target = room.game.players.find((player) => player.userId === guest.data.user.id);
  manager.setSpectatorVisibility(guest, { hidden: true, handId: room.game.handId });
  const watched = manager.watchPlayer(host, { userId: target.userId }).room;

  assert.equal(room.members.get(host.data.user.id).spectatorFocusUserId, target.userId);
  assert.equal(watched.game.spectatorView.focusUserId, target.userId);
  assert.deepEqual(watched.game.players.find((player) => player.userId === host.data.user.id).cards, ownCards);
  assert.equal(watched.game.players.find((player) => player.userId === target.userId).cards.length, 2);
  assert.equal(watched.game.players.find((player) => player.userId === target.userId).spectatorAccessGranted, true);
  assert.equal(watched.game.legal, null);
  manager.shutdown();
});

test("spectator access is sticky within one hand but never carries into the next hand", () => {
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const host = { id: "socket-private-host", data: { user: { id: "private-host", username: "隐私玩家" } }, join() {}, leave() {}, on() {} };
  const spectator = { id: "socket-private-watch", data: { user: { id: "private-watch", username: "隐私观战" } }, join() {}, leave() {}, on() {} };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(host, {
    name: "手牌隐私测试",
    settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  manager.addBot(host);
  manager.setReady(host, { ready: true });
  manager.startGame(host);
  manager.joinRoom(spectator, { code: created.room.code });

  const room = manager.rooms.get(created.room.code);
  const bot = room.game.players.find((player) => player.isBot);
  room.game.spectatorMysteryUserId = bot.userId;
  const spectatorMember = room.members.get(spectator.data.user.id);
  spectatorMember.spectatorCardAccess = null;
  manager.setSpectatorVisibility(host, { hidden: true, handId: room.game.handId });

  assert.equal(room.game.players.find((player) => player.userId === host.data.user.id).spectatorHidden, true);
  assert.throws(
    () => manager.watchPlayer(spectator, { userId: host.data.user.id }),
    /已隐藏手牌/,
  );
  assert.throws(
    () => manager.setSpectatorVisibility(spectator, { hidden: false, handId: room.game.handId }),
    /观战者不能设置/,
  );

  manager.setSpectatorVisibility(host, { hidden: false, handId: room.game.handId });
  const visible = manager.watchPlayer(spectator, { userId: host.data.user.id }).room;
  assert.equal(visible.game.players.find((player) => player.userId === host.data.user.id).cards.length, 2);
  assert.equal(
    visible.game.players.find((player) => player.userId === host.data.user.id).spectatorAccessGranted,
    true,
  );

  manager.setSpectatorVisibility(host, { hidden: true, handId: room.game.handId });
  const stillVisible = manager.watchPlayer(spectator, { userId: host.data.user.id }).room;
  assert.equal(stillVisible.game.spectatorView.focusUserId, host.data.user.id);
  assert.equal(stillVisible.game.players.find((player) => player.userId === host.data.user.id).cards.length, 2);

  const previousHandId = room.game.handId;
  room.game = new HoldemGame({
    players: room.game.players.map((player) => ({
      userId: player.userId,
      username: player.username,
      seat: player.seat,
      stack: 2000,
      isBot: player.isBot,
    })),
    settings: room.settings,
  });
  room.game.spectatorMysteryUserId = bot.userId;
  assert.notEqual(room.game.handId, previousHandId);
  manager.setSpectatorVisibility(host, { hidden: true, handId: room.game.handId });
  assert.throws(
    () => manager.watchPlayer(spectator, { userId: host.data.user.id }),
    /已隐藏手牌/,
  );
  manager.shutdown();
});

test("same-hand spectator access survives a runtime restart", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-spectator-access-"));
  const runtimeFile = path.join(dataDir, "runtime-rooms.json");
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const host = { id: "socket-access-host", data: { user: { id: "access-host", username: "授权玩家" } }, join() {}, leave() {}, on() {} };
  const spectator = { id: "socket-access-watch", data: { user: { id: "access-watch", username: "授权观战" } }, join() {}, leave() {}, on() {} };
  let manager;
  let restored;

  try {
    manager = new RoomManager(io, store, { runtimeFile });
    const created = manager.createRoom(host, {
      name: "观战授权恢复测试",
      settings: { maxPlayers: 2, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
    });
    manager.addBot(host);
    manager.setReady(host, { ready: true });
    manager.startGame(host);
    const room = manager.rooms.get(created.room.code);
    const bot = room.game.players.find((player) => player.isBot);
    room.game.spectatorMysteryUserId = bot.userId;
    manager.joinRoom(spectator, { code: created.room.code });
    manager.watchPlayer(spectator, { userId: host.data.user.id });
    manager.setSpectatorVisibility(host, { hidden: true, handId: room.game.handId });
    const handId = room.game.handId;
    manager.shutdown();
    manager = null;

    restored = new RoomManager(io, store, { runtimeFile, reconnectGraceMs: 0 });
    const restoredRoom = restored.rooms.get(created.room.code);
    assert.equal(restoredRoom.game.handId, handId);
    assert.deepEqual(restoredRoom.members.get(spectator.data.user.id).spectatorCardAccess, {
      handId,
      userIds: [host.data.user.id],
    });
    const watched = restored.watchPlayer(spectator, { userId: host.data.user.id }).room;
    assert.equal(watched.game.players.find((player) => player.userId === host.data.user.id).cards.length, 2);
    assert.equal(
      watched.game.players.find((player) => player.userId === host.data.user.id).spectatorAccessGranted,
      true,
    );
  } finally {
    manager?.shutdown();
    restored?.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the live leaderboard ranks connected humans by their authoritative current stacks", () => {
  const broadcasts = [];
  const io = {
    emit(event, payload) {
      if (event === "leaderboard:update") broadcasts.push(payload);
    },
    to() { return { emit() {} }; },
  };
  const store = { addHistory() {}, userForToken() { return {}; } };
  const manager = new RoomManager(io, store);
  const tablePlayer = {
    id: "socket-table",
    data: { user: { id: "table-player", username: "牌桌玩家" }, sessionToken: "table-token" },
    join() {},
    leave() {},
    on() {},
  };
  const lobbyPlayer = {
    id: "socket-lobby",
    data: { user: { id: "lobby-player", username: "大厅玩家" }, sessionToken: "lobby-token" },
    join() {},
    leave() {},
    on() {},
  };

  manager.register(tablePlayer);
  manager.register(lobbyPlayer);
  const created = manager.createRoom(tablePlayer, {
    name: "积分榜测试房",
    settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  manager.addBot(tablePlayer);

  let leaderboard = manager.listLeaderboard();
  assert.deepEqual(leaderboard.map((entry) => entry.userId), ["table-player", "lobby-player"]);
  assert.equal(leaderboard[0].rank, 1);
  assert.equal(leaderboard[0].score, 2000);
  assert.equal(leaderboard[0].roomCode, created.room.code);
  assert.equal(leaderboard[0].status, "等待开局");
  assert.equal(leaderboard[1].rank, 2);
  assert.equal(leaderboard[1].score, 0);
  assert.equal(leaderboard[1].status, "大厅");
  assert.equal(leaderboard.some((entry) => entry.userId.startsWith("bot-")), false);

  manager.setReady(tablePlayer, { ready: true });
  manager.startGame(tablePlayer);
  const room = manager.rooms.get(created.room.code);
  const authoritativeStack = room.game.players.find((player) => player.userId === "table-player").stack;
  leaderboard = manager.listLeaderboard();
  assert.equal(leaderboard.find((entry) => entry.userId === "table-player").score, authoritativeStack);
  assert.equal(leaderboard.find((entry) => entry.userId === "table-player").status, "牌局中");
  assert.ok(broadcasts.length > 0);

  const secondSocket = { ...tablePlayer, id: "socket-table-second", on() {} };
  manager.register(secondSocket);
  manager.disconnect(tablePlayer);
  assert.equal(manager.listLeaderboard().some((entry) => entry.userId === "table-player"), true);
  manager.disconnect(secondSocket);
  assert.equal(manager.listLeaderboard().some((entry) => entry.userId === "table-player"), false);
  manager.disconnect(lobbyPlayer);
  assert.deepEqual(manager.listLeaderboard(), []);
  manager.shutdown();
});

test("a hand containing any test player is settled as leaderboard-ineligible for every human", () => {
  const histories = [];
  const analyses = [];
  const actionLogs = [];
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = {
    addHistory(entry) { histories.push(entry); },
    addHandAnalysis(entry) { analyses.push(entry); },
  };
  const host = {
    id: "socket-practice-host",
    data: { user: { id: "practice-host", username: "练习房主" } },
    join() {},
    leave() {},
    on() {},
  };
  const manager = new RoomManager(io, store, {
    logger: {
      info(domain, event, fields) {
        if (event === "poker_action_recorded") actionLogs.push({ domain, event, fields });
      },
    },
  });
  const created = manager.createRoom(host, {
    name: "测试玩家练习局",
    settings: { maxPlayers: 8, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  manager.addBot(host);
  manager.setReady(host, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  const view = room.game.viewFor(host.data.user.id);
  manager.gameAction(host, {
    action: "fold",
    handId: view.handId,
    actionToken: view.actionToken,
  });

  assert.equal(histories.length, 1);
  assert.equal(histories[0].userId, host.data.user.id);
  assert.equal(histories[0].leaderboardEligible, false);
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].leaderboardEligible, false);
  assert.equal(analyses[0].players.length, 2);
  assert.ok(analyses[0].players.every(({ holeCards }) => holeCards.length === 2));
  assert.equal(actionLogs.length, 1);
  assert.equal(actionLogs[0].domain, "action");
  assert.equal(actionLogs[0].fields.action, "fold");
  assert.equal(JSON.stringify(actionLogs[0]).includes("holeCards"), false);
  assert.throws(
    () => manager.finalSettlement(host),
    /测试玩家的练习牌局不进入好友终局结算/,
  );
  manager.shutdown();
});

test("the system caps table chips after a hand and produces a balanced final settlement", () => {
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const host = { id: "socket-ledger-host", data: { user: { id: "ledger-host", username: "结算房主" } }, join() {}, leave() {}, on() {} };
  const guestOne = { id: "socket-ledger-one", data: { user: { id: "ledger-one", username: "结算玩家一" } }, join() {}, leave() {}, on() {} };
  const guestTwo = { id: "socket-ledger-two", data: { user: { id: "ledger-two", username: "结算玩家二" } }, join() {}, leave() {}, on() {} };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(host, {
    name: "终局结算测试",
    settings: { maxPlayers: 3, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  const room = manager.rooms.get(created.room.code);

  for (const [guest, seat] of [[guestOne, 1], [guestTwo, 2]]) {
    manager.joinRoom(guest, { code: room.code });
    manager.requestSeat(guest, { seat });
    manager.approveSeat(host, { userId: guest.data.user.id });
  }

  room.handNumber = 1;
  room.gameSynced = false;
  room.game = {
    stage: "finished",
    players: [
      { userId: host.data.user.id, username: host.data.user.username, stack: 6000, startingStack: 2000, isBot: false },
      { userId: guestOne.data.user.id, username: guestOne.data.user.username, stack: 0, startingStack: 2000, isBot: false },
      { userId: guestTwo.data.user.id, username: guestTwo.data.user.username, stack: 0, startingStack: 2000, isBot: false },
    ],
    winners: [{ userId: host.data.user.id, username: host.data.user.username, amount: 6000, handName: "同花" }],
    finishedReason: "showdown",
    viewFor() { return null; },
  };

  assert.throws(() => manager.finalSettlement(guestOne), /只有房主可以执行该操作/);
  const result = manager.finalSettlement(host);
  const winner = result.settlement.accounts.find((account) => account.userId === host.data.user.id);
  const losers = result.settlement.accounts.filter((account) => account.userId !== host.data.user.id);

  assert.equal(result.settlement.status, "closed");
  assert.equal(result.settlement.tableCap, 4000);
  assert.equal(winner.autoCashOut, 2000);
  assert.equal(winner.finalCashOut, 4000);
  assert.equal(winner.settlementPoints, 4000);
  assert.deepEqual(losers.map((account) => account.settlementPoints), [-2000, -2000]);
  assert.equal(result.settlement.accounts.reduce((total, account) => total + account.settlementPoints, 0), 0);
  assert.equal(result.settlement.totals.systemBalance, 0);
  assert.ok([...room.members.values()].every((member) => member.stack === 0 && member.pendingRebuy === 0));
  assert.equal(manager.listRooms().some(({ code }) => code === room.code), false);
  assert.throws(() => manager.startGame(host), /已经完成终局结算/);
  manager.shutdown();
});

test("a password room accepts the normalized password used by the lobby join form", () => {
  const io = { emit() {}, to() { return { emit() {} }; } };
  const store = { addHistory() {} };
  const host = { id: "socket-password-host", data: { user: { id: "password-host", username: "密码房主" } }, join() {}, leave() {}, on() {} };
  const guest = { id: "socket-password-guest", data: { user: { id: "password-guest", username: "密码房客" } }, join() {}, leave() {}, on() {} };
  const manager = new RoomManager(io, store);
  const created = manager.createRoom(host, {
    name: "密码房测试",
    settings: { initialChips: 2000, smallBlind: 5, bigBlind: 10, password: "  poker-123  " },
  });

  assert.throws(
    () => manager.joinRoom(guest, { code: created.room.code, password: "wrong" }),
    /房间密码不正确/,
  );
  const joined = manager.joinRoom(guest, { code: created.room.code, password: "  poker-123  " });
  assert.equal(joined.room.self.role, "spectator");
  assert.equal(manager.rooms.get(created.room.code).settings.password, "poker-123");
  manager.shutdown();
});
