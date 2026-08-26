import assert from "node:assert/strict";
import test from "node:test";
import {
  CHIP_DENOMINATIONS,
  CHIP_UNIT,
  chipBreakdown,
  isStandardChipAmount,
  snapToChipUnit,
} from "../shared/chips.js";

test("chip breakdown only emits the eight approved denominations", () => {
  const exact = chipBreakdown(2135);

  assert.deepEqual(exact.chips, [
    { value: 1000, count: 2 },
    { value: 100, count: 1 },
    { value: 20, count: 1 },
    { value: 10, count: 1 },
    { value: 5, count: 1 },
  ]);
  assert.equal(exact.remainder, 0);
  assert.equal(exact.representedAmount, 2135);
  assert.ok(exact.chips.every(({ value }) => CHIP_DENOMINATIONS.includes(value)));
});

test("a legacy remainder is reported but never fabricated as a chip", () => {
  const legacy = chipBreakdown(2139);

  assert.equal(legacy.remainder, 4);
  assert.equal(legacy.representedAmount, 2135);
  assert.equal(legacy.chips.some(({ value }) => value === 4), false);
});

test("chip amounts and manual raises use the five-point table unit", () => {
  assert.equal(CHIP_UNIT, 5);
  assert.equal(isStandardChipAmount(240), true);
  assert.equal(isStandardChipAmount(239), false);
  assert.equal(snapToChipUnit(239), 240);
});
