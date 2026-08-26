import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HEXTECH_SKILLS } from "../shared/hextech.js";
import { HoldemGame, createDeck } from "../server/game.js";
import {
  HEXTECH_CHARACTER_COMMANDS,
  HEXTECH_CHARACTER_DIRECTIVES,
  restoreHextechCharacterEngine,
} from "../server/hextech-characters.js";
import { HEXTECH_EFFECT_DIRECTIVE_TYPES } from "../server/hextech-effects.js";
import { RoomManager } from "../server/rooms.js";

function socket(id, username = id) {
  return {
    id: `socket-${id}`,
    data: { user: { id, username, displayName: username } },
    join() {},
    leave() {},
    on() {},
  };
}

function setup(options = {}) {
  const states = new Map();
  const io = {
    emit() {},
    to(socketId) {
      return {
        emit(event, payload) {
          if (event === "room:state") states.set(socketId, payload);
        },
      };
    },
  };
  const store = { addHistory() {} };
  const manager = new RoomManager(io, store, options);
  const host = socket("host", "房主");
  return { manager, states, host };
}

function seatGuest(manager, host, roomCode, id, seat) {
  const guest = socket(id, id);
  manager.joinRoom(guest, { code: roomCode, mode: "player" });
  manager.requestSeat(guest, { seat });
  manager.approveSeat(host, { userId: id });
  return guest;
}

function forceDraftSkill(room, userId, skillId) {
  const offer = room.hextech.draft.offers.get(userId);
  const fillers = HEXTECH_SKILLS
    .map(({ id }) => id)
    .filter((id) => id !== skillId)
    .slice(0, 2);
  offer.skillIds = [skillId, ...fillers];
  return offer;
}

function skillCommand(manager, states, actor, command, extra = {}, commandId = `${actor.id}-${command}-${Date.now()}`) {
  const skillWindow = states.get(actor.id).hextech.selfSkillWindow;
  return manager.hextechSkillCommand(actor, {
    command,
    commandId,
    windowToken: skillWindow.windowToken,
    windowVersion: skillWindow.windowVersion,
    ...extra,
  });
}

function lockDraftSkillForAll(room, manager, participants, skillId = "fake-weak") {
  const offers = new Map();
  for (const userId of participants.keys()) offers.set(userId, forceDraftSkill(room, userId, skillId));
  for (const [userId, actor] of participants) {
    const offer = offers.get(userId);
    manager.selectHextechSkill(actor, { offerId: offer.offerId, skillId });
  }
}

function submitCurrentAction(manager, room, participants, action, amount = undefined) {
  const actor = room.game.currentPlayer;
  assert.ok(actor, "expected an active poker actor");
  manager.gameAction(participants.get(actor.userId), {
    action,
    ...(amount == null ? {} : { amount }),
    handId: room.game.handId,
    actionToken: room.game.actionToken,
  });
  return actor.userId;
}

test("hextech room settings are authoritative and ignore forged classic values", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: {
      maxPlayers: 8,
      initialChips: 999999,
      smallBlind: 3,
      bigBlind: 7,
      allowRebuy: false,
      rebuyAmount: 10,
      maxRebuys: 20,
    },
  });

  assert.equal(created.room.mode, "hextech-chaos");
  assert.deepEqual(
    created.room.settings,
    {
      maxPlayers: 8,
      initialChips: 2000,
      smallBlind: 20,
      bigBlind: 40,
      allowRebuy: true,
      rebuyAmount: 2000,
      maxRebuys: 3,
      hasPassword: false,
    },
  );
  assert.equal(created.room.hextech.targetChips, 4000);
  assert.equal(created.room.hextech.targetLocked, false);
  assert.equal(manager.listRooms()[0].targetChips, 4000);

  const guestOne = seatGuest(manager, host, created.room.code, "guest-one", 1);
  const guestTwo = seatGuest(manager, host, created.room.code, "guest-two", 2);
  const threePlayerPreview = manager.listRooms()[0];
  assert.equal(threePlayerPreview.playerCount, 3);
  assert.equal(threePlayerPreview.targetChips, 5400);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guestOne, { characterId: "xu" });
  manager.selectCharacter(guestTwo, { characterId: "jiansheng" });
  for (let index = 0; index < 5; index += 1) manager.addBot(host);
  const eightPlayerPreview = manager.listRooms()[0];
  assert.equal(eightPlayerPreview.playerCount, 8);
  assert.equal(eightPlayerPreview.targetChips, 12400);
  assert.equal(new Set(
    [...manager.rooms.get(created.room.code).members.values()]
      .filter(({ role }) => role === "player")
      .map(({ characterId }) => characterId),
  ).size, 8);
  assert.throws(
    () => manager.createRoom(socket("other"), {
      mode: "hextech-chaos",
      settings: { maxPlayers: 9 },
    }),
    /2–8|玩家人数/,
  );
  manager.shutdown();
});

test("characters lock atomically and the private three-card draft gates poker actions", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 7 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 2);

  manager.selectCharacter(host, { characterId: "fenxiang" });
  assert.throws(
    () => manager.selectCharacter(guest, { characterId: "fenxiang" }),
    /已被.*锁定/,
  );
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  const hostDraft = states.get(host.id);
  const guestDraft = states.get(guest.id);
  assert.equal(room.hextech.phase, "skill-draft");
  assert.equal(room.hextech.lockedPlayerCount, 2);
  assert.equal(room.hextech.targetChips, 4000);
  assert.deepEqual(room.hextech.participantUserIds.sort(), ["guest", "host"]);
  assert.equal(room.game.settings.smallBlind, 20);
  assert.equal(room.game.settings.bigBlind, 40);
  assert.equal(room.game.actionSeconds, 60);
  assert.equal(hostDraft.game.legal, null);
  assert.equal(hostDraft.game.actionToken, null);
  assert.equal(hostDraft.hextech.draft.selfOffer.skillIds.length, 3);
  assert.equal(guestDraft.hextech.draft.selfOffer.skillIds.length, 3);
  assert.equal(new Set(hostDraft.hextech.draft.selfOffer.skillIds).size, 3);

  const rarity = new Map(HEXTECH_SKILLS.map((entry) => [entry.id, entry.rarity]));
  assert.ok(hostDraft.hextech.draft.selfOffer.skillIds.filter((id) => rarity.get(id) === "金色").length <= 1);
  assert.throws(
    () => manager.gameAction(host, {
      action: "fold",
      handId: room.game.handId,
      actionToken: room.game.actionToken,
    }),
    /完成本手技能装备/,
  );

  const originalHostOffer = hostDraft.hextech.draft.selfOffer;
  manager.refreshHextechOffer(host, { offerId: originalHostOffer.offerId });
  const refreshedHostOffer = states.get(host.id).hextech.draft.selfOffer;
  assert.notEqual(refreshedHostOffer.offerId, originalHostOffer.offerId);
  assert.equal(refreshedHostOffer.refreshesRemaining, 0);
  assert.throws(
    () => manager.selectHextechSkill(host, {
      offerId: originalHostOffer.offerId,
      skillId: originalHostOffer.skillIds[0],
    }),
    /已更新/,
  );

  manager.selectHextechSkill(host, {
    offerId: refreshedHostOffer.offerId,
    skillId: refreshedHostOffer.skillIds[0],
  });
  const guestOffer = states.get(guest.id).hextech.draft.selfOffer;
  manager.selectHextechSkill(guest, {
    offerId: guestOffer.offerId,
    skillId: guestOffer.skillIds[1],
  });

  assert.equal(room.hextech.phase, "playing");
  assert.equal(room.hextech.draft, null);
  assert.equal(room.members.get("host").equippedSkillId, refreshedHostOffer.skillIds[0]);
  assert.equal(room.members.get("guest").equippedSkillId, guestOffer.skillIds[1]);
  const hostPlayingView = states.get(host.id);
  const guestPlayingView = states.get(guest.id);
  assert.equal(hostPlayingView.members.find((member) => member.userId === "guest").hasEquipment, true);
  assert.equal(hostPlayingView.members.find((member) => member.userId === "guest").equippedSkillId, null);
  assert.equal(guestPlayingView.members.find((member) => member.userId === "host").hasEquipment, true);
  assert.equal(guestPlayingView.members.find((member) => member.userId === "host").equippedSkillId, null);
  assert.equal(hostPlayingView.self.equippedSkillId, refreshedHostOffer.skillIds[0]);
  assert.ok(room.game.turnDeadline > Date.now());
  assert.throws(
    () => manager.buyTimeExtension(host, {
      handId: room.game.handId,
      actionToken: room.game.actionToken,
    }),
    /不提供经典加时卡/,
  );
  manager.shutdown();
});

test("a server-authoritative skill command targets, confirms, stays private and cannot replay", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, { mode: "hextech-chaos", settings: { maxPlayers: 2 } });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  const hostOffer = forceDraftSkill(room, "host", "mind-read");
  const guestOffer = forceDraftSkill(room, "guest", "fake-weak");
  manager.selectHextechSkill(host, { offerId: hostOffer.offerId, skillId: "mind-read" });
  manager.selectHextechSkill(guest, { offerId: guestOffer.offerId, skillId: "fake-weak" });

  assert.equal(states.get(host.id).hextech.selfSkillWindow.state, "idle");
  skillCommand(manager, states, host, "arm");
  assert.equal(states.get(host.id).hextech.selfSkillWindow.state, "targeting");
  assert.deepEqual(states.get(host.id).hextech.selfSkillWindow.validTargetUserIds, ["guest"]);
  assert.throws(
    () => skillCommand(manager, states, host, "target", { targetUserId: "forged" }),
    /目标.*失效|目标格式|技能目标/,
  );
  skillCommand(manager, states, host, "target", { targetUserId: "guest" });
  const confirmingWindow = states.get(host.id).hextech.selfSkillWindow;
  const commandId = "confirm-mind-read-once";
  const result = manager.hextechSkillCommand(host, {
    command: "confirm",
    commandId,
    windowToken: confirmingWindow.windowToken,
    windowVersion: confirmingWindow.windowVersion,
  });
  assert.equal(result.result.status, "resolved");
  assert.ok(["保守", "跟随", "进攻"].includes(result.result.tendency));
  assert.equal(states.get(host.id).hextech.selfSkillWindow.state, "consumed");
  assert.ok(states.get(host.id).hextech.recentSkillEvents.some(({ payload }) => payload?.tendency));
  assert.equal(states.get(guest.id).hextech.recentSkillEvents.some(({ payload }) => payload?.tendency), false);
  assert.equal(
    states.get(guest.id).game.actionLog.some(({ text }) => text.includes(result.result.tendency)),
    false,
    "the private tendency must never be copied into the public table log",
  );

  const eventSeq = room.hextech.effects.exportState().eventSeq;
  const replay = manager.hextechSkillCommand(host, {
    command: "confirm",
    commandId,
    windowToken: confirmingWindow.windowToken,
    windowVersion: confirmingWindow.windowVersion,
  });
  assert.equal(replay.replayed, true);
  assert.equal(room.hextech.effects.exportState().eventSeq, eventSeq);
  manager.shutdown();
});

test("intimidate changes the real poker legal actions after its confirmed target flow", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, { mode: "hextech-chaos", settings: { maxPlayers: 2 } });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  const hostOffer = forceDraftSkill(room, "host", "intimidate");
  const guestOffer = forceDraftSkill(room, "guest", "fake-weak");
  manager.selectHextechSkill(host, { offerId: hostOffer.offerId, skillId: "intimidate" });
  manager.selectHextechSkill(guest, { offerId: guestOffer.offerId, skillId: "fake-weak" });

  skillCommand(manager, states, host, "arm");
  skillCommand(manager, states, host, "target", { targetUserId: "guest" });
  skillCommand(manager, states, host, "confirm");
  const hostGame = states.get(host.id).game;
  manager.gameAction(host, {
    action: "call",
    handId: hostGame.handId,
    actionToken: hostGame.actionToken,
  });
  const guestLegal = room.game.legalActions("guest");
  assert.equal(guestLegal.canRaise, false);
  assert.match(guestLegal.restrictionReason, /恐吓/);
  assert.throws(() => room.game.act("guest", "raise", 80), /当前不能加注/);
  manager.shutdown();
});

test("public reveal charges the actual pot and exposes only its timed public card", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, { mode: "hextech-chaos", settings: { maxPlayers: 2 } });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  const hostOffer = forceDraftSkill(room, "host", "fake-weak");
  const guestOffer = forceDraftSkill(room, "guest", "public-reveal");
  manager.selectHextechSkill(host, { offerId: hostOffer.offerId, skillId: "fake-weak" });
  manager.selectHextechSkill(guest, { offerId: guestOffer.offerId, skillId: "public-reveal" });

  let view = states.get(host.id).game;
  manager.gameAction(host, { action: "call", handId: view.handId, actionToken: view.actionToken });
  view = states.get(guest.id).game;
  manager.gameAction(guest, { action: "check", handId: view.handId, actionToken: view.actionToken });
  assert.equal(room.game.stage, "flop");
  const beforePot = room.game.pot;

  skillCommand(manager, states, guest, "arm");
  skillCommand(manager, states, guest, "target", { targetUserId: "host" });
  skillCommand(manager, states, guest, "confirm");
  assert.equal(room.game.pot, beforePot + 80);
  const hostReveal = states.get(host.id).hextech.publicEffects.publicReveals[0];
  const guestReveal = states.get(guest.id).hextech.publicEffects.publicReveals[0];
  assert.equal(hostReveal.card, guestReveal.card);
  assert.equal(hostReveal.targetUserId, "host");
  assert.ok(hostReveal.expiresAt > Date.now());
  assert.equal(states.get(guest.id).game.players.find(({ userId }) => userId === "host").cards.length, 0);
  manager.shutdown();
});

test("a rejected first-hand start does not lock the participant roster or target", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 7 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });

  const room = manager.rooms.get(created.room.code);
  assert.throws(() => manager.startGame(host), /尚未准备/);
  assert.equal(room.hextech.lockedPlayerCount, null);
  assert.equal(room.hextech.targetChips, null);
  assert.deepEqual(room.hextech.participantUserIds, []);

  manager.setReady(guest, { ready: true });
  manager.startGame(host);
  assert.equal(room.hextech.lockedPlayerCount, 2);
  assert.equal(room.hextech.targetChips, 4000);
  assert.deepEqual(room.hextech.participantUserIds.sort(), ["guest", "host"]);
  manager.shutdown();
});

test("blind all-ins wait for equipment and settle instead of trapping the room in draft", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });

  const room = manager.rooms.get(created.room.code);
  room.members.get("host").stack = 5;
  room.members.get("guest").stack = 10;
  manager.startGame(host);
  assert.equal(room.hextech.phase, "skill-draft");
  assert.equal(room.game.stage, "preflop");

  const hostOffer = states.get(host.id).hextech.draft.selfOffer;
  const guestOffer = states.get(guest.id).hextech.draft.selfOffer;
  manager.selectHextechSkill(host, { offerId: hostOffer.offerId, skillId: hostOffer.skillIds[0] });
  manager.selectHextechSkill(guest, { offerId: guestOffer.offerId, skillId: guestOffer.skillIds[0] });

  assert.equal(room.game.stage, "finished");
  assert.equal(room.hextech.phase, "hand-result");
  assert.equal(room.gameSynced, true);
  manager.shutdown();
});

test("locked participants cannot be removed before the hextech match ends", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);
  for (const participant of [host, guest]) {
    const offer = states.get(participant.id).hextech.draft.selfOffer;
    manager.selectHextechSkill(participant, { offerId: offer.offerId, skillId: offer.skillIds[0] });
  }

  const room = manager.rooms.get(created.room.code);
  while (room.game.stage !== "finished") {
    const actor = room.game.currentPlayer;
    manager.gameAction(actor.userId === "host" ? host : guest, {
      action: "fold",
      handId: room.game.handId,
      actionToken: room.game.actionToken,
    });
  }
  assert.throws(() => manager.leaveRoom(guest), /不能退出参赛名单/);
  assert.throws(() => manager.kickMember(host, { userId: "guest" }), /不能移除锁定参赛者/);
  assert.equal(room.members.has("guest"), true);
  manager.shutdown();
});

test("a busted hextech bot automatically consumes a server-side rebuy", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  manager.addBot(host);
  const room = manager.rooms.get(created.room.code);
  const bot = [...room.members.values()].find((member) => member.isBot);
  manager.selectCharacter(host, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  room.members.get("host").stack = 1000;
  bot.stack = 5;
  manager.startGame(host);

  const hostPlayer = room.game.players.find((player) => player.userId === "host");
  const botPlayer = room.game.players.find((player) => player.userId === bot.userId);
  hostPlayer.hand = ["As", "Ah"];
  botPlayer.hand = ["2c", "3d"];
  const boardAndBurns = ["4c", "5d", "7h", "9s", "Jc", "Kd", "Qd", "Td"];
  const fixed = new Set([...hostPlayer.hand, ...botPlayer.hand, ...boardAndBurns]);
  room.game.deck = [
    ...createDeck().filter((card) => !fixed.has(card)),
    "Jc", "Td", "9s", "Qd", "7h", "5d", "4c", "Kd",
  ];

  const offer = states.get(host.id).hextech.draft.selfOffer;
  manager.selectHextechSkill(host, { offerId: offer.offerId, skillId: offer.skillIds[0] });
  assert.equal(room.game.stage, "finished");
  assert.equal(bot.stack, 0);
  assert.equal(bot.pendingRebuy, 2000);
  assert.equal(bot.rebuyCount, 1);
  assert.equal(bot.role, "player");
  manager.shutdown();
});

test("a match-ending hand does not charge an unnecessary bot rebuy", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  manager.addBot(host);
  const room = manager.rooms.get(created.room.code);
  const bot = [...room.members.values()].find((member) => member.isBot);
  manager.selectCharacter(host, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  room.members.get("host").stack = 4000;
  bot.stack = 5;
  manager.startGame(host);

  const hostPlayer = room.game.players.find((player) => player.userId === "host");
  const botPlayer = room.game.players.find((player) => player.userId === bot.userId);
  hostPlayer.hand = ["As", "Ah"];
  botPlayer.hand = ["2c", "3d"];
  const boardAndBurns = ["4c", "5d", "7h", "9s", "Jc", "Kd", "Qd", "Td"];
  const fixed = new Set([...hostPlayer.hand, ...botPlayer.hand, ...boardAndBurns]);
  room.game.deck = [
    ...createDeck().filter((card) => !fixed.has(card)),
    "Jc", "Td", "9s", "Qd", "7h", "5d", "4c", "Kd",
  ];

  const offer = states.get(host.id).hextech.draft.selfOffer;
  manager.selectHextechSkill(host, { offerId: offer.offerId, skillId: offer.skillIds[0] });
  assert.equal(room.hextech.matchEnd.reason, "target");
  assert.equal(bot.stack, 0);
  assert.equal(bot.pendingRebuy, 0);
  assert.equal(bot.rebuyCount, 0);
  manager.shutdown();
});

test("refresh and selection requests are rejected once the draft deadline has passed", () => {
  for (const mutation of ["refresh", "select"]) {
    const { manager, states, host } = setup();
    const created = manager.createRoom(host, {
      mode: "hextech-chaos",
      settings: { maxPlayers: 2 },
    });
    const guest = seatGuest(manager, host, created.room.code, `guest-${mutation}`, 1);
    manager.selectCharacter(host, { characterId: "fenxiang" });
    manager.selectCharacter(guest, { characterId: "xu" });
    manager.setReady(host, { ready: true });
    manager.setReady(guest, { ready: true });
    manager.startGame(host);

    const room = manager.rooms.get(created.room.code);
    const offer = states.get(host.id).hextech.draft.selfOffer;
    room.hextech.draft.deadline = Date.now() - 1;
    assert.throws(
      () => mutation === "refresh"
        ? manager.refreshHextechOffer(host, { offerId: offer.offerId })
        : manager.selectHextechSkill(host, { offerId: offer.offerId, skillId: offer.skillIds[0] }),
      /装备时间已结束/,
    );
    assert.notEqual(room.hextech.phase, "skill-draft");
    assert.equal(room.hextech.draft, null);
    manager.shutdown();
  }
});

test("a timed-out human rebuy decision moves the player to spectator without removing standings", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const room = manager.rooms.get(created.room.code);
  const member = room.members.get("host");
  room.handNumber = 1;
  room.hextech.lockedPlayerCount = 2;
  room.hextech.targetChips = 4000;
  room.hextech.participantUserIds = ["host", "missing-opponent"];
  room.game = { stage: "finished", viewFor: () => null };
  member.stack = 0;
  member.rebuyDeadline = Date.now() - 1;

  assert.throws(() => manager.rebuy(host, { accept: true }), /时间已结束/);
  assert.equal(member.role, "spectator");
  assert.equal(member.rebuyDeadline, null);
  assert.equal(room.hextech.participantUserIds.includes("host"), true);
  assert.equal(room.hextech.matchEnd.reason, "last-player");
  manager.shutdown();
});

test("accepting a hextech rebuy keeps the seat ready even after disconnect", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  const room = manager.rooms.get(created.room.code);
  room.handNumber = 1;
  room.hextech.phase = "hand-result";
  room.hextech.lockedPlayerCount = 2;
  room.hextech.targetChips = 4000;
  room.hextech.participantUserIds = ["host", "guest"];
  room.game = { stage: "finished", players: [], viewFor: () => null };
  room.members.get("host").stack = 1000;
  room.members.get("host").ready = true;
  room.members.get("guest").stack = 0;
  room.members.get("guest").rebuyDeadline = Date.now() + 30_000;

  manager.rebuy(guest, { accept: true });
  manager.disconnect(guest);
  assert.equal(room.members.get("guest").role, "player");
  assert.equal(room.members.get("guest").ready, true);
  manager.startGame(host);
  assert.equal(room.members.get("guest").stack, 2000);
  assert.equal(room.hextech.phase, "skill-draft");
  manager.shutdown();
});

test("the last seated hextech player ends the match when nobody else can continue", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const room = manager.rooms.get(created.room.code);
  room.handNumber = 1;
  room.hextech.phase = "hand-result";
  room.hextech.lockedPlayerCount = 2;
  room.hextech.targetChips = 4000;
  room.hextech.participantUserIds = ["host", "guest"];
  room.game = { stage: "finished", players: [], viewFor: () => null };
  room.members.get("host").stack = 3500;
  room.members.get("guest").stack = 0;
  room.members.get("guest").rebuyDeadline = Date.now() + 30_000;

  manager.rebuy(guest, { accept: false });
  assert.equal(room.hextech.matchEnd.reason, "last-player");
  assert.equal(room.hextech.matchEnd.winnerUserId, "host");
  assert.throws(() => manager.startGame(host), /已经结束/);
  manager.shutdown();
});

test("a newly seated nonparticipant sees public showdown cards but never the mystery hand", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    settings: { maxPlayers: 3, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const observer = socket("observer", "observer");
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  room.game.spectatorMysteryUserId = "guest";
  manager.setSpectatorVisibility(host, { hidden: true, handId: room.game.handId });
  // The observer enters only after the hand was hidden, so no same-hand
  // sticky authorization could have been granted.
  manager.joinRoom(observer, { code: created.room.code, mode: "spectator" });
  while (room.game.stage !== "finished") {
    const actor = room.game.currentPlayer;
    const legal = room.game.legalActions(actor.userId);
    manager.gameAction(actor.userId === "host" ? host : guest, {
      action: legal.canCheck ? "check" : "call",
      handId: room.game.handId,
      actionToken: room.game.actionToken,
    });
  }

  manager.requestSeat(observer, { seat: 2 });
  manager.approveSeat(host, { userId: "observer" });
  const observerView = states.get(observer.id);
  assert.equal(observerView.self.role, "player");
  assert.equal(observerView.game.players.find((player) => player.userId === "host").cards.length, 2);
  assert.equal(observerView.game.players.find((player) => player.userId === "guest").cards.length, 0);
  manager.shutdown();
});

test("authorized hextech spectators receive fake hole cards instead of bypassing the disguise", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const observer = socket("observer", "observer");
  manager.joinRoom(observer, { code: created.room.code, mode: "spectator" });
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  const hostOffer = forceDraftSkill(room, "host", "fake-weak");
  const guestOffer = forceDraftSkill(room, "guest", "escape");
  manager.selectHextechSkill(host, { offerId: hostOffer.offerId, skillId: "fake-weak" });
  manager.selectHextechSkill(guest, { offerId: guestOffer.offerId, skillId: "escape" });
  room.game.spectatorMysteryUserId = "guest";

  const hostPlayer = room.game.players.find(({ userId }) => userId === "host");
  const replacementIndex = room.game.deck.findIndex((card) => (
    !["7c", "2d", hostPlayer.hand[1]].includes(card)
  ));
  const originalFirstCard = hostPlayer.hand[0];
  hostPlayer.hand[0] = room.game.deck[replacementIndex];
  room.game.deck[replacementIndex] = originalFirstCard;
  const realCards = room.game.privateCardsFor("host");
  assert.notDeepEqual(realCards, ["7c", "2d"]);

  manager.watchPlayer(observer, { userId: "host" });
  const observerView = states.get(observer.id);
  assert.deepEqual(
    observerView.game.players.find(({ userId }) => userId === "host").cards,
    ["7c", "2d"],
  );
  assert.deepEqual(room.game.privateCardsFor("host"), realCards);
  assert.equal(room.hextech.effects.exportState().hand.equipments.host.status, "consumed");
  manager.shutdown();
});

test("Wengwengwen hunt derives its target server-side and receives only one disguised private card", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "wengwengwen" });
  manager.selectCharacter(guest, { characterId: "fenxiang" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  const hostOffer = forceDraftSkill(room, "host", "escape");
  const guestOffer = forceDraftSkill(room, "guest", "fake-weak");
  manager.selectHextechSkill(host, { offerId: hostOffer.offerId, skillId: "escape" });
  manager.selectHextechSkill(guest, { offerId: guestOffer.offerId, skillId: "fake-weak" });

  const characterSnapshot = room.hextech.characters.exportState();
  characterSnapshot.players.host.resource = 2;
  room.hextech.characters = restoreHextechCharacterEngine(characterSnapshot);
  const guestPlayer = room.game.players.find(({ userId }) => userId === "guest");
  const replacementIndex = room.game.deck.findIndex((card) => (
    !["7c", "2d", guestPlayer.hand[1]].includes(card)
  ));
  const originalFirstCard = guestPlayer.hand[0];
  guestPlayer.hand[0] = room.game.deck[replacementIndex];
  room.game.deck[replacementIndex] = originalFirstCard;
  assert.notDeepEqual(room.game.privateCardsFor("guest"), ["7c", "2d"]);

  while (room.game.stage === "preflop") {
    const actor = room.game.currentPlayer;
    const legal = room.game.legalActions(actor.userId);
    manager.gameAction(participants.get(actor.userId), {
      action: legal.canCheck ? "check" : "call",
      handId: room.game.handId,
      actionToken: room.game.actionToken,
    });
  }
  assert.equal(room.game.stage, "flop");
  if (room.game.currentPlayer.userId === "host") {
    manager.gameAction(host, {
      action: "check",
      handId: room.game.handId,
      actionToken: room.game.actionToken,
    });
  }
  assert.equal(room.game.currentPlayer.userId, "guest");
  const guestLegal = room.game.legalActions("guest");
  const raiseTo = Math.max(80, guestLegal.minRaiseTo);
  manager.gameAction(guest, {
    action: "raise",
    amount: raiseTo,
    handId: room.game.handId,
    actionToken: room.game.actionToken,
  });
  assert.equal(room.game.currentPlayer.userId, "host");
  assert.equal(states.get(host.id).hextech.selfCharacter.latestAggressorUserId, "guest");

  const result = manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE,
    commandId: "weng-room-hunt",
  });
  assert.equal(result.duplicate, false);
  const ownerReveal = states.get(host.id).hextech.selfCharacter.reveal;
  assert.equal(ownerReveal.targetUserId, "guest");
  assert.ok(["7c", "2d"].includes(ownerReveal.cardId));
  const guestViewOfWeng = states.get(guest.id).hextech.characters
    .find(({ userId }) => userId === "host");
  assert.equal(guestViewOfWeng.reveal, null);
  assert.equal(room.hextech.characters.exportState().players.host.hand.wengReveal.masked, true);
  assert.equal(room.hextech.effects.exportState().hand.equipments.guest.status, "consumed");

  const replay = manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE,
    commandId: "weng-room-hunt",
  });
  assert.equal(replay.duplicate, true);
  manager.shutdown();
});

test("hextech draft and hand-result phases survive runtime round trips", () => {
  for (const phase of ["skill-draft", "hand-result"]) {
    const directory = mkdtempSync(path.join(tmpdir(), `hextech-${phase}-`));
    const runtimeFile = path.join(directory, "runtime.json");
    try {
      const { manager, states, host } = setup({ runtimeFile });
      const created = manager.createRoom(host, {
        mode: "hextech-chaos",
        settings: { maxPlayers: 2 },
      });
      const guest = seatGuest(manager, host, created.room.code, "guest", 1);
      manager.selectCharacter(host, { characterId: "fenxiang" });
      manager.selectCharacter(guest, { characterId: "xu" });
      manager.setReady(host, { ready: true });
      manager.setReady(guest, { ready: true });
      manager.startGame(host);
      const room = manager.rooms.get(created.room.code);
      if (phase === "hand-result") {
        for (const participant of [host, guest]) {
          const offer = states.get(participant.id).hextech.draft.selfOffer;
          manager.selectHextechSkill(participant, { offerId: offer.offerId, skillId: offer.skillIds[0] });
        }
        const actor = room.game.currentPlayer;
        manager.gameAction(actor.userId === "host" ? host : guest, {
          action: "fold",
          handId: room.game.handId,
          actionToken: room.game.actionToken,
        });
        assert.equal(room.hextech.phase, "hand-result");
      }
      manager.shutdown();

      const restored = setup({ runtimeFile }).manager;
      const restoredRoom = restored.rooms.get(created.room.code);
      assert.equal(restoredRoom.hextech.phase, phase);
      assert.equal(restoredRoom.hextech.draft?.offers.size ?? 0, phase === "skill-draft" ? 2 : 0);
      restored.shutdown();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a persisted last-player match keeps its authoritative winner across restart", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hextech-match-winner-"));
  const runtimeFile = path.join(directory, "runtime.json");
  try {
    const { manager, host } = setup({ runtimeFile });
    const created = manager.createRoom(host, {
      mode: "hextech-chaos",
      settings: { maxPlayers: 2 },
    });
    seatGuest(manager, host, created.room.code, "guest", 1);
    const room = manager.rooms.get(created.room.code);
    room.handNumber = 1;
    room.hextech.phase = "finished";
    room.hextech.lockedPlayerCount = 2;
    room.hextech.targetChips = 4000;
    room.hextech.participantUserIds = ["host", "guest"];
    room.members.get("host").role = "spectator";
    room.members.get("host").seat = null;
    room.members.get("host").stack = 3000;
    room.members.get("guest").stack = 0;
    room.members.get("guest").pendingRebuy = 2000;
    room.hextech.matchEnd = {
      reason: "last-player",
      handNumber: 1,
      targetChips: 4000,
      winnerUserId: "guest",
      standings: [
        { userId: "host", username: "房主", characterId: null, chips: 3000, netAssets: 3000 },
        { userId: "guest", username: "guest", characterId: null, chips: 0, netAssets: 0 },
      ],
    };
    manager.shutdown();

    const restored = setup({ runtimeFile }).manager;
    const restoredMatchEnd = restored.rooms.get(created.room.code).hextech.matchEnd;
    assert.equal(restoredMatchEnd.reason, "last-player");
    assert.equal(restoredMatchEnd.standings[0].userId, "host");
    assert.equal(restoredMatchEnd.winnerUserId, "guest");
    restored.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("classic blind all-ins enter the timed runout and synchronize after its final step", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    settings: { maxPlayers: 2, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  const room = manager.rooms.get(created.room.code);
  room.members.get("host").stack = 5;
  room.members.get("guest").stack = 10;

  manager.startGame(host);
  assert.equal(room.game.stage, "preflop");
  assert.equal(room.gameSynced, false);
  assert.equal(room.game.viewFor("host").runout.active, true);
  while (room.game.stage !== "finished") {
    assert.equal(room.game.advanceRunoutIfNeeded(room.game.viewFor("host").runout.nextAt), true);
  }
  // Final settlement is a public path that first synchronizes an unsynced
  // finished game, matching what the room tick does after the last runout step.
  manager.finalSettlement(host);
  assert.equal(room.gameSynced, true);
  assert.equal(room.game.players.reduce((sum, player) => sum + player.stack, 0), 15);
  manager.shutdown();
});

test("hextech hand settlement bypasses the classic 4000 cap and ends on its locked target", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 7 },
  });
  const guestA = seatGuest(manager, host, created.room.code, "guest-a", 1);
  const guestB = seatGuest(manager, host, created.room.code, "guest-b", 2);
  const participants = new Map([
    ["host", host],
    ["guest-a", guestA],
    ["guest-b", guestB],
  ]);

  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guestA, { characterId: "xu" });
  manager.selectCharacter(guestB, { characterId: "jiansheng" });
  for (const participant of participants.values()) manager.setReady(participant, { ready: true });
  const room = manager.rooms.get(created.room.code);
  room.members.get("host").stack = 6000;
  manager.startGame(host);
  for (const [userId, offer] of room.hextech.draft.offers) {
    manager.selectHextechSkill(participants.get(userId), {
      offerId: offer.offerId,
      skillId: offer.skillIds[0],
    });
  }

  while (room.game.stage !== "finished") {
    const actor = room.game.currentPlayer;
    const legal = room.game.legalActions(actor.userId);
    const action = actor.userId === "host"
      ? legal.canCheck ? "check" : legal.canCall ? "call" : "fold"
      : "fold";
    manager.gameAction(participants.get(actor.userId), {
      action,
      handId: room.game.handId,
      actionToken: room.game.actionToken,
    });
  }

  assert.equal(room.hextech.targetChips, 5400);
  assert.equal(room.hextech.matchEnd.reason, "target");
  assert.equal(room.hextech.matchEnd.winnerUserId, "host");
  assert.ok(room.members.get("host").stack > 4000);
  assert.deepEqual(room.lastHandCashOuts, []);
  assert.throws(() => manager.startGame(host), /已经结束/);
  manager.shutdown();
});

test("the fifteenth settled hand ends the match at the hand cap", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  const room = manager.rooms.get(created.room.code);
  room.handNumber = 14;

  manager.startGame(host);
  lockDraftSkillForAll(room, manager, participants);
  submitCurrentAction(manager, room, participants, "fold");

  assert.equal(room.handNumber, 15);
  assert.equal(room.hextech.phase, "finished");
  assert.equal(room.hextech.matchEnd.reason, "hand-cap");
  assert.equal(room.hextech.matchEnd.handNumber, 15);
  assert.throws(() => manager.startGame(host), /已经结束|15 手上限/);
  manager.shutdown();
});

test("character poker hooks grant Fenxiang, Xu and Jiansheng resources and Sword Pressure caps the real next raise", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 3 },
  });
  const xu = seatGuest(manager, host, created.room.code, "xu-player", 1);
  const jiansheng = seatGuest(manager, host, created.room.code, "jiansheng-player", 2);
  const participants = new Map([
    ["host", host],
    ["xu-player", xu],
    ["jiansheng-player", jiansheng],
  ]);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(xu, { characterId: "xu" });
  manager.selectCharacter(jiansheng, { characterId: "jiansheng" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });

  const room = manager.rooms.get(created.room.code);
  room.members.get("host").stack = 500;
  manager.startGame(host);
  lockDraftSkillForAll(room, manager, participants);

  assert.equal(room.game.currentPlayer.userId, "host");
  submitCurrentAction(manager, room, participants, "call");
  assert.equal(room.hextech.characters.exportState().players.host.resource, 1);

  assert.equal(room.game.currentPlayer.userId, "xu-player");
  room.game.turnDeadline = Date.now() + 1_000;
  submitCurrentAction(manager, room, participants, "call");
  assert.equal(
    room.hextech.characters.exportState().players["xu-player"].resource,
    0,
    "the small blind's half-big-blind call is below Xu's minimum investment",
  );

  assert.equal(room.game.currentPlayer.userId, "jiansheng-player");
  submitCurrentAction(manager, room, participants, "check");
  assert.equal(room.game.stage, "flop");
  assert.equal(room.game.currentPlayer.userId, "xu-player");
  room.game.turnDeadline = Date.now() + 1_000;
  const xuBetTo = room.game.legalActions("xu-player").minRaiseTo;
  submitCurrentAction(manager, room, participants, "raise", xuBetTo);
  assert.equal(room.hextech.characters.exportState().players["xu-player"].resource, 1);

  assert.equal(room.game.currentPlayer.userId, "jiansheng-player");
  const raiseTo = room.game.legalActions("jiansheng-player").minRaiseTo;
  submitCurrentAction(manager, room, participants, "raise", raiseTo);
  assert.equal(room.hextech.characters.exportState().players["jiansheng-player"].resource, 1);
  assert.equal(room.game.currentPlayer.userId, "host");

  manager.hextechCharacterCommand(jiansheng, {
    type: HEXTECH_CHARACTER_COMMANDS.JIANSHENG_PRESSURE,
    commandId: "room-jiansheng-pressure",
    targetUserId: "host",
  });
  const hostLegal = room.game.legalActions("host");
  assert.equal(room.hextech.characters.exportState().players["jiansheng-player"].resource, 0);
  assert.equal(hostLegal.canRaise, false);
  assert.equal(hostLegal.maxRaiseTo, room.game.currentBet);
  assert.match(hostLegal.restrictionReason, /剑压/);
  assert.equal(states.get(host.id).hextech.selfCharacter.resource, 1);
  assert.equal(states.get(xu.id).hextech.selfCharacter.resource, 1);
  manager.shutdown();
});

test("Xu barbecue applies the next-street clock to every non-source player regardless of seat order", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 3 },
  });
  const playerB = seatGuest(manager, host, created.room.code, "player-b", 1);
  const playerC = seatGuest(manager, host, created.room.code, "player-c", 2);
  const participants = new Map([
    ["host", host],
    ["player-b", playerB],
    ["player-c", playerC],
  ]);
  manager.selectCharacter(host, { characterId: "xu" });
  manager.selectCharacter(playerB, { characterId: "fenxiang" });
  manager.selectCharacter(playerC, { characterId: "jiansheng" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);
  room.hextech.characters.state.players.host.resource = 4;

  manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.XU_BARBECUE,
    commandId: "room-xu-barbecue-all-opponents",
  });
  assert.deepEqual(room.hextech.characterActionEffects.clockModifiers, [{
    directiveId: room.hextech.characterActionEffects.clockModifiers[0].directiveId,
    sourceUserId: "host",
    street: "flop",
    selfSecondsDelta: 10,
    opponentSecondsDelta: -15,
    minimumOpponentActionSeconds: 30,
    targetPolicy: "all-opponents-still-in-hand",
  }]);
  assert.equal(room.game.turnTimePolicy({ userId: "player-b", stage: "flop", baseSeconds: 60 }), 45);
  assert.equal(room.game.turnTimePolicy({ userId: "player-c", stage: "flop", baseSeconds: 60 }), 45);
  assert.equal(room.game.turnTimePolicy({ userId: "host", stage: "flop", baseSeconds: 60 }), 70);

  submitCurrentAction(manager, room, participants, "call");
  submitCurrentAction(manager, room, participants, "call");
  submitCurrentAction(manager, room, participants, "check");
  assert.equal(room.game.stage, "flop");
  assert.equal(room.game.currentPlayer.userId, "player-b");
  assert.equal(room.game.currentTurnActionSeconds, 45);
  submitCurrentAction(manager, room, participants, "check");
  assert.equal(room.game.currentPlayer.userId, "player-c");
  assert.equal(room.game.currentTurnActionSeconds, 45);
  submitCurrentAction(manager, room, participants, "check");
  assert.equal(room.game.currentPlayer.userId, "host");
  assert.equal(room.game.currentTurnActionSeconds, 70);
  manager.shutdown();
});

test("expired manual calls and raises cannot race the timer or advance Xu", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 3 },
  });
  const playerB = seatGuest(manager, host, created.room.code, "player-b", 1);
  const playerC = seatGuest(manager, host, created.room.code, "player-c", 2);
  const participants = new Map([
    ["host", host],
    ["player-b", playerB],
    ["player-c", playerC],
  ]);
  manager.selectCharacter(host, { characterId: "xu" });
  manager.selectCharacter(playerB, { characterId: "fenxiang" });
  manager.selectCharacter(playerC, { characterId: "jiansheng" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);
  assert.equal(room.game.currentPlayer.userId, "host");
  const raiseTo = room.game.legalActions("host").minRaiseTo;

  for (const attempt of [
    { action: "call" },
    { action: "raise", amount: raiseTo },
  ]) {
    room.game.turnDeadline = Date.now() - 1;
    const gameBefore = room.game.createTransactionSnapshot();
    const characterBefore = room.hextech.characters.exportState();
    assert.throws(
      () => manager.gameAction(host, {
        ...attempt,
        handId: room.game.handId,
        actionToken: room.game.actionToken,
      }),
      /本回合行动时间已经结束/,
    );
    assert.deepEqual(room.game.createTransactionSnapshot(), gameBefore);
    assert.deepEqual(room.hextech.characters.exportState(), characterBefore);
    assert.equal(room.game.playerSnapshot("host").totalCommitted, 0);
    assert.equal(room.hextech.characters.exportState().players.host.resource, 0);
    assert.equal(
      room.hextech.characters.exportState().players.host.progress.effectiveLateInvestments,
      0,
    );
  }
  manager.shutdown();
});

test("legacy Xu clock profiles migrate by awakening while new-format modifiers remain unchanged", () => {
  for (const awakened of [false, true]) {
    const directory = mkdtempSync(path.join(tmpdir(), `hextech-xu-clock-${awakened ? "awake" : "normal"}-`));
    const runtimeFile = path.join(directory, "runtime.json");
    try {
      const { manager, host } = setup({ runtimeFile });
      const created = manager.createRoom(host, {
        mode: "hextech-chaos",
        settings: { maxPlayers: 2 },
      });
      const guest = seatGuest(manager, host, created.room.code, "guest", 1);
      const participants = new Map([["host", host], ["guest", guest]]);
      manager.selectCharacter(host, { characterId: "xu" });
      manager.selectCharacter(guest, { characterId: "fenxiang" });
      manager.setReady(host, { ready: true });
      manager.setReady(guest, { ready: true });
      manager.startGame(host);
      const room = manager.rooms.get(created.room.code);
      lockDraftSkillForAll(room, manager, participants);
      room.hextech.characters.state.players.host.awakened = awakened;
      const newFormatModifier = {
        directiveId: `new-xu-clock-${awakened}`,
        sourceUserId: "host",
        street: "flop",
        opponentSecondsDelta: -17,
        selfSecondsDelta: 11,
        minimumOpponentActionSeconds: 32,
        targetPolicy: "all-opponents-still-in-hand",
        persistedMarker: "must-remain-unchanged",
      };
      room.hextech.characterActionEffects.clockModifiers = [{
        directiveId: `legacy-xu-clock-${awakened}`,
        sourceUserId: "host",
        street: "flop",
        opponentsAfterCasterSecondsDelta: -3,
        selfSecondsDelta: 2,
        minimumOpponentActionSeconds: 6,
      }, newFormatModifier];
      manager.shutdown();

      const restored = setup({ runtimeFile }).manager;
      const restoredRoom = restored.rooms.get(created.room.code);
      const [legacy, current] = restoredRoom.hextech.characterActionEffects.clockModifiers;
      assert.deepEqual(legacy, {
        directiveId: `legacy-xu-clock-${awakened}`,
        sourceUserId: "host",
        street: "flop",
        opponentSecondsDelta: awakened ? -20 : -15,
        selfSecondsDelta: awakened ? 15 : 10,
        minimumOpponentActionSeconds: 30,
        targetPolicy: "all-opponents-still-in-hand",
      });
      assert.deepEqual(current, newFormatModifier);
      restored.shutdown();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Zige loan acceptance transfers chips in the finished real game and member ledger", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const borrower = seatGuest(manager, host, created.room.code, "borrower", 1);
  const participants = new Map([["host", host], ["borrower", borrower]]);
  manager.selectCharacter(host, { characterId: "zige" });
  manager.selectCharacter(borrower, { characterId: "fenxiang" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);

  assert.equal(submitCurrentAction(manager, room, participants, "fold"), "host");
  assert.equal(room.hextech.phase, "hand-result");
  const lenderBefore = room.game.playerSnapshot("host").stack;
  const borrowerBefore = room.game.playerSnapshot("borrower").stack;

  manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.ZIGE_OFFER_LOAN,
    commandId: "room-zige-offer",
    borrowerUserId: "borrower",
    principal: 200,
  });
  const offeredLoan = states.get(borrower.id).hextech.loans.find(({ state }) => state === "offered");
  assert.ok(offeredLoan);
  const appliedBeforeFault = room.hextech.appliedCharacterDirectiveIds.length;
  const faultingEngine = room.hextech.characters;
  const originalCommand = faultingEngine.command.bind(faultingEngine);
  faultingEngine.command = (input) => {
    const outcome = originalCommand(input);
    return input.commandId === "room-zige-fault"
      ? {
        ...outcome,
        directives: [...outcome.directives, {
          directiveId: "character-test-invalid",
          type: "test-invalid-directive",
        }],
      }
      : outcome;
  };
  assert.throws(
    () => manager.hextechCharacterCommand(borrower, {
      type: HEXTECH_CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN,
      commandId: "room-zige-fault",
      loanId: offeredLoan.loanId,
      accept: true,
    }),
    /未知人物结算指令/,
  );
  assert.equal(room.game.playerSnapshot("host").stack, lenderBefore);
  assert.equal(room.game.playerSnapshot("borrower").stack, borrowerBefore);
  assert.equal(room.hextech.characters.viewFor("borrower").loans.find(({ loanId }) => loanId === offeredLoan.loanId).state, "offered");
  assert.equal(room.hextech.appliedCharacterDirectiveIds.length, appliedBeforeFault);
  manager.hextechCharacterCommand(borrower, {
    type: HEXTECH_CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN,
    commandId: "room-zige-accept",
    loanId: offeredLoan.loanId,
    accept: true,
  });

  assert.equal(room.game.playerSnapshot("host").stack, lenderBefore - 200);
  assert.equal(room.game.playerSnapshot("borrower").stack, borrowerBefore + 200);
  assert.equal(room.members.get("host").stack, lenderBefore - 200);
  assert.equal(room.members.get("borrower").stack, borrowerBefore + 200);
  const activeLoan = states.get(host.id).hextech.loans.find(({ loanId }) => loanId === offeredLoan.loanId);
  assert.equal(activeLoan.state, "active");
  assert.equal(activeLoan.outstanding, 220);
  assert.equal(activeLoan.dueHandNumber, room.handNumber + 3);
  manager.shutdown();
});

test("a hand-result loan that busts the lender opens the rebuy window instead of ending the match", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 3 },
  });
  const borrower = seatGuest(manager, host, created.room.code, "borrower", 1);
  const third = seatGuest(manager, host, created.room.code, "third", 2);
  const participants = new Map([["host", host], ["borrower", borrower], ["third", third]]);
  manager.selectCharacter(host, { characterId: "zige" });
  manager.selectCharacter(borrower, { characterId: "fenxiang" });
  manager.selectCharacter(third, { characterId: "xu" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);
  while (room.game.stage !== "finished") submitCurrentAction(manager, room, participants, "fold");

  const lender = room.game.playerSnapshot("host");
  room.game.transferPlayerChips({
    fromUserId: "host",
    toUserId: "borrower",
    amount: lender.stack - 200,
    allowPartial: false,
    label: "测试前置资金整理",
  });
  for (const player of room.game.players) room.members.get(player.userId).stack = player.stack;

  manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.ZIGE_OFFER_LOAN,
    commandId: "bust-loan-offer",
    borrowerUserId: "borrower",
    principal: 200,
  });
  const loan = states.get(borrower.id).hextech.loans.find(({ state }) => state === "offered");
  manager.hextechCharacterCommand(borrower, {
    type: HEXTECH_CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN,
    commandId: "bust-loan-accept",
    loanId: loan.loanId,
    accept: true,
  });

  assert.equal(room.members.get("host").stack, 0);
  assert.equal(room.members.get("host").role, "player");
  assert.ok(room.members.get("host").rebuyDeadline > Date.now());
  assert.equal(room.hextech.matchEnd, null);
  assert.equal(room.hextech.phase, "hand-result");
  manager.shutdown();
});

test("a hand-result loan cannot trigger the target victory before another hand settles", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const borrower = seatGuest(manager, host, created.room.code, "borrower", 1);
  const participants = new Map([["host", host], ["borrower", borrower]]);
  manager.selectCharacter(host, { characterId: "zige" });
  manager.selectCharacter(borrower, { characterId: "fenxiang" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);

  assert.equal(submitCurrentAction(manager, room, participants, "fold"), "host");
  assert.equal(room.hextech.phase, "hand-result");
  const lender = room.game.playerSnapshot("host");
  room.game.transferPlayerChips({
    fromUserId: "host",
    toUserId: "borrower",
    amount: lender.stack - 200,
    allowPartial: false,
    label: "测试目标边界资金整理",
  });
  for (const player of room.game.players) room.members.get(player.userId).stack = player.stack;

  manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.ZIGE_OFFER_LOAN,
    commandId: "target-boundary-loan-offer",
    borrowerUserId: "borrower",
    principal: 200,
  });
  const loan = states.get(borrower.id).hextech.loans.find(({ state }) => state === "offered");
  assert.ok(loan);
  manager.hextechCharacterCommand(borrower, {
    type: HEXTECH_CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN,
    commandId: "target-boundary-loan-accept",
    loanId: loan.loanId,
    accept: true,
  });

  assert.equal(room.members.get("borrower").stack, room.hextech.targetChips);
  assert.equal(room.members.get("host").stack, 0);
  assert.ok(room.members.get("host").rebuyDeadline > Date.now());
  assert.equal(room.hextech.matchEnd, null);
  assert.equal(room.hextech.phase, "hand-result");
  manager.shutdown();
});

test("Qiwan replaces the selected hole card from the server deck top without a candidate window", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "qiwan" });
  manager.selectCharacter(guest, { characterId: "fenxiang" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);
  room.hextech.characters.state.players.host.resource = 2;

  const originalCards = room.game.privateCardsFor("host");
  assert.equal(submitCurrentAction(manager, room, participants, "allin"), "host");
  const expectedDeckTop = room.game.exportState().deck.at(-1);
  for (const reservedCommandId of ["supply:character-999", "resolve:character-999"]) {
    assert.throws(
      () => manager.hextechCharacterCommand(host, {
        type: HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE,
        commandId: reservedCommandId,
        holeCardIndex: 0,
      }),
      /服务端保留前缀/,
    );
  }
  assert.equal(room.hextech.characters.exportState().players.host.resource, 2);
  assert.equal(room.hextech.characters.exportState().players.host.window, null);
  manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE,
    commandId: "room-qiwan-activate",
    holeCardIndex: 0,
  });

  const ownerWindow = states.get(host.id).hextech.selfCharacter.window;
  const guestViewOfQiwan = states.get(guest.id).hextech.characters
    .find(({ userId }) => userId === "host");
  assert.equal(ownerWindow, null);
  assert.equal(guestViewOfQiwan.window, null);
  assert.equal(JSON.stringify(guestViewOfQiwan).includes("candidateCardIds"), false);

  const replacedCards = room.game.privateCardsFor("host");
  assert.equal(replacedCards[0], expectedDeckTop);
  assert.notEqual(replacedCards[0], originalCards[0]);
  assert.ok(room.game.exportState().burned.includes(originalCards[0]));
  assert.equal(room.game.exportState().deck.includes(expectedDeckTop), false);
  assert.equal(room.game.exportState().hextechPause, null);
  assert.equal(typeof states.get(guest.id).game.actionToken, "string");

  const afterFirstReplacement = room.game.privateCardsFor("host");
  const replay = manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE,
    commandId: "room-qiwan-activate",
    holeCardIndex: 1,
  });
  assert.equal(replay.duplicate, true);
  assert.deepEqual(room.game.privateCardsFor("host"), afterFirstReplacement);
  assert.throws(() => manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE,
    commandId: "room-qiwan-second-activation",
    holeCardIndex: 1,
  }), /没有可用的全押人物技能机会/);
  manager.shutdown();
});

test("a last-calling Qiwan can replace a hole card before the all-in board runs out", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "qiwan" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);
  room.hextech.characters.state.players.guest.resource = 2;

  assert.equal(submitCurrentAction(manager, room, participants, "allin"), "host");
  const originalCards = room.game.privateCardsFor("guest");
  assert.equal(submitCurrentAction(manager, room, participants, "call"), "guest");
  assert.equal(room.game.stage, "preflop");
  assert.equal(room.game.community.length, 0);
  assert.equal(room.game.exportState().hextechPause.deferStageAdvance, true);
  assert.equal(room.hextech.characterOpportunity.userId, "guest");
  assert.equal(states.get(guest.id).hextech.characterOpportunity.userId, "guest");
  assert.equal(states.get(host.id).hextech.characterOpportunity, null);

  const expectedDeckTop = room.game.exportState().deck.at(-1);
  manager.hextechCharacterCommand(guest, {
    type: HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE,
    commandId: "last-caller-qiwan-activate",
    holeCardIndex: 0,
  });
  assert.equal(room.hextech.characterOpportunity, null);
  assert.equal(states.get(guest.id).hextech.selfCharacter.window, null);
  assert.equal(room.game.privateCardsFor("guest")[0], expectedDeckTop);
  assert.notEqual(room.game.privateCardsFor("guest")[0], originalCards[0]);
  assert.equal(room.game.stage, "finished");
  assert.equal(room.game.exportState().hextechPause, null);
  assert.equal(room.gameSynced, true);
  manager.shutdown();
});

test("Ya replaces the natural river with exactly the next server deck card and exposes no candidates", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "ya" });
  manager.selectCharacter(guest, { characterId: "fenxiang" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);
  room.hextech.characters.state.players.host.resource = 2;
  const deckBefore = room.game.exportState().deck;
  const naturalRiver = deckBefore.at(-8);
  const replacementRiver = deckBefore.at(-9);

  assert.equal(submitCurrentAction(manager, room, participants, "allin"), "host");
  manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.YA_ACTIVATE,
    commandId: "ya-random-river-activate",
  });
  assert.equal(room.game.exportState().riverReplacementArmed, true);
  assert.equal(JSON.stringify(states.get(guest.id).hextech).includes("candidateCardIds"), false);

  assert.equal(submitCurrentAction(manager, room, participants, "call"), "guest");
  assert.equal(room.game.stage, "finished");
  assert.equal(room.game.community.at(-1), replacementRiver);
  assert.ok(room.game.burned.includes(naturalRiver));
  assert.equal(room.game.community.includes(naturalRiver), false);
  assert.equal(room.game.exportState().riverReplacementArmed, false);
  manager.shutdown();
});

test("a call-type all-in never opens Ya's opportunity or advances Ya's passive", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "ya" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);
  room.hextech.characters.state.players.guest.resource = 2;

  assert.equal(submitCurrentAction(manager, room, participants, "allin"), "host");
  assert.equal(submitCurrentAction(manager, room, participants, "call"), "guest");
  assert.equal(room.hextech.characterOpportunity, null);
  const ya = room.hextech.characters.exportState().players.guest;
  assert.equal(ya.progress.earlyAggressiveAllInsReachingShowdown, 0);
  assert.equal(ya.resource, 2);
  manager.shutdown();
});

test("a force-folded Ya does not gain showdown progress when only the remaining players reach showdown", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 3 },
  });
  const guestA = seatGuest(manager, host, created.room.code, "guest-a", 1);
  const guestB = seatGuest(manager, host, created.room.code, "guest-b", 2);
  const participants = new Map([["host", host], ["guest-a", guestA], ["guest-b", guestB]]);
  manager.selectCharacter(host, { characterId: "ya" });
  manager.selectCharacter(guestA, { characterId: "fenxiang" });
  manager.selectCharacter(guestB, { characterId: "xu" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);

  room.hextech.characters.state.players.host.hand.yaEarlyAggressiveAllIn = true;
  room.game.forceFold({ userId: "host", label: "抓老千强制弃牌" });
  while (room.game.stage !== "finished") {
    const actor = room.game.currentPlayer;
    const legal = room.game.legalActions(actor.userId);
    submitCurrentAction(manager, room, participants, legal.canCheck ? "check" : "call");
  }

  assert.equal(room.game.finishedReason, "showdown");
  assert.equal(room.game.playerSnapshot("host").folded, true);
  const ya = room.hextech.characters.exportState().players.host;
  assert.equal(ya.resource, 0);
  assert.equal(ya.progress.earlyAggressiveAllInsReachingShowdown, 0);
  assert.equal(ya.progress.earlyAggressiveAllInShowdownWins, 0);
  manager.shutdown();
});

test("a public-skill reaction takes priority over Qiwan's all-in opportunity and restores its full timer", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "qiwan" });
  manager.selectCharacter(guest, { characterId: "fenxiang" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  const hostOffer = forceDraftSkill(room, "host", "charm");
  const guestOffer = forceDraftSkill(room, "guest", "escape");
  manager.selectHextechSkill(host, { offerId: hostOffer.offerId, skillId: "charm" });
  manager.selectHextechSkill(guest, { offerId: guestOffer.offerId, skillId: "escape" });
  room.hextech.characters.state.players.host.resource = 2;

  skillCommand(manager, states, host, "arm", {}, "overlap-charm-arm");
  skillCommand(manager, states, host, "target", { targetUserId: "guest" }, "overlap-charm-target");
  skillCommand(manager, states, host, "confirm", {}, "overlap-charm-confirm");
  assert.equal(submitCurrentAction(manager, room, participants, "allin"), "host");
  assert.equal(room.hextech.characterOpportunity.userId, "host");
  assert.equal(states.get(guest.id).hextech.activeReaction.targetUserId, "guest");
  assert.ok(room.game.exportState().hextechPause);

  const selectedReaction = skillCommand(manager, states, guest, "react", {}, "overlap-escape-select");
  assert.equal(selectedReaction.result.status, "confirming-reaction");
  const resolvedReaction = skillCommand(manager, states, guest, "confirm", {}, "overlap-escape-confirm");
  assert.equal(resolvedReaction.result.status, "reaction-resolved");
  assert.equal(room.hextech.effects.exportState().hand.activeReaction, null);
  assert.equal(room.hextech.characterOpportunity.userId, "host");
  assert.ok(room.hextech.characterOpportunity.expiresAt - Date.now() >= 59_500);
  assert.ok(room.game.exportState().hextechPause);

  manager.hextechCharacterCommand(host, {
    type: HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE,
    commandId: "overlap-qiwan-activate",
    holeCardIndex: 0,
  });
  assert.equal(room.hextech.characterOpportunity, null);
  assert.equal(states.get(host.id).hextech.selfCharacter.window, null);
  assert.equal(room.game.exportState().hextechPause, null);
  manager.shutdown();
});

test("declining an overlapping public-skill reaction also restores Qiwan's full timer", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "qiwan" });
  manager.selectCharacter(guest, { characterId: "fenxiang" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  const hostOffer = forceDraftSkill(room, "host", "charm");
  const guestOffer = forceDraftSkill(room, "guest", "escape");
  manager.selectHextechSkill(host, { offerId: hostOffer.offerId, skillId: "charm" });
  manager.selectHextechSkill(guest, { offerId: guestOffer.offerId, skillId: "escape" });
  room.hextech.characters.state.players.host.resource = 2;

  skillCommand(manager, states, host, "arm", {}, "decline-charm-arm");
  skillCommand(manager, states, host, "target", { targetUserId: "guest" }, "decline-charm-target");
  skillCommand(manager, states, host, "confirm", {}, "decline-charm-confirm");
  submitCurrentAction(manager, room, participants, "allin");
  const guestBetBefore = room.game.playerSnapshot("guest").bet;

  const declined = skillCommand(manager, states, guest, "cancel", {}, "decline-overlap-reaction");
  assert.equal(declined.result.status, "reaction-resolved");
  assert.equal(declined.result.option, "decline");
  assert.equal(room.game.playerSnapshot("guest").bet, guestBetBefore + 600);
  assert.equal(room.hextech.effects.exportState().hand.activeReaction, null);
  assert.equal(room.hextech.characterOpportunity.userId, "host");
  assert.ok(room.hextech.characterOpportunity.expiresAt - Date.now() >= 59_500);
  assert.ok(room.game.exportState().hextechPause);
  manager.shutdown();
});

test("a restored last-all-in character opportunity receives reconnect grace, then resumes the board", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hextech-allin-opportunity-"));
  const runtimeFile = path.join(directory, "runtime.json");
  try {
    const { manager, host } = setup({ runtimeFile, reconnectGraceMs: 100 });
    const created = manager.createRoom(host, {
      mode: "hextech-chaos",
      settings: { maxPlayers: 2 },
    });
    const guest = seatGuest(manager, host, created.room.code, "guest", 1);
    const participants = new Map([["host", host], ["guest", guest]]);
    manager.selectCharacter(host, { characterId: "fenxiang" });
    manager.selectCharacter(guest, { characterId: "qiwan" });
    for (const actor of participants.values()) manager.setReady(actor, { ready: true });
    manager.startGame(host);
    const room = manager.rooms.get(created.room.code);
    lockDraftSkillForAll(room, manager, participants);
    room.hextech.characters.state.players.guest.resource = 2;

    assert.equal(submitCurrentAction(manager, room, participants, "allin"), "host");
    assert.equal(submitCurrentAction(manager, room, participants, "call"), "guest");
    assert.equal(room.game.stage, "preflop");
    assert.ok(room.game.exportState().hextechPause);
    room.hextech.characterOpportunity.expiresAt = Date.now() - 1;
    manager.shutdown();

    const restored = setup({ runtimeFile, reconnectGraceMs: 100 }).manager;
    const restoredRoom = restored.rooms.get(created.room.code);
    assert.equal(restoredRoom.game.stage, "preflop");
    assert.equal(restoredRoom.hextech.characterOpportunity.userId, "guest");
    assert.ok(restoredRoom.hextech.characterOpportunity.expiresAt > Date.now());
    assert.ok(restoredRoom.game.exportState().hextechPause);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(restoredRoom.hextech.characterOpportunity, null);
    assert.equal(restoredRoom.game.stage, "finished");
    assert.equal(restoredRoom.game.exportState().hextechPause, null);
    assert.equal(restoredRoom.gameSynced, true);
    restored.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("character settlement receives authoritative per-side-pot opponents from HoldemGame", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 3 },
  });
  const playerB = seatGuest(manager, host, created.room.code, "player-b", 1);
  const playerC = seatGuest(manager, host, created.room.code, "player-c", 2);
  const participants = new Map([
    ["host", host],
    ["player-b", playerB],
    ["player-c", playerC],
  ]);
  manager.selectCharacter(host, { characterId: "xu" });
  manager.selectCharacter(playerB, { characterId: "jiansheng" });
  manager.selectCharacter(playerC, { characterId: "fenxiang" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);

  const popSequence = [
    "Kc", "As", "2c", "Kd", "Ah", "7d",
    "Qc", "3s", "4h", "8c", "Qd", "9d", "Qh", "Ts",
  ];
  const used = new Set(popSequence);
  room.game = new HoldemGame({
    players: [
      { userId: "host", username: "房主", seat: 0, stack: 100 },
      { userId: "player-b", username: "player-b", seat: 1, stack: 50 },
      { userId: "player-c", username: "player-c", seat: 2, stack: 20 },
    ],
    settings: room.settings,
    actionSeconds: 60,
    deck: [
      ...createDeck().filter((card) => !used.has(card)),
      ...[...popSequence].reverse(),
    ],
  });
  room.gameSynced = false;
  // This test isolates the room-to-character settlement contract. The public
  // skill engine's hand belongs to the discarded fixture game and is not part
  // of the provenance assertion.
  room.hextech.effects = null;

  let receivedResults = null;
  const settleHand = room.hextech.characters.settleHand.bind(room.hextech.characters);
  room.hextech.characters.settleHand = (input) => {
    receivedResults = input.results;
    return settleHand(input);
  };

  while (room.game.stage !== "finished") {
    const actor = room.game.currentPlayer;
    manager.gameAction(participants.get(actor.userId), {
      action: "allin",
      handId: room.game.handId,
      actionToken: room.game.actionToken,
    });
  }

  assert.ok(receivedResults);
  const byUserId = new Map(receivedResults.map((result) => [result.userId, result]));
  assert.deepEqual(byUserId.get("player-c").opponentsBeaten.sort(), ["host", "player-b"]);
  assert.deepEqual(byUserId.get("player-b").opponentsBeaten, ["host"]);
  assert.deepEqual(byUserId.get("host").opponentsBeaten, []);
  manager.shutdown();
});

test("Ya's server-only random river replacement survives disconnect, runtime restore and reconnect", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hextech-ya-reservation-"));
  const runtimeFile = path.join(directory, "runtime.json");
  try {
    const { manager, states, host } = setup({ runtimeFile });
    const created = manager.createRoom(host, {
      mode: "hextech-chaos",
      settings: { maxPlayers: 2 },
    });
    const guest = seatGuest(manager, host, created.room.code, "guest", 1);
    const participants = new Map([["host", host], ["guest", guest]]);
    manager.selectCharacter(host, { characterId: "ya" });
    manager.selectCharacter(guest, { characterId: "fenxiang" });
    for (const actor of participants.values()) manager.setReady(actor, { ready: true });
    manager.startGame(host);
    const room = manager.rooms.get(created.room.code);
    lockDraftSkillForAll(room, manager, participants);
    room.hextech.characters.state.players.host.resource = 2;

    assert.equal(submitCurrentAction(manager, room, participants, "allin"), "host");
    manager.hextechCharacterCommand(host, {
      type: HEXTECH_CHARACTER_COMMANDS.YA_ACTIVATE,
      commandId: "room-ya-activate",
    });
    assert.equal(states.get(host.id).hextech.selfCharacter.window, null);
    assert.equal(room.game.exportState().riverReplacementArmed, true);
    assert.equal(room.game.exportState().queuedBoardCards.river, null);
    assert.equal(JSON.stringify(states.get(guest.id).hextech.characters).includes("candidateCardIds"), false);

    manager.disconnect(host);
    assert.equal(room.members.get("host").connected, false);
    manager.shutdown();

    const restoredFixture = setup({ runtimeFile });
    const restoredRoom = restoredFixture.manager.rooms.get(created.room.code);
    assert.equal(restoredRoom.game.exportState().riverReplacementArmed, true);
    assert.equal(restoredRoom.game.exportState().queuedBoardCards.river, null);
    assert.equal(restoredRoom.hextech.characters.exportState().players.host.window, null);
    assert.ok(restoredRoom.hextech.appliedCharacterDirectiveIds.length > 0);

    restoredFixture.manager.register(restoredFixture.host);
    await Promise.resolve();
    assert.equal(restoredRoom.members.get("host").connected, true);
    assert.equal(restoredFixture.states.get(restoredFixture.host.id).hextech.selfCharacter.characterId, "ya");
    assert.equal(restoredRoom.game.exportState().riverReplacementArmed, true);
    restoredFixture.manager.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mao cannot claim a street card already reserved by another character", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "mao" });
  manager.selectCharacter(guest, { characterId: "fenxiang" });
  for (const actor of participants.values()) manager.setReady(actor, { ready: true });
  manager.startGame(host);
  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);

  submitCurrentAction(manager, room, participants, "call");
  submitCurrentAction(manager, room, participants, "check");
  assert.equal(room.game.stage, "flop");
  const reservedTurn = room.game.nextCommunityCandidates({ street: "turn", count: 1 })[0];
  room.game.queueBoardCard({ street: "turn", card: reservedTurn, label: "其他人物技能" });

  assert.throws(
    () => manager.hextechCharacterCommand(host, {
      type: HEXTECH_CHARACTER_COMMANDS.MAO_CLAIM,
      commandId: "mao-conflicting-turn-claim",
      suit: "hearts",
      useAwakening: false,
    }),
    /已经被其他人物技能锁定/,
  );
  assert.equal(states.get(host.id).hextech.selfCharacter.window, null);
  assert.equal(room.hextech.characters.exportState().players.host.hand.activeUsed, false);
  manager.shutdown();
});

test("hextech rebuy is available only after a player's stack reaches zero", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 6 },
  });
  const room = manager.rooms.get(created.room.code);
  const member = room.members.get("host");
  room.game = { stage: "finished", viewFor: () => null };
  member.stack = 100;
  assert.throws(() => manager.rebuy(host, { accept: true }), /只有筹码归零/);
  member.stack = 0;
  manager.rebuy(host, { accept: true });
  assert.equal(member.pendingRebuy, 2000);
  assert.equal(member.rebuyCount, 1);
  assert.equal(member.role, "player");
  assert.equal(member.ready, true);
  assert.equal(member.seatRequest, false);
  manager.shutdown();
});

test("pot bomb triggers only after real actions cross 800 and injects 120 into the live pot", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  const bomberUserId = room.game.currentPlayer.userId;
  const otherUserId = bomberUserId === "host" ? "guest" : "host";
  const bomberOffer = forceDraftSkill(room, bomberUserId, "pot-bomb");
  const otherOffer = forceDraftSkill(room, otherUserId, "fake-weak");
  manager.selectHextechSkill(participants.get(bomberUserId), {
    offerId: bomberOffer.offerId,
    skillId: "pot-bomb",
  });
  manager.selectHextechSkill(participants.get(otherUserId), {
    offerId: otherOffer.offerId,
    skillId: "fake-weak",
  });

  const bomber = participants.get(bomberUserId);
  skillCommand(manager, states, bomber, "arm");
  const armed = skillCommand(manager, states, bomber, "confirm");
  assert.equal(armed.result.status, "armed");
  assert.equal(room.game.bankInjected, 0);

  submitCurrentAction(manager, room, participants, "raise", 400);
  assert.equal(room.game.pot, 440);
  assert.equal(room.game.bankInjected, 0);

  submitCurrentAction(manager, room, participants, "call");
  assert.equal(room.game.stage, "flop");
  assert.equal(room.game.players.reduce((sum, player) => sum + player.totalCommitted, 0), 800);
  assert.equal(room.game.bonusPot, 120);
  assert.equal(room.game.bankInjected, 120);
  assert.equal(room.game.pot, 920);
  assert.equal(room.hextech.effects.exportState().hand.equipments[bomberUserId].status, "consumed");

  submitCurrentAction(manager, room, participants, "check");
  assert.equal(room.game.bankInjected, 120, "subsequent actions must not trigger the bomb twice");
  assert.equal(room.game.pot, 920);
  manager.shutdown();
});

test("stop loss settles from a real 800-chip showdown before synchronizing the member stack", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  const protectedUserId = room.game.currentPlayer.userId;
  const winnerUserId = protectedUserId === "host" ? "guest" : "host";
  const protectedOffer = forceDraftSkill(room, protectedUserId, "stop-loss");
  const winnerOffer = forceDraftSkill(room, winnerUserId, "fake-weak");
  manager.selectHextechSkill(participants.get(protectedUserId), {
    offerId: protectedOffer.offerId,
    skillId: "stop-loss",
  });
  manager.selectHextechSkill(participants.get(winnerUserId), {
    offerId: winnerOffer.offerId,
    skillId: "fake-weak",
  });

  const protectedPlayer = room.game.players.find(({ userId }) => userId === protectedUserId);
  const winningPlayer = room.game.players.find(({ userId }) => userId === winnerUserId);
  protectedPlayer.hand = ["2c", "3d"];
  winningPlayer.hand = ["As", "Ah"];
  const futureCards = ["Kc", "7h", "Qs", "6h", "Jh", "8d", "4c", "5h"];
  const fixedCards = new Set([...protectedPlayer.hand, ...winningPlayer.hand, ...futureCards]);
  room.game.deck = [
    ...createDeck().filter((card) => !fixedCards.has(card)),
    ...futureCards,
  ];

  submitCurrentAction(manager, room, participants, "raise", 400);
  submitCurrentAction(manager, room, participants, "call");
  assert.equal(room.game.stage, "flop");
  assert.equal(room.game.pot, 800);

  while (room.game.stage !== "finished") {
    const actor = room.game.currentPlayer;
    const legal = room.game.legalActions(actor.userId);
    assert.equal(legal.canCheck, true);
    submitCurrentAction(manager, room, participants, "check");
  }

  assert.equal(room.game.finishedReason, "showdown");
  assert.equal(room.game.winners[0].userId, winnerUserId);
  assert.equal(room.game.bankInjected, 100);
  assert.equal(room.game.playerSnapshot(protectedUserId).totalCommitted, 400);
  assert.equal(room.game.playerSnapshot(protectedUserId).stack, 1700);
  assert.equal(room.members.get(protectedUserId).stack, 1700);
  assert.equal(room.hextech.phase, "hand-result");
  assert.ok(room.hextech.effects.exportState().completedHandIds.includes(room.game.handId));
  manager.shutdown();
});

test("check-raise hunter pauses the live action and reveals its masked card only to the hunter", () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  const hunterUserId = room.game.currentPlayer.userId;
  const checkRaiserUserId = hunterUserId === "host" ? "guest" : "host";
  const hunterOffer = forceDraftSkill(room, hunterUserId, "check-raise-hunter");
  const checkRaiserOffer = forceDraftSkill(room, checkRaiserUserId, "fake-weak");
  manager.selectHextechSkill(participants.get(hunterUserId), {
    offerId: hunterOffer.offerId,
    skillId: "check-raise-hunter",
  });
  manager.selectHextechSkill(participants.get(checkRaiserUserId), {
    offerId: checkRaiserOffer.offerId,
    skillId: "fake-weak",
  });

  submitCurrentAction(manager, room, participants, "call");
  submitCurrentAction(manager, room, participants, "check");
  assert.equal(room.game.stage, "flop");
  assert.equal(room.game.currentPlayer.userId, checkRaiserUserId);

  submitCurrentAction(manager, room, participants, "check");
  assert.equal(room.game.currentPlayer.userId, hunterUserId);
  const hunterBet = room.game.legalActions(hunterUserId).minRaiseTo;
  submitCurrentAction(manager, room, participants, "raise", hunterBet);
  assert.equal(room.game.currentPlayer.userId, checkRaiserUserId);
  const checkRaiseTo = room.game.legalActions(checkRaiserUserId).minRaiseTo;
  submitCurrentAction(manager, room, participants, "raise", checkRaiseTo);

  const hunter = participants.get(hunterUserId);
  const checkRaiser = participants.get(checkRaiserUserId);
  assert.equal(states.get(hunter.id).hextech.selfSkillWindow.state, "reaction");
  assert.equal(states.get(hunter.id).hextech.activeReaction.reactionSkillId, "check-raise-hunter");
  assert.equal(room.game.actionToken, null, "the real poker turn must pause while the reaction is open");
  assert.deepEqual(states.get(hunter.id).hextech.privateEffects, []);
  assert.deepEqual(states.get(checkRaiser.id).hextech.privateEffects, []);

  const selected = skillCommand(manager, states, hunter, "react");
  assert.equal(selected.result.status, "confirming-reaction");
  assert.equal(selected.result.option, "hunt");
  const resolved = skillCommand(manager, states, hunter, "confirm");
  assert.equal(resolved.result.status, "reaction-resolved");

  const hunterPrivateEffects = states.get(hunter.id).hextech.privateEffects;
  assert.equal(hunterPrivateEffects.length, 1);
  assert.equal(hunterPrivateEffects[0].sourceSkillId, "check-raise-hunter");
  assert.equal(hunterPrivateEffects[0].targetUserId, checkRaiserUserId);
  assert.ok(["7c", "2d"].includes(hunterPrivateEffects[0].card));
  assert.deepEqual(states.get(checkRaiser.id).hextech.privateEffects, []);
  assert.equal(
    states.get(hunter.id).game.players.find(({ userId }) => userId === checkRaiserUserId).cards.length,
    0,
  );
  assert.ok(room.game.actionToken, "resolving the reaction must resume the same poker turn");

  submitCurrentAction(manager, room, participants, "call");
  assert.deepEqual(states.get(hunter.id).hextech.privateEffects, []);
  assert.equal(room.hextech.effects.exportState().hand.equipments[hunterUserId].status, "consumed");
  manager.shutdown();
});

test("a timeout check is recorded by effects and can open a later check-raise hunter reaction", async () => {
  const { manager, states, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "fenxiang" });
  manager.selectCharacter(guest, { characterId: "xu" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  const hunterUserId = room.game.currentPlayer.userId;
  const checkRaiserUserId = hunterUserId === "host" ? "guest" : "host";
  const hunterOffer = forceDraftSkill(room, hunterUserId, "check-raise-hunter");
  const checkRaiserOffer = forceDraftSkill(room, checkRaiserUserId, "fake-weak");
  manager.selectHextechSkill(participants.get(hunterUserId), {
    offerId: hunterOffer.offerId,
    skillId: "check-raise-hunter",
  });
  manager.selectHextechSkill(participants.get(checkRaiserUserId), {
    offerId: checkRaiserOffer.offerId,
    skillId: "fake-weak",
  });

  submitCurrentAction(manager, room, participants, "call");
  submitCurrentAction(manager, room, participants, "check");
  assert.equal(room.game.stage, "flop");
  assert.equal(room.game.currentPlayer.userId, checkRaiserUserId);
  assert.equal(room.game.legalActions(checkRaiserUserId).canCheck, true);

  room.game.turnDeadline = Date.now() - 1;
  const waitDeadline = Date.now() + 2_200;
  while (room.game.currentPlayer?.userId !== hunterUserId && Date.now() < waitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(room.game.currentPlayer?.userId, hunterUserId, "timeout should submit the check and advance the turn");

  const hunterBet = room.game.legalActions(hunterUserId).minRaiseTo;
  submitCurrentAction(manager, room, participants, "raise", hunterBet);
  assert.equal(room.game.currentPlayer.userId, checkRaiserUserId);
  const checkRaiseTo = room.game.legalActions(checkRaiserUserId).minRaiseTo;
  submitCurrentAction(manager, room, participants, "raise", checkRaiseTo);

  assert.equal(states.get(participants.get(hunterUserId).id).hextech.selfSkillWindow.state, "reaction");
  assert.equal(
    states.get(participants.get(hunterUserId).id).hextech.activeReaction.reactionSkillId,
    "check-raise-hunter",
  );
  manager.shutdown();
});

test("a public forced call is recorded as an automatic character action and grants Fenxiang's short-stack resource", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "xu" });
  manager.selectCharacter(guest, { characterId: "fenxiang" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });

  const room = manager.rooms.get(created.room.code);
  room.members.get("guest").stack = 500;
  manager.startGame(host);
  lockDraftSkillForAll(room, manager, participants);

  assert.equal(room.game.currentPlayer.userId, "host");
  assert.equal(room.game.playerSnapshot("guest").startingStack, 500);
  assert.equal(room.hextech.characters.exportState().players.guest.resource, 0);

  const effects = room.hextech.effects;
  const originalAfterPokerAction = effects.afterPokerAction.bind(effects);
  effects.afterPokerAction = (input) => {
    const outcome = originalAfterPokerAction(input);
    if (input.actorId !== "host" || input.action !== "raise") return outcome;
    return {
      ...outcome,
      directives: [...outcome.directives, {
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.FORCED_CALL,
        userId: "guest",
        maximumAmount: 500,
        label: "测试公共技能强制跟注",
      }],
    };
  };

  const guestBefore = room.game.playerSnapshot("guest");
  const raiseTo = room.game.legalActions("host").minRaiseTo;
  submitCurrentAction(manager, room, participants, "raise", raiseTo);

  const guestAfter = room.game.playerSnapshot("guest");
  assert.equal(guestAfter.totalCommitted - guestBefore.totalCommitted, 40);
  assert.equal(guestAfter.totalCommitted, raiseTo);
  assert.equal(room.game.stage, "flop");
  assert.equal(room.hextech.characters.exportState().players.guest.resource, 1);
  assert.ok(
    room.hextech.characters.exportState().eventLog.some((event) => (
      event.type === "character.resource.gained"
      && event.payload.userId === "guest"
      && event.payload.reason === "fenxiang.short-stack-call"
    )),
  );
  manager.shutdown();
});

test("a failing effect batch rolls back its forced fold and every character-side mutation atomically", () => {
  const { manager, host } = setup();
  const created = manager.createRoom(host, {
    mode: "hextech-chaos",
    settings: { maxPlayers: 2 },
  });
  const guest = seatGuest(manager, host, created.room.code, "guest", 1);
  const participants = new Map([["host", host], ["guest", guest]]);
  manager.selectCharacter(host, { characterId: "xu" });
  manager.selectCharacter(guest, { characterId: "fenxiang" });
  manager.setReady(host, { ready: true });
  manager.setReady(guest, { ready: true });
  manager.startGame(host);

  const room = manager.rooms.get(created.room.code);
  lockDraftSkillForAll(room, manager, participants);
  assert.equal(room.game.currentPlayer.userId, "host");

  room.hextech.characterActionEffects.raiseCaps.push({
    directiveId: "seeded-raise-cap",
    sourceUserId: "host",
    targetUserId: "guest",
    street: "preflop",
    maximumRaiseTotal: 120,
  });
  room.hextech.appliedCharacterDirectiveIds.push("seeded-character-directive");

  const foldHookInputs = [];
  const characters = room.hextech.characters;
  const originalCharacterAfterPokerAction = characters.afterPokerAction.bind(characters);
  characters.afterPokerAction = (input) => {
    const outcome = originalCharacterAfterPokerAction(input);
    if (input.userId !== "guest" || input.action !== "fold" || input.automatic !== true) return outcome;
    foldHookInputs.push(structuredClone(input));
    return {
      ...outcome,
      directives: [...outcome.directives, {
        directiveId: "forced-fold-character-award",
        type: HEXTECH_CHARACTER_DIRECTIVES.BANK_AWARD,
        userId: "guest",
        amount: 100,
        reason: "test.forced-fold-character-hook",
      }],
    };
  };

  let baseline = null;
  let stateDuringFailedBatch = null;
  const effects = room.hextech.effects;
  const originalEffectAfterPokerAction = effects.afterPokerAction.bind(effects);
  effects.afterPokerAction = (input) => {
    baseline = {
      effects: structuredClone(room.hextech.effects.exportState()),
      game: room.game.createTransactionSnapshot(),
      memberStacks: Object.fromEntries([...room.members].map(([userId, member]) => [userId, member.stack])),
      characters: structuredClone(room.hextech.characters.exportState()),
      characterActionEffects: structuredClone(room.hextech.characterActionEffects),
      appliedCharacterDirectiveIds: [...room.hextech.appliedCharacterDirectiveIds],
    };
    const outcome = originalEffectAfterPokerAction(input);
    const invalidDirective = {};
    Object.defineProperty(invalidDirective, "type", {
      enumerable: true,
      get() {
        stateDuringFailedBatch ??= {
          stage: room.game.stage,
          memberStacks: Object.fromEntries([...room.members].map(([userId, member]) => [userId, member.stack])),
          characters: structuredClone(room.hextech.characters.exportState()),
          characterActionEffects: structuredClone(room.hextech.characterActionEffects),
          appliedCharacterDirectiveIds: [...room.hextech.appliedCharacterDirectiveIds],
        };
        return "test-invalid-effect-directive";
      },
    });
    return {
      ...outcome,
      directives: [...outcome.directives, {
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.FORCE_FOLD,
        userId: "guest",
        label: "测试公共技能强制弃牌",
      }, invalidDirective],
    };
  };

  const raiseTo = room.game.legalActions("host").minRaiseTo;
  assert.throws(
    () => submitCurrentAction(manager, room, participants, "raise", raiseTo),
    /未知海克斯结算指令/,
  );

  assert.ok(baseline, "the effect transaction baseline should be captured after the real raise");
  assert.equal(foldHookInputs.length, 1);
  assert.equal(foldHookInputs[0].userId, "guest");
  assert.equal(foldHookInputs[0].action, "fold");
  assert.equal(foldHookInputs[0].automatic, true);
  assert.equal(stateDuringFailedBatch.stage, "finished");
  assert.notDeepEqual(stateDuringFailedBatch.memberStacks, baseline.memberStacks);
  assert.notDeepEqual(stateDuringFailedBatch.characters, baseline.characters);
  assert.deepEqual(stateDuringFailedBatch.characterActionEffects.raiseCaps, []);
  assert.ok(stateDuringFailedBatch.appliedCharacterDirectiveIds.includes("forced-fold-character-award"));

  assert.deepEqual(room.hextech.effects.exportState(), baseline.effects);
  assert.deepEqual(room.game.createTransactionSnapshot(), baseline.game);
  assert.deepEqual(
    Object.fromEntries([...room.members].map(([userId, member]) => [userId, member.stack])),
    baseline.memberStacks,
  );
  assert.deepEqual(room.hextech.characters.exportState(), baseline.characters);
  assert.deepEqual(room.hextech.characterActionEffects, baseline.characterActionEffects);
  assert.deepEqual(room.hextech.appliedCharacterDirectiveIds, baseline.appliedCharacterDirectiveIds);
  manager.shutdown();
});
