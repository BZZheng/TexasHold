import assert from "node:assert/strict";
import test from "node:test";
import {
  HEXTECH_CHARACTER_RULES,
  HEXTECH_CHARACTERS,
  HEXTECH_HAND_CATEGORY_CHOICES,
  HEXTECH_RANK_CHOICES,
  HEXTECH_SKILL_RULES,
  HEXTECH_SKILLS,
  HEXTECH_SUIT_CHOICES,
  assertValidHextechRuleContract,
  validateHextechRuleContract,
} from "../shared/hextech.js";

test("machine-readable hextech catalog is complete and internally valid", () => {
  assert.equal(HEXTECH_SKILLS.length, 30);
  assert.equal(HEXTECH_CHARACTERS.length, 8);
  assert.equal(Object.keys(HEXTECH_SKILL_RULES).length, 30);
  assert.equal(Object.keys(HEXTECH_CHARACTER_RULES).length, 8);
  assert.equal(new Set(HEXTECH_SKILLS.map(({ id }) => id)).size, 30);
  assert.equal(new Set(HEXTECH_CHARACTERS.map(({ id }) => id)).size, 8);
  assert.deepEqual(validateHextechRuleContract(), { valid: true, errors: [] });
  assert.equal(assertValidHextechRuleContract(), true);
});

test("each skill publishes server execution fields without replacing UI copy", () => {
  for (const current of HEXTECH_SKILLS) {
    assert.equal(current.rules, HEXTECH_SKILL_RULES[current.id]);
    assert.ok(current.name);
    assert.ok(current.summary);
    assert.ok(["active", "passive", "reaction"].includes(current.rules.activation.kind));
    assert.ok(current.rules.activation.windows.length >= 1);
    assert.ok(Array.isArray(current.rules.activation.legalStreets));
    assert.ok(current.rules.target.type);
    assert.equal(current.rules.usage.scope, "hand");
    assert.equal(current.rules.usage.limit, 1);
    assert.ok(Array.isArray(current.rules.counterplay));
    assert.equal(current.rules.audit.cheat, current.cheat);
  }
});

test("probabilistic skills use normalized authoritative outcomes", () => {
  const probabilistic = HEXTECH_SKILLS.filter(({ rules }) => rules.probabilities.length > 0);
  assert.deepEqual(probabilistic.map(({ id }) => id), ["xray", "gambler"]);
  for (const { rules } of probabilistic) {
    const total = rules.probabilities.reduce((sum, outcome) => sum + outcome.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
  }
  assert.deepEqual(
    HEXTECH_SKILL_RULES.gambler.probabilities.map(({ probability }) => probability),
    [0.3, 0.6, 0.099, 0.001],
  );
});

test("confirmation choices expose complete stable enums", () => {
  const gamblerSteps = HEXTECH_SKILL_RULES.gambler.choiceSchema.steps;
  assert.deepEqual(gamblerSteps.find(({ id }) => id === "holeCardIndex").options, [0, 1]);
  assert.deepEqual(gamblerSteps.find(({ id }) => id === "rank").options, HEXTECH_RANK_CHOICES);
  assert.equal(HEXTECH_RANK_CHOICES.length, 13);
  assert.deepEqual(HEXTECH_SKILL_RULES.prophet.choiceSchema.steps[0].options, HEXTECH_SUIT_CHOICES);
  assert.deepEqual(
    HEXTECH_SKILL_RULES["hand-prediction"].choiceSchema.steps[0].options,
    HEXTECH_HAND_CATEGORY_CHOICES,
  );
  for (const current of HEXTECH_SKILLS.filter(({ kind }) => kind === "confirm-choice")) {
    assert.ok(current.rules.requiresConfirmation);
    assert.ok(current.rules.choiceSchema.steps.length > 0);
  }
});

test("defense, reaction, target and chip-risk contracts are explicit", () => {
  assert.equal(HEXTECH_SKILL_RULES.shield.defense.type, "block");
  assert.equal(HEXTECH_SKILL_RULES.mirror.defense.type, "reflect-or-block");
  assert.equal(HEXTECH_SKILL_RULES["smoke-bomb"].defense.sourceVisibility, "secret");
  assert.equal(HEXTECH_SKILL_RULES.escape.activation.kind, "reaction");
  assert.equal(HEXTECH_SKILL_RULES.escape.maximumChipRisk, 160);
  assert.equal(HEXTECH_SKILL_RULES["public-reveal"].cost.amount, 80);
  assert.equal(HEXTECH_SKILL_RULES["river-veto"].usage.owner, "table");
  assert.ok(HEXTECH_SKILL_RULES.charm.counterplay.includes("escape"));
});

test("all eight characters publish resources, progression and awakening values", () => {
  for (const current of HEXTECH_CHARACTERS) {
    assert.equal(current.rules, HEXTECH_CHARACTER_RULES[current.id]);
    assert.equal(current.resource, current.rules.resource.label);
    assert.ok(current.rules.gain.windows.length > 0);
    assert.ok(current.rules.active.id);
    assert.ok(current.rules.growth.counters.every(({ target }) => target > 0));
    assert.ok(current.rules.awakening.id);
  }
  assert.equal(HEXTECH_CHARACTER_RULES.fenxiang.resource.maximum, 3);
  assert.deepEqual(
    HEXTECH_CHARACTER_RULES.fenxiang.active.rewardTiers.map(({ potRatio, cap }) => [potRatio, cap]),
    [[0.15, 180], [0.25, 300], [0.35, 420]],
  );
  assert.deepEqual(
    HEXTECH_CHARACTER_RULES.xu.gain.conditions,
    {
      countdownRemainingAtMostSeconds: 2,
      excludeAutomaticActions: true,
      actions: ["call", "bet", "raise", "all-in"],
      minimumInvestmentBigBlinds: 1,
    },
  );
  assert.deepEqual(
    HEXTECH_CHARACTER_RULES.xu.growth.counters.map(({ id, target }) => [id, target]),
    [
      ["effectiveLateInvestments", 12],
      ["distinctHandsWithEffectiveLateInvestment", 6],
    ],
  );
  assert.equal(HEXTECH_CHARACTER_RULES.xu.active.opponentSecondsDelta, -15);
  assert.equal(HEXTECH_CHARACTER_RULES.xu.active.minimumOpponentActionSeconds, 30);
  assert.equal(HEXTECH_CHARACTER_RULES.xu.active.selfSecondsDelta, 10);
  assert.equal(HEXTECH_CHARACTER_RULES.xu.awakening.opponentSecondsDelta, -20);
  assert.equal(HEXTECH_CHARACTER_RULES.wengwengwen.resource.maximum, 3);
  assert.equal(HEXTECH_CHARACTER_RULES.wengwengwen.active.cost, 2);
  assert.equal(HEXTECH_CHARACTER_RULES.xu.awakening.selfSecondsDelta, 15);
  assert.equal(HEXTECH_CHARACTER_RULES.ya.growth.counters[0].target, 3);
  assert.deepEqual(HEXTECH_CHARACTER_RULES.ya.active.windows, ["on-self-all-in"]);
  assert.deepEqual(HEXTECH_CHARACTER_RULES.ya.active.legalStreets, ["preflop", "flop"]);
  assert.equal(HEXTECH_CHARACTER_RULES.ya.active.replacementPolicy, "discard-natural-river-and-deal-next-deck-card");
  assert.equal(HEXTECH_CHARACTER_RULES.ya.awakening.activeCost, 1);
  assert.equal(HEXTECH_CHARACTER_RULES.qiwan.active.replacementPolicy, "discard-selected-hole-card-and-deal-deck-top");
  assert.equal(HEXTECH_CHARACTER_RULES.qiwan.awakening.resourceRefund, 1);
  assert.equal(HEXTECH_CHARACTER_RULES.zige.active.interestRatio, 0.1);
  assert.equal(HEXTECH_CHARACTER_RULES.zige.active.principal.step, 100);
  assert.equal(HEXTECH_CHARACTER_RULES.mao.active.responseSeconds, 4);
});

test("validator reports duplicate ids and invalid probability totals", () => {
  const brokenXray = {
    ...HEXTECH_SKILLS.find(({ id }) => id === "xray"),
    rules: {
      ...HEXTECH_SKILL_RULES.xray,
      probabilities: [
        { id: "success", probability: 0.6 },
        { id: "failure", probability: 0.3 },
      ],
    },
  };
  const skills = HEXTECH_SKILLS.map((entry) => entry.id === "xray" ? brokenXray : entry);
  skills[1] = { ...skills[1], id: skills[0].id };
  const result = validateHextechRuleContract({ skills, characters: HEXTECH_CHARACTERS });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes("id 必须唯一")));
  assert.ok(result.errors.some((message) => message.includes("概率和必须为 1")));
});
