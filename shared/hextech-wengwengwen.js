import { HEXTECH_CHARACTER_VOICE_LINES } from "./hextech-character-voice-lines.js";

export const WENGWENGWEN_RULES_VERSION = 1;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const WENGWENGWEN_COMMANDS = Object.freeze({
  ACTIVATE_HUNT: "wengwengwen:activate-hunt",
});

export const WENGWENGWEN_EVENTS = Object.freeze({
  RESOURCE_GAINED: "character.wengwengwen.resource-gained",
  HUNT_ACTIVATED: "character.wengwengwen.hunt-activated",
  PRIVATE_CARD_REVEALED: "character.wengwengwen.private-card-revealed",
  FULL_MOON_REFUND: "character.wengwengwen.full-moon-refund",
  AWAKENED: "character.wengwengwen.awakened",
});

export const WENGWENGWEN_RULES = deepFreeze({
  resource: {
    id: "moon-mark",
    label: "月痕",
    initial: 0,
    maximum: 3,
    visibility: "public",
  },
  gain: {
    id: "moon-chase",
    windows: ["after-manual-chase"],
    perScope: "hand",
    limit: 1,
    legalStreets: ["flop", "turn"],
    validActions: ["call", "raise", "all-in"],
    perHandLimit: 1,
    amount: 1,
    minimumAggressorInvestmentBigBlinds: 2,
    minimumSelfInvestmentBigBlinds: 2,
    requiresVoluntaryAggressor: true,
    excludesAutomaticActions: true,
  },
  active: {
    id: "eclipse-hunt",
    windows: ["before-action"],
    legalStreets: ["flop", "turn"],
    window: "before-own-action-facing-voluntary-aggressor",
    cost: 2,
    perHandLimit: 1,
    target: "latest-voluntary-aggressor",
    targetContract: {
      type: "opponent",
      minimum: 1,
      maximum: 1,
      filters: ["active-in-hand", "latest-voluntary-aggressor", "has-hole-cards"],
    },
    usage: { scope: "hand", owner: "player", limit: 1 },
    reveal: {
      cardCount: 1,
      selection: "server-random",
      visibility: "owner-private",
      duration: "street",
      usesDisplayedCardMask: true,
      realCardsRemainServerOnly: true,
    },
    requiresConfirmation: true,
    irreversible: true,
  },
  growth: {
    counters: [
      { id: "distinctHuntHands", label: "不同手牌追刃", target: 5 },
      { id: "turnHunts", label: "转牌圈追刃", target: 1 },
      { id: "showdownWinsAgainstAggressor", label: "摊牌击败进攻者", target: 1 },
    ],
    allRequired: true,
  },
  awakening: {
    id: "full-moon-twin-blades",
    resourceRefund: 1,
    refundTrigger: "immediate-next-action-is-full-raise",
    minimumRaiseInvestmentBigBlinds: 2,
    perHandLimit: 1,
    resourceMaximumStillApplies: true,
  },
  counterplay: {
    fakeWeakAndStrongMaskReveal: true,
    maskUseCountsAsCheatUse: true,
    spectatorVisibilityDoesNotAffectSkill: true,
  },
});

export const WENGWENGWEN_VOICE_LINES = HEXTECH_CHARACTER_VOICE_LINES.wengwengwen;

export const WENGWENGWEN_CHARACTER = deepFreeze({
  id: "wengwengwen",
  name: "嗡嗡文",
  title: "月刃行者",
  role: "信息追猎",
  resource: "月痕",
  summary: "追击翻牌后的主动进攻者，以一张私密牌面判断是否完成双刃加注。",
  passive: "翻牌或转牌面对至少 2BB 的主动进攻，并手动投入至少 2BB 跟注或加注；每手首次获得 1 月痕。",
  active: "消耗 2 月痕，随机私密查看当前进攻者的一张展示底牌；伪装技能可能使结果失真。",
  growth: "在 5 手牌完成追刃，其中至少 1 次发生在转牌圈，并在摊牌击败 1 名被追击的进攻者。",
  awaken: "满月双刃：查看后立即完成至少 2BB 的完整加注，返还 1 月痕。",
  voiceLines: WENGWENGWEN_VOICE_LINES,
  rules: WENGWENGWEN_RULES,
});

export function validateWengwengwenRules() {
  const errors = [];
  const rules = WENGWENGWEN_RULES;
  if (rules.resource.initial < 0 || rules.resource.initial > rules.resource.maximum) {
    errors.push("月痕初始值必须位于资源上限内");
  }
  if (rules.active.cost >= rules.resource.maximum) {
    errors.push("主动消耗必须低于月痕上限，避免发动后资源永远归零");
  }
  if (rules.gain.perHandLimit !== 1 || rules.active.perHandLimit !== 1) {
    errors.push("资源获取与人物主动均必须保持每手一次");
  }
  if (rules.active.reveal.cardCount !== 1 || rules.active.reveal.selection !== "server-random") {
    errors.push("月蚀追猎只能由服务端随机展示一张牌");
  }
  if (!rules.growth.counters.every(({ target }) => Number.isSafeInteger(target) && target > 0)) {
    errors.push("成长目标必须是正整数");
  }
  return errors;
}

export function assertValidWengwengwenRules() {
  const errors = validateWengwengwenRules();
  if (errors.length) throw new Error(errors.join("；"));
  return true;
}
