import assert from "node:assert/strict";
import test from "node:test";
import { buildRaisePresets, normalizeRaiseTarget } from "../shared/betting.js";

test("tournament raise presets include call-adjusted pot fractions and a three-bet", () => {
  const presets = buildRaisePresets({
    legal: { minRaiseTo: 80, maxRaiseTo: 500 },
    pot: 120,
    currentBet: 40,
    playerBet: 20,
    bigBlind: 10,
  });
  const byId = new Map(presets.map((preset) => [preset.id, preset]));

  assert.equal(byId.get("half-pot").value, 110);
  assert.equal(byId.get("two-thirds-pot").value, 135);
  assert.equal(byId.get("pot").value, 180);
  assert.equal(byId.get("three-bet").value, 120);
  assert.equal(byId.get("three-bet").label, "3Bet");
  assert.equal(byId.get("all-in").value, 500);
  assert.ok(presets.every(({ value }) => value >= 80 && value <= 500 && value % 5 === 0));
});

test("an unopened pot keeps every tournament shortcut visible after chip-unit rounding", () => {
  const presets = buildRaisePresets({
    legal: { minRaiseTo: 20, maxRaiseTo: 35 },
    pot: 15,
    currentBet: 10,
    playerBet: 0,
    bigBlind: 10,
  });

  assert.deepEqual(
    presets.find(({ id }) => id === "three-bet"),
    { id: "three-bet", label: "3Bet", detail: "开池至 3BB", value: 30 },
  );
  assert.deepEqual(presets.map(({ id }) => id), [
    "minimum",
    "half-pot",
    "two-thirds-pot",
    "pot",
    "three-bet",
    "all-in",
  ]);
  assert.deepEqual(presets.map(({ value }) => value), [20, 25, 25, 35, 30, 35]);
});

test("manual raise targets stay within the authoritative legal range", () => {
  const legal = { minRaiseTo: 80, maxRaiseTo: 500 };

  assert.equal(normalizeRaiseTarget(77, legal), 80);
  assert.equal(normalizeRaiseTarget(113, legal), 115);
  assert.equal(normalizeRaiseTarget(900, legal), 500);
});
