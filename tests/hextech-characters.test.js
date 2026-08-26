import assert from "node:assert/strict";
import test from "node:test";
import {
  HEXTECH_CHARACTER_COMMANDS,
  HEXTECH_CHARACTER_DIRECTIVES,
  createHextechCharacterEngine,
  restoreHextechCharacterEngine,
} from "../server/hextech-characters.js";

function begin(engine, handNumber, stacks) {
  return engine.beginHand({
    eventId: `begin-${handNumber}`,
    handNumber,
    players: Object.entries(stacks).map(([userId, startingStack]) => ({ userId, startingStack })),
  });
}

function character(engine, userId) {
  return engine.viewFor(userId).characters.find((entry) => entry.userId === userId);
}

test("character engine exports, restores and ignores duplicate authoritative hooks", () => {
  const engine = createHextechCharacterEngine({
    players: [
      { userId: "fen", characterId: "fenxiang" },
      { userId: "xu", characterId: "xu" },
    ],
  });
  const first = begin(engine, 1, { fen: 500, xu: 1500 });
  assert.equal(first.stateChanged, true);
  const action = engine.afterPokerAction({
    eventId: "game-action-1",
    handNumber: 1,
    userId: "fen",
    action: "call",
    street: "preflop",
    callAmount: 40,
    bigBlind: 40,
  });
  assert.equal(action.duplicate, false);
  const duplicate = engine.afterPokerAction({
    eventId: "game-action-1",
    handNumber: 1,
    userId: "fen",
    action: "call",
    street: "preflop",
    callAmount: 40,
    bigBlind: 40,
  });
  assert.deepEqual(duplicate.directives, []);
  assert.equal(duplicate.duplicate, true);
  assert.equal(character(engine, "fen").resource, 1);

  const restored = restoreHextechCharacterEngine(JSON.parse(JSON.stringify(engine.export())));
  assert.deepEqual(restored.export(), engine.export());
  assert.equal(restored.viewFor("fen").eventSeq, engine.viewFor("fen").eventSeq);
});

test("legacy Xu growth counters migrate without losing persisted progress", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "xu", characterId: "xu" },
    { userId: "other", characterId: "fenxiang" },
  ] });
  begin(engine, 1, { xu: 1500, other: 1500 });
  const snapshot = engine.export();
  snapshot.players.xu.progress = {
    lateValidActions: 8,
    distinctHandsWithLateAction: 3,
  };
  snapshot.players.xu.progressMeta.xuHands = [1, 2, 3];

  const restored = restoreHextechCharacterEngine(snapshot);
  const xu = character(restored, "xu");
  assert.equal(xu.progress.effectiveLateInvestments, 8);
  assert.equal(xu.progress.distinctHandsWithEffectiveLateInvestment, 3);
  assert.equal(Object.hasOwn(xu.progress, "lateValidActions"), false);
  assert.equal(Object.hasOwn(xu.progress, "distinctHandsWithLateAction"), false);
});

test("Fenxiang gains once per hand, pays resource, awards by stack ratio and awakens", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "fen", characterId: "fenxiang" },
    { userId: "big", characterId: "xu" },
  ] });

  let finalSettlement;
  for (let handNumber = 1; handNumber <= 3; handNumber += 1) {
    begin(engine, handNumber, { fen: 500, big: 2000 });
    engine.afterPokerAction({
      eventId: `fen-call-${handNumber}`,
      handNumber,
      userId: "fen",
      action: "call",
      street: "preflop",
      callAmount: 40,
      bigBlind: 40,
    });
    engine.afterPokerAction({
      eventId: `fen-call-again-${handNumber}`,
      handNumber,
      userId: "fen",
      action: "call",
      street: "flop",
      callAmount: 200,
      bigBlind: 40,
    });
    if (handNumber === 3) {
      engine.command({
        commandId: "fen-activate",
        handNumber,
        type: HEXTECH_CHARACTER_COMMANDS.FENXIANG_ACTIVATE,
        userId: "fen",
      });
    }
    finalSettlement = engine.settleHand({
      eventId: `settle-${handNumber}`,
      handNumber,
      results: [
        { userId: "fen", endingStack: 1500, wonPotAmount: 1000, opponentsBeaten: ["big"] },
        { userId: "big", endingStack: 1000 },
      ],
    });
  }

  const fen = character(engine, "fen");
  assert.equal(fen.resource, 0);
  assert.equal(fen.progress.largeOpponentPotsWon, 3);
  assert.equal(fen.awakened, true);
  const award = finalSettlement.directives.find(({ type }) => type === HEXTECH_CHARACTER_DIRECTIVES.BANK_AWARD);
  assert.equal(award.amount, 350);
  assert.equal(award.potRatio, 0.35);
  assert.equal(engine.settleHand({ eventId: "settle-3", handNumber: 3, results: [] }).duplicate, true);
});

test("Xu only counts manual last-two-second investments of at least one big blind", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "xu", characterId: "xu" },
    { userId: "other", characterId: "fenxiang" },
  ] });
  begin(engine, 1, { xu: 1500, other: 1500 });
  const rejected = [
    { action: "check", delta: 0, automatic: false },
    { action: "fold", delta: 0, automatic: false },
    { action: "call", delta: 20, automatic: false },
    { action: "call", delta: 40, automatic: true },
    { action: "raise", delta: 80, automatic: false, secondsRemaining: 0 },
  ];
  rejected.forEach((input, index) => {
    engine.afterPokerAction({
      eventId: `xu-rejected-${index}`,
      handNumber: 1,
      userId: "xu",
      street: "preflop",
      secondsRemaining: 1.5,
      bigBlind: 40,
      ...input,
    });
  });
  assert.equal(character(engine, "xu").resource, 0);
  assert.equal(character(engine, "xu").progress.effectiveLateInvestments, 0);

  engine.afterPokerAction({
    eventId: "xu-qualified-call",
    handNumber: 1,
    userId: "xu",
    action: "call",
    street: "preflop",
    secondsRemaining: 2,
    automatic: false,
    delta: 40,
    bigBlind: 40,
  });
  engine.afterPokerAction({
    eventId: "xu-qualified-same-street-raise",
    handNumber: 1,
    userId: "xu",
    action: "raise",
    street: "preflop",
    secondsRemaining: 1,
    automatic: false,
    delta: 80,
    bigBlind: 40,
  });
  assert.equal(character(engine, "xu").resource, 1, "each street grants at most one coal");
  assert.equal(
    character(engine, "xu").progress.effectiveLateInvestments,
    1,
    "a same-street betting exchange cannot farm awakening progress",
  );
  assert.equal(character(engine, "xu").progress.distinctHandsWithEffectiveLateInvestment, 1);
});

test("Xu normal barbecue affects every opponent and uses the new clock directive fields", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "xu", characterId: "xu" },
    { userId: "other", characterId: "fenxiang" },
  ] });
  for (let handNumber = 1; handNumber <= 2; handNumber += 1) {
    begin(engine, handNumber, { xu: 1500, other: 1500 });
    for (const street of ["preflop", "flop"]) {
      engine.afterPokerAction({
        eventId: `xu-normal-${handNumber}-${street}`,
        handNumber,
        userId: "xu",
        action: "call",
        street,
        secondsRemaining: 1,
        automatic: false,
        delta: 40,
        bigBlind: 40,
      });
    }
  }
  const outcome = engine.command({
    commandId: "xu-normal-bbq",
    handNumber: 2,
    type: HEXTECH_CHARACTER_COMMANDS.XU_BARBECUE,
    userId: "xu",
    street: "flop",
  });
  assert.deepEqual(outcome.directives.map(({ type }) => type), [
    HEXTECH_CHARACTER_DIRECTIVES.MODIFY_NEXT_STREET_CLOCK,
  ]);
  assert.equal(outcome.directives[0].opponentSecondsDelta, -15);
  assert.equal(outcome.directives[0].minimumOpponentActionSeconds, 30);
  assert.equal(outcome.directives[0].selfSecondsDelta, 10);
  assert.equal(outcome.directives[0].targetPolicy, "all-opponents-still-in-hand");
  assert.equal(Object.hasOwn(outcome.directives[0], "opponentsAfterCasterSecondsDelta"), false);
});

test("Xu awakens only after twelve effective investments across six hands and upgrades barbecue", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "xu", characterId: "xu" },
    { userId: "other", characterId: "fenxiang" },
  ] });
  for (let handNumber = 1; handNumber <= 6; handNumber += 1) {
    begin(engine, handNumber, { xu: 1500, other: 1500 });
    for (const street of ["preflop", "flop"]) {
      engine.afterPokerAction({
        eventId: `xu-growth-${handNumber}-${street}`,
        handNumber,
        userId: "xu",
        action: street === "preflop" ? "bet" : "all-in",
        street,
        secondsRemaining: 1.5,
        automatic: false,
        delta: 40,
        bigBlind: 40,
      });
      if (handNumber === 6 && street === "preflop") {
        assert.equal(character(engine, "xu").awakened, false);
      }
    }
    if (handNumber === 5) {
      assert.equal(character(engine, "xu").progress.effectiveLateInvestments, 10);
      assert.equal(character(engine, "xu").progress.distinctHandsWithEffectiveLateInvestment, 5);
      assert.equal(character(engine, "xu").awakened, false);
    }
  }
  const xu = character(engine, "xu");
  assert.equal(xu.progress.effectiveLateInvestments, 12);
  assert.equal(xu.progress.distinctHandsWithEffectiveLateInvestment, 6);
  assert.equal(xu.awakened, true);
  assert.equal(xu.resource, 4);

  const outcome = engine.command({
    commandId: "xu-awakened-bbq",
    handNumber: 6,
    type: HEXTECH_CHARACTER_COMMANDS.XU_BARBECUE,
    userId: "xu",
    street: "flop",
  });
  assert.deepEqual(outcome.directives.map(({ type }) => type), [
    HEXTECH_CHARACTER_DIRECTIVES.MODIFY_NEXT_STREET_CLOCK,
    HEXTECH_CHARACTER_DIRECTIVES.BANK_TO_POT,
  ]);
  assert.equal(outcome.directives[0].opponentSecondsDelta, -20);
  assert.equal(outcome.directives[0].minimumOpponentActionSeconds, 30);
  assert.equal(outcome.directives[0].selfSecondsDelta, 15);
  assert.equal(outcome.directives[1].amount, 80);
});

test("Jiansheng applies authoritative raise caps and awakens after three distinct targets plus a win", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "jian", characterId: "jiansheng" },
    { userId: "a", characterId: "fenxiang" },
    { userId: "b", characterId: "xu" },
    { userId: "c", characterId: "ya" },
  ] });
  for (const [index, targetUserId] of ["a", "b", "c"].entries()) {
    const handNumber = index + 1;
    begin(engine, handNumber, { jian: 1000, a: 1000, b: 1000, c: 1000 });
    engine.afterPokerAction({
      eventId: `jian-raise-${handNumber}`,
      handNumber,
      userId: "jian",
      action: "raise",
      street: "flop",
      activePlayerCount: 4,
    });
    const pressure = engine.command({
      commandId: `jian-pressure-${handNumber}`,
      handNumber,
      type: HEXTECH_CHARACTER_COMMANDS.JIANSHENG_PRESSURE,
      userId: "jian",
      targetUserId,
      casterStreetCommitted: 160,
    });
    assert.equal(pressure.directives[0].type, HEXTECH_CHARACTER_DIRECTIVES.CAP_NEXT_RAISE_TOTAL);
    assert.equal(pressure.directives[0].maximumRaiseTotal, 160);
    engine.settleHand({
      eventId: `jian-settle-${handNumber}`,
      handNumber,
      results: [{
        userId: "jian",
        wonPotAmount: handNumber === 1 ? 500 : 0,
        opponentsBeaten: handNumber === 1 ? [targetUserId] : [],
      }],
    });
  }
  const jian = character(engine, "jian");
  assert.equal(jian.progress.distinctPlayersAffected, 3);
  assert.equal(jian.progress.affectedPotsWon, 1);
  assert.equal(jian.awakened, true);
});

test("Zige loans transfer only after acceptance, repay principal plus interest and awaken after three settlements", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "banker", characterId: "zige", chips: 3000 },
    { userId: "borrower", characterId: "fenxiang", chips: 1000 },
  ] });
  let lastRepayment;
  for (let handNumber = 1; handNumber <= 3; handNumber += 1) {
    begin(engine, handNumber, { banker: 3000, borrower: 1000 });
    engine.command({
      commandId: `offer-${handNumber}`,
      handNumber,
      type: HEXTECH_CHARACTER_COMMANDS.ZIGE_OFFER_LOAN,
      userId: "banker",
      borrowerUserId: "borrower",
      principal: 200,
      lenderAvailableStack: 3000,
      now: handNumber * 1000,
    });
    const loan = engine.viewFor("banker", { now: handNumber * 1000 }).loans.at(-1);
    const accepted = engine.command({
      commandId: `accept-${handNumber}`,
      handNumber,
      type: HEXTECH_CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN,
      userId: "borrower",
      loanId: loan.loanId,
      accept: true,
      lenderAvailableStack: 3000,
      now: handNumber * 1000 + 100,
    });
    assert.equal(accepted.directives[0].amount, 200);
    assert.equal(accepted.directives[0].allowPartial, false);
    lastRepayment = engine.command({
      commandId: `repay-${handNumber}`,
      handNumber,
      type: HEXTECH_CHARACTER_COMMANDS.ZIGE_REPAY_LOAN,
      userId: "borrower",
      loanId: loan.loanId,
      borrowerAvailableStack: 1220,
    });
    assert.equal(lastRepayment.directives[0].amount, 220);
    assert.equal(lastRepayment.directives[0].allowPartial, false);
    engine.settleHand({ eventId: `bank-settle-${handNumber}`, handNumber, results: [] });
  }
  const banker = character(engine, "banker");
  assert.equal(banker.progress.loansSettledNormally, 3);
  assert.equal(banker.awakened, true);
  assert.ok(lastRepayment.directives.some(({ type, amount }) => type === HEXTECH_CHARACTER_DIRECTIVES.BANK_AWARD && amount === 30));
  assert.ok(engine.viewFor("banker").loans.every(({ state, outstanding }) => state === "repaid" && outstanding === 0));
});

test("overdue Zige debt never makes a stack negative and takes twenty percent of later net wins", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "banker", characterId: "zige", chips: 1000 },
    { userId: "borrower", characterId: "fenxiang", chips: 0 },
  ] });
  begin(engine, 1, { banker: 1000, borrower: 0 });
  engine.command({
    commandId: "late-offer",
    handNumber: 1,
    type: HEXTECH_CHARACTER_COMMANDS.ZIGE_OFFER_LOAN,
    userId: "banker",
    borrowerUserId: "borrower",
    principal: 200,
    now: 1000,
  });
  const loanId = engine.viewFor("banker", { now: 1000 }).loans[0].loanId;
  engine.command({
    commandId: "late-accept",
    handNumber: 1,
    type: HEXTECH_CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN,
    userId: "borrower",
    loanId,
    accept: true,
    now: 1100,
  });
  engine.settleHand({ eventId: "late-settle-1", handNumber: 1, results: [{ userId: "borrower", endingStack: 0 }] });
  for (let handNumber = 2; handNumber <= 4; handNumber += 1) {
    begin(engine, handNumber, { banker: 800, borrower: 0 });
    engine.settleHand({ eventId: `late-settle-${handNumber}`, handNumber, results: [{ userId: "borrower", endingStack: 0 }] });
  }
  assert.equal(engine.viewFor("borrower").loans[0].state, "overdue");
  begin(engine, 5, { banker: 800, borrower: 500 });
  const collection = engine.settleHand({
    eventId: "late-settle-5",
    handNumber: 5,
    results: [{ userId: "borrower", endingStack: 500, netWin: 500 }],
  });
  const payment = collection.directives.find(({ reason }) => reason === "zige.loan-repayment.overdue-net-win");
  assert.equal(payment.amount, 100);
  assert.equal(character(engine, "borrower").availableStack, 400);
  assert.equal(engine.viewFor("borrower").loans[0].outstanding, 120);
});

test("Ya requires an early aggressive all-in showdown and never exposes a river candidate", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "ya", characterId: "ya" },
    { userId: "other", characterId: "fenxiang" },
  ] });

  begin(engine, 1, { ya: 1000, other: 1000 });
  engine.afterPokerAction({
    eventId: "ya-call-allin",
    handNumber: 1,
    userId: "ya",
    action: "all-in",
    street: "preflop",
    isRaise: false,
    isAllInAfter: true,
  });
  engine.settleHand({
    eventId: "ya-call-allin-settle",
    handNumber: 1,
    results: [{ userId: "ya", wonPotAmount: 500, reachedShowdown: true }],
  });
  assert.equal(character(engine, "ya").resource, 0);

  begin(engine, 2, { ya: 1000, other: 1000 });
  engine.afterPokerAction({
    eventId: "ya-folded-to",
    handNumber: 2,
    userId: "ya",
    action: "all-in",
    street: "flop",
    isRaise: true,
    isAllInAfter: true,
  });
  engine.settleHand({
    eventId: "ya-folded-to-settle",
    handNumber: 2,
    results: [{ userId: "ya", wonPotAmount: 500, reachedShowdown: false }],
  });
  assert.equal(character(engine, "ya").resource, 0);

  for (let handNumber = 3; handNumber <= 5; handNumber += 1) {
    begin(engine, handNumber, { ya: 1000, other: 1000 });
    engine.afterPokerAction({
      eventId: `ya-allin-${handNumber}`,
      handNumber,
      userId: "ya",
      action: "all-in",
      street: "preflop",
      isRaise: true,
      isAllInAfter: true,
    });
    engine.settleHand({
      eventId: `ya-settle-${handNumber}`,
      handNumber,
      results: [{ userId: "ya", wonPotAmount: handNumber === 3 ? 500 : 0, reachedShowdown: true }],
    });
  }
  assert.equal(character(engine, "ya").awakened, true);
  assert.equal(character(engine, "ya").progress.earlyAggressiveAllInsReachingShowdown, 3);
  assert.equal(character(engine, "ya").progress.earlyAggressiveAllInShowdownWins, 1);

  begin(engine, 6, { ya: 1000, other: 1000 });
  engine.afterPokerAction({
    eventId: "ya-allin-6",
    handNumber: 6,
    userId: "ya",
    action: "all-in",
    street: "flop",
    isRaise: true,
    isAllInAfter: true,
  });
  const activation = engine.command({
    commandId: "ya-activate",
    handNumber: 6,
    type: HEXTECH_CHARACTER_COMMANDS.YA_ACTIVATE,
    userId: "ya",
    street: "flop",
    casterAllIn: true,
    riverDealt: false,
  });
  assert.equal(activation.directives[0].type, HEXTECH_CHARACTER_DIRECTIVES.REPLACE_UPCOMING_RIVER);
  assert.equal(Object.hasOwn(activation.directives[0], "cardId"), false);
  assert.equal(Object.hasOwn(activation.directives[0], "candidateCardIds"), false);
  assert.equal(character(engine, "ya").window, null);
  assert.equal(character(engine, "ya").resource, 1);
});

test("Qiwan selects only a hole-card index and emits no replacement-card candidate", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "qi", characterId: "qiwan" },
    { userId: "caller", characterId: "fenxiang" },
  ] });
  for (let handNumber = 1; handNumber <= 2; handNumber += 1) {
    begin(engine, handNumber, { qi: 1000, caller: 1000 });
    engine.afterPokerAction({
      eventId: `qi-raise-${handNumber}`,
      handNumber,
      userId: "qi",
      action: "raise",
      street: "preflop",
      raiseTo: 160,
      bigBlind: 40,
    });
    engine.afterPokerAction({
      eventId: `qi-call-${handNumber}`,
      handNumber,
      userId: "caller",
      action: "call",
      street: "preflop",
      calledRaiseUserId: "qi",
    });
    if (handNumber === 1) engine.settleHand({ eventId: "qi-settle-1", handNumber, results: [] });
  }
  const activation = engine.command({
    commandId: "qi-activate",
    handNumber: 2,
    type: HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE,
    userId: "qi",
    street: "preflop",
    casterAllIn: true,
    flopDealt: false,
    holeCardIndex: 1,
  });
  assert.equal(activation.directives[0].type, HEXTECH_CHARACTER_DIRECTIVES.REPLACE_HOLE_CARD);
  assert.equal(activation.directives[0].holeCardIndex, 1);
  assert.equal(Object.hasOwn(activation.directives[0], "replacementCardId"), false);
  assert.equal(Object.hasOwn(activation.directives[0], "candidateCardIds"), false);
  assert.equal(character(engine, "qi").window, null);
  assert.equal(character(engine, "qi").progress.replacementsCompleted, 1);
});

test("Qiwan inspiration echo refunds one resource only for an awakened winning best-five replacement", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "qi", characterId: "qiwan" },
    { userId: "caller", characterId: "fenxiang" },
  ] });
  engine.state.players.qi.awakened = true;
  engine.state.players.qi.resource = 2;
  begin(engine, 1, { qi: 1000, caller: 1000 });
  engine.command({
    commandId: "echo-activate",
    handNumber: 1,
    type: HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE,
    userId: "qi",
    street: "preflop",
    casterAllIn: true,
    flopDealt: false,
    holeCardIndex: 0,
  });
  assert.equal(character(engine, "qi").resource, 0);
  const settlement = engine.settleHand({
    eventId: "echo-settle",
    handNumber: 1,
    results: [{ userId: "qi", wonPotAmount: 500, replacementUsedInFinalHand: true }],
  });
  assert.equal(character(engine, "qi").resource, 1);
  assert.ok(settlement.events.some(({ type, payload }) => (
    type === "character.resource.gained" && payload.reason === "qiwan.inspiration-echo"
  )));
});

test("legacy Ya and Qiwan candidate windows restore without exposing candidates and resolve to top-deck directives", () => {
  const source = createHextechCharacterEngine({ players: [
    { userId: "ya", characterId: "ya" },
    { userId: "qi", characterId: "qiwan" },
  ] });
  begin(source, 1, { ya: 1000, qi: 1000 });
  const snapshot = source.export();
  snapshot.players.ya.hand.yaEarlyAllIn = true;
  snapshot.players.ya.window = {
    windowId: "legacy-ya-window",
    ownerUserId: "ya",
    type: "ya-river-choice",
    state: "armed",
    candidateCardIds: ["As", "Kh", "Qc"],
    expiresAt: 100,
  };
  snapshot.players.qi.window = {
    windowId: "legacy-qi-window",
    ownerUserId: "qi",
    type: "qiwan-card-swap",
    state: "armed",
    candidateCardIds: ["2s", "3h", "4c"],
    preselectedHoleCardIndex: 1,
    expiresAt: 100,
  };
  snapshot.eventLog.push({
    eventSeq: ++snapshot.eventSeq,
    type: "character.choice.armed",
    payload: {
      type: "ya-river-choice",
      candidateCardIds: ["As", "Kh", "Qc"],
    },
  });
  const restored = restoreHextechCharacterEngine(snapshot);
  assert.equal(character(restored, "ya").window.candidateCardIds, undefined);
  assert.equal(character(restored, "qi").window.candidateCardIds, undefined);
  assert.equal(JSON.stringify(restored.viewFor("ya")).includes("candidateCardIds"), false);
  const outcome = restored.tick({ now: 101 });
  assert.deepEqual(outcome.directives.map(({ type }) => type).sort(), [
    HEXTECH_CHARACTER_DIRECTIVES.REPLACE_HOLE_CARD,
    HEXTECH_CHARACTER_DIRECTIVES.REPLACE_UPCOMING_RIVER,
  ].sort());
  assert.ok(outcome.directives.every((directive) => !Object.hasOwn(directive, "cardId")));
  assert.equal(character(restored, "ya").window, null);
  assert.equal(character(restored, "qi").window, null);
});

test("internal Mao resolution cannot be shadowed by a colliding client receipt and replays once", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "mao", characterId: "mao" },
    { userId: "challenger", characterId: "fenxiang" },
  ] });
  begin(engine, 1, { mao: 1000, challenger: 1000 });
  engine.command({
    commandId: "collision-mao-claim",
    handNumber: 1,
    type: HEXTECH_CHARACTER_COMMANDS.MAO_CLAIM,
    userId: "mao",
    street: "turn",
    suit: "spades",
    now: 1000,
  });
  const windowId = character(engine, "mao").window.windowId;
  const challengeInput = {
    handNumber: 1,
    type: HEXTECH_CHARACTER_COMMANDS.MAO_CHALLENGE,
    userId: "challenger",
    windowId,
    now: 2000,
  };
  const probe = restoreHextechCharacterEngine(engine.export());
  const probedDirective = probe.command({ ...challengeInput, commandId: "probe-mao-challenge" }).directives[0];
  const collidingCommandId = `resolve:${probedDirective.directiveId}`;
  const challenged = engine.command({ ...challengeInput, commandId: collidingCommandId });
  assert.equal(challenged.directives[0].directiveId, probedDirective.directiveId);

  const resolutionInput = {
    commandId: collidingCommandId,
    handNumber: 1,
    type: HEXTECH_CHARACTER_COMMANDS.INTERNAL_RESOLVE_MAO_CHALLENGE,
    trusted: true,
    windowId,
    naturalCardId: "As",
    naturalSuit: "spades",
  };
  const resolved = engine.command(resolutionInput);
  assert.equal(resolved.duplicate, false);
  assert.equal(resolved.directives[0].type, HEXTECH_CHARACTER_DIRECTIVES.PAY_TO_POT);
  assert.equal(character(engine, "mao").window, null);
  const eventSeq = engine.viewFor("mao").eventSeq;
  const replay = engine.command(resolutionInput);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.directives, []);
  assert.equal(engine.viewFor("mao").eventSeq, eventSeq);
});

test("Mao supports first-challenger resolution, unchallenged suit directives and awakening progress", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "mao", characterId: "mao" },
    { userId: "challenger", characterId: "fenxiang" },
  ] });
  for (let handNumber = 1; handNumber <= 2; handNumber += 1) {
    begin(engine, handNumber, { mao: 1000, challenger: 1000 });
    engine.command({
      commandId: `mao-claim-${handNumber}`,
      handNumber,
      type: HEXTECH_CHARACTER_COMMANDS.MAO_CLAIM,
      userId: "mao",
      street: handNumber === 1 ? "turn" : "river",
      suit: "hearts",
      now: handNumber * 1000,
    });
    const windowId = character(engine, "mao").window.windowId;
    const expired = engine.tick({ eventId: `mao-tick-${handNumber}`, now: handNumber * 1000 + 4000 });
    assert.equal(expired.directives[0].type, HEXTECH_CHARACTER_DIRECTIVES.DEAL_NEXT_SUIT_CARD);
    assert.equal(expired.directives[0].suit, "hearts");
    engine.settleHand({ eventId: `mao-settle-${handNumber}`, handNumber, results: [] });
    assert.ok(windowId);
  }
  begin(engine, 3, { mao: 1000, challenger: 1000 });
  engine.command({
    commandId: "mao-claim-3",
    handNumber: 3,
    type: HEXTECH_CHARACTER_COMMANDS.MAO_CLAIM,
    userId: "mao",
    street: "turn",
    suit: "spades",
    now: 5000,
  });
  const windowId = character(engine, "mao").window.windowId;
  const challenged = engine.command({
    commandId: "mao-challenge",
    handNumber: 3,
    type: HEXTECH_CHARACTER_COMMANDS.MAO_CHALLENGE,
    userId: "challenger",
    windowId,
    now: 6000,
  });
  assert.equal(challenged.directives[0].type, HEXTECH_CHARACTER_DIRECTIVES.REVEAL_NATURAL_BOARD_CARD);
  const resolved = engine.command({
    commandId: "mao-resolve",
    handNumber: 3,
    type: HEXTECH_CHARACTER_COMMANDS.INTERNAL_RESOLVE_MAO_CHALLENGE,
    trusted: true,
    windowId,
    naturalCardId: "As",
    naturalSuit: "spades",
  });
  assert.equal(resolved.directives[0].type, HEXTECH_CHARACTER_DIRECTIVES.PAY_TO_POT);
  const mao = character(engine, "mao");
  assert.equal(mao.progress.unchallengedClaimsResolved, 2);
  assert.equal(mao.progress.correctChallengedClaims, 1);
  assert.equal(mao.resource, 1);
  assert.equal(mao.awakened, true);
});

test("Wengwengwen tracks manual pursuits, keeps the random reveal private and refunds an awakened full raise", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "weng", characterId: "wengwengwen" },
    { userId: "target", characterId: "fenxiang" },
  ] });

  for (let handNumber = 1; handNumber <= 5; handNumber += 1) {
    const street = handNumber === 4 ? "turn" : "flop";
    begin(engine, handNumber, { weng: 2000, target: 2000 });
    engine.afterPokerAction({
      eventId: `weng-target-raise-${handNumber}`,
      handNumber,
      userId: "target",
      action: "raise",
      street,
      delta: 80,
      bigBlind: 40,
      isRaise: true,
    });
    engine.afterPokerAction({
      eventId: `weng-call-${handNumber}`,
      handNumber,
      userId: "weng",
      action: "call",
      street,
      delta: 80,
      bigBlind: 40,
      toCallBefore: 80,
    });
    engine.settleHand({
      eventId: `weng-settle-${handNumber}`,
      handNumber,
      results: [{
        userId: "weng",
        endingStack: 2000,
        reachedShowdown: handNumber === 5,
        wonPotAmount: handNumber === 5 ? 320 : 0,
        opponentsBeaten: handNumber === 5 ? ["target"] : [],
      }],
    });
  }

  assert.equal(character(engine, "weng").awakened, true);
  assert.deepEqual(character(engine, "weng").progress, {
    distinctHuntHands: 5,
    turnHunts: 1,
    showdownWinsAgainstAggressor: 1,
  });

  begin(engine, 6, { weng: 2000, target: 2000 });
  engine.afterPokerAction({
    eventId: "weng-target-raise-6",
    handNumber: 6,
    userId: "target",
    action: "raise",
    street: "flop",
    delta: 80,
    bigBlind: 40,
    isRaise: true,
  });
  const activation = engine.command({
    commandId: "weng-hunt-6",
    handNumber: 6,
    type: HEXTECH_CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE,
    userId: "weng",
    street: "flop",
    isOwnAction: true,
    toCall: 80,
    targetUserId: "target",
    displayedCards: ["7c", "2d"],
    masked: true,
  });
  assert.equal(activation.duplicate, false);
  assert.equal(engine.command({
    commandId: "weng-hunt-6",
    handNumber: 6,
    type: HEXTECH_CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE,
    userId: "weng",
  }).duplicate, true);
  assert.ok(["7c", "2d"].includes(character(engine, "weng").reveal.cardId));
  assert.equal(engine.viewFor("target").characters.find(({ userId }) => userId === "weng").reveal, null);
  assert.equal(engine.viewFor("target").events.some(({ payload }) => payload?.cardId), false);
  assert.equal(Object.hasOwn(character(engine, "weng").reveal, "masked"), false);
  assert.equal(engine.exportState().players.weng.hand.wengReveal.masked, true);

  engine.afterPokerAction({
    eventId: "weng-full-raise-6",
    handNumber: 6,
    userId: "weng",
    action: "raise",
    street: "flop",
    delta: 120,
    bigBlind: 40,
    toCallBefore: 80,
    isRaise: true,
    isFullRaise: true,
  });
  assert.equal(character(engine, "weng").resource, 3, "refund and the once-per-hand pursuit both respect the cap");
  const restored = restoreHextechCharacterEngine(engine.exportState());
  assert.equal(character(restored, "weng").awakened, true);
  assert.equal(restored.viewFor("target").characters.find(({ userId }) => userId === "weng").reveal, null);
});

test("loan offers expire without consuming the hand active or moving chips", () => {
  const engine = createHextechCharacterEngine({ players: [
    { userId: "banker", characterId: "zige", chips: 1000 },
    { userId: "borrower", characterId: "fenxiang", chips: 1000 },
  ] });
  begin(engine, 1, { banker: 1000, borrower: 1000 });
  engine.command({
    commandId: "expiring-offer",
    handNumber: 1,
    type: HEXTECH_CHARACTER_COMMANDS.ZIGE_OFFER_LOAN,
    userId: "banker",
    borrowerUserId: "borrower",
    principal: 600,
    now: 1000,
  });
  const outcome = engine.tick({ eventId: "expire-offer", now: 11000 });
  assert.deepEqual(outcome.directives, []);
  assert.equal(engine.viewFor("banker").loans[0].state, "rejected");
  assert.equal(engine.viewFor("banker").loans[0].resolution, "expired");
  assert.equal(character(engine, "banker").activeUsed, false);
  assert.equal(character(engine, "banker").availableStack, 1000);
});
