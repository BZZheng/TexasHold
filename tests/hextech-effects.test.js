import assert from "node:assert/strict";
import test from "node:test";
import {
  HEXTECH_EFFECT_DIRECTIVE_TYPES,
  HEXTECH_EFFECT_RULES,
  IMPLEMENTED_HEXTECH_EFFECT_SKILL_IDS,
  HextechEffectError,
  createHextechEffectsEngine,
  restoreHextechEffectsEngine,
} from "../server/hextech-effects.js";

function game({
  handId = "hand-1",
  stage = "preflop",
  actingUserId = "a",
  players = null,
  tendencies = {},
  community = [],
  winners = [],
  finishedReason = null,
  bonusPot = 0,
  deck = null,
} = {}) {
  const state = {
    handId,
    stage,
    actingUserId,
    currentBet: 40,
    community: [...community],
    winners: winners.map((winner) => ({ ...winner })),
    finishedReason,
    bonusPot,
    ...(deck ? { deck: [...deck] } : {}),
    actingSeat: 0,
    settings: { smallBlind: 20, bigBlind: 40 },
    players: players ?? [
      {
        userId: "a", username: "A", seat: 0, stack: 1960, startingStack: 2000,
        hand: ["As", "Kd"], folded: false, allIn: false, bet: 40, totalCommitted: 40,
      },
      {
        userId: "b", username: "B", seat: 1, stack: 1980, startingStack: 2000,
        hand: ["Qh", "Jc"], folded: false, allIn: false, bet: 20, totalCommitted: 20,
      },
      {
        userId: "c", username: "C", seat: 2, stack: 2000, startingStack: 2000,
        hand: ["9s", "9d"], folded: false, allIn: false, bet: 0, totalCommitted: 0,
      },
    ],
    get currentPlayer() {
      return this.players.find((player) => player.userId === this.actingUserId) ?? null;
    },
    get pot() {
      return this.players.reduce((sum, player) => sum + Number(player.totalCommitted ?? 0), 0)
        + Number(this.bonusPot ?? 0);
    },
    playerSnapshot(userId) {
      const player = this.players.find((candidate) => candidate.userId === userId);
      return player ? { ...player, hand: [...player.hand] } : null;
    },
    privateCardsFor(userId) {
      const player = this.players.find((candidate) => candidate.userId === userId);
      return player ? [...player.hand] : null;
    },
    publicTendencyFor(userId) {
      return tendencies[userId] ?? null;
    },
  };
  return state;
}

function engineFor(equipmentByUserId, options = {}) {
  const engine = createHextechEffectsEngine({
    matchId: options.matchId ?? "match-1",
    participantUserIds: ["a", "b", "c"],
    rng: options.rng,
  });
  engine.beginHand({
    handId: options.handId ?? "hand-1",
    players: ["a", "b", "c"],
    equipmentByUserId: { a: "escape", b: "escape", c: "escape", ...equipmentByUserId },
    stage: options.stage ?? "preflop",
    now: options.now ?? 1_000,
  });
  return engine;
}

let nextCommand = 0;
function issue(engine, actorId, command, gameState, extra = {}, now = 1_500) {
  nextCommand += 1;
  const window = engine.viewFor(actorId, gameState, now).skillWindow;
  return engine.command({
    actorId,
    command,
    game: gameState,
    now,
    payload: {
      commandId: `command-${nextCommand}`,
      windowToken: window.token,
      windowVersion: window.version,
      ...extra,
    },
  });
}

function resolveTargetSkill(engine, actorId, targetUserId, gameState, now = 1_500) {
  const activated = issue(engine, actorId, "activate", gameState, {}, now);
  assert.equal(activated.result.status, "targeting");
  const selected = issue(engine, actorId, "select-target", gameState, { targetUserId }, now + 1);
  assert.equal(selected.result.status, "confirming");
  return issue(engine, actorId, "confirm", gameState, {}, now + 2);
}

function resolveChoiceSkill(engine, actorId, choices, gameState, now = 1_500) {
  const activated = issue(engine, actorId, "activate", gameState, {}, now);
  assert.equal(activated.result.status, "confirming");
  return issue(engine, actorId, "confirm", gameState, { choices }, now + 1);
}

function directiveTypes(...outcomes) {
  return outcomes.flatMap((outcome) => outcome.directives.map(({ type }) => type));
}

test("effect state, skill windows and command receipts serialize without replaying directives", () => {
  const table = game();
  const engine = engineFor({ a: "xray", b: "fake-weak" }, { rng: () => 0.1 });
  const initial = engine.viewFor("a", table, 1_100).skillWindow;
  assert.equal(initial.state, "idle");
  assert.equal(initial.skillId, "xray");
  assert.equal(typeof initial.token, "string");
  assert.equal(initial.version, 1);

  const activationPayload = {
    commandId: "fixed-activation",
    windowToken: initial.token,
    windowVersion: initial.version,
  };
  const activated = engine.command({ actorId: "a", command: "activate", payload: activationPayload, game: table, now: 1_200 });
  assert.equal(activated.result.status, "targeting");
  assert.notEqual(engine.viewFor("a", table, 1_200).skillWindow.token, initial.token);
  const replay = engine.command({ actorId: "a", command: "activate", payload: activationPayload, game: table, now: 1_201 });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.directives, []);
  assert.equal(replay.acceptedEventSeq, activated.eventSeq);

  issue(engine, "a", "select-target", table, { targetUserId: "b" }, 1_202);
  const resolved = issue(engine, "a", "confirm", table, {}, 1_203);
  assert.equal(resolved.result.success, true);
  const reveal = resolved.directives.find(({ type }) => type === "private-reveal");
  assert.deepEqual(reveal.cards, ["7c", "2d"]);
  assert.deepEqual(engine.viewFor("a", table, 1_204).privateEffects[0].cards, ["7c", "2d"]);
  assert.deepEqual(engine.viewFor("c", table, 1_204).privateEffects, []);
  assert.equal(engine.viewFor("a", table, 1_204).skillWindow.state, "consumed");
  assert.equal(engine.viewFor("b", table, 1_204).skillWindow.state, "consumed");

  const saved = engine.exportState();
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
  const restored = restoreHextechEffectsEngine(saved, { rng: () => 0.99 });
  const restoredState = restored.exportState();
  assert.equal(restoredState.eventSeq, saved.eventSeq);
  assert.equal(restoredState.hand.equipments.a.status, saved.hand.equipments.a.status);
  assert.notEqual(restoredState.hand.windows.a.token, saved.hand.windows.a.token);
  assert.equal(restoredState.hand.windows.a.version, saved.hand.windows.a.version + 1);
  assert.deepEqual(restored.viewFor("c", table, 1_204).privateEffects, []);
});

test("external spectator views consume and persist a server-side fake hand mask", () => {
  const table = game();
  const engine = engineFor({ a: "fake-weak" });
  const first = engine.externalHoleCardView({
    viewerUserId: "b",
    targetUserId: "a",
    cards: table.privateCardsFor("a"),
    now: 1_100,
  });
  assert.deepEqual(first.cards, ["7c", "2d"]);
  assert.equal(first.masked, true);
  assert.equal(engine.viewFor("a", table, 1_101).equipment.status, "consumed");

  const repeated = engine.externalHoleCardView({
    viewerUserId: "b",
    targetUserId: "a",
    cards: table.privateCardsFor("a"),
    now: 1_102,
  });
  assert.deepEqual(repeated.cards, ["7c", "2d"]);
  assert.equal(repeated.eventSeq, first.eventSeq);

  const laterViewer = engine.externalHoleCardView({
    viewerUserId: "c",
    targetUserId: "a",
    cards: table.privateCardsFor("a"),
    now: 1_103,
  });
  assert.deepEqual(laterViewer.cards, ["As", "Kd"]);
  assert.doesNotMatch(JSON.stringify(engine.viewFor("b", table, 1_104)), /7c|2d/);
});

test("stale windows, forged targets and insufficient confirmation costs do not consume equipment", () => {
  const table = game({ stage: "flop" });
  table.players[0].stack = 80;
  const engine = engineFor({ a: "public-reveal", b: "fake-strong" }, { stage: "flop" });
  const first = engine.viewFor("a", table, 1_100).skillWindow;
  issue(engine, "a", "activate", table, {}, 1_200);
  assert.throws(
    () => engine.command({
      actorId: "a",
      command: "select-target",
      game: table,
      now: 1_201,
      payload: { commandId: "stale-window", windowToken: first.token, targetUserId: "b" },
    }),
    (error) => error instanceof HextechEffectError && error.code === "stale_hextech_skill_window",
  );
  assert.throws(
    () => issue(engine, "a", "select-target", table, { targetUserId: "missing" }, 1_202),
    /目标.*失效/,
  );
  issue(engine, "a", "select-target", table, { targetUserId: "b" }, 1_203);
  assert.throws(
    () => issue(engine, "a", "confirm", table, {}, 1_204),
    (error) => error.code === "insufficient_hextech_chips",
  );
  assert.equal(engine.viewFor("a", table, 1_205).skillWindow.state, "confirming");
  assert.equal(engine.exportState().hand.equipments.a.status, "available");
});

test("xray is a server-side 60 percent roll and smoke source remains private", () => {
  const missTable = game();
  const missEngine = engineFor({ a: "xray", b: "fake-strong" }, { rng: () => 0.6 });
  const miss = resolveTargetSkill(missEngine, "a", "b", missTable);
  assert.equal(miss.result.success, false);
  assert.equal(miss.result.reason, "roll");
  assert.equal(missEngine.viewFor("b", missTable).skillWindow.state, "armed");
  assert.equal(miss.directives.some(({ type }) => type === "private-reveal"), false);

  const smokeTable = game();
  const smokeEngine = engineFor({ a: "xray", b: "smoke-bomb" }, { rng: () => 0.01 });
  const obscured = resolveTargetSkill(smokeEngine, "a", "b", smokeTable);
  assert.equal(obscured.result.reason, "obscured");
  assert.equal(JSON.stringify(smokeEngine.viewFor("a", smokeTable).recentEvents).includes("smoke-bomb"), false);
  assert.equal(JSON.stringify(smokeEngine.viewFor("b", smokeTable).recentEvents).includes("smoke-bomb"), true);
});

test("mirror reflects information to the defender without leaking it to the caster", () => {
  const table = game({ tendencies: { a: "进攻", b: "保守" } });
  const engine = engineFor({ a: "mind-read", b: "mirror" });
  const result = resolveTargetSkill(engine, "a", "b", table);
  assert.equal(result.result.reflected, true);
  assert.equal(result.result.tendency, null);
  assert.equal(engine.viewFor("a", table).privateEffects.length, 0);
  assert.equal(engine.viewFor("b", table).privateEffects[0].tendency, "进攻");
  const reveal = result.directives.find(({ type }) => type === "private-reveal");
  assert.deepEqual(reveal.audienceUserIds, ["b"]);
  assert.equal(reveal.subjectUserId, "a");
});

test("public reveal charges the pot, uses server card RNG and remains public for four seconds", () => {
  const table = game({ stage: "flop" });
  const engine = engineFor(
    { a: "public-reveal", b: "fake-strong" },
    { stage: "flop", rng: { random: () => 0.1, randomInt: () => 1 } },
  );
  const result = resolveTargetSkill(engine, "a", "b", table, 2_000);
  assert.deepEqual(directiveTypes(result), ["charge-pot", "public-reveal", "log"]);
  assert.equal(result.directives[0].amount, 80);
  assert.equal(result.result.cardIndex, 1);
  assert.equal(result.result.card, "Ah");
  assert.equal(engine.viewFor("c", table, 5_999).publicEffects.publicReveals[0].card, "Ah");
  assert.equal(engine.viewFor("c", table, 6_003).publicEffects.publicReveals.length, 0);

  const shielded = engineFor({ a: "public-reveal", b: "shield" }, { stage: "flop" });
  const blocked = resolveTargetSkill(shielded, "a", "b", table, 2_000);
  assert.deepEqual(directiveTypes(blocked), ["charge-pot", "skill-blocked", "log"]);
  assert.equal(blocked.result.status, "blocked");
});

test("charm only fires after the armed caster actually becomes all-in", () => {
  const table = game();
  const engine = engineFor({ a: "charm", b: "escape" });
  const armed = resolveTargetSkill(engine, "a", "b", table, 1_200);
  assert.equal(armed.result.status, "armed");
  assert.equal(armed.directives.some(({ type }) => type === "forced-call"), false);

  const before = { players: table.players.map((player) => ({ ...player, hand: [...player.hand] })), stage: table.stage };
  table.players[0].allIn = true;
  table.players[0].stack = 0;
  table.players[0].bet = 2_000;
  table.currentBet = 2_000;
  table.actingUserId = "b";
  const triggered = engine.afterPokerAction({ actorId: "a", action: "allin", before, game: table, now: 2_000 });
  assert.deepEqual(directiveTypes(triggered), ["open-reaction", "log"]);
  assert.equal(engine.viewFor("b", table, 2_001).skillWindow.state, "armed");
  assert.equal(engine.viewFor("b", table, 2_001).activeReaction.expiresAt, 6_000);

  const selected = issue(engine, "b", "react", table, {}, 2_100);
  assert.equal(selected.result.option, "escape");
  assert.equal(selected.result.maximumChipRisk, 160);
  const escaped = issue(engine, "b", "confirm-reaction", table, {}, 2_200);
  assert.deepEqual(directiveTypes(escaped), ["charge-bank", "log"]);
  assert.equal(escaped.directives[0].amount, 160);
  assert.equal(engine.viewFor("a", table, 2_201).skillWindow.state, "consumed");
  assert.equal(engine.viewFor("b", table, 2_201).skillWindow.state, "consumed");
});

test("charm reaction timeout and cancel resolve exactly one forced call", () => {
  for (const resolution of ["timeout", "cancel"]) {
    const table = game({ handId: `hand-${resolution}` });
    const engine = engineFor(
      { a: "charm", b: "escape" },
      { handId: `hand-${resolution}`, matchId: `match-${resolution}` },
    );
    resolveTargetSkill(engine, "a", "b", table, 1_200);
    const before = { players: table.players.map((player) => ({ ...player })), stage: table.stage };
    table.players[0].allIn = true;
    table.players[0].stack = 0;
    table.players[0].bet = 2_000;
    table.currentBet = 2_000;
    engine.afterPokerAction({ actorId: "a", action: "allin", before, game: table, now: 2_000 });
    const result = resolution === "timeout"
      ? engine.tick({ game: table, now: 6_001 })
      : issue(engine, "b", "cancel", table, {}, 2_100);
    assert.equal(result.directives.filter(({ type }) => type === "forced-call").length, 1);
    assert.equal(result.directives.find(({ type }) => type === "forced-call").maximumAmount, 600);
    assert.deepEqual(engine.tick({ game: table, now: 7_000 }).directives, []);
    assert.equal(engine.viewFor("b", table, 7_000).skillWindow.state, "idle");
  }
});

test("an unaffordable escape does not create a zero-stack bank-fee reaction", () => {
  const table = game();
  table.players[1].stack = 80;
  const engine = engineFor({ a: "charm", b: "escape" });
  resolveTargetSkill(engine, "a", "b", table, 1_200);
  const before = { players: table.players.map((player) => ({ ...player })), stage: table.stage };
  table.players[0].allIn = true;
  table.players[0].stack = 0;
  table.players[0].bet = 2_000;
  table.currentBet = 2_000;
  const triggered = engine.afterPokerAction({ actorId: "a", action: "allin", before, game: table, now: 2_000 });
  assert.equal(triggered.directives.some(({ type }) => type === "open-reaction"), false);
  assert.equal(triggered.directives.filter(({ type }) => type === "forced-call").length, 1);
  assert.equal(engine.viewFor("b", table, 2_001).skillWindow.state, "idle");
});

test("intimidate, silence and peace treaty expose enforceable action policies", () => {
  const intimidationTable = game();
  intimidationTable.players[0].bet = 150;
  const intimidation = engineFor({ a: "intimidate", b: "mind-read" });
  const result = resolveTargetSkill(intimidation, "a", "b", intimidationTable);
  assert.ok(directiveTypes(result).includes("raise-cap"));
  assert.deepEqual(
    intimidation.actionPolicyFor({
      userId: "b", stage: "preflop", currentBet: 100, players: intimidationTable.players,
    }),
    { maxRaiseTo: 150, reason: "受到恐吓，本次加注受限" },
  );
  const beforeRaise = { players: intimidationTable.players.map((player) => ({ ...player })) };
  intimidationTable.players[1].bet = 150;
  intimidation.afterPokerAction({ actorId: "b", action: "raise", amount: 150, before: beforeRaise, game: intimidationTable, now: 2_000 });
  assert.deepEqual(intimidation.actionPolicyFor({ userId: "b", stage: "preflop", currentBet: 150, players: intimidationTable.players }), {});

  const silenceTable = game();
  const silence = engineFor({ a: "silence", b: "xray" }, { now: 1_000 });
  resolveTargetSkill(silence, "a", "b", silenceTable, 1_100);
  silenceTable.actingUserId = "b";
  assert.throws(
    () => issue(silence, "b", "activate", silenceTable, {}, 1_200),
    (error) => error.code === "hextech_skill_silenced",
  );

  const peaceTable = game();
  const peace = engineFor({ a: "peace-treaty", b: "xray" });
  const treaty = resolveTargetSkill(peace, "a", "b", peaceTable);
  assert.ok(directiveTypes(treaty).includes("mutual-raise-lock"));
  const policy = peace.actionPolicyFor({ userId: "b", stage: "preflop", currentBet: 40, players: peaceTable.players });
  assert.equal(policy.disableRaise, true);
  assert.match(policy.reason, /和平条约/);
});

test("disarm disables only an unused active equipment and awards server bank compensation", () => {
  const table = game();
  const engine = engineFor({ a: "disarm", b: "xray", c: "shield" });
  const targeting = issue(engine, "a", "activate", table);
  assert.deepEqual(engine.viewFor("a", table).skillWindow.validTargetUserIds, ["b"]);
  assert.equal(targeting.result.status, "targeting");
  issue(engine, "a", "select-target", table, { targetUserId: "b" });
  const result = issue(engine, "a", "confirm", table);
  assert.deepEqual(directiveTypes(result), ["disable-equipment", "bank-credit", "log"]);
  assert.equal(result.directives.find(({ type }) => type === "bank-credit").amount, 80);
  assert.equal(engine.exportState().hand.equipments.b.status, "disabled");
  assert.equal(engine.viewFor("b", table).skillWindow.disabledReason, "本手装备已被缴械");
});

test("street transitions expire street-scoped private views and control effects", () => {
  const table = game();
  const engine = engineFor({ a: "xray", b: "fake-weak" }, { rng: () => 0.1 });
  resolveTargetSkill(engine, "a", "b", table, 1_200);
  assert.equal(engine.viewFor("a", table, 1_300).privateEffects.length, 1);
  const before = { stage: "preflop", players: table.players.map((player) => ({ ...player })) };
  table.stage = "flop";
  table.actingUserId = "b";
  const transition = engine.afterPokerAction({
    actorId: "b",
    action: "check",
    before,
    game: table,
    now: 2_000,
  });
  assert.ok(transition.events.some(({ type }) => type === "street-changed"));
  assert.deepEqual(engine.viewFor("a", table, 2_001).privateEffects, []);
});

test("choice skills validate the shared schema and gambler outcomes use injected server RNG", () => {
  const cases = [
    {
      name: "chosen-rank",
      rng: { random: () => 0.299, randomInt: () => 0 },
      expectedType: "replace-hole-card-rank",
      expectedRank: "Q",
      preserveSuit: true,
    },
    {
      name: "small-rank",
      rng: { random: () => 0.3, randomInt: () => 2 },
      expectedType: "replace-hole-card-rank",
      expectedRank: "4",
      preserveSuit: false,
    },
    {
      name: "unchanged",
      rng: { random: () => 0.9, randomInt: () => 0 },
      expectedType: null,
      expectedRank: null,
    },
    {
      name: "blank",
      rng: { random: () => 0.999, randomInt: () => 0 },
      expectedType: "blank-hole-card",
      expectedRank: null,
    },
  ];

  for (const current of cases) {
    const handId = `gambler-${current.name}`;
    const table = game({ handId });
    const engine = engineFor(
      { a: "gambler" },
      { handId, matchId: `match-${current.name}`, rng: current.rng },
    );
    const activated = issue(engine, "a", "activate", table);
    assert.equal(activated.result.status, "confirming");
    if (current.name === "chosen-rank") {
      assert.throws(
        () => issue(engine, "a", "confirm", table, { choices: { holeCardIndex: 0, rank: "joker" } }),
        (error) => error.code === "invalid_hextech_choice",
      );
      assert.equal(engine.exportState().hand.equipments.a.status, "available");
    }
    const result = issue(
      engine,
      "a",
      "confirm",
      table,
      { choices: { holeCardIndex: 0, rank: "Q" } },
    );
    assert.equal(result.result.outcome, current.name);
    assert.equal(result.result.resultingRank, current.expectedRank);
    const mutation = result.directives.find(({ type }) => type !== "log");
    assert.equal(mutation?.type ?? null, current.expectedType);
    if (current.expectedType === "replace-hole-card-rank") {
      assert.equal(mutation.rank, current.expectedRank);
      assert.equal(mutation.preferredSuit, "s");
      assert.equal(mutation.preserveSuit, current.preserveSuit);
    }
    assert.deepEqual(engine.exportState().hand.effects.cheatUsageByUserId.a, ["gambler"]);
    assert.equal(engine.viewFor("a", table).skillWindow.state, "consumed");
  }
});

test("reforge and swap-trick emit authoritative replacement directives with correct discard visibility", () => {
  const preflop = game();
  const reforge = engineFor({ a: "reforge" });
  const reforged = resolveChoiceSkill(reforge, "a", { holeCardIndex: 1 }, preflop);
  assert.deepEqual(directiveTypes(reforged), ["replace-hole-card-random", "log"]);
  assert.equal(reforged.directives[0].publicDiscard, false);
  assert.equal(reforged.directives[0].cardIndex, 1);
  assert.equal(reforge.exportState().hand.effects.cheatUsageByUserId.a, undefined);

  const turn = game({ handId: "swap-hand", stage: "turn", actingUserId: "b", community: ["2c", "3d", "4h", "5s"] });
  const swap = engineFor(
    { a: "swap-trick" },
    { handId: "swap-hand", matchId: "swap-match", stage: "turn" },
  );
  const swapped = resolveChoiceSkill(swap, "a", { holeCardIndex: 0 }, turn);
  assert.deepEqual(directiveTypes(swapped), ["replace-hole-card-random", "log"]);
  assert.equal(swapped.directives[0].publicDiscard, true);
  assert.equal(swapped.directives[0].discardedCard, "As");
  assert.deepEqual(swap.exportState().hand.effects.cheatUsageByUserId.a, ["swap-trick"]);

  const illegal = engineFor({ a: "swap-trick" });
  assert.throws(
    () => issue(illegal, "a", "activate", preflop),
    (error) => error.code === "invalid_hextech_skill_timing",
  );
});

test("prophet resolves exactly once when the flop arrives and keeps the prediction private beforehand", () => {
  const winningTable = game({ handId: "prophet-hit" });
  const winning = engineFor(
    { a: "prophet" },
    { handId: "prophet-hit", matchId: "prophet-hit-match" },
  );
  const armed = resolveChoiceSkill(winning, "a", { suit: "clubs" }, winningTable);
  assert.deepEqual(directiveTypes(armed), ["log"]);
  assert.equal(winning.viewFor("a", winningTable).privateEffects[0].suit, "clubs");
  assert.deepEqual(winning.viewFor("b", winningTable).privateEffects, []);

  const before = { stage: "preflop", players: winningTable.players.map((player) => ({ ...player })) };
  winningTable.stage = "flop";
  winningTable.community = ["2c", "7c", "Ah"];
  winningTable.actingUserId = "b";
  const hit = winning.afterPokerAction({ actorId: "b", action: "check", before, game: winningTable, now: 2_000 });
  assert.deepEqual(directiveTypes(hit), ["bank-credit", "log"]);
  assert.equal(hit.directives[0].amount, 160);
  assert.equal(winning.exportState().hand.effects.predictions[0].success, true);
  assert.deepEqual(winning.viewFor("a", winningTable).privateEffects, []);
  assert.deepEqual(winning.tick({ game: winningTable, now: 2_100 }).directives, []);

  const losingTable = game({ handId: "prophet-miss" });
  const losing = engineFor(
    { a: "prophet" },
    { handId: "prophet-miss", matchId: "prophet-miss-match" },
  );
  resolveChoiceSkill(losing, "a", { suit: "spades" }, losingTable);
  const losingBefore = { stage: "preflop", players: losingTable.players.map((player) => ({ ...player })) };
  losingTable.stage = "flop";
  losingTable.community = ["2c", "7c", "Ah"];
  const miss = losing.afterPokerAction({ actorId: "b", action: "check", before: losingBefore, game: losingTable, now: 2_000 });
  assert.deepEqual(directiveTypes(miss), ["charge-pot", "log"]);
  assert.equal(miss.directives[0].amount, 80);
  assert.equal(miss.directives[0].allowPartial, true);
});

test("river-veto charges once per table and emits a server redeal directive", () => {
  const table = game({
    handId: "river-hand",
    stage: "river",
    community: ["2c", "3d", "4h", "5s", "Kd"],
  });
  const engine = engineFor(
    { a: "river-veto", b: "river-veto" },
    { handId: "river-hand", matchId: "river-match", stage: "river" },
  );
  table.players[0].stack = 120;
  const activated = issue(engine, "a", "activate", table);
  assert.equal(activated.result.status, "confirming");
  assert.throws(
    () => issue(engine, "a", "confirm", table, { choices: {} }),
    (error) => error.code === "insufficient_hextech_chips",
  );
  assert.equal(engine.viewFor("a", table).skillWindow.state, "confirming");
  assert.equal(engine.exportState().hand.equipments.a.status, "available");

  table.players[0].stack = 125;
  const result = issue(engine, "a", "confirm", table, { choices: {} });
  assert.deepEqual(directiveTypes(result), ["charge-bank", "redeal-river", "log"]);
  assert.equal(result.directives[0].amount, 120);
  assert.equal(engine.viewFor("b", table).publicEffects.riverVetoUsedByUserId, "a");
  assert.match(engine.viewFor("b", table).skillWindow.disabledReason, /已经使用过/);
  assert.throws(
    () => issue(engine, "b", "activate", table),
    (error) => error.code === "hextech_table_skill_consumed",
  );
});

test("catch-cheater audits authoritative cheat history, pays the table, and honors defenses", () => {
  const caughtTable = game({ handId: "caught-hand", actingUserId: "b" });
  const caught = engineFor(
    { a: "catch-cheater", b: "xray" },
    { handId: "caught-hand", matchId: "caught-match", rng: () => 0.1 },
  );
  resolveTargetSkill(caught, "b", "c", caughtTable);
  caughtTable.actingUserId = "a";
  const result = resolveTargetSkill(caught, "a", "b", caughtTable);
  assert.equal(result.result.success, true);
  assert.deepEqual(directiveTypes(result), ["transfer-chips", "transfer-chips", "force-fold", "log"]);
  const transfers = result.directives.filter(({ type }) => type === "transfer-chips");
  assert.deepEqual(transfers.map(({ fromUserId, toUserId, amount }) => [fromUserId, toUserId, amount]), [
    ["b", "a", 100],
    ["b", "c", 100],
  ]);
  assert.equal(result.directives.find(({ type }) => type === "force-fold").userId, "b");

  const missTable = game({ handId: "audit-miss" });
  const missEngine = engineFor(
    { a: "catch-cheater", b: "mind-read" },
    { handId: "audit-miss", matchId: "audit-miss-match" },
  );
  const miss = resolveTargetSkill(missEngine, "a", "b", missTable);
  assert.equal(miss.result.success, false);
  assert.deepEqual(directiveTypes(miss), ["transfer-chips", "log"]);
  assert.deepEqual(
    { from: miss.directives[0].fromUserId, to: miss.directives[0].toUserId, amount: miss.directives[0].amount },
    { from: "a", to: "b", amount: 100 },
  );

  const shieldTable = game({ handId: "audit-shield" });
  const shield = engineFor(
    { a: "catch-cheater", b: "shield" },
    { handId: "audit-shield", matchId: "audit-shield-match" },
  );
  const blocked = resolveTargetSkill(shield, "a", "b", shieldTable);
  assert.equal(blocked.result.status, "blocked");
  assert.deepEqual(directiveTypes(blocked), ["skill-blocked"]);
});

test("pot-bomb survives restore, triggers exactly once at 800, and raise-cap limits every player", () => {
  const bombTable = game({ handId: "pot-bomb-hand" });
  const bomb = engineFor(
    { a: "pot-bomb" },
    { handId: "pot-bomb-hand", matchId: "pot-bomb-match" },
  );
  const armed = resolveChoiceSkill(bomb, "a", {}, bombTable);
  assert.equal(armed.result.status, "armed");
  assert.deepEqual(directiveTypes(armed), ["log"]);
  const restored = restoreHextechEffectsEngine(bomb.exportState());
  bombTable.players[0].totalCommitted = 400;
  bombTable.players[1].totalCommitted = 300;
  bombTable.players[2].totalCommitted = 100;
  const before = {
    stage: "preflop",
    currentBet: 300,
    players: bombTable.players.map((player) => ({ ...player, hand: [...player.hand] })),
  };
  const triggered = restored.afterPokerAction({
    actorId: "b", action: "call", before, game: bombTable, now: 2_000,
  });
  assert.deepEqual(directiveTypes(triggered), ["bank-pot", "log"]);
  assert.equal(triggered.directives[0].amount, 120);
  assert.equal(restored.viewFor("a", bombTable).skillWindow.state, "consumed");
  assert.deepEqual(restored.tick({ game: bombTable, now: 2_100 }).directives, []);

  const capTable = game({ handId: "raise-cap-hand", stage: "flop" });
  capTable.currentBet = 100;
  const cap = engineFor(
    { a: "raise-cap" },
    { handId: "raise-cap-hand", matchId: "raise-cap-match", stage: "flop", now: 1_000 },
  );
  const applied = resolveChoiceSkill(cap, "a", {}, capTable, 1_100);
  assert.deepEqual(directiveTypes(applied), ["raise-cap", "log"]);
  assert.equal(applied.directives[0].maximumIncrement, 120);
  assert.deepEqual(
    cap.actionPolicyFor({
      userId: "b",
      stage: "flop",
      currentBet: 100,
      bigBlind: 40,
      players: capTable.players,
    }),
    { maxRaiseTo: 220, reason: "限高令生效，单次加注增量最多 120" },
  );
  const capBefore = { stage: "flop", currentBet: 100, players: capTable.players.map((player) => ({ ...player })) };
  capTable.stage = "turn";
  capTable.community = ["2c", "3d", "4h", "5s"];
  cap.afterPokerAction({ actorId: "b", action: "check", before: capBefore, game: capTable, now: 2_000 });
  assert.deepEqual(cap.actionPolicyFor({
    userId: "b", stage: "turn", currentBet: 0, bigBlind: 40, players: capTable.players,
  }), {});
});

test("duel-contract and bounty settle server-side showdown comparisons and finish receipts cannot replay", () => {
  const duelTable = game({ handId: "duel-hand" });
  duelTable.players[0].hand = ["As", "Ad"];
  duelTable.players[1].hand = ["Kh", "Kd"];
  const duel = engineFor(
    { a: "duel-contract" },
    { handId: "duel-hand", matchId: "duel-match" },
  );
  resolveTargetSkill(duel, "a", "b", duelTable);
  const restored = restoreHextechEffectsEngine(duel.exportState());
  duelTable.stage = "finished";
  duelTable.finishedReason = "showdown";
  duelTable.community = ["2c", "3d", "4h", "8s", "Tc"];
  duelTable.players[0].totalCommitted = 400;
  duelTable.players[1].totalCommitted = 400;
  duelTable.players[2].folded = true;
  duelTable.winners = [{ userId: "a", amount: 800, handName: "一对" }];
  const settled = restored.finishHand({ handId: "duel-hand", game: duelTable, now: 3_000 });
  assert.equal(settled.ok, true);
  assert.equal(settled.replayed, false);
  assert.deepEqual(directiveTypes(settled), ["bank-credit", "log"]);
  assert.deepEqual(
    { userId: settled.directives[0].userId, amount: settled.directives[0].amount },
    { userId: "a", amount: 180 },
  );
  assert.equal(settled.result.settlements.some(({ type }) => type === "duel-contract-settled"), true);
  assert.ok(settled.finishedHand.effects.duelContracts[0].winnerUserId === "a");
  const postFinishRestore = restoreHextechEffectsEngine(restored.exportState());
  const replay = postFinishRestore.finishHand({ handId: "duel-hand", game: duelTable, now: 3_001 });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.directives, []);
  assert.deepEqual(replay.result, settled.result);

  const bountyTable = game({ handId: "bounty-hand" });
  bountyTable.players[0].hand = ["2s", "7d"];
  bountyTable.players[1].hand = ["Ah", "Ad"];
  const bounty = engineFor(
    { a: "bounty" },
    { handId: "bounty-hand", matchId: "bounty-match" },
  );
  resolveTargetSkill(bounty, "a", "b", bountyTable);
  bountyTable.stage = "finished";
  bountyTable.finishedReason = "showdown";
  bountyTable.community = ["3c", "4d", "8h", "Js", "Kc"];
  bountyTable.players[0].totalCommitted = 300;
  bountyTable.players[1].totalCommitted = 300;
  bountyTable.players[2].folded = true;
  bountyTable.winners = [{ userId: "b", amount: 600, handName: "一对" }];
  const bountySettlement = bounty.finishHand({ handId: "bounty-hand", game: bountyTable, now: 3_000 });
  assert.deepEqual(directiveTypes(bountySettlement), ["bank-credit", "log"]);
  assert.equal(bountySettlement.directives[0].userId, "b");
  assert.equal(bountySettlement.directives[0].amount, 80);
});

test("last-stand and insurance arm on real all-ins and refund bounded poker losses at finish", () => {
  const shortPlayers = [
    {
      userId: "a", username: "A", seat: 0, stack: 300, startingStack: 300,
      hand: ["2c", "7d"], folded: false, allIn: false, bet: 0, totalCommitted: 0,
    },
    {
      userId: "b", username: "B", seat: 1, stack: 2_000, startingStack: 2_000,
      hand: ["As", "Ad"], folded: false, allIn: false, bet: 0, totalCommitted: 0,
    },
    {
      userId: "c", username: "C", seat: 2, stack: 2_000, startingStack: 2_000,
      hand: ["Kh", "Kd"], folded: false, allIn: false, bet: 0, totalCommitted: 0,
    },
  ];
  const standTable = game({ handId: "last-stand-hand", players: shortPlayers });
  const stand = engineFor(
    { a: "last-stand" },
    { handId: "last-stand-hand", matchId: "last-stand-match" },
  );
  const armed = resolveChoiceSkill(stand, "a", {}, standTable);
  assert.equal(armed.result.status, "armed");
  const beforeAllIn = {
    stage: "preflop",
    currentBet: 40,
    players: standTable.players.map((player) => ({ ...player, hand: [...player.hand] })),
  };
  standTable.players[0].stack = 0;
  standTable.players[0].allIn = true;
  standTable.players[0].bet = 300;
  standTable.players[0].totalCommitted = 300;
  stand.afterPokerAction({ actorId: "a", action: "allin", before: beforeAllIn, game: standTable, now: 2_000 });
  assert.equal(stand.exportState().hand.effects.lastStands[0].status, "triggered");
  standTable.stage = "finished";
  standTable.finishedReason = "showdown";
  standTable.community = ["3c", "4d", "8h", "Js", "Qc"];
  standTable.players[2].folded = true;
  standTable.winners = [{ userId: "b", amount: 600, handName: "一对" }];
  const standSettlement = stand.finishHand({ handId: "last-stand-hand", game: standTable, now: 3_000 });
  assert.deepEqual(directiveTypes(standSettlement), ["bank-credit", "log"]);
  assert.equal(standSettlement.directives[0].amount, 75);

  const insuranceTable = game({ handId: "insurance-hand" });
  const insurance = engineFor(
    { a: "insurance" },
    { handId: "insurance-hand", matchId: "insurance-match" },
  );
  const purchased = resolveChoiceSkill(insurance, "a", {}, insuranceTable);
  assert.deepEqual(directiveTypes(purchased), ["charge-bank", "log"]);
  assert.equal(purchased.directives[0].amount, 60);
  // Simulate the room executor collecting the premium before the poker all-in.
  insuranceTable.players[0].stack -= 60;
  const insuranceBefore = {
    stage: "preflop",
    currentBet: 40,
    players: insuranceTable.players.map((player) => ({ ...player, hand: [...player.hand] })),
  };
  insuranceTable.players[0].totalCommitted += insuranceTable.players[0].stack;
  insuranceTable.players[0].bet += insuranceTable.players[0].stack;
  insuranceTable.players[0].stack = 0;
  insuranceTable.players[0].allIn = true;
  insurance.afterPokerAction({ actorId: "a", action: "allin", before: insuranceBefore, game: insuranceTable, now: 2_000 });
  insuranceTable.stage = "finished";
  insuranceTable.finishedReason = "showdown";
  insuranceTable.community = ["2c", "3d", "4h", "8s", "Tc"];
  insuranceTable.players[1].hand = ["Ah", "Ad"];
  insuranceTable.players[2].folded = true;
  insuranceTable.winners = [{ userId: "b", amount: 2_000, handName: "一对" }];
  const insuranceSettlement = insurance.finishHand({ handId: "insurance-hand", game: insuranceTable, now: 3_000 });
  assert.deepEqual(directiveTypes(insuranceSettlement), ["bank-credit", "log"]);
  assert.equal(insuranceSettlement.directives[0].amount, 300);
});

test("check-raise-hunter opens a restorable four-second reaction and reveals privately until hunter acts", () => {
  const table = game({ handId: "hunter-hand", stage: "flop", actingUserId: "b" });
  table.currentBet = 0;
  table.players[1].bet = 0;
  const engine = engineFor(
    { a: "check-raise-hunter", b: "fake-weak" },
    {
      handId: "hunter-hand",
      matchId: "hunter-match",
      stage: "flop",
      rng: { random: () => 0.1, randomInt: () => 0 },
    },
  );
  const beforeCheck = {
    stage: "flop", currentBet: 0, players: table.players.map((player) => ({ ...player, hand: [...player.hand] })),
  };
  engine.afterPokerAction({ actorId: "b", action: "check", before: beforeCheck, game: table, now: 1_200 });
  table.currentBet = 100;
  const beforeRaise = {
    stage: "flop", currentBet: 100, players: table.players.map((player) => ({ ...player, hand: [...player.hand] })),
  };
  table.players[1].bet = 200;
  table.players[1].totalCommitted = 220;
  table.players[1].stack -= 200;
  table.actingUserId = "a";
  const opened = engine.afterPokerAction({ actorId: "b", action: "raise", before: beforeRaise, game: table, now: 1_500 });
  assert.deepEqual(directiveTypes(opened), ["open-reaction", "log"]);
  assert.equal(engine.viewFor("a", table, 1_501).activeReaction.reactionSkillId, "check-raise-hunter");
  assert.equal(engine.viewFor("a", table, 1_501).activeReaction.expiresAt, 5_500);
  const activeState = engine.exportState();
  const timedOut = restoreHextechEffectsEngine(activeState);
  const expired = timedOut.tick({ game: table, now: 5_501 });
  assert.deepEqual(directiveTypes(expired), ["log"]);
  assert.equal(timedOut.exportState().hand.equipments.a.status, "available");
  assert.equal(timedOut.viewFor("a", table, 5_502).activeReaction, null);
  const restored = restoreHextechEffectsEngine(activeState, {
    rng: { random: () => 0.1, randomInt: () => 0 },
  });
  const selected = issue(restored, "a", "react", table, {}, 1_600);
  assert.equal(selected.result.option, "hunt");
  const revealed = issue(restored, "a", "confirm-reaction", table, {}, 1_700);
  assert.deepEqual(directiveTypes(revealed), ["private-reveal", "log"]);
  assert.equal(revealed.directives[0].card, "7c");
  assert.equal(restored.viewFor("a", table, 1_701).privateEffects[0].card, "7c");
  assert.deepEqual(restored.viewFor("c", table, 1_701).privateEffects, []);
  const beforeHunterAction = {
    stage: "flop", currentBet: 100, players: table.players.map((player) => ({ ...player, hand: [...player.hand] })),
  };
  restored.afterPokerAction({ actorId: "a", action: "call", before: beforeHunterAction, game: table, now: 1_800 });
  assert.deepEqual(restored.viewFor("a", table, 1_801).privateEffects, []);
});

test("hand-prediction keeps its choice private and stop-loss settles only qualifying showdown losers", () => {
  const hitTable = game({ handId: "prediction-hit" });
  hitTable.players[0].hand = ["As", "Ad"];
  const hitEngine = engineFor(
    { a: "hand-prediction" },
    { handId: "prediction-hit", matchId: "prediction-hit-match" },
  );
  resolveChoiceSkill(hitEngine, "a", { handCategory: "one-pair" }, hitTable);
  assert.equal(hitEngine.viewFor("a", hitTable).privateEffects[0].handCategory, "one-pair");
  assert.deepEqual(hitEngine.viewFor("b", hitTable).privateEffects, []);
  hitTable.stage = "finished";
  hitTable.finishedReason = "showdown";
  hitTable.community = ["2c", "3d", "4h", "8s", "Tc"];
  hitTable.players[2].folded = true;
  hitTable.winners = [{ userId: "a", amount: 500, handName: "一对" }];
  const hit = hitEngine.finishHand({ handId: "prediction-hit", game: hitTable, now: 3_000 });
  assert.deepEqual(directiveTypes(hit), ["bank-credit", "log"]);
  assert.equal(hit.directives[0].amount, 240);

  const missTable = game({ handId: "prediction-miss" });
  missTable.players[0].hand = ["As", "Ad"];
  const missEngine = engineFor(
    { a: "hand-prediction" },
    { handId: "prediction-miss", matchId: "prediction-miss-match" },
  );
  resolveChoiceSkill(missEngine, "a", { handCategory: "flush" }, missTable);
  missTable.stage = "finished";
  missTable.finishedReason = "showdown";
  missTable.community = ["2c", "3d", "4h", "8s", "Tc"];
  missTable.players[2].folded = true;
  missTable.winners = [{ userId: "a", amount: 500, handName: "一对" }];
  const miss = missEngine.finishHand({ handId: "prediction-miss", game: missTable, now: 3_000 });
  assert.deepEqual(directiveTypes(miss), ["charge-pot", "log"]);
  assert.equal(miss.directives[0].amount, 60);
  assert.equal(miss.directives[0].allowPartial, true);

  const stopTable = game({ handId: "stop-loss-hand" });
  const stop = engineFor(
    { a: "stop-loss" },
    { handId: "stop-loss-hand", matchId: "stop-loss-match" },
  );
  stopTable.stage = "finished";
  stopTable.finishedReason = "showdown";
  stopTable.community = ["2c", "3d", "4h", "8s", "Tc"];
  stopTable.players[0].totalCommitted = 500;
  stopTable.players[1].totalCommitted = 500;
  stopTable.players[2].folded = true;
  stopTable.winners = [{ userId: "b", amount: 1_000, handName: "一对" }];
  const stopped = stop.finishHand({ handId: "stop-loss-hand", game: stopTable, now: 3_000 });
  assert.deepEqual(directiveTypes(stopped), ["bank-credit", "log"]);
  assert.equal(stopped.directives[0].userId, "a");
  assert.equal(stopped.directives[0].amount, 100);
});

test("fixed-deposit returns 180 on an early fold or 230 at the river without double settlement", () => {
  const foldTable = game({ handId: "deposit-fold" });
  const foldEngine = engineFor(
    { a: "fixed-deposit" },
    { handId: "deposit-fold", matchId: "deposit-fold-match" },
  );
  const locked = resolveChoiceSkill(foldEngine, "a", {}, foldTable);
  assert.deepEqual(directiveTypes(locked), ["charge-bank", "log"]);
  assert.equal(locked.directives[0].amount, 200);
  const restored = restoreHextechEffectsEngine(foldEngine.exportState());
  const beforeFold = {
    stage: "preflop", currentBet: 40, players: foldTable.players.map((player) => ({ ...player, hand: [...player.hand] })),
  };
  foldTable.players[0].folded = true;
  const early = restored.afterPokerAction({ actorId: "a", action: "fold", before: beforeFold, game: foldTable, now: 2_000 });
  assert.deepEqual(directiveTypes(early), ["bank-credit", "log"]);
  assert.equal(early.directives[0].amount, 180);
  assert.deepEqual(restored.tick({ game: foldTable, now: 2_100 }).directives, []);
  foldTable.stage = "finished";
  foldTable.finishedReason = "fold";
  foldTable.winners = [{ userId: "b", amount: 60, handName: "其他玩家均已弃牌" }];
  const foldedFinish = restored.finishHand({ handId: "deposit-fold", game: foldTable, now: 3_000 });
  assert.deepEqual(foldedFinish.directives, []);

  const riverTable = game({ handId: "deposit-river" });
  const riverEngine = engineFor(
    { a: "fixed-deposit" },
    { handId: "deposit-river", matchId: "deposit-river-match" },
  );
  resolveChoiceSkill(riverEngine, "a", {}, riverTable);
  riverTable.stage = "turn";
  riverTable.community = ["2c", "3d", "4h", "8s"];
  riverEngine.tick({ game: riverTable, now: 1_900 });
  const beforeRiver = {
    stage: "turn", currentBet: 0, players: riverTable.players.map((player) => ({ ...player, hand: [...player.hand] })),
  };
  riverTable.stage = "river";
  riverTable.community = ["2c", "3d", "4h", "8s", "Tc"];
  const matured = riverEngine.afterPokerAction({ actorId: "b", action: "check", before: beforeRiver, game: riverTable, now: 2_000 });
  assert.deepEqual(directiveTypes(matured), ["bank-credit", "log"]);
  assert.equal(matured.directives[0].amount, 230);
  assert.deepEqual(riverEngine.tick({ game: riverTable, now: 2_100 }).directives, []);
});

test("every emitted directive belongs to the documented finite executor enum", () => {
  assert.deepEqual(IMPLEMENTED_HEXTECH_EFFECT_SKILL_IDS, [
    "fake-weak", "fake-strong", "xray", "mind-read", "public-reveal",
    "charm", "intimidate", "silence", "peace-treaty", "disarm",
    "gambler", "reforge", "prophet", "swap-trick", "river-veto",
    "shield", "mirror", "smoke-bomb", "escape", "catch-cheater",
    "pot-bomb", "raise-cap", "duel-contract", "last-stand", "check-raise-hunter",
    "insurance", "bounty", "hand-prediction", "stop-loss", "fixed-deposit",
  ]);
  const values = new Set(Object.values(HEXTECH_EFFECT_DIRECTIVE_TYPES));
  const declared = new Set(Object.values(HEXTECH_EFFECT_RULES).flatMap(({ directiveTypes }) => directiveTypes));
  for (const type of declared) assert.equal(values.has(type), true, `rule directive ${type}`);
  assert.deepEqual(
    [...values].sort(),
    [
      "bank-credit",
      "bank-pot",
      "blank-hole-card",
      "charge-bank",
      "charge-pot",
      "disable-equipment",
      "force-fold",
      "forced-call",
      "log",
      "mutual-raise-lock",
      "open-reaction",
      "private-reveal",
      "public-reveal",
      "raise-cap",
      "redeal-river",
      "replace-hole-card-random",
      "replace-hole-card-rank",
      "skill-blocked",
      "skill-lock",
      "transfer-chips",
    ],
  );
});
