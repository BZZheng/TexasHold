import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_IN_RUNOUT_STEP_MS,
  DEFAULT_ACTION_SECONDS,
  HEXTECH_BLANK_CARD,
  HoldemGame,
  RESTART_RECONNECT_GRACE_MS,
  TIME_EXTENSION_COST,
  TIME_EXTENSION_SECONDS,
  createDeck,
} from "../server/game.js";
import { holeCardDealDurationMs } from "../shared/dealing.js";

const settings = { smallBlind: 5, bigBlind: 10 };

function twoPlayerGame(overrides = {}) {
  return new HoldemGame({
    players: [
      { userId: "a", username: "玩家 A", seat: 0, stack: 2000 },
      { userId: "b", username: "玩家 B", seat: 1, stack: 2000 },
    ],
    settings,
    actionSeconds: 30,
    ...overrides,
  });
}

function settledThreePlayerSidePotGame() {
  const popSequence = [
    // Hole cards are dealt B, C, A twice. C wins the main pot, B wins the
    // contested side pot, and A receives only the final uncontested level.
    "Kc", "As", "2c", "Kd", "Ah", "7d",
    // Burn, flop, burn, turn, burn, river.
    "Qc", "3s", "4h", "8c", "Qd", "9d", "Qh", "Ts",
  ];
  const used = new Set(popSequence);
  const game = new HoldemGame({
    players: [
      { userId: "a", username: "玩家 A", seat: 0, stack: 100 },
      { userId: "b", username: "玩家 B", seat: 1, stack: 50 },
      { userId: "c", username: "玩家 C", seat: 2, stack: 20 },
    ],
    settings,
    deck: [
      ...createDeck().filter((card) => !used.has(card)),
      ...[...popSequence].reverse(),
    ],
  });
  while (game.stage !== "finished") game.act(game.currentPlayer.userId, "allin");
  assert.deepEqual(
    Object.fromEntries(game.winners.map(({ userId, amount }) => [userId, amount])),
    { c: 60, b: 60, a: 50 },
  );
  return game;
}

test("the default player receives thirty seconds after the opening deal finishes", () => {
  const before = Date.now();
  const game = new HoldemGame({
    players: [
      { userId: "a", username: "玩家 A", seat: 0, stack: 2000 },
      { userId: "b", username: "玩家 B", seat: 1, stack: 2000 },
    ],
    settings,
  });
  const after = Date.now();

  assert.equal(DEFAULT_ACTION_SECONDS, 30);
  assert.equal(game.actionSeconds, 30);
  const dealingDuration = holeCardDealDurationMs(2);
  assert.ok(game.dealCompleteAt >= before + dealingDuration);
  assert.ok(game.dealCompleteAt <= after + dealingDuration);
  assert.ok(game.turnDeadline >= before + 30_000 + dealingDuration);
  assert.ok(game.turnDeadline <= after + 30_000 + dealingDuration);
  assert.equal(game.viewFor("a").actionSeconds, 30);
});

test("a token-valid manual action is rejected once its authoritative deadline has passed", () => {
  const game = twoPlayerGame();
  const view = game.viewFor("a");
  game.turnDeadline = Date.now() - 1;
  const before = game.createTransactionSnapshot();
  assert.throws(
    () => game.submitAction({
      userId: "a",
      action: "call",
      handId: view.handId,
      actionToken: view.actionToken,
    }),
    /本回合行动时间已经结束/,
  );
  assert.deepEqual(game.createTransactionSnapshot(), before);
});

test("a server turn-time policy controls the next actor deadline and public action seconds", () => {
  const game = twoPlayerGame();
  const policyCalls = [];
  game.setTurnTimePolicy((context) => {
    policyCalls.push(context);
    return context.userId === "b" ? 7 : 19;
  });

  const before = Date.now();
  game.act("a", "call");
  const after = Date.now();
  const view = game.viewFor("b");

  assert.equal(game.currentPlayer.userId, "b");
  assert.equal(game.currentTurnActionSeconds, 7);
  assert.equal(view.actionSeconds, 7);
  assert.ok(view.turnDeadline >= before + 7_000);
  assert.ok(view.turnDeadline <= after + 7_000);
  assert.deepEqual(policyCalls, [{
    userId: "b",
    stage: "preflop",
    baseSeconds: 30,
    players: [
      { userId: "a", seat: 0, folded: false, allIn: false },
      { userId: "b", seat: 1, folded: false, allIn: false },
    ],
  }]);
  assert.throws(() => game.setTurnTimePolicy("7"), /行动时长策略格式不正确/);
});

test("the active policy duration survives export and restore without serializing executable policy", () => {
  const game = twoPlayerGame();
  game.setTurnTimePolicy(({ userId }) => (userId === "b" ? 7 : 19));
  game.act("a", "call");

  const savedAt = Date.now();
  const snapshot = game.exportState(savedAt);
  assert.equal(snapshot.currentTurnActionSeconds, 7);
  assert.ok(snapshot.turnRemainingMs >= 0 && snapshot.turnRemainingMs <= 7_000);
  assert.equal("turnTimePolicy" in snapshot, false);

  const restoredAt = savedAt + 2_000;
  const restored = HoldemGame.restore(snapshot, {
    settings,
    now: restoredAt,
    reconnectGraceMs: 0,
  });
  assert.equal(restored.currentPlayer.userId, "b");
  assert.equal(restored.currentTurnActionSeconds, 7);
  assert.equal(restored.viewFor("b").actionSeconds, 7);
  assert.equal(restored.turnDeadline, restoredAt + snapshot.turnRemainingMs);

  // Runtime-owned policies are deliberately reattached after restoration.
  // Once reattached, the following street's next actor receives the policy
  // duration instead of falling back to the persisted base setting.
  restored.setTurnTimePolicy(({ userId }) => (userId === "b" ? 9 : 21));
  const nextBefore = Date.now();
  restored.act("b", "check");
  const nextAfter = Date.now();
  assert.equal(restored.stage, "flop");
  assert.equal(restored.currentPlayer.userId, "b");
  assert.equal(restored.currentTurnActionSeconds, 9);
  assert.equal(restored.viewFor("b").actionSeconds, 9);
  assert.ok(restored.turnDeadline >= nextBefore + 9_000);
  assert.ok(restored.turnDeadline <= nextAfter + 9_000);
});

test("the acting player can spend 500 chips for one extra minute", () => {
  const game = twoPlayerGame();
  const before = game.viewFor("a");
  const playerStack = before.players.find((player) => player.userId === "a").stack;

  game.buyTimeExtension({
    userId: "a",
    handId: before.handId,
    actionToken: before.actionToken,
  });

  const after = game.viewFor("a");
  assert.equal(TIME_EXTENSION_COST, 500);
  assert.equal(TIME_EXTENSION_SECONDS, 60);
  assert.equal(after.turnDeadline, before.turnDeadline + 60_000);
  assert.equal(after.players.find((player) => player.userId === "a").stack, playerStack - 500);
  assert.equal(after.timeExtension.used, true);
  assert.equal(after.timeExtension.canBuy, false);
  assert.match(after.actionLog[0].text, /购买加时 \+60 秒，花费 500 筹码/);

  assert.throws(
    () => game.buyTimeExtension({
      userId: "a",
      handId: before.handId,
      actionToken: before.actionToken,
    }),
    /本回合已经使用过加时卡/,
  );

  game.act("a", "fold");
  assert.equal(game.stage, "finished");
  assert.equal(game.players.reduce((sum, player) => sum + player.stack, 0) + game.timeExtensionFees, 4000);
});

test("time extension rejects another player, stale tokens, and insufficient chips", () => {
  const game = twoPlayerGame();
  const view = game.viewFor("a");

  assert.throws(
    () => game.buyTimeExtension({
      userId: "b",
      handId: view.handId,
      actionToken: view.actionToken,
    }),
    /只有当前行动玩家可以购买加时/,
  );
  assert.throws(
    () => game.buyTimeExtension({
      userId: "a",
      handId: view.handId,
      actionToken: "forged",
    }),
    /操作已过期/,
  );

  const shortStack = twoPlayerGame({
    players: [
      { userId: "a", username: "玩家 A", seat: 0, stack: 500 },
      { userId: "b", username: "玩家 B", seat: 1, stack: 2000 },
    ],
  });
  const shortView = shortStack.viewFor("a");
  assert.equal(shortView.timeExtension.canBuy, false);
  assert.throws(
    () => shortStack.buyTimeExtension({
      userId: "a",
      handId: shortView.handId,
      actionToken: shortView.actionToken,
    }),
    /至少需要 505 筹码/,
  );
});

test("a spectator can follow one player while one random mystery hand stays hidden", () => {
  const game = twoPlayerGame();
  const playerView = game.viewFor("a");
  const mysteryUserId = game.spectatorMysteryUserId;
  const watchableUserId = game.players.find((player) => player.userId !== mysteryUserId).userId;
  const spectatorView = game.viewFor("observer", { isSpectator: true, focusUserId: watchableUserId });
  const forgedMysteryView = game.viewFor("observer", { isSpectator: true, focusUserId: mysteryUserId });

  assert.equal(playerView.players.find((player) => player.userId === "a").cards.length, 2);
  assert.equal(playerView.players.find((player) => player.userId === "b").cards.length, 0);
  assert.equal(spectatorView.spectatorView.focusUserId, watchableUserId);
  assert.equal(spectatorView.spectatorView.mysteryUserId, mysteryUserId);
  assert.equal(spectatorView.players.find((player) => player.userId === watchableUserId).cards.length, 2);
  assert.equal(spectatorView.players.find((player) => player.userId === mysteryUserId).cards.length, 0);
  assert.notEqual(forgedMysteryView.spectatorView.focusUserId, mysteryUserId);
  assert.equal(forgedMysteryView.players.find((player) => player.userId === mysteryUserId).cards.length, 0);
  assert.equal(typeof playerView.players[0].acted, "boolean");
});

test("a player can hide their hand from spectators and restore visibility", () => {
  const game = twoPlayerGame();
  const mysteryUserId = game.spectatorMysteryUserId;
  const watchableUserId = game.players.find((player) => player.userId !== mysteryUserId).userId;

  game.setSpectatorVisibility({ userId: watchableUserId, hidden: true, handId: game.handId });
  const hiddenView = game.viewFor("observer", { isSpectator: true, focusUserId: watchableUserId });
  const ownerView = game.viewFor(watchableUserId);

  assert.equal(hiddenView.spectatorView.focusUserId, null);
  assert.equal(hiddenView.players.find((player) => player.userId === watchableUserId).spectatorHidden, true);
  assert.equal(hiddenView.players.find((player) => player.userId === watchableUserId).cards.length, 0);
  assert.equal(ownerView.players.find((player) => player.userId === watchableUserId).cards.length, 2);

  game.setSpectatorVisibility({ userId: watchableUserId, hidden: false, handId: game.handId });
  const restoredView = game.viewFor("observer", { isSpectator: true, focusUserId: watchableUserId });
  assert.equal(restoredView.spectatorView.focusUserId, watchableUserId);
  assert.equal(restoredView.players.find((player) => player.userId === watchableUserId).cards.length, 2);
  assert.throws(
    () => game.setSpectatorVisibility({ userId: watchableUserId, hidden: true, handId: "stale-hand" }),
    /已过期/,
  );
});

test("an authorized spectator keeps same-hand access after the player hides", () => {
  const game = twoPlayerGame();
  const target = game.players.find((player) => player.userId !== game.spectatorMysteryUserId);

  game.setSpectatorVisibility({ userId: target.userId, hidden: true, handId: game.handId });
  const unauthorized = game.viewFor("observer", {
    isSpectator: true,
    focusUserId: target.userId,
    authorizedUserIds: [],
  });
  assert.equal(unauthorized.players.find((player) => player.userId === target.userId).cards.length, 0);
  assert.equal(unauthorized.players.find((player) => player.userId === target.userId).spectatorAccessGranted, false);

  const authorized = game.viewFor("observer", {
    isSpectator: true,
    focusUserId: target.userId,
    authorizedUserIds: [target.userId],
  });
  assert.equal(authorized.spectatorView.focusUserId, target.userId);
  assert.equal(authorized.players.find((player) => player.userId === target.userId).cards.length, 2);
  assert.equal(authorized.players.find((player) => player.userId === target.userId).spectatorAccessGranted, true);
  assert.equal(
    authorized.players.find((player) => player.userId === game.spectatorMysteryUserId).cards.length,
    0,
  );
});

test("a timed all-in runout reveals live hands and advances one street per server deadline", () => {
  const game = twoPlayerGame({ runoutStepMs: ALL_IN_RUNOUT_STEP_MS });
  game.act("a", "allin");
  game.act("b", "allin");

  const preflopView = game.viewFor("a");
  assert.equal(game.stage, "preflop");
  assert.equal(game.community.length, 0);
  assert.equal(game.currentPlayer, undefined);
  assert.equal(preflopView.runout.active, true);
  assert.equal(preflopView.runout.stepMs, ALL_IN_RUNOUT_STEP_MS);
  assert.ok(preflopView.runout.nextAt >= game.dealCompleteAt + ALL_IN_RUNOUT_STEP_MS);
  assert.ok(preflopView.players.filter((player) => !player.folded).every((player) => player.cards.length === 2));

  const savedAt = preflopView.runout.nextAt - 250;
  const snapshot = game.exportState(savedAt);
  assert.equal(snapshot.runoutRemainingMs, 250);
  const restoredAt = savedAt + 5_000;
  const restored = HoldemGame.restore(snapshot, {
    settings,
    now: restoredAt,
    reconnectGraceMs: 0,
  });
  assert.equal(restored.viewFor("a").runout.nextAt, restoredAt + 250);
  assert.equal(restored.advanceRunoutIfNeeded(restoredAt + 249), false);

  assert.equal(restored.advanceRunoutIfNeeded(restoredAt + 250), true);
  assert.equal(restored.stage, "flop");
  assert.equal(restored.community.length, 3);
  assert.equal(restored.advanceRunoutIfNeeded(restored.viewFor("a").runout.nextAt), true);
  assert.equal(restored.stage, "turn");
  assert.equal(restored.community.length, 4);
  assert.equal(restored.advanceRunoutIfNeeded(restored.viewFor("a").runout.nextAt), true);
  assert.equal(restored.stage, "river");
  assert.equal(restored.community.length, 5);
  assert.equal(restored.advanceRunoutIfNeeded(restored.viewFor("a").runout.nextAt), true);
  assert.equal(restored.stage, "finished");
  assert.equal(restored.finishedReason, "showdown");
  assert.equal(restored.viewFor("a").runout, null);
  assert.equal(restored.players.reduce((sum, player) => sum + player.stack, 0), 4000);
});

test("a hidden live hand becomes public to every spectator at showdown except the mystery hand", () => {
  const game = twoPlayerGame();
  const target = game.players.find((player) => player.userId !== game.spectatorMysteryUserId);
  game.setSpectatorVisibility({ userId: target.userId, hidden: true, handId: game.handId });
  while (game.stage !== "finished") {
    const legal = game.legalActions(game.currentPlayer.userId);
    game.act(game.currentPlayer.userId, legal.canCheck ? "check" : "call");
  }

  const view = game.viewFor("observer", {
    isSpectator: true,
    focusUserId: target.userId,
    authorizedUserIds: [],
  });
  assert.equal(view.finishedReason, "showdown");
  assert.equal(view.players.find((player) => player.userId === target.userId).cards.length, 2);
  assert.equal(
    view.players.find((player) => player.userId === game.spectatorMysteryUserId).cards.length,
    0,
  );
});

test("an active hand restores with the same cards and a fresh action token", () => {
  const game = twoPlayerGame();
  const before = game.viewFor("a");
  const savedAt = Date.now();
  const snapshot = game.exportState(savedAt);
  assert.equal("actionToken" in snapshot, false);
  const restoredAt = savedAt + 4_000;
  const restored = HoldemGame.restore(snapshot, { settings, now: restoredAt });
  const after = restored.viewFor("a");

  assert.equal(after.handId, before.handId);
  assert.equal(restored.spectatorMysteryUserId, game.spectatorMysteryUserId);
  assert.deepEqual(after.community, before.community);
  assert.deepEqual(
    after.players.map((player) => ({ userId: player.userId, stack: player.stack, cards: player.cards })),
    before.players.map((player) => ({ userId: player.userId, stack: player.stack, cards: player.cards })),
  );
  assert.notEqual(after.actionToken, before.actionToken);
  assert.equal(
    after.turnDeadline,
    restoredAt + snapshot.turnRemainingMs + RESTART_RECONNECT_GRACE_MS,
  );
  assert.equal(after.dealCompleteAt, restoredAt + snapshot.dealRemainingMs);
  assert.throws(
    () => restored.submitAction({
      userId: "a",
      action: "call",
      handId: before.handId,
      actionToken: before.actionToken,
    }),
    /操作已过期/,
  );
  restored.submitAction({
    userId: "a",
    action: "call",
    handId: after.handId,
    actionToken: after.actionToken,
  });
  assert.equal(restored.currentPlayer.userId, "b");
});

test("a draft-paused blind all-in survives restart and runs out only after resume", () => {
  const paused = new HoldemGame({
    players: [
      { userId: "a", username: "玩家 A", seat: 0, stack: 5 },
      { userId: "b", username: "玩家 B", seat: 1, stack: 10 },
    ],
    settings: { smallBlind: 20, bigBlind: 40 },
    actionSeconds: 12,
    deferAutoRunout: true,
  });
  assert.equal(paused.stage, "preflop");
  assert.equal(paused.autoRunoutDeferred, true);

  const savedAt = Date.now();
  const restored = HoldemGame.restore(paused.exportState(savedAt), {
    settings: { smallBlind: 20, bigBlind: 40 },
    now: savedAt + 500,
  });
  assert.equal(restored.stage, "preflop");
  assert.equal(restored.autoRunoutDeferred, true);
  assert.equal(restored.actionToken, null);

  restored.resumeAfterDraft();
  assert.equal(restored.autoRunoutDeferred, false);
  assert.equal(restored.stage, "finished");
});

test("a folded player remains seated with a spectator-style game view until the hand ends", () => {
  const game = new HoldemGame({
    players: [
      { userId: "a", username: "玩家 A", seat: 0, stack: 2000 },
      { userId: "b", username: "玩家 B", seat: 1, stack: 2000 },
      { userId: "c", username: "玩家 C", seat: 2, stack: 2000 },
    ],
    settings,
  });

  game.act(game.currentPlayer.userId, "fold");
  const foldedView = game.viewFor("a");
  assert.notEqual(foldedView.stage, "finished");
  assert.equal(foldedView.players.find((player) => player.userId === "a").folded, true);
  assert.equal(foldedView.legal, null);
  assert.equal(foldedView.players.find((player) => player.userId === "a").cards.length, 2);
});

test("heads-up call and checks advance through every street", () => {
  const game = twoPlayerGame();
  game.act("a", "call");
  game.act("b", "check");
  assert.equal(game.stage, "flop");
  assert.equal(game.community.length, 3);

  while (game.stage !== "finished") {
    const actor = game.currentPlayer;
    assert.ok(actor, `expected actor during ${game.stage}`);
    const legal = game.legalActions(actor.userId);
    game.act(actor.userId, legal.canCheck ? "check" : "call");
  }

  assert.equal(game.community.length, 5);
  assert.equal(game.finishedReason, "showdown");
  assert.equal(game.players.reduce((sum, player) => sum + player.stack, 0), 4000);
  assert.ok(game.winners.length >= 1);
  const spectatorShowdown = game.viewFor("observer", true);
  assert.equal(spectatorShowdown.players.find((player) => player.userId === game.spectatorMysteryUserId).cards.length, 0);
  assert.ok(spectatorShowdown.players
    .filter((player) => player.userId !== game.spectatorMysteryUserId)
    .every((player) => player.cards.length === 2));
  assert.ok(game.viewFor("a").players.every((player) => player.cards.length === 2));
});

test("a fold immediately awards the full pot to the remaining player", () => {
  const game = twoPlayerGame();
  game.act("a", "fold");

  assert.equal(game.stage, "finished");
  assert.equal(game.finishedReason, "fold");
  assert.equal(game.winners[0].userId, "b");
  assert.equal(game.winners[0].amount, 15);
  assert.equal(game.players.find((player) => player.userId === "b").stack, 2005);
  assert.equal(game.foldReveal.winnerUserId, "b");
  assert.equal(game.foldReveal.decision, null);
  assert.ok(game.foldReveal.deadline > Date.now());
});

test("an uncontested human winner has five seconds to reveal or muck their hand", () => {
  const game = twoPlayerGame();
  game.act("a", "fold");
  const deadline = game.foldReveal.deadline;
  const hiddenView = game.viewFor("a");
  assert.equal(hiddenView.foldReveal.canChoose, false);
  assert.equal(hiddenView.players.find((player) => player.userId === "b").cards.length, 0);

  const winnerView = game.viewFor("b");
  assert.equal(winnerView.foldReveal.canChoose, true);
  assert.equal(winnerView.players.find((player) => player.userId === "b").cards.length, 2);
  assert.throws(
    () => game.chooseFoldReveal({ userId: "a", reveal: true, handId: game.handId, now: deadline - 1 }),
    /只有本局获胜玩家/,
  );
  game.chooseFoldReveal({ userId: "b", reveal: true, handId: game.handId, now: deadline - 1 });
  assert.equal(game.viewFor("a").players.find((player) => player.userId === "b").cards.length, 2);
  assert.equal(game.viewFor("observer", true).players.find((player) => player.userId === "b").cards.length, 2);
  assert.throws(
    () => game.chooseFoldReveal({ userId: "b", reveal: false, handId: game.handId }),
    /已经完成/,
  );

  const timedOut = twoPlayerGame();
  timedOut.act("a", "fold");
  assert.equal(timedOut.resolveFoldRevealIfNeeded(timedOut.foldReveal.deadline + 1), true);
  assert.equal(timedOut.foldReveal.decision, "muck");
  assert.equal(timedOut.viewFor("a").players.find((player) => player.userId === "b").cards.length, 0);
});

test("a regular raise must meet the minimum raise amount", () => {
  const game = twoPlayerGame();
  assert.throws(() => game.act("a", "raise", 15), /最低需要加注至 20/);
  assert.throws(() => game.act("a", "raise", 21), /必须是 5 的倍数/);
  game.act("a", "raise", 20);
  assert.equal(game.currentBet, 20);
  assert.equal(game.currentPlayer.userId, "b");
});

test("hextech action policies cap raises without creating an illegal partial raise", () => {
  const game = twoPlayerGame();
  game.setActionPolicy(({ userId }) => userId === "a"
    ? { maxRaiseTo: 15, reason: "受到恐吓，本次加注受限" }
    : {});

  const restricted = game.legalActions("a");
  assert.equal(restricted.canRaise, false);
  assert.equal(restricted.canAllIn, false);
  assert.equal(restricted.maxRaiseTo, 15);
  assert.match(restricted.restrictionReason, /恐吓/);
  assert.throws(() => game.act("a", "raise", 15), /当前不能加注/);

  game.setActionPolicy(({ userId }) => userId === "a" ? { maxRaiseTo: 30 } : {});
  assert.equal(game.legalActions("a").canRaise, true);
  game.act("a", "raise", 30);
  assert.equal(game.currentBet, 30);
});

test("hextech pot fees and bank awards remain conserved through restore and settlement", () => {
  const game = twoPlayerGame();
  game.addPlayerChipsToPot({ userId: "a", amount: 80, label: "明牌审判" });
  game.addBankChipsToPot({ amount: 120, label: "底池炸弹" });
  game.creditPlayerFromBank({ userId: "b", amount: 80, label: "缴械补偿" });
  game.collectPlayerChipsToBank({ userId: "b", amount: 60, label: "保险费" });
  assert.equal(game.pot, 215);

  const restored = HoldemGame.restore(game.exportState(), { settings });
  assert.equal(restored.pot, 215);
  assert.equal(restored.bonusPot, 200);
  assert.equal(restored.bankInjected, 200);
  assert.equal(restored.bankCollected, 60);
  restored.act("a", "fold");
  assert.equal(restored.winners[0].amount, 215);
  assert.equal(restored.bonusPot, 0);
  assert.equal(
    restored.players.reduce((sum, player) => sum + player.stack, 0) + restored.bankCollected,
    restored.initialChipTotal + restored.bankInjected,
  );
});

test("a delayed prediction penalty is added to an already settled all-in pot", () => {
  const game = twoPlayerGame();
  while (game.stage !== "finished") game.act(game.currentPlayer.userId, "allin");
  const payer = game.players.find((player) => player.stack > 0 && !game.winners.some((winner) => winner.userId === player.userId))
    ?? game.players.find((player) => player.stack > 0);
  const winnerBefore = game.winners.reduce((sum, winner) => sum + winner.amount, 0);
  const paid = game.addPlayerChipsToPot({
    userId: payer.userId,
    amount: 80,
    allowPartial: true,
    label: "预言失败",
  });
  assert.equal(game.winners.reduce((sum, winner) => sum + winner.amount, 0), winnerBefore + paid);
  assert.equal(game.players.reduce((sum, player) => sum + player.stack, 0), 4000);
});

test("a delayed bank pot reward is distributed after an automatic showdown", () => {
  const game = twoPlayerGame();
  while (game.stage !== "finished") game.act(game.currentPlayer.userId, "allin");
  const before = game.winners.reduce((sum, winner) => sum + winner.amount, 0);
  game.addBankChipsToPot({ amount: 120, label: "底池炸弹" });
  assert.equal(game.winners.reduce((sum, winner) => sum + winner.amount, 0), before + 120);
  assert.equal(game.players.reduce((sum, player) => sum + player.stack, 0), 4120);
  assert.equal(game.bankInjected, 120);
});

test("a delayed bank pot reward after a side-pot showdown goes only to the main-pot winner", () => {
  const game = settledThreePlayerSidePotGame();
  const stacksBefore = Object.fromEntries(game.players.map(({ userId, stack }) => [userId, stack]));
  const winningsBefore = Object.fromEntries(game.winners.map(({ userId, amount }) => [userId, amount]));

  game.addBankChipsToPot({ amount: 120, label: "底池炸弹" });

  const stacksAfter = Object.fromEntries(game.players.map(({ userId, stack }) => [userId, stack]));
  const winningsAfter = Object.fromEntries(game.winners.map(({ userId, amount }) => [userId, amount]));
  assert.deepEqual(stacksAfter, {
    a: stacksBefore.a,
    b: stacksBefore.b,
    c: stacksBefore.c + 120,
  });
  assert.deepEqual(winningsAfter, {
    c: winningsBefore.c + 120,
    b: winningsBefore.b,
    a: winningsBefore.a,
  });
  assert.equal(game.bankInjected, 120);
  assert.equal(game.players.reduce((sum, player) => sum + player.stack, 0), 290);
});

test("a delayed partial pot penalty after a side-pot showdown goes only to the main-pot winner", () => {
  const game = settledThreePlayerSidePotGame();
  const winningsBefore = Object.fromEntries(game.winners.map(({ userId, amount }) => [userId, amount]));

  const paid = game.addPlayerChipsToPot({
    userId: "a",
    amount: 80,
    allowPartial: true,
    label: "牌型预报失败",
  });

  const stacksAfter = Object.fromEntries(game.players.map(({ userId, stack }) => [userId, stack]));
  const winningsAfter = Object.fromEntries(game.winners.map(({ userId, amount }) => [userId, amount]));
  assert.equal(paid, 50);
  assert.deepEqual(stacksAfter, { a: 0, b: 60, c: 110 });
  assert.deepEqual(winningsAfter, {
    c: winningsBefore.c + paid,
    b: winningsBefore.b,
    a: winningsBefore.a,
  });
  assert.equal(game.players.reduce((sum, player) => sum + player.stack, 0), 170);
});

test("an external skill fee that empties the acting stack advances the turn safely", () => {
  const game = twoPlayerGame();
  const actor = game.currentPlayer;
  game.collectPlayerChipsToBank({
    userId: actor.userId,
    amount: actor.stack,
    label: "技能极限费用",
  });
  assert.equal(game.playerSnapshot(actor.userId).allIn, true);
  assert.equal(game.legalActions(actor.userId), null);
  if (game.stage !== "finished") {
    assert.notEqual(game.currentPlayer.userId, actor.userId);
    assert.ok(game.actionToken);
  }
});

test("a paused character fee never exposes a poker action token while reconciling", () => {
  const game = twoPlayerGame();
  const actor = game.currentPlayer;
  game.pauseForHextechWindow();
  game.transferPlayerChips({
    fromUserId: actor.userId,
    toUserId: game.players.find((player) => player.userId !== actor.userId).userId,
    amount: actor.stack,
    allowPartial: false,
    label: "人物结算",
  });
  assert.equal(game.actionToken, null);
  assert.equal(game.turnDeadline, null);
  game.resumeFromHextechWindow();
  if (game.stage !== "finished") assert.ok(game.actionToken);
});

test("a room transaction can roll back an applied character directive exactly", () => {
  const game = twoPlayerGame();
  const before = game.exportState();
  const transaction = game.createTransactionSnapshot();
  game.addBankChipsToPot({ amount: 120, label: "人物奖励" });
  game.transferPlayerChips({ fromUserId: "a", toUserId: "b", amount: 100 });
  game.restoreTransactionSnapshot(transaction);
  const restored = game.exportState();
  assert.deepEqual(restored.players, before.players);
  assert.equal(restored.bonusPot, before.bonusPot);
  assert.equal(restored.bankInjected, before.bankInjected);
  assert.equal(restored.actionToken, before.actionToken);
  assert.equal(restored.turnDeadline, before.turnDeadline);
});

test("server-only card replacement keeps a complete unique deck and survives restore", () => {
  const game = twoPlayerGame();
  const before = game.privateCardsFor("a");
  const expectedDeckTop = game.exportState().deck.at(-1);
  const change = game.replaceHoleCardFromDeck({
    userId: "a",
    cardIndex: 0,
    publicDiscard: true,
    label: "回炉重造",
    source: "character:qiwan",
  });
  assert.equal(change.discarded, before[0]);
  assert.equal(change.replacement, expectedDeckTop);
  assert.notEqual(change.replacement, before[0]);
  assert.deepEqual(game.privateCardsFor("a"), [change.replacement, before[1]]);
  assert.equal(game.viewFor("b").players.find(({ userId }) => userId === "a").cards.length, 0);

  const restored = HoldemGame.restore(game.exportState(), { settings });
  assert.deepEqual(restored.privateCardsFor("a"), game.privateCardsFor("a"));
});

test("an armed Ya river replacement discards the natural river and deals exactly the next deck card", () => {
  const game = twoPlayerGame();
  const before = game.exportState();
  const naturalRiver = before.deck.at(-8);
  const replacementRiver = before.deck.at(-9);
  game.armRiverReplacementFromDeck();
  assert.equal(game.exportState().riverReplacementArmed, true);

  const restored = HoldemGame.restore(game.exportState(), { settings, reconnectGraceMs: 0 });
  assert.equal(restored.exportState().riverReplacementArmed, true);
  while (restored.stage !== "finished") restored.act(restored.currentPlayer.userId, "allin");

  assert.equal(restored.community.at(-1), replacementRiver);
  assert.ok(restored.burned.includes(naturalRiver));
  assert.equal(restored.exportState().riverReplacementArmed, false);
  assert.equal(restored.community.includes(naturalRiver), false);
});

test("a reserved character board card survives pause, restart and the real street deal", () => {
  const game = twoPlayerGame();
  game.act("a", "call");
  game.act("b", "check");
  assert.equal(game.stage, "flop");

  const [chosenTurn] = game.nextCommunityCandidates({ street: "turn", count: 3 });
  game.queueBoardCard({ street: "turn", card: chosenTurn, label: "毛哥·花色蛊惑" });
  assert.equal(game.pauseForHextechWindow(), true);
  assert.equal(game.legalActions(game.currentPlayer.userId), null);
  assert.equal(game.viewFor(game.currentPlayer.userId).actionToken, null);

  const restored = HoldemGame.restore(game.exportState(), { settings, reconnectGraceMs: 0 });
  assert.equal(restored.queuedBoardCards.turn, chosenTurn);
  assert.equal(restored.legalActions(restored.currentPlayer.userId), null);
  assert.equal(restored.resumeFromHextechWindow(), true);
  restored.act("b", "check");
  restored.act("a", "check");
  assert.equal(restored.stage, "turn");
  assert.equal(restored.community.at(-1), chosenTurn);
  assert.equal(restored.queuedBoardCards.turn, null);
});

test("a white-board hole card remains visible but is excluded from hand evaluation", () => {
  const game = twoPlayerGame();
  const original = game.privateCardsFor("a")[0];
  const result = game.replaceHoleCardWithBlank({ userId: "a", cardIndex: 0 });
  assert.equal(result.discarded, original);
  assert.equal(result.replacement, HEXTECH_BLANK_CARD);
  assert.equal(game.privateCardsFor("a")[0], HEXTECH_BLANK_CARD);

  const restored = HoldemGame.restore(game.exportState(), { settings });
  assert.equal(restored.privateCardsFor("a")[0], HEXTECH_BLANK_CARD);
  restored.act("a", "call");
  restored.act("b", "check");
  while (restored.stage !== "finished") restored.act(restored.currentPlayer.userId, "check");
  assert.ok(restored.winners.length >= 1);
});

test("a tied pot awards the odd physical chip in five-point units", () => {
  const popSequence = [
    "2c", "3c", "4c", "5c", "6c", "7c",
    "8c", "Ah", "Kh", "Qh", "9c", "Jh", "Jc", "Th",
  ];
  const used = new Set(popSequence);
  const deck = [
    ...createDeck().filter((card) => !used.has(card)),
    ...[...popSequence].reverse(),
  ];
  const game = new HoldemGame({
    players: [
      { userId: "a", username: "玩家 A", seat: 0, stack: 2000 },
      { userId: "b", username: "玩家 B", seat: 1, stack: 2000 },
      { userId: "c", username: "玩家 C", seat: 2, stack: 2000 },
    ],
    settings,
    deck,
  });

  game.act("a", "call");
  game.act("b", "fold");
  game.act("c", "check");
  while (game.stage !== "finished") {
    game.act(game.currentPlayer.userId, "check");
  }

  assert.equal(game.pot, 25);
  assert.deepEqual(game.winners.map(({ amount }) => amount).sort((a, b) => a - b), [10, 15]);
  assert.equal(game.winners.find(({ userId }) => userId === "c").amount, 15);
  assert.ok(game.players.every(({ stack }) => stack % 5 === 0));
  assert.equal(game.players.reduce((total, player) => total + player.stack, 0), 6000);
});

test("three all-ins produce side pots without creating or losing chips", () => {
  const game = new HoldemGame({
    players: [
      { userId: "a", username: "玩家 A", seat: 0, stack: 100 },
      { userId: "b", username: "玩家 B", seat: 1, stack: 50 },
      { userId: "c", username: "玩家 C", seat: 2, stack: 20 },
    ],
    settings,
    actionSeconds: 30,
  });

  while (game.stage !== "finished") {
    const actor = game.currentPlayer;
    assert.ok(actor);
    game.act(actor.userId, "allin");
  }

  assert.equal(game.pot, 170);
  assert.equal(game.community.length, 5);
  assert.equal(game.players.reduce((sum, player) => sum + player.stack, 0), 170);
  assert.ok(game.winners.length >= 1);
});

test("server settlement provenance attributes each winner only to opponents in the pots they won", () => {
  const popSequence = [
    // Hole cards are dealt B, C, A twice.
    "Kc", "As", "2c", "Kd", "Ah", "7d",
    // Burn, flop, burn, turn, burn, river.
    "Qc", "3s", "4h", "8c", "Qd", "9d", "Qh", "Ts",
  ];
  const used = new Set(popSequence);
  const deck = [
    ...createDeck().filter((card) => !used.has(card)),
    ...[...popSequence].reverse(),
  ];
  const game = new HoldemGame({
    players: [
      { userId: "a", username: "玩家 A", seat: 0, stack: 100 },
      { userId: "b", username: "玩家 B", seat: 1, stack: 50 },
      { userId: "c", username: "玩家 C", seat: 2, stack: 20 },
    ],
    settings,
    deck,
  });

  while (game.stage !== "finished") game.act(game.currentPlayer.userId, "allin");

  const results = new Map(game.settlementResults().map((result) => [result.userId, result]));
  // C wins only the 20-chip main-pot level and therefore beats both deeper
  // stacks. B wins the 20-50 side pot and must not be credited with beating C.
  assert.deepEqual(results.get("c").opponentsBeaten.sort(), ["a", "b"]);
  assert.deepEqual(results.get("b").opponentsBeaten, ["a"]);
  // A's unmatched 50-chip level is returned through the payout engine but
  // contains no opponent, so it cannot advance a "beat a player" objective.
  assert.deepEqual(results.get("a").opponentsBeaten, []);
  assert.deepEqual(results.get("c").bestFiveCardIds, ["As", "Ah", "Ts", "9d", "8c"]);
  assert.equal(Object.hasOwn(game.viewFor("a"), "settlementProvenance"), false);
  assert.equal(Object.hasOwn(game.viewFor("a").winners[0], "bestFiveCardIds"), false);
});

test("a specific character replacement is credited only when it reaches the final best five", () => {
  const popSequence = [
    "Kc", "2c", "Kd", "7d",
    "Qc", "Ah", "4h", "8c", "Qd", "9d", "Qh", "Ts",
  ];
  const used = new Set(popSequence);
  const deck = [
    ...createDeck().filter((card) => !used.has(card)),
    ...[...popSequence].reverse(),
  ];
  const game = twoPlayerGame({ deck });
  game.replaceHoleCardWithSpecificCard({ userId: "a", cardIndex: 0, card: "As" });
  while (game.stage !== "finished") game.act(game.currentPlayer.userId, "allin");

  const result = game.settlementResults().find(({ userId }) => userId === "a");
  assert.equal(result.replacementUsedInFinalHand, true);
  assert.ok(result.bestFiveCardIds.includes("As"));

  const restored = HoldemGame.restore(game.exportState(), { settings });
  assert.deepEqual(restored.settlementResults(), game.settlementResults());
  assert.equal(Object.hasOwn(restored.viewFor("b"), "settlementProvenance"), false);
});

test("a board-only tie excludes both co-winners and an unused replacement from provenance", () => {
  const popSequence = [
    "3c", "2c", "4d", "7d",
    "Qc", "As", "Ks", "Qs", "Qd", "Js", "Qh", "Ts",
  ];
  const used = new Set(popSequence);
  const game = twoPlayerGame({
    deck: [
      ...createDeck().filter((card) => !used.has(card)),
      ...[...popSequence].reverse(),
    ],
  });
  game.replaceHoleCardWithSpecificCard({ userId: "a", cardIndex: 0, card: "5c" });
  while (game.stage !== "finished") game.act(game.currentPlayer.userId, "allin");

  const results = game.settlementResults();
  assert.equal(game.winners.length, 2);
  assert.ok(results.every((result) => result.opponentsBeaten.length === 0));
  assert.equal(results.find(({ userId }) => userId === "a").replacementUsedInFinalHand, false);
});

test("timeout checks when possible and folds when facing a bet", () => {
  const game = twoPlayerGame();
  assert.equal(game.timeoutIfNeeded(game.turnDeadline + 1), true);
  assert.equal(game.stage, "finished");
  assert.equal(game.finishedReason, "fold");
});
