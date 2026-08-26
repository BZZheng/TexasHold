export const CHIP_DENOMINATIONS = Object.freeze([1000, 500, 250, 100, 50, 20, 10, 5]);
export const CHIP_UNIT = CHIP_DENOMINATIONS.at(-1);
export const LOW_STACK_REBUY_THRESHOLD = 500;

export function isStandardChipAmount(value, { allowZero = true } = {}) {
  return Number.isSafeInteger(value)
    && (allowZero ? value >= 0 : value > 0)
    && value % CHIP_UNIT === 0;
}

export function snapToChipUnit(value, mode = "nearest") {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const scaled = number / CHIP_UNIT;
  const rounded = mode === "down"
    ? Math.floor(scaled)
    : mode === "up"
      ? Math.ceil(scaled)
      : Math.round(scaled);
  return rounded * CHIP_UNIT;
}

export function chipBreakdown(amount) {
  const total = Number.isFinite(Number(amount))
    ? Math.max(0, Math.trunc(Number(amount)))
    : 0;
  let remaining = total;
  const chips = CHIP_DENOMINATIONS.flatMap((value) => {
    const count = Math.floor(remaining / value);
    remaining -= count * value;
    return count ? [{ value, count }] : [];
  });

  return {
    chips,
    remainder: remaining,
    representedAmount: total - remaining,
  };
}
