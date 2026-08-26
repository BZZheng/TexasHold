export const HOLE_CARD_DEAL_TIMING = Object.freeze({
  startDelayMs: 160,
  cardGapMs: 190,
  roundPauseMs: 300,
  flightMs: 720,
  settleMs: 180,
});

function clockwiseDistance(seat, buttonSeat) {
  const distance = (seat - buttonSeat + 8) % 8;
  return distance === 0 ? 8 : distance;
}

export function holeCardDealOrder(players = [], buttonSeat = 0) {
  return players
    .filter((player) => Number.isSafeInteger(player?.seat) && player.seat >= 0 && player.seat <= 7)
    .map((player) => player.seat)
    .sort((left, right) => clockwiseDistance(left, buttonSeat) - clockwiseDistance(right, buttonSeat));
}

export function holeCardDealDelayMs(orderIndex, roundIndex, playerCount) {
  const count = Math.max(2, Math.min(8, Number(playerCount) || 2));
  const order = Math.max(0, Math.min(count - 1, Number(orderIndex) || 0));
  const round = roundIndex === 1 ? 1 : 0;
  const { startDelayMs, cardGapMs, roundPauseMs } = HOLE_CARD_DEAL_TIMING;
  return startDelayMs
    + order * cardGapMs
    + round * (count * cardGapMs + roundPauseMs);
}

export function holeCardDealDurationMs(playerCount) {
  const count = Math.max(2, Math.min(8, Number(playerCount) || 2));
  const { flightMs, settleMs } = HOLE_CARD_DEAL_TIMING;
  return holeCardDealDelayMs(count - 1, 1, count) + flightMs + settleMs;
}
