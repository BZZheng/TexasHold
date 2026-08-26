import assert from "node:assert/strict";
import test from "node:test";
import {
  HOLE_CARD_DEAL_TIMING,
  holeCardDealDelayMs,
  holeCardDealDurationMs,
  holeCardDealOrder,
} from "../shared/dealing.js";

test("hole cards travel clockwise from the seat left of the dealer across sparse seats", () => {
  const players = [0, 2, 5, 7].map((seat) => ({ seat }));
  assert.deepEqual(holeCardDealOrder(players, 5), [7, 0, 2, 5]);
  assert.deepEqual(holeCardDealOrder(players, 7), [0, 2, 5, 7]);
});

test("the second hole-card lap waits until the complete first lap has finished", () => {
  const playerCount = 4;
  const firstLap = Array.from({ length: playerCount }, (_, order) => holeCardDealDelayMs(order, 0, playerCount));
  const secondLap = Array.from({ length: playerCount }, (_, order) => holeCardDealDelayMs(order, 1, playerCount));

  assert.equal(firstLap[1] - firstLap[0], HOLE_CARD_DEAL_TIMING.cardGapMs);
  assert.equal(secondLap[1] - secondLap[0], HOLE_CARD_DEAL_TIMING.cardGapMs);
  assert.equal(
    secondLap[0] - firstLap.at(-1),
    HOLE_CARD_DEAL_TIMING.cardGapMs + HOLE_CARD_DEAL_TIMING.roundPauseMs,
  );
  assert.equal(
    holeCardDealDurationMs(playerCount),
    secondLap.at(-1) + HOLE_CARD_DEAL_TIMING.flightMs + HOLE_CARD_DEAL_TIMING.settleMs,
  );
});

test("an eight-player opening deal remains deliberate without exceeding five seconds", () => {
  const duration = holeCardDealDurationMs(8);
  assert.ok(duration >= 4_000);
  assert.ok(duration < 5_000);
});
