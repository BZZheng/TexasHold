import { CHIP_UNIT, snapToChipUnit } from "./chips.js";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeRaiseTarget(value, legal) {
  const minimum = Math.max(CHIP_UNIT, finiteNumber(legal?.minRaiseTo, CHIP_UNIT));
  const maximum = Math.max(minimum, finiteNumber(legal?.maxRaiseTo, minimum));
  const proposed = finiteNumber(value, minimum);
  if (proposed >= maximum) return maximum;
  return Math.min(maximum, Math.max(minimum, snapToChipUnit(proposed)));
}

export function buildRaisePresets({
  legal,
  pot = 0,
  currentBet = 0,
  playerBet = 0,
  bigBlind = CHIP_UNIT * 2,
} = {}) {
  if (!legal) return [];

  const tablePot = Math.max(0, finiteNumber(pot));
  const tableBet = Math.max(0, finiteNumber(currentBet));
  const committed = Math.max(0, finiteNumber(playerBet));
  const blind = Math.max(CHIP_UNIT, finiteNumber(bigBlind, CHIP_UNIT * 2));
  const toCall = Math.max(0, tableBet - committed);
  const potAfterCall = tablePot + toCall;
  const potRaiseTarget = (fraction) => tableBet + potAfterCall * fraction;
  const isThreeBet = tableBet > blind;

  const candidates = [
    { id: "minimum", label: "最低", detail: "合法下限", value: legal.minRaiseTo },
    { id: "half-pot", label: "½ 底池", detail: "标准尺度", value: potRaiseTarget(0.5) },
    { id: "two-thirds-pot", label: "⅔ 底池", detail: "持续施压", value: potRaiseTarget(2 / 3) },
    { id: "pot", label: "1Bet", detail: "1× 底池", value: potRaiseTarget(1) },
    {
      id: "three-bet",
      label: "3Bet",
      detail: isThreeBet ? "当前下注×3" : "开池至 3BB",
      value: (isThreeBet ? tableBet : blind) * 3,
    },
    { id: "all-in", label: "全押", detail: "最大筹码", value: legal.maxRaiseTo },
  ];

  return candidates.map((preset) => {
    const value = normalizeRaiseTarget(preset.value, legal);
    return { ...preset, value };
  });
}
