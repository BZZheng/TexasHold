import crypto from "node:crypto";
import pokerSolver from "pokersolver";
import { CHIP_UNIT, snapToChipUnit } from "../shared/chips.js";
import { hextechSkill, isHextechSkillId } from "../shared/hextech.js";

const { Hand } = pokerSolver;

const EFFECT_STATE_VERSION = 1;
const REACTION_WINDOW_MS = 4_000;
const PUBLIC_REVEAL_MS = 4_000;
const STREET_START_WINDOW_MS = 4_000;
const MAX_EVENT_HISTORY = 120;
const MAX_RECEIPTS = 80;
const ACTIVE_STAGES = new Set(["preflop", "flop", "turn", "river"]);
const HAND_CATEGORY_BY_SOLVER_NAME = Object.freeze({
  "High Card": "high-card",
  Pair: "one-pair",
  "Two Pair": "two-pair",
  "Three of a Kind": "three-of-a-kind",
  Straight: "straight",
  Flush: "flush",
  "Full House": "full-house",
  "Four of a Kind": "four-of-a-kind",
  "Straight Flush": "straight-flush",
  "Royal Flush": "straight-flush",
});

export const HEXTECH_SKILL_WINDOW_STATES = Object.freeze([
  "idle",
  "armed",
  "targeting",
  "confirming",
  "resolving",
  "consumed",
]);

export const HEXTECH_EFFECT_DIRECTIVE_TYPES = Object.freeze({
  PRIVATE_REVEAL: "private-reveal",
  PUBLIC_REVEAL: "public-reveal",
  CHARGE_POT: "charge-pot",
  CHARGE_BANK: "charge-bank",
  BANK_CREDIT: "bank-credit",
  BANK_POT: "bank-pot",
  DISABLE_EQUIPMENT: "disable-equipment",
  RAISE_CAP: "raise-cap",
  SKILL_LOCK: "skill-lock",
  MUTUAL_RAISE_LOCK: "mutual-raise-lock",
  FORCED_CALL: "forced-call",
  OPEN_REACTION: "open-reaction",
  SKILL_BLOCKED: "skill-blocked",
  REPLACE_HOLE_CARD_RANDOM: "replace-hole-card-random",
  REPLACE_HOLE_CARD_RANK: "replace-hole-card-rank",
  BLANK_HOLE_CARD: "blank-hole-card",
  REDEAL_RIVER: "redeal-river",
  TRANSFER_CHIPS: "transfer-chips",
  FORCE_FOLD: "force-fold",
  LOG: "log",
});

export const IMPLEMENTED_HEXTECH_EFFECT_SKILL_IDS = Object.freeze([
  "fake-weak",
  "fake-strong",
  "xray",
  "mind-read",
  "public-reveal",
  "charm",
  "intimidate",
  "silence",
  "peace-treaty",
  "disarm",
  "gambler",
  "reforge",
  "prophet",
  "swap-trick",
  "river-veto",
  "shield",
  "mirror",
  "smoke-bomb",
  "escape",
  "catch-cheater",
  "pot-bomb",
  "raise-cap",
  "duel-contract",
  "last-stand",
  "check-raise-hunter",
  "insurance",
  "bounty",
  "hand-prediction",
  "stop-loss",
  "fixed-deposit",
]);

const IMPLEMENTED_SKILL_IDS = new Set(IMPLEMENTED_HEXTECH_EFFECT_SKILL_IDS);
const PASSIVE_SKILL_IDS = new Set(["fake-weak", "fake-strong", "shield", "mirror", "smoke-bomb", "stop-loss"]);
const REACTION_SKILL_IDS = new Set(["escape", "check-raise-hunter"]);

const rule = ({ timing, target, chipRisk = 0, counterplay = [], directiveTypes = [] }) => Object.freeze({
  timing,
  target,
  chipRisk,
  counterplay: Object.freeze([...counterplay]),
  directiveTypes: Object.freeze([...directiveTypes]),
});

/**
 * Server execution metadata for the production public-skill catalog. UI copy continues
 * to live in shared/hextech.js; these records describe authority and adapter
 * requirements, not presentation.
 */
export const HEXTECH_EFFECT_RULES = Object.freeze({
  "fake-weak": rule({ timing: "successful-hole-card-view", target: "self", directiveTypes: ["private-reveal", "public-reveal"] }),
  "fake-strong": rule({ timing: "successful-hole-card-view", target: "self", directiveTypes: ["private-reveal", "public-reveal"] }),
  xray: rule({
    timing: "action-before",
    target: "active-opponent",
    counterplay: ["技能护盾", "反弹镜", "烟雾弹"],
    directiveTypes: ["private-reveal", "skill-blocked", "log"],
  }),
  "mind-read": rule({
    timing: "action-before",
    target: "active-opponent",
    counterplay: ["技能护盾", "反弹镜"],
    directiveTypes: ["private-reveal", "skill-blocked", "log"],
  }),
  "public-reveal": rule({
    timing: "postflop-action-before",
    target: "active-opponent",
    chipRisk: 80,
    counterplay: ["技能护盾", "反弹镜", "烟雾弹"],
    directiveTypes: ["charge-pot", "public-reveal", "skill-blocked", "log"],
  }),
  charm: rule({
    timing: "arm-before-own-all-in",
    target: "callable-opponent",
    counterplay: ["技能护盾", "反弹镜", "金蝉脱壳"],
    directiveTypes: ["forced-call", "open-reaction", "skill-blocked", "log"],
  }),
  intimidate: rule({
    timing: "action-before",
    target: "raise-capable-opponent",
    counterplay: ["技能护盾", "反弹镜"],
    directiveTypes: ["raise-cap", "skill-blocked", "log"],
  }),
  silence: rule({
    timing: "street-start",
    target: "active-opponent",
    counterplay: ["技能护盾", "反弹镜"],
    directiveTypes: ["skill-lock", "skill-blocked", "log"],
  }),
  "peace-treaty": rule({
    timing: "action-before",
    target: "active-opponent",
    counterplay: ["技能护盾", "反弹镜"],
    directiveTypes: ["mutual-raise-lock", "skill-blocked", "log"],
  }),
  disarm: rule({
    timing: "preflop-action-before",
    target: "unused-active-equipment-opponent",
    counterplay: ["技能护盾", "反弹镜"],
    directiveTypes: ["disable-equipment", "bank-credit", "skill-blocked", "log"],
  }),
  gambler: rule({
    timing: "preflop-action-before",
    target: "own-hole-card-and-rank",
    counterplay: [],
    directiveTypes: ["replace-hole-card-rank", "blank-hole-card", "log"],
  }),
  reforge: rule({
    timing: "preflop-action-before",
    target: "own-hole-card",
    counterplay: [],
    directiveTypes: ["replace-hole-card-random", "log"],
  }),
  prophet: rule({
    timing: "preflop-action-before",
    target: "self-and-suit",
    chipRisk: 80,
    counterplay: [],
    directiveTypes: ["charge-pot", "bank-credit", "log"],
  }),
  "swap-trick": rule({
    timing: "before-turn-board-deal",
    target: "own-hole-card",
    counterplay: [],
    directiveTypes: ["replace-hole-card-random", "log"],
  }),
  "river-veto": rule({
    timing: "after-river-deal",
    target: "table",
    chipRisk: 120,
    counterplay: [],
    directiveTypes: ["charge-bank", "redeal-river", "log"],
  }),
  shield: rule({
    timing: "passive-targeted-skill",
    target: "self",
    directiveTypes: ["skill-blocked", "log"],
  }),
  mirror: rule({
    timing: "passive-targeted-skill",
    target: "self",
    directiveTypes: ["skill-blocked", "log"],
  }),
  "smoke-bomb": rule({
    timing: "passive-hole-card-view",
    target: "self",
    directiveTypes: ["skill-blocked", "log"],
  }),
  escape: rule({
    timing: "forced-call-reaction",
    target: "self",
    chipRisk: 160,
    directiveTypes: ["charge-bank", "open-reaction", "forced-call", "log"],
  }),
  "catch-cheater": rule({
    timing: "pre-river-action-before",
    target: "active-opponent",
    chipRisk: 100,
    counterplay: ["技能护盾", "反弹镜"],
    directiveTypes: ["transfer-chips", "force-fold", "skill-blocked", "log"],
  }),
  "pot-bomb": rule({
    timing: "preflop-action-before",
    target: "table",
    directiveTypes: ["bank-pot", "log"],
  }),
  "raise-cap": rule({
    timing: "street-start",
    target: "all-active-players",
    directiveTypes: ["raise-cap", "log"],
  }),
  "duel-contract": rule({
    timing: "preflop-action-before",
    target: "active-opponent",
    counterplay: ["技能护盾", "反弹镜"],
    directiveTypes: ["bank-credit", "skill-blocked", "log"],
  }),
  "last-stand": rule({
    timing: "before-own-all-in",
    target: "self",
    directiveTypes: ["bank-credit", "log"],
  }),
  "check-raise-hunter": rule({
    timing: "check-raise-reaction",
    target: "check-raiser",
    counterplay: ["技能护盾", "反弹镜", "烟雾弹"],
    directiveTypes: ["private-reveal", "open-reaction", "skill-blocked", "log"],
  }),
  insurance: rule({
    timing: "preflop-action-before",
    target: "self",
    chipRisk: 60,
    directiveTypes: ["charge-bank", "bank-credit", "log"],
  }),
  bounty: rule({
    timing: "preflop-action-before",
    target: "active-opponent",
    counterplay: ["技能护盾", "反弹镜"],
    directiveTypes: ["bank-credit", "skill-blocked", "log"],
  }),
  "hand-prediction": rule({
    timing: "preflop-action-before",
    target: "self-and-hand-category",
    chipRisk: 60,
    directiveTypes: ["charge-pot", "bank-credit", "log"],
  }),
  "stop-loss": rule({
    timing: "showdown-passive",
    target: "self",
    directiveTypes: ["bank-credit", "log"],
  }),
  "fixed-deposit": rule({
    timing: "preflop-action-before",
    target: "self",
    chipRisk: 200,
    directiveTypes: ["charge-bank", "bank-credit", "log"],
  }),
});

export class HextechEffectError extends Error {
  constructor(message, code = "invalid_hextech_effect") {
    super(message);
    this.name = "HextechEffectError";
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function uniqueStrings(values, maximum = 8) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0 && value.length <= 80))]
    .slice(0, maximum);
}

function token() {
  return crypto.randomBytes(18).toString("base64url");
}

function effectId() {
  return crypto.randomUUID();
}

function commandIdFrom(payload = {}) {
  const commandId = payload.commandId;
  if (typeof commandId !== "string" || commandId.length < 1 || commandId.length > 128) {
    throw new HextechEffectError("技能命令标识不正确", "invalid_hextech_command_id");
  }
  return commandId;
}

function equipmentEntries(equipmentByUserId) {
  if (equipmentByUserId instanceof Map) return [...equipmentByUserId.entries()];
  if (Array.isArray(equipmentByUserId)) {
    return equipmentByUserId.map((entry) => [entry.userId, entry.skillId]);
  }
  if (equipmentByUserId && typeof equipmentByUserId === "object") {
    return Object.entries(equipmentByUserId);
  }
  return [];
}

function makeWindow(skillId, { state, disabledReason = null, expiresAt = null } = {}) {
  const initialState = state
    ?? (PASSIVE_SKILL_IDS.has(skillId) ? "armed" : "idle");
  const unavailableReason = !IMPLEMENTED_SKILL_IDS.has(skillId)
    && !PASSIVE_SKILL_IDS.has(skillId)
    && !REACTION_SKILL_IDS.has(skillId)
    ? "该技能效果尚未接入当前服务端批次"
    : disabledReason;
  return {
    skillId,
    state: initialState,
    validTargetUserIds: [],
    maximumChipRisk: HEXTECH_EFFECT_RULES[skillId]?.chipRisk ?? 0,
    counterplayLabels: [...(HEXTECH_EFFECT_RULES[skillId]?.counterplay ?? [])],
    expiresAt,
    disabledReason: unavailableReason
      ?? (REACTION_SKILL_IDS.has(skillId) ? "等待合法反应窗口" : null),
    token: token(),
    version: 1,
    pendingTargetUserId: null,
    pendingReactionOption: null,
  };
}

function freshMatchState({ matchId = crypto.randomUUID(), participantUserIds = [] } = {}) {
  const participants = uniqueStrings(participantUserIds);
  if (typeof matchId !== "string" || matchId.length < 1 || matchId.length > 100) {
    throw new HextechEffectError("海克斯对局标识不正确", "invalid_hextech_match_id");
  }
  return {
    version: EFFECT_STATE_VERSION,
    matchId,
    participantUserIds: participants,
    eventSeq: 0,
    completedHandIds: [],
    completedHandReceipts: {},
    hand: null,
  };
}

function assertRestorableState(value) {
  if (!value || value.version !== EFFECT_STATE_VERSION || typeof value.matchId !== "string") {
    throw new HextechEffectError("海克斯效果状态格式不正确", "invalid_hextech_effect_state");
  }
  if (!Number.isSafeInteger(value.eventSeq) || value.eventSeq < 0) {
    throw new HextechEffectError("海克斯事件序号不正确", "invalid_hextech_event_seq");
  }
  if (value.hand != null) {
    if (typeof value.hand.handId !== "string" || !value.hand.equipments || !value.hand.windows) {
      throw new HextechEffectError("海克斯手牌效果状态不完整", "invalid_hextech_hand_state");
    }
    for (const [userId, equipment] of Object.entries(value.hand.equipments)) {
      const window = value.hand.windows[userId];
      if (!isHextechSkillId(equipment?.skillId)
        || !window
        || window.skillId !== equipment.skillId
        || !HEXTECH_SKILL_WINDOW_STATES.includes(window.state)
        || typeof window.token !== "string"
        || !Number.isSafeInteger(window.version)) {
        throw new HextechEffectError("海克斯装备状态无法恢复", "invalid_hextech_equipment_state");
      }
    }
  }
}

function playerList(game) {
  if (!game || !Array.isArray(game.players)) {
    throw new HextechEffectError("服务端牌局上下文缺失", "missing_server_game");
  }
  return game.players;
}

function playerFor(game, userId) {
  const snapshot = typeof game.playerSnapshot === "function"
    ? game.playerSnapshot(userId)
    : playerList(game).find((candidate) => candidate.userId === userId);
  return snapshot ? { ...snapshot, hand: undefined } : null;
}

function privateCardsFor(game, userId) {
  const cards = typeof game.privateCardsFor === "function"
    ? game.privateCardsFor(userId)
    : playerList(game).find((candidate) => candidate.userId === userId)?.hand;
  if (!Array.isArray(cards) || cards.length !== 2 || cards.some((card) => typeof card !== "string")) {
    throw new HextechEffectError("服务端底牌数据缺失", "missing_server_hole_cards");
  }
  return [...cards];
}

function actingUserId(game) {
  if (game.currentPlayer?.userId) return game.currentPlayer.userId;
  const actingSeat = game.actingSeat;
  return playerList(game).find((player) => player.seat === actingSeat)?.userId ?? null;
}

function snapshotPlayer(before, userId) {
  if (!before) return null;
  if (typeof before.playerSnapshot === "function") return before.playerSnapshot(userId);
  return Array.isArray(before.players)
    ? before.players.find((candidate) => candidate.userId === userId) ?? null
    : null;
}

function potFor(game) {
  if (Number.isFinite(game?.pot)) return Number(game.pot);
  return playerList(game).reduce((sum, player) => sum + Number(player.totalCommitted ?? 0), 0)
    + Number(game?.bonusPot ?? 0);
}

function settledPotFor(game) {
  if (game?.stage === "finished" && Array.isArray(game.winners)) {
    return game.winners.reduce((sum, winner) => sum + Number(winner.amount ?? 0), 0);
  }
  return potFor(game);
}

function roundDownChips(value) {
  return Math.max(0, snapToChipUnit(value, "down"));
}

function isPassiveCatalogSkill(skillId) {
  return hextechSkill(skillId)?.kind === "passive";
}

function isReactionCatalogSkill(skillId) {
  return hextechSkill(skillId)?.kind === "reaction";
}

function targetTypeFor(skillId) {
  return hextechSkill(skillId)?.rules?.target?.type ?? "none";
}

function requiresOpponentTarget(skillId) {
  return targetTypeFor(skillId) === "opponent";
}

function choiceStepsFor(skillId) {
  const steps = hextechSkill(skillId)?.rules?.choiceSchema?.steps;
  return Array.isArray(steps) ? steps : [];
}

function ensureCurrentHandShape(state) {
  state.completedHandReceipts ??= {};
  const hand = state.hand;
  if (!hand) return;
  hand.effects ??= {};
  hand.effects.privateViews ??= [];
  hand.effects.externalHoleCardViews ??= [];
  hand.effects.publicReveals ??= [];
  hand.effects.intimidations ??= [];
  hand.effects.silences ??= [];
  hand.effects.peaceTreaties ??= [];
  hand.effects.forcedCalls ??= [];
  hand.effects.disarms ??= [];
  hand.effects.predictions ??= [];
  hand.effects.cheatAudits ??= [];
  hand.effects.potBombs ??= [];
  hand.effects.globalRaiseCaps ??= [];
  hand.effects.duelContracts ??= [];
  hand.effects.lastStands ??= [];
  hand.effects.insurances ??= [];
  hand.effects.bounties ??= [];
  hand.effects.handPredictions ??= [];
  hand.effects.fixedDeposits ??= [];
  hand.effects.cheatUsageByUserId ??= {};
  if (!("riverVetoUsedByUserId" in hand.effects)) hand.effects.riverVetoUsedByUserId = null;
  hand.actionMemory ??= { checkedStreetsByUserId: {}, checkRaiseSeenByUserId: {} };
  hand.actionMemory.checkedStreetsByUserId ??= {};
  hand.actionMemory.checkRaiseSeenByUserId ??= {};
  hand.reactionQueue ??= [];
}

function visibleEvent(event, userId) {
  return event.visibility === "public"
    || (Array.isArray(event.userIds) && event.userIds.includes(userId));
}

function normalizeRng(rng) {
  if (typeof rng === "function") return { random: rng, randomInt: null };
  if (rng && typeof rng.random === "function") {
    return {
      random: rng.random.bind(rng),
      randomInt: typeof rng.randomInt === "function" ? rng.randomInt.bind(rng) : null,
    };
  }
  return {
    random: () => crypto.randomInt(2 ** 48) / (2 ** 48),
    randomInt: (maximum) => crypto.randomInt(maximum),
  };
}

export class HextechEffectsEngine {
  constructor({ state = null, rng = null, clock = () => Date.now() } = {}) {
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.rng = normalizeRng(rng);
    this.state = state ? clone(state) : freshMatchState();
    assertRestorableState(this.state);
    // Version 1 states created before the second public-skill batch remain
    // restorable; the newly introduced collections have neutral defaults.
    ensureCurrentHandShape(this.state);
  }

  static create(options = {}) {
    const { matchId, participantUserIds, ...runtime } = options;
    return new HextechEffectsEngine({
      ...runtime,
      state: freshMatchState({ matchId, participantUserIds }),
    });
  }

  static restore(state, options = {}) {
    const { rotateWindowTokens = true, ...runtime } = options;
    const engine = new HextechEffectsEngine({ ...runtime, state });
    // A process restart is a new authority epoch. Rotate every private window
    // capability so a command captured before restart cannot be replayed after
    // reconnect, while keeping the gameplay state and event sequence intact.
    if (rotateWindowTokens && engine.state.hand) {
      for (const window of Object.values(engine.state.hand.windows)) {
        window.token = token();
        window.version += 1;
      }
    }
    return engine;
  }

  exportState() {
    return clone(this.state);
  }

  beginHand({ handId, players, equipmentByUserId, stage = "preflop", now = this.clock() }) {
    if (this.state.hand) throw new HextechEffectError("上一手海克斯效果尚未结束", "hextech_hand_already_active");
    if (typeof handId !== "string" || handId.length < 1 || handId.length > 100) {
      throw new HextechEffectError("手牌标识不正确", "invalid_hextech_hand_id");
    }
    if (!ACTIVE_STAGES.has(stage)) throw new HextechEffectError("手牌阶段不正确", "invalid_hextech_stage");
    const userIds = uniqueStrings(
      Array.isArray(players) ? players.map((player) => (typeof player === "string" ? player : player?.userId)) : [],
    );
    if (userIds.length < 2 || userIds.length !== players.length) {
      throw new HextechEffectError("海克斯手牌玩家不正确", "invalid_hextech_hand_players");
    }
    const equipment = {};
    const windows = {};
    const entries = equipmentEntries(equipmentByUserId);
    if (entries.length !== userIds.length) {
      throw new HextechEffectError("每名手牌玩家必须且只能装备一个技能", "invalid_hextech_equipment_list");
    }
    for (const [rawUserId, skillId] of entries) {
      const userId = String(rawUserId);
      if (!userIds.includes(userId) || !isHextechSkillId(skillId) || equipment[userId]) {
        throw new HextechEffectError("海克斯装备清单不正确", "invalid_hextech_equipment_list");
      }
      equipment[userId] = {
        skillId,
        status: "available",
        usedAtSeq: null,
        disabledByUserId: null,
      };
      windows[userId] = makeWindow(skillId);
    }
    if (Object.keys(equipment).length !== userIds.length) {
      throw new HextechEffectError("每名手牌玩家必须且只能装备一个技能", "invalid_hextech_equipment_list");
    }
    this.state.hand = {
      handId,
      playerUserIds: userIds,
      stage,
      streetStartedAt: now,
      equipments: equipment,
      windows,
      effects: {
        privateViews: [],
        externalHoleCardViews: [],
        publicReveals: [],
        intimidations: [],
        silences: [],
        peaceTreaties: [],
        forcedCalls: [],
        disarms: [],
        predictions: [],
        cheatAudits: [],
        potBombs: [],
        globalRaiseCaps: [],
        duelContracts: [],
        lastStands: [],
        insurances: [],
        bounties: [],
        handPredictions: [],
        fixedDeposits: [],
        cheatUsageByUserId: {},
        riverVetoUsedByUserId: null,
      },
      behaviorByUserId: Object.fromEntries(userIds.map((userId) => [userId, {
        folds: 0,
        checks: 0,
        calls: 0,
        raises: 0,
      }])),
      activeReaction: null,
      reactionQueue: [],
      actionMemory: {
        checkedStreetsByUserId: {},
        checkRaiseSeenByUserId: {},
      },
      events: [],
      receipts: {},
    };
    this.#event("hand-began", { handId, stage }, { visibility: "public" }, now);
    return this.exportState().hand;
  }

  finishHand({ handId = this.state.hand?.handId, game, now = this.clock() } = {}) {
    if (typeof handId !== "string" || !handId) {
      throw new HextechEffectError("手牌标识不正确", "invalid_hextech_hand_id");
    }
    const completedReceipt = this.state.completedHandReceipts?.[handId];
    if (completedReceipt && this.state.hand?.handId !== handId) {
      return {
        ok: true,
        replayed: true,
        eventSeq: this.state.eventSeq,
        acceptedEventSeq: completedReceipt.acceptedEventSeq,
        result: clone(completedReceipt.result),
        directives: [],
        events: [],
        finishedHand: null,
      };
    }
    if (!this.state.hand) {
      throw new HextechEffectError("当前没有进行中的海克斯手牌", "no_active_hextech_hand");
    }
    const hand = this.#hand();
    if (hand.handId !== handId) throw new HextechEffectError("手牌标识已过期", "stale_hextech_hand");
    this.#assertGameHand(game);
    if (game.stage !== "finished") {
      throw new HextechEffectError("牌局尚未完成，不能结算海克斯效果", "hextech_hand_not_finished");
    }
    const firstSeq = this.state.eventSeq;
    const directives = [
      ...this.#advanceStage(game, now),
      ...this.#settleFinishedHand(game, now),
    ];
    const settlements = hand.events
      .filter((event) => event.seq > firstSeq && event.type.endsWith("-settled"))
      .map((event) => ({ type: event.type, ...clone(event.payload) }));
    this.#event("hand-finished", { handId, settlementCount: settlements.length }, { visibility: "public" }, now);
    const result = { status: "finished", handId, settlements };
    const events = hand.events.filter((event) => event.seq > firstSeq).map(clone);
    const finishedHand = clone(hand);
    this.state.completedHandIds = [...this.state.completedHandIds, handId].slice(-30);
    this.state.completedHandReceipts[handId] = {
      acceptedEventSeq: this.state.eventSeq,
      result: clone(result),
    };
    for (const receiptHandId of Object.keys(this.state.completedHandReceipts)) {
      if (!this.state.completedHandIds.includes(receiptHandId)) delete this.state.completedHandReceipts[receiptHandId];
    }
    this.state.hand = null;
    return {
      ok: true,
      replayed: false,
      eventSeq: this.state.eventSeq,
      acceptedEventSeq: this.state.eventSeq,
      result,
      directives,
      events,
      finishedHand,
    };
  }

  command({ actorId, command, payload = {}, game, now = this.clock() }) {
    const hand = this.#hand();
    this.#assertGameHand(game);
    const commandId = commandIdFrom(payload);
    const receipt = hand.receipts[commandId];
    if (receipt) {
      return {
        ok: true,
        replayed: true,
        eventSeq: this.state.eventSeq,
        acceptedEventSeq: receipt.acceptedEventSeq,
        result: clone(receipt.result),
        directives: [],
        events: [],
      };
    }
    if (typeof actorId !== "string" || !hand.playerUserIds.includes(actorId)) {
      throw new HextechEffectError("技能发动玩家不在本手中", "invalid_hextech_actor");
    }
    if (hand.activeReaction) {
      if (now >= hand.activeReaction.expiresAt) {
        throw new HextechEffectError("反应窗口已经结束，请等待服务端结算", "hextech_reaction_expired");
      }
      const reactionCommands = new Set(["react", "confirm-reaction", "cancel"]);
      if (actorId !== hand.activeReaction.targetUserId || !reactionCommands.has(command)) {
        throw new HextechEffectError("当前有待处理的限时反应", "hextech_reaction_active");
      }
    }
    const firstSeq = this.state.eventSeq;
    const stageDirectives = [
      ...this.#advanceStage(game, now),
      ...this.#triggerPotBombs(game, now),
      ...this.#resolveFoldedFixedDeposits(game, now),
    ];
    let outcome;
    if (command === "activate") outcome = this.#activate(actorId, payload, game, now);
    else if (command === "select-target") outcome = this.#selectTarget(actorId, payload, game, now);
    else if (command === "confirm") outcome = this.#confirm(actorId, payload, game, now);
    else if (command === "cancel") outcome = this.#cancel(actorId, payload, game, now);
    else if (command === "react") outcome = this.#selectReaction(actorId, payload, game, now);
    else if (command === "confirm-reaction") outcome = this.#confirmReaction(actorId, payload, game, now);
    else throw new HextechEffectError("未知技能命令", "unknown_hextech_command");

    const result = outcome.result ?? { status: "accepted" };
    hand.receipts[commandId] = {
      acceptedEventSeq: this.state.eventSeq,
      result: clone(result),
    };
    const receiptIds = Object.keys(hand.receipts);
    if (receiptIds.length > MAX_RECEIPTS) delete hand.receipts[receiptIds[0]];
    return {
      ok: true,
      replayed: false,
      eventSeq: this.state.eventSeq,
      result,
      directives: [...stageDirectives, ...(outcome.directives ?? [])],
      events: hand.events.filter((event) => event.seq > firstSeq).map(clone),
    };
  }

  tick({ game, now = this.clock() }) {
    const hand = this.#hand();
    this.#assertGameHand(game);
    const firstSeq = this.state.eventSeq;
    const directives = [];
    if (hand.activeReaction && now >= hand.activeReaction.expiresAt) {
      directives.push(...this.#resolveActiveReaction("decline", game, now, { expired: true }));
    }
    directives.push(...this.#advanceStage(game, now));
    directives.push(...this.#triggerPotBombs(game, now));
    directives.push(...this.#resolveFoldedFixedDeposits(game, now));
    hand.effects.publicReveals = hand.effects.publicReveals.filter((entry) => entry.expiresAt > now);
    return {
      eventSeq: this.state.eventSeq,
      directives,
      events: hand.events.filter((event) => event.seq > firstSeq).map(clone),
    };
  }

  afterPokerAction({ actorId, action, amount = null, before, game, now = this.clock() }) {
    const hand = this.#hand();
    this.#assertGameHand(game);
    const firstSeq = this.state.eventSeq;
    const directives = [];
    const actionStreet = ACTIVE_STAGES.has(before?.stage) ? before.stage : hand.stage;
    const expiringViews = hand.effects.privateViews.filter((entry) => (
      entry.expiresAfterActionUserId === actorId
    ));
    if (expiringViews.length) {
      hand.effects.privateViews = hand.effects.privateViews.filter((entry) => !expiringViews.includes(entry));
      this.#event("action-scoped-views-expired", { userId: actorId }, { visibility: "private", userIds: [actorId] }, now);
    }
    const behavior = hand.behaviorByUserId[actorId];
    if (behavior) {
      if (action === "fold") behavior.folds += 1;
      else if (action === "check") behavior.checks += 1;
      else if (action === "call") behavior.calls += 1;
      else if (action === "raise" || action === "allin") behavior.raises += 1;
    }

    const prior = snapshotPlayer(before, actorId);
    const current = playerFor(game, actorId);
    const becameAllIn = Boolean(current?.allIn) && !Boolean(prior?.allIn);
    const charm = hand.equipments[actorId];
    if (becameAllIn && charm?.skillId === "charm" && charm.status === "armed") {
      directives.push(...this.#triggerCharm(actorId, game, now));
    }
    if (becameAllIn) this.#triggerAllInProtections(actorId, now);

    const allInTarget = Number(prior?.bet ?? 0) + Number(prior?.stack ?? 0);
    const raised = action === "raise"
      || (action === "allin" && allInTarget > Number(before?.currentBet ?? 0));
    if (raised) {
      const expired = hand.effects.intimidations.filter((entry) => (
        entry.targetUserId === actorId && entry.street === hand.stage
      ));
      if (expired.length) {
        hand.effects.intimidations = hand.effects.intimidations.filter((entry) => !expired.includes(entry));
        this.#event("intimidation-spent", { targetUserId: actorId }, { visibility: "public" }, now);
      }
    }

    const checkedStreet = hand.actionMemory.checkedStreetsByUserId[actorId];
    if (action === "check") hand.actionMemory.checkedStreetsByUserId[actorId] = actionStreet;
    if (raised && checkedStreet === actionStreet) {
      directives.push(...this.#queueCheckRaiseReactions(actorId, actionStreet, game, now));
    }

    if (hand.activeReaction && now >= hand.activeReaction.expiresAt) {
      directives.push(...this.#resolveActiveReaction("decline", game, now, { expired: true }));
    }
    directives.push(...this.#advanceStage(game, now));
    directives.push(...this.#triggerPotBombs(game, now));
    directives.push(...this.#resolveFoldedFixedDeposits(game, now));
    return {
      eventSeq: this.state.eventSeq,
      directives,
      events: hand.events.filter((event) => event.seq > firstSeq).map(clone),
      action: { actorId, action, amount },
    };
  }

  actionPolicyFor({ userId, stage, currentBet, bigBlind, players }) {
    const hand = this.state.hand;
    if (!hand || !ACTIVE_STAGES.has(stage)) return {};
    const reasons = [];
    let maxRaiseTo = null;
    const intimidations = hand.effects.intimidations.filter((entry) => (
      entry.targetUserId === userId && entry.street === stage
    ));
    for (const entry of intimidations) {
      maxRaiseTo = maxRaiseTo == null
        ? entry.maximumTotal
        : Math.min(maxRaiseTo, entry.maximumTotal);
      reasons.push("受到恐吓，本次加注受限");
    }
    const globalCaps = hand.effects.globalRaiseCaps.filter((entry) => entry.street === stage);
    for (const entry of globalCaps) {
      const maximumIncrement = Number.isSafeInteger(entry.maximumIncrement)
        ? entry.maximumIncrement
        : Math.max(0, Number(bigBlind ?? 0) * 3);
      const globalMaximum = Number(currentBet ?? 0) + maximumIncrement;
      maxRaiseTo = maxRaiseTo == null ? globalMaximum : Math.min(maxRaiseTo, globalMaximum);
      reasons.push(`限高令生效，单次加注增量最多 ${maximumIncrement}`);
    }
    const activeIds = new Set((players ?? [])
      .filter((player) => !player.folded)
      .map((player) => player.userId));
    const peace = hand.effects.peaceTreaties.some((entry) => (
      entry.street === stage
      && entry.userIds.includes(userId)
      && entry.userIds.some((candidate) => candidate !== userId && activeIds.has(candidate))
    ));
    if (peace) reasons.push("和平条约生效，本街不能加注");
    const result = {};
    if (maxRaiseTo != null) result.maxRaiseTo = Math.max(0, maxRaiseTo);
    if (peace || (maxRaiseTo != null && maxRaiseTo <= currentBet)) result.disableRaise = true;
    if (reasons.length) result.reason = [...new Set(reasons)].join("；");
    return result;
  }

  viewFor(userId, game = null, now = this.clock()) {
    const hand = this.state.hand;
    if (!hand) {
      return {
        version: EFFECT_STATE_VERSION,
        matchId: this.state.matchId,
        eventSeq: this.state.eventSeq,
        handId: null,
        skillWindow: null,
        activeReaction: null,
        privateEffects: [],
        publicEffects: null,
        recentEvents: [],
      };
    }
    const window = hand.windows[userId] ? clone(hand.windows[userId]) : null;
    if (window && window.state === "idle" && game) {
      window.disabledReason = this.#disabledReason(userId, game, now);
    }
    const reaction = hand.activeReaction;
    const involved = reaction && [reaction.sourceUserId, reaction.targetUserId].includes(userId);
    return {
      version: EFFECT_STATE_VERSION,
      matchId: this.state.matchId,
      eventSeq: this.state.eventSeq,
      handId: hand.handId,
      stage: hand.stage,
      equipment: hand.equipments[userId]
        ? { skillId: hand.equipments[userId].skillId, status: hand.equipments[userId].status }
        : null,
      skillWindow: window,
      activeReaction: involved ? {
        reactionId: reaction.reactionId,
        sourceUserId: reaction.sourceUserId,
        targetUserId: reaction.targetUserId,
        sourceSkillId: reaction.sourceSkillId,
        reactionSkillId: reaction.reactionSkillId,
        expiresAt: reaction.expiresAt,
        options: [...reaction.options],
        selectedOption: userId === reaction.targetUserId ? reaction.selectedOption : null,
      } : null,
      privateEffects: [
        ...hand.effects.privateViews
          .filter((entry) => entry.viewerUserId === userId && entry.street === hand.stage),
        ...hand.effects.predictions
          .filter((entry) => entry.sourceUserId === userId && entry.status === "pending")
          .map((entry) => ({
            effectId: entry.effectId,
            sourceSkillId: "prophet",
            kind: "flop-majority-suit-prediction",
            suit: entry.suit,
            status: entry.status,
          })),
        ...hand.effects.handPredictions
          .filter((entry) => entry.sourceUserId === userId && entry.status === "pending")
          .map((entry) => ({
            effectId: entry.effectId,
            sourceSkillId: "hand-prediction",
            kind: "final-hand-category-prediction",
            handCategory: entry.handCategory,
            status: entry.status,
          })),
      ].map(clone),
      publicEffects: {
        publicReveals: hand.effects.publicReveals
          .filter((entry) => entry.expiresAt > now)
          .map(({ effectId: id, targetUserId, cardIndex, card, expiresAt }) => ({
            effectId: id, targetUserId, cardIndex, card, expiresAt,
          })),
        intimidations: hand.effects.intimidations.map(({ effectId: id, sourceUserId, targetUserId, street }) => ({
          effectId: id, sourceUserId, targetUserId, street,
        })),
        silences: hand.effects.silences.map(({ effectId: id, sourceUserId, targetUserId, street }) => ({
          effectId: id, sourceUserId, targetUserId, street,
        })),
        peaceTreaties: hand.effects.peaceTreaties.map(({ effectId: id, userIds, street }) => ({
          effectId: id, userIds: [...userIds], street,
        })),
        riverVetoUsedByUserId: hand.effects.riverVetoUsedByUserId,
        potBombs: hand.effects.potBombs.map(({ effectId: id, sourceUserId, threshold, status }) => ({
          effectId: id, sourceUserId, threshold, status,
        })),
        globalRaiseCaps: hand.effects.globalRaiseCaps.map((entry) => ({
          effectId: entry.effectId,
          sourceUserId: entry.sourceUserId,
          street: entry.street,
          maximumIncrement: entry.maximumIncrement,
        })),
        duelContracts: hand.effects.duelContracts.map(({ effectId: id, sourceUserId, targetUserId, status }) => ({
          effectId: id, sourceUserId, targetUserId, status,
        })),
        bounties: hand.effects.bounties.map(({ effectId: id, sourceUserId, targetUserId, status }) => ({
          effectId: id, sourceUserId, targetUserId, status,
        })),
        lastStands: hand.effects.lastStands.map(({ effectId: id, sourceUserId, status }) => ({
          effectId: id, sourceUserId, status,
        })),
        insurances: hand.effects.insurances.map(({ effectId: id, sourceUserId, status }) => ({
          effectId: id, sourceUserId, status,
        })),
        fixedDeposits: hand.effects.fixedDeposits.map(({ effectId: id, sourceUserId, status, resolution }) => ({
          effectId: id, sourceUserId, status, resolution,
        })),
      },
      recentEvents: hand.events.filter((event) => visibleEvent(event, userId)).slice(-30).map(clone),
    };
  }

  externalHoleCardView({ viewerUserId, targetUserId, cards, now = this.clock() } = {}) {
    const hand = this.#hand();
    if (typeof viewerUserId !== "string" || typeof targetUserId !== "string"
      || viewerUserId === targetUserId
      || !hand.playerUserIds.includes(targetUserId)
      || !Array.isArray(cards) || cards.length !== 2
      || cards.some((card) => typeof card !== "string")) {
      throw new HextechEffectError("外部查看底牌请求不正确", "invalid_external_hole_card_view");
    }
    const cached = hand.effects.externalHoleCardViews.find((entry) => (
      entry.viewerUserId === viewerUserId && entry.targetUserId === targetUserId
    ));
    if (cached) {
      return { cards: [...cached.cards], masked: cached.masked, eventSeq: this.state.eventSeq };
    }
    const equipment = hand.equipments[targetUserId];
    const maskSkillId = equipment?.status === "available"
      && ["fake-weak", "fake-strong"].includes(equipment.skillId)
      ? equipment.skillId
      : null;
    const shownCards = maskSkillId ? this.#maskedCards(targetUserId, cards, now) : [...cards];
    if (maskSkillId) {
      hand.effects.externalHoleCardViews.push({
        viewerUserId,
        targetUserId,
        cards: [...shownCards],
        masked: true,
      });
    }
    return { cards: [...shownCards], masked: Boolean(maskSkillId), eventSeq: this.state.eventSeq };
  }

  #hand() {
    if (!this.state.hand) throw new HextechEffectError("当前没有进行中的海克斯手牌", "no_active_hextech_hand");
    return this.state.hand;
  }

  #assertGameHand(game) {
    const hand = this.#hand();
    if (!game || game.handId !== hand.handId) {
      throw new HextechEffectError("牌局上下文已过期", "stale_hextech_game");
    }
    playerList(game);
  }

  #event(type, payload, { visibility = "public", userIds = [] } = {}, now = this.clock()) {
    const hand = this.#hand();
    this.state.eventSeq += 1;
    const event = {
      seq: this.state.eventSeq,
      type,
      at: now,
      visibility,
      userIds: uniqueStrings(userIds),
      payload: clone(payload),
    };
    hand.events.push(event);
    hand.events = hand.events.slice(-MAX_EVENT_HISTORY);
    return event;
  }

  #rotateWindow(userId, patch) {
    const hand = this.#hand();
    const current = hand.windows[userId];
    if (!current) throw new HextechEffectError("玩家本手没有装备技能", "missing_hextech_equipment");
    hand.windows[userId] = {
      ...current,
      ...patch,
      token: token(),
      version: current.version + 1,
    };
    return hand.windows[userId];
  }

  #assertWindowToken(userId, payload) {
    const current = this.#hand().windows[userId];
    if (!current || typeof payload.windowToken !== "string" || payload.windowToken !== current.token) {
      throw new HextechEffectError("技能窗口已更新，请以最新牌桌状态为准", "stale_hextech_skill_window");
    }
    if (payload.windowVersion != null && payload.windowVersion !== current.version) {
      throw new HextechEffectError("技能窗口版本已过期", "stale_hextech_skill_window");
    }
    return current;
  }

  #equipment(userId) {
    const equipment = this.#hand().equipments[userId];
    if (!equipment) throw new HextechEffectError("玩家本手没有装备技能", "missing_hextech_equipment");
    return equipment;
  }

  #consume(userId, now, reason = null) {
    const equipment = this.#equipment(userId);
    equipment.status = "consumed";
    equipment.usedAtSeq = this.state.eventSeq + 1;
    this.#rotateWindow(userId, {
      state: "consumed",
      validTargetUserIds: [],
      expiresAt: null,
      disabledReason: reason ?? "本手已经发动",
      pendingTargetUserId: null,
      pendingReactionOption: null,
    });
    return equipment;
  }

  #markCheat(userId, skillId) {
    const usage = this.#hand().effects.cheatUsageByUserId;
    usage[userId] = [...new Set([...(usage[userId] ?? []), skillId])];
  }

  #activate(actorId, payload, game, now) {
    const window = this.#assertWindowToken(actorId, payload);
    const equipment = this.#equipment(actorId);
    if (equipment.status !== "available" || window.state !== "idle") {
      throw new HextechEffectError("当前技能不能开始发动", "hextech_skill_unavailable");
    }
    const skillId = equipment.skillId;
    if (!IMPLEMENTED_SKILL_IDS.has(skillId)) {
      throw new HextechEffectError("该技能效果尚未接入当前服务端批次", "hextech_skill_not_implemented");
    }
    if (isPassiveCatalogSkill(skillId) || isReactionCatalogSkill(skillId)) {
      throw new HextechEffectError("该技能只能由服务端触发", "hextech_skill_server_triggered");
    }
    this.#assertTiming(actorId, skillId, game, now);
    this.#assertNotSilenced(actorId);
    if (!requiresOpponentTarget(skillId)) {
      this.#rotateWindow(actorId, {
        state: "confirming",
        validTargetUserIds: [],
        disabledReason: null,
        pendingTargetUserId: targetTypeFor(skillId) === "self" ? actorId : null,
      });
      this.#event(
        "skill-confirmation-opened",
        { actorId, skillId },
        { visibility: "public" },
        now,
      );
      return { result: { status: "confirming", skillId } };
    }
    const validTargetUserIds = this.#validTargets(actorId, skillId, game);
    if (!validTargetUserIds.length) {
      throw new HextechEffectError("当前没有合法技能目标", "no_valid_hextech_target");
    }
    this.#rotateWindow(actorId, {
      state: "targeting",
      validTargetUserIds,
      disabledReason: null,
      pendingTargetUserId: null,
    });
    this.#event("skill-targeting", { actorId, skillId }, { visibility: "public" }, now);
    return { result: { status: "targeting", skillId } };
  }

  #selectTarget(actorId, payload, game, now) {
    const window = this.#assertWindowToken(actorId, payload);
    if (window.state !== "targeting") {
      throw new HextechEffectError("当前不在选择目标阶段", "hextech_not_targeting");
    }
    const skillId = this.#equipment(actorId).skillId;
    this.#assertTiming(actorId, skillId, game, now);
    this.#assertNotSilenced(actorId);
    const targets = this.#validTargets(actorId, skillId, game);
    if (typeof payload.targetUserId !== "string" || !targets.includes(payload.targetUserId)) {
      throw new HextechEffectError("技能目标已经失效", "invalid_hextech_target");
    }
    this.#rotateWindow(actorId, {
      state: "confirming",
      validTargetUserIds: targets,
      pendingTargetUserId: payload.targetUserId,
      disabledReason: null,
    });
    this.#event(
      "skill-target-selected",
      { actorId, skillId, targetUserId: payload.targetUserId },
      { visibility: "private", userIds: [actorId] },
      now,
    );
    return { result: { status: "confirming", skillId, targetUserId: payload.targetUserId } };
  }

  #confirm(actorId, payload, game, now) {
    const window = this.#assertWindowToken(actorId, payload);
    const skillId = this.#equipment(actorId).skillId;
    const needsTarget = requiresOpponentTarget(skillId);
    if (window.state !== "confirming" || (needsTarget && !window.pendingTargetUserId)) {
      throw new HextechEffectError("当前没有待确认的技能", "hextech_not_confirming");
    }
    this.#assertTiming(actorId, skillId, game, now);
    this.#assertNotSilenced(actorId);
    if (needsTarget) {
      const validTargets = this.#validTargets(actorId, skillId, game);
      if (!validTargets.includes(window.pendingTargetUserId)) {
        throw new HextechEffectError("确认时技能目标已经失效", "invalid_hextech_target");
      }
    }
    const choices = this.#validatedChoices(skillId, payload.choices);
    if (skillId === "public-reveal" && Number(playerFor(game, actorId)?.stack ?? 0) < 80 + CHIP_UNIT) {
      throw new HextechEffectError("至少需要 85 筹码才能支付明牌审判并保留行动筹码", "insufficient_hextech_chips");
    }
    if (skillId === "river-veto" && Number(playerFor(game, actorId)?.stack ?? 0) < 120 + CHIP_UNIT) {
      throw new HextechEffectError("至少需要 125 筹码才能支付河牌否决并保留行动筹码", "insufficient_hextech_chips");
    }
    if (skillId === "insurance" && Number(playerFor(game, actorId)?.stack ?? 0) < 60 + CHIP_UNIT) {
      throw new HextechEffectError("筹码不足，无法购买保险并继续行动", "insufficient_hextech_chips");
    }
    if (skillId === "fixed-deposit" && Number(playerFor(game, actorId)?.stack ?? 0) < 200 + CHIP_UNIT) {
      throw new HextechEffectError("筹码不足，无法锁定定期存款并继续行动", "insufficient_hextech_chips");
    }
    if (["gambler", "reforge", "swap-trick"].includes(skillId)) {
      const cards = privateCardsFor(game, actorId);
      if (cards[choices.holeCardIndex] === "BLANK") {
        throw new HextechEffectError("白板牌不能再次被变牌", "invalid_hextech_choice");
      }
    }
    this.#rotateWindow(actorId, {
      state: "resolving",
      validTargetUserIds: [],
      disabledReason: null,
    });
    this.#event(
      "skill-confirmed",
      { actorId, skillId, targetUserId: window.pendingTargetUserId },
      { visibility: "public" },
      now,
    );
    return this.#execute(actorId, window.pendingTargetUserId, skillId, game, now, choices);
  }

  #cancel(actorId, payload, game, now) {
    const window = this.#assertWindowToken(actorId, payload);
    const reaction = this.#hand().activeReaction;
    if (reaction?.targetUserId === actorId && ["armed", "confirming"].includes(window.state)) {
      const directives = this.#resolveActiveReaction("decline", game, now);
      return {
        result: { status: "reaction-resolved", option: "decline" },
        directives,
      };
    }
    if (!["targeting", "confirming"].includes(window.state)) {
      throw new HextechEffectError("当前技能流程不能取消", "hextech_skill_not_cancelable");
    }
    const skillId = this.#equipment(actorId).skillId;
    this.#rotateWindow(actorId, {
      state: "idle",
      validTargetUserIds: [],
      disabledReason: null,
      pendingTargetUserId: null,
      pendingReactionOption: null,
    });
    this.#event("skill-canceled", { actorId, skillId }, { visibility: "private", userIds: [actorId] }, now);
    return { result: { status: "canceled", skillId } };
  }

  #selectReaction(actorId, payload, game, now) {
    const hand = this.#hand();
    const reaction = hand.activeReaction;
    if (!reaction || reaction.targetUserId !== actorId || now >= reaction.expiresAt) {
      throw new HextechEffectError("当前没有可用的反应窗口", "hextech_reaction_unavailable");
    }
    const window = this.#assertWindowToken(actorId, payload);
    if (window.state !== "armed") throw new HextechEffectError("反应技能当前不可用", "hextech_reaction_unavailable");
    let option = payload.option ?? (reaction.reactionSkillId === "check-raise-hunter" ? "hunt" : "escape");
    // The current room adapter supplies its legacy no-option reaction default
    // as "escape". Treat that value as the single affirmative hunter action;
    // the authoritative active reaction still determines what it means.
    if (reaction.reactionSkillId === "check-raise-hunter" && option === "escape") option = "hunt";
    if (!reaction.options.includes(option)) {
      throw new HextechEffectError("反应选项不正确", "invalid_hextech_reaction_option");
    }
    const risk = reaction.reactionSkillId === "escape" && option === "escape" ? reaction.escapeCost : 0;
    reaction.selectedOption = option;
    this.#rotateWindow(actorId, {
      state: "confirming",
      maximumChipRisk: risk,
      expiresAt: reaction.expiresAt,
      pendingReactionOption: option,
      disabledReason: null,
    });
    this.#event(
      "reaction-selected",
      { reactionId: reaction.reactionId, option },
      { visibility: "private", userIds: [actorId] },
      now,
    );
    return { result: { status: "confirming-reaction", option, maximumChipRisk: risk } };
  }

  #confirmReaction(actorId, payload, game, now) {
    const hand = this.#hand();
    const reaction = hand.activeReaction;
    if (!reaction || reaction.targetUserId !== actorId || now >= reaction.expiresAt) {
      throw new HextechEffectError("反应窗口已经结束", "hextech_reaction_expired");
    }
    const window = this.#assertWindowToken(actorId, payload);
    if (window.state !== "confirming"
      || !window.pendingReactionOption
      || window.pendingReactionOption !== reaction.selectedOption) {
      throw new HextechEffectError("当前没有待确认的反应", "hextech_reaction_not_confirming");
    }
    const directives = this.#resolveActiveReaction(window.pendingReactionOption, game, now);
    return {
      result: { status: "reaction-resolved", option: window.pendingReactionOption },
      directives,
    };
  }

  #execute(actorId, targetUserId, skillId, game, now, choices = {}) {
    if (skillId === "gambler") return this.#executeGambler(actorId, choices, game, now);
    if (skillId === "reforge") return this.#executeReforge(actorId, choices, game, now);
    if (skillId === "prophet") return this.#executeProphet(actorId, choices, now);
    if (skillId === "swap-trick") return this.#executeSwapTrick(actorId, choices, game, now);
    if (skillId === "river-veto") return this.#executeRiverVeto(actorId, game, now);
    if (skillId === "pot-bomb") return this.#executePotBomb(actorId, game, now);
    if (skillId === "raise-cap") return this.#executeRaiseCap(actorId, game, now);
    if (skillId === "last-stand") return this.#executeLastStand(actorId, game, now);
    if (skillId === "insurance") return this.#executeInsurance(actorId, game, now);
    if (skillId === "hand-prediction") return this.#executeHandPrediction(actorId, choices, now);
    if (skillId === "fixed-deposit") return this.#executeFixedDeposit(actorId, game, now);
    if (skillId === "charm") {
      const equipment = this.#equipment(actorId);
      equipment.status = "armed";
      this.#rotateWindow(actorId, {
        state: "armed",
        pendingTargetUserId: targetUserId,
        disabledReason: "等待你的全押动作",
      });
      this.#event("charm-armed", { actorId, targetUserId }, { visibility: "public" }, now);
      return {
        result: { status: "armed", skillId, targetUserId },
        directives: [this.#log(`${actorId} 已锁定魅惑目标，等待全押触发`)],
      };
    }
    if (skillId === "public-reveal") return this.#executePublicReveal(actorId, targetUserId, game, now);
    const defense = this.#automaticDefense(actorId, targetUserId, skillId, game, now);
    if (defense.blocked) {
      this.#consume(actorId, now);
      return {
        result: { status: "blocked", skillId, defenseSkillId: defense.defenseSkillId },
        directives: defense.directives,
      };
    }
    const effectiveTargetUserId = defense.targetUserId;
    const effectiveSourceUserId = defense.reflected ? targetUserId : actorId;
    if (skillId === "xray") {
      return this.#executeXray(actorId, effectiveSourceUserId, effectiveTargetUserId, game, now, defense);
    }
    if (skillId === "mind-read") {
      return this.#executeMindRead(actorId, effectiveSourceUserId, effectiveTargetUserId, game, now, defense);
    }
    if (skillId === "intimidate") {
      return this.#executeIntimidate(actorId, effectiveSourceUserId, effectiveTargetUserId, game, now, defense);
    }
    if (skillId === "silence") {
      return this.#executeSilence(actorId, effectiveSourceUserId, effectiveTargetUserId, game, now, defense);
    }
    if (skillId === "peace-treaty") {
      return this.#executePeaceTreaty(actorId, effectiveSourceUserId, effectiveTargetUserId, game, now, defense);
    }
    if (skillId === "disarm") return this.#executeDisarm(actorId, effectiveTargetUserId, game, now, defense);
    if (skillId === "catch-cheater") {
      return this.#executeCatchCheater(
        actorId,
        effectiveSourceUserId,
        effectiveTargetUserId,
        game,
        now,
        defense,
      );
    }
    if (skillId === "duel-contract") {
      return this.#executeDuelContract(
        actorId,
        effectiveSourceUserId,
        effectiveTargetUserId,
        now,
        defense,
      );
    }
    if (skillId === "bounty") {
      return this.#executeBounty(
        actorId,
        effectiveSourceUserId,
        effectiveTargetUserId,
        now,
        defense,
      );
    }
    throw new HextechEffectError("技能效果没有服务端裁决器", "hextech_skill_not_implemented");
  }

  #executeGambler(actorId, choices, game, now) {
    const { holeCardIndex, rank: chosenRank } = choices;
    const currentCard = privateCardsFor(game, actorId)[holeCardIndex];
    const roll = this.#random();
    let outcome;
    let resultingRank = null;
    let fallbackReason = null;
    const directives = [];
    if (roll < 0.3) {
      outcome = "chosen-rank";
      resultingRank = chosenRank;
    } else if (roll < 0.9) {
      outcome = "small-rank";
      const smallRanks = ["2", "3", "4", "5", "6"];
      const legalSmallRanks = Array.isArray(game.deck)
        ? smallRanks.filter((rank) => rank === currentCard[0] || game.deck.some((card) => card[0] === rank))
        : smallRanks;
      if (legalSmallRanks.length) resultingRank = legalSmallRanks[this.#randomInt(legalSmallRanks.length)];
      else {
        outcome = "unchanged";
        fallbackReason = "no-legal-small-rank-card";
      }
    } else if (roll < 0.999) {
      outcome = "unchanged";
    } else {
      outcome = "blank";
    }

    if (resultingRank && resultingRank !== currentCard[0]
      && Array.isArray(game.deck) && !game.deck.some((card) => card[0] === resultingRank)) {
      outcome = "unchanged";
      resultingRank = null;
      fallbackReason = "rank-unavailable";
    }

    if (resultingRank && resultingRank !== currentCard[0]) {
      directives.push({
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.REPLACE_HOLE_CARD_RANK,
        userId: actorId,
        cardIndex: holeCardIndex,
        rank: resultingRank,
        preferredSuit: currentCard.slice(-1),
        preserveSuit: outcome === "chosen-rank",
        label: outcome === "chosen-rank" ? "赌圣如愿变牌" : "赌圣变成小瘪三",
      });
    } else if (outcome === "blank") {
      directives.push({
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BLANK_HOLE_CARD,
        userId: actorId,
        cardIndex: holeCardIndex,
        label: "赌圣白板变牌",
      });
    }

    this.#markCheat(actorId, "gambler");
    this.#consume(actorId, now);
    this.#event(
      "gambler-resolved",
      { actorId, outcome, holeCardIndex, resultingRank, fallbackReason },
      { visibility: "private", userIds: [actorId] },
      now,
    );
    directives.push(this.#log("赌圣变牌已由服务端完成裁决"));
    return {
      result: {
        status: "resolved",
        skillId: "gambler",
        outcome,
        holeCardIndex,
        resultingRank,
        fallbackReason,
      },
      directives,
    };
  }

  #executeReforge(actorId, choices, game, now) {
    const { holeCardIndex } = choices;
    privateCardsFor(game, actorId);
    this.#consume(actorId, now);
    this.#event(
      "hole-card-reforge-requested",
      { actorId, holeCardIndex },
      { visibility: "private", userIds: [actorId] },
      now,
    );
    return {
      result: { status: "resolved", skillId: "reforge", holeCardIndex },
      directives: [
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.REPLACE_HOLE_CARD_RANDOM,
          userId: actorId,
          cardIndex: holeCardIndex,
          publicDiscard: false,
          label: "回炉重造",
        },
        this.#log("回炉重造生效：一张底牌已秘密替换"),
      ],
    };
  }

  #executeProphet(actorId, choices, now) {
    const prediction = {
      effectId: effectId(),
      sourceUserId: actorId,
      suit: choices.suit,
      status: "pending",
      createdAt: now,
      resolvedAt: null,
      actualMajoritySuit: null,
      success: null,
    };
    this.#hand().effects.predictions.push(prediction);
    this.#consume(actorId, now);
    this.#event(
      "prophecy-locked",
      { effectId: prediction.effectId, suit: prediction.suit },
      { visibility: "private", userIds: [actorId] },
      now,
    );
    this.#event(
      "prophet-armed",
      { actorId, effectId: prediction.effectId },
      { visibility: "public" },
      now,
    );
    return {
      result: { status: "armed", skillId: "prophet", suit: prediction.suit },
      directives: [this.#log("预言家已锁定翻牌多数花色预测")],
    };
  }

  #executeSwapTrick(actorId, choices, game, now) {
    const { holeCardIndex } = choices;
    const discardedCard = privateCardsFor(game, actorId)[holeCardIndex];
    this.#markCheat(actorId, "swap-trick");
    this.#consume(actorId, now);
    this.#event(
      "swap-trick-requested",
      { actorId, holeCardIndex, discardedCard },
      { visibility: "public" },
      now,
    );
    return {
      result: { status: "resolved", skillId: "swap-trick", holeCardIndex, discardedCard },
      directives: [
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.REPLACE_HOLE_CARD_RANDOM,
          userId: actorId,
          cardIndex: holeCardIndex,
          publicDiscard: true,
          discardedCard,
          label: "偷梁换柱",
        },
        this.#log(`偷梁换柱生效：公开弃置 ${discardedCard} 并替换底牌`),
      ],
    };
  }

  #executeRiverVeto(actorId, game, now) {
    const hand = this.#hand();
    if (hand.effects.riverVetoUsedByUserId) {
      throw new HextechEffectError("本手全桌已经使用过河牌否决", "hextech_table_skill_consumed");
    }
    if (!Array.isArray(game.community) || game.community.length !== 5) {
      throw new HextechEffectError("当前没有可否决的河牌", "invalid_hextech_skill_timing");
    }
    hand.effects.riverVetoUsedByUserId = actorId;
    this.#consume(actorId, now);
    this.#event("river-veto-used", { actorId }, { visibility: "public" }, now);
    return {
      result: { status: "resolved", skillId: "river-veto" },
      directives: [
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.CHARGE_BANK,
          userId: actorId,
          amount: 120,
          label: "河牌否决",
        },
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.REDEAL_RIVER,
          userId: actorId,
          label: "河牌否决",
        },
        this.#log("河牌否决生效：原河牌公开弃置并重新发牌"),
      ],
    };
  }

  #executeCatchCheater(actorId, auditorUserId, targetUserId, game, now, defense) {
    const hand = this.#hand();
    const caughtSkillIds = [...(hand.effects.cheatUsageByUserId[targetUserId] ?? [])];
    const success = caughtSkillIds.length > 0;
    const directives = [...defense.directives];
    const payments = [];
    if (success) {
      let remaining = Math.max(0, Number(playerFor(game, targetUserId)?.stack ?? 0));
      const recipients = playerList(game)
        .filter((player) => hand.playerUserIds.includes(player.userId) && player.userId !== targetUserId)
        .sort((left, right) => Number(left.seat ?? 0) - Number(right.seat ?? 0));
      for (const recipient of recipients) {
        const amount = Math.min(100, remaining);
        if (amount < CHIP_UNIT) break;
        remaining -= amount;
        payments.push({ fromUserId: targetUserId, toUserId: recipient.userId, amount });
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.TRANSFER_CHIPS,
          fromUserId: targetUserId,
          toUserId: recipient.userId,
          amount,
          requestedAmount: 100,
          allowPartial: true,
          label: "抓老千成功赔付",
        });
      }
      directives.push({
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.FORCE_FOLD,
        userId: targetUserId,
        sourceUserId: auditorUserId,
        label: "抓老千成功，本手强制离局",
      });
    } else {
      const amount = Math.min(100, Math.max(0, Number(playerFor(game, auditorUserId)?.stack ?? 0)));
      if (amount >= CHIP_UNIT) {
        payments.push({ fromUserId: auditorUserId, toUserId: targetUserId, amount });
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.TRANSFER_CHIPS,
          fromUserId: auditorUserId,
          toUserId: targetUserId,
          amount,
          requestedAmount: 100,
          allowPartial: true,
          label: "抓老千误判赔付",
        });
      }
    }
    const audit = {
      effectId: effectId(),
      sourceUserId: auditorUserId,
      targetUserId,
      success,
      caughtSkillIds,
      payments,
      reflected: auditorUserId !== actorId,
    };
    hand.effects.cheatAudits.push(audit);
    this.#consume(actorId, now);
    this.#event(
      "cheat-audit-resolved",
      {
        sourceUserId: auditorUserId,
        targetUserId,
        success,
        reflected: audit.reflected,
      },
      { visibility: "public" },
      now,
    );
    directives.push(this.#log(success
      ? "抓老千成功：目标向其他在座玩家赔付并退出本手"
      : "抓老千误判：发动者向目标支付 100 筹码（不足时支付剩余筹码）"));
    return {
      result: {
        status: "resolved",
        skillId: "catch-cheater",
        success,
        targetUserId,
        reflected: audit.reflected,
        paymentCount: payments.length,
      },
      directives,
    };
  }

  #executePotBomb(actorId, game, now) {
    const entry = {
      effectId: effectId(),
      sourceUserId: actorId,
      threshold: 800,
      bankContribution: 120,
      status: "armed",
      armedAt: now,
      triggeredAt: null,
    };
    this.#hand().effects.potBombs.push(entry);
    const equipment = this.#equipment(actorId);
    equipment.status = "armed";
    this.#rotateWindow(actorId, {
      state: "armed",
      disabledReason: "等待底池首次达到 800",
      pendingTargetUserId: null,
    });
    this.#event("pot-bomb-armed", { actorId, effectId: entry.effectId }, { visibility: "public" }, now);
    const directives = [this.#log("底池炸弹已埋下，将在底池首次达到 800 时触发")];
    if (potFor(game) >= entry.threshold) directives.unshift(...this.#triggerPotBombs(game, now));
    return {
      result: { status: entry.status === "armed" ? "armed" : "resolved", skillId: "pot-bomb" },
      directives,
    };
  }

  #executeRaiseCap(actorId, game, now) {
    const bigBlind = Number(game.settings?.bigBlind ?? game.bigBlind ?? 0);
    if (!Number.isSafeInteger(bigBlind) || bigBlind < CHIP_UNIT) {
      throw new HextechEffectError("服务端大盲配置缺失", "missing_server_blinds");
    }
    const entry = {
      effectId: effectId(),
      sourceUserId: actorId,
      street: this.#hand().stage,
      maximumIncrement: bigBlind * 3,
    };
    this.#hand().effects.globalRaiseCaps.push(entry);
    this.#consume(actorId, now);
    this.#event("global-raise-cap-applied", entry, { visibility: "public" }, now);
    return {
      result: { status: "resolved", skillId: "raise-cap", ...entry },
      directives: [
        { type: HEXTECH_EFFECT_DIRECTIVE_TYPES.RAISE_CAP, ...entry, appliesTo: "all-active-players" },
        this.#log(`限高令生效：本街单次加注增量最多 ${entry.maximumIncrement}`),
      ],
    };
  }

  #executeDuelContract(actorId, sourceUserId, targetUserId, now, defense) {
    const entry = {
      effectId: effectId(),
      sourceUserId,
      targetUserId,
      status: "armed",
      reflected: sourceUserId !== actorId,
    };
    this.#hand().effects.duelContracts.push(entry);
    this.#consume(actorId, now);
    this.#event("duel-contract-armed", entry, { visibility: "public" }, now);
    return {
      result: { status: "armed", skillId: "duel-contract", ...entry },
      directives: [...defense.directives, this.#log("单挑契约成立：双方进入摊牌时，胜者获得银行奖励")],
    };
  }

  #executeLastStand(actorId, game, now) {
    const actor = playerFor(game, actorId);
    const averageStartingStack = playerList(game)
      .reduce((sum, player) => sum + Number(player.startingStack ?? 0), 0) / playerList(game).length;
    const entry = {
      effectId: effectId(),
      sourceUserId: actorId,
      startingStack: Number(actor.startingStack ?? 0),
      averageStartingStack,
      status: "armed",
      triggeredAt: null,
      lossAtSettlement: null,
      refund: 0,
    };
    this.#hand().effects.lastStands.push(entry);
    const equipment = this.#equipment(actorId);
    equipment.status = "armed";
    this.#rotateWindow(actorId, {
      state: "armed",
      disabledReason: "等待你的全押动作",
      pendingTargetUserId: actorId,
    });
    this.#event("last-stand-armed", { actorId, effectId: entry.effectId }, { visibility: "public" }, now);
    return {
      result: { status: "armed", skillId: "last-stand" },
      directives: [this.#log("背水一战已准备，将在你的全押动作后锁定保障")],
    };
  }

  #executeInsurance(actorId, game, now) {
    const entry = {
      effectId: effectId(),
      sourceUserId: actorId,
      premium: 60,
      status: "armed",
      triggeredAt: null,
      lossAtSettlement: null,
      refund: 0,
      insuredStackBasis: Math.max(0, Number(playerFor(game, actorId)?.stack ?? 0) - 60),
    };
    this.#hand().effects.insurances.push(entry);
    this.#consume(actorId, now);
    this.#event("insurance-purchased", { actorId, premium: entry.premium }, { visibility: "public" }, now);
    return {
      result: { status: "armed", skillId: "insurance", premium: entry.premium },
      directives: [
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.CHARGE_BANK,
          userId: actorId,
          amount: entry.premium,
          label: "保险单保费",
        },
        this.#log("保险单已生效：全押产生净损失时返还 25%，最多 300"),
      ],
    };
  }

  #executeBounty(actorId, sourceUserId, targetUserId, now, defense) {
    const entry = {
      effectId: effectId(),
      sourceUserId,
      targetUserId,
      status: "armed",
      reflected: sourceUserId !== actorId,
    };
    this.#hand().effects.bounties.push(entry);
    this.#consume(actorId, now);
    this.#event("bounty-armed", entry, { visibility: "public" }, now);
    return {
      result: { status: "armed", skillId: "bounty", ...entry },
      directives: [...defense.directives, this.#log("悬赏令已标记目标，摊牌胜负将由服务端结算")],
    };
  }

  #executeHandPrediction(actorId, choices, now) {
    const entry = {
      effectId: effectId(),
      sourceUserId: actorId,
      handCategory: choices.handCategory,
      status: "pending",
      actualHandCategory: null,
      success: null,
    };
    this.#hand().effects.handPredictions.push(entry);
    this.#consume(actorId, now);
    this.#event(
      "hand-prediction-locked",
      { effectId: entry.effectId, handCategory: entry.handCategory },
      { visibility: "private", userIds: [actorId] },
      now,
    );
    this.#event("hand-prediction-armed", { actorId, effectId: entry.effectId }, { visibility: "public" }, now);
    return {
      result: { status: "armed", skillId: "hand-prediction", handCategory: entry.handCategory },
      directives: [this.#log("牌型预报已锁定，将在本手结束时由服务端核验")],
    };
  }

  #executeFixedDeposit(actorId, game, now) {
    const entry = {
      effectId: effectId(),
      sourceUserId: actorId,
      principal: 200,
      status: "locked",
      openedAt: now,
      resolvedAt: null,
      returnAmount: null,
      resolution: null,
      openingStreet: this.#hand().stage,
      openingStack: Number(playerFor(game, actorId)?.stack ?? 0),
    };
    this.#hand().effects.fixedDeposits.push(entry);
    this.#consume(actorId, now);
    this.#event("fixed-deposit-locked", { actorId, principal: entry.principal }, { visibility: "public" }, now);
    return {
      result: { status: "armed", skillId: "fixed-deposit", principal: entry.principal },
      directives: [
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.CHARGE_BANK,
          userId: actorId,
          amount: entry.principal,
          label: "定期存款锁定",
        },
        this.#log("定期存款已锁定 200：坚持至河牌返 230，提前弃牌返 180"),
      ],
    };
  }

  #executeXray(actorId, viewerUserId, targetUserId, game, now, defense) {
    this.#markCheat(actorId, "xray");
    const smoke = this.#consumeSmokeIfAvailable(targetUserId, now);
    if (smoke) {
      this.#consume(actorId, now);
      this.#event(
        "view-failed",
        { actorId: viewerUserId, targetUserId, skillId: "xray", reason: "obscured" },
        { visibility: "private", userIds: [viewerUserId] },
        now,
      );
      return {
        result: { status: "resolved", skillId: "xray", success: false, reason: "obscured" },
        directives: [...defense.directives, this.#log("透视眼受到未知干扰，查看失败")],
      };
    }
    const success = this.#random() < 0.6;
    if (!success) {
      this.#consume(actorId, now);
      this.#event(
        "view-failed",
        { actorId: viewerUserId, targetUserId, skillId: "xray", reason: "roll" },
        { visibility: "private", userIds: [viewerUserId] },
        now,
      );
      return {
        result: { status: "resolved", skillId: "xray", success: false, reason: "roll" },
        directives: [...defense.directives, this.#log("透视眼本次未能看清目标底牌")],
      };
    }
    const realCards = privateCardsFor(game, targetUserId);
    const shownCards = this.#maskedCards(targetUserId, realCards, now);
    const view = {
      effectId: effectId(),
      sourceSkillId: "xray",
      viewerUserId,
      targetUserId,
      cards: shownCards,
      street: this.#hand().stage,
    };
    this.#hand().effects.privateViews.push(view);
    this.#consume(actorId, now);
    this.#event(
      "private-view-created",
      { sourceSkillId: "xray", targetUserId, cards: shownCards, street: view.street },
      { visibility: "private", userIds: [viewerUserId] },
      now,
    );
    return {
      result: { status: "resolved", skillId: "xray", success: true, targetUserId },
      directives: [
        ...defense.directives,
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.PRIVATE_REVEAL,
          audienceUserIds: [viewerUserId],
          subjectUserId: targetUserId,
          kind: "hole-cards",
          cards: shownCards,
          expiresAfterStreet: view.street,
        },
        this.#log("透视眼发动成功，结果仅向发动者展示"),
      ],
    };
  }

  #executeMindRead(actorId, viewerUserId, targetUserId, game, now, defense) {
    const tendency = this.#tendencyFor(targetUserId, game);
    this.#hand().effects.privateViews.push({
      effectId: effectId(),
      sourceSkillId: "mind-read",
      viewerUserId,
      targetUserId,
      kind: "public-tendency",
      tendency,
      street: this.#hand().stage,
    });
    this.#consume(actorId, now);
    this.#event(
      "tendency-view-created",
      { sourceSkillId: "mind-read", targetUserId, tendency },
      { visibility: "private", userIds: [viewerUserId] },
      now,
    );
    return {
      result: {
        status: "resolved",
        skillId: "mind-read",
        targetUserId,
        tendency: viewerUserId === actorId ? tendency : null,
        reflected: viewerUserId !== actorId,
      },
      directives: [
        ...defense.directives,
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.PRIVATE_REVEAL,
          audienceUserIds: [viewerUserId],
          subjectUserId: targetUserId,
          kind: "public-tendency",
          tendency,
          cards: null,
          expiresAfterStreet: this.#hand().stage,
        },
        this.#log("读心术已完成，结果仅向合法查看者展示"),
      ],
    };
  }

  #executePublicReveal(actorId, targetUserId, game, now) {
    const actor = playerFor(game, actorId);
    if (!actor || actor.stack < 80 + CHIP_UNIT) {
      throw new HextechEffectError("至少需要 85 筹码才能支付明牌审判并保留行动筹码", "insufficient_hextech_chips");
    }
    const directives = [{
      type: HEXTECH_EFFECT_DIRECTIVE_TYPES.CHARGE_POT,
      userId: actorId,
      amount: 80,
      label: "明牌审判",
    }];
    const defense = this.#automaticDefense(actorId, targetUserId, "public-reveal", game, now);
    directives.push(...defense.directives);
    if (defense.blocked) {
      this.#consume(actorId, now);
      directives.push(this.#log("明牌审判被防御技能抵挡，80 筹码仍加入底池"));
      return {
        result: { status: "blocked", skillId: "public-reveal", defenseSkillId: defense.defenseSkillId },
        directives,
      };
    }
    const effectiveTargetUserId = defense.targetUserId;
    if (this.#consumeSmokeIfAvailable(effectiveTargetUserId, now)) {
      this.#consume(actorId, now);
      directives.push(this.#log("明牌审判受到未知干扰，80 筹码仍加入底池"));
      return {
        result: { status: "resolved", skillId: "public-reveal", success: false, reason: "obscured" },
        directives,
      };
    }
    const cardIndex = this.#randomInt(2);
    const cards = this.#maskedCards(effectiveTargetUserId, privateCardsFor(game, effectiveTargetUserId), now);
    const reveal = {
      effectId: effectId(),
      sourceUserId: actorId,
      targetUserId: effectiveTargetUserId,
      cardIndex,
      card: cards[cardIndex],
      expiresAt: now + PUBLIC_REVEAL_MS,
    };
    this.#hand().effects.publicReveals.push(reveal);
    this.#consume(actorId, now);
    this.#event(
      "public-card-revealed",
      { targetUserId: reveal.targetUserId, cardIndex, card: reveal.card, expiresAt: reveal.expiresAt },
      { visibility: "public" },
      now,
    );
    directives.push({
      type: HEXTECH_EFFECT_DIRECTIVE_TYPES.PUBLIC_REVEAL,
      audienceUserIds: "all",
      subjectUserId: reveal.targetUserId,
      kind: "one-hole-card",
      cardIndex,
      card: reveal.card,
      expiresAt: reveal.expiresAt,
    });
    directives.push(this.#log("明牌审判已随机公开目标的一张底牌，持续 4 秒"));
    return {
      result: { status: "resolved", skillId: "public-reveal", success: true, ...reveal },
      directives,
    };
  }

  #executeIntimidate(actorId, effectiveSourceUserId, targetUserId, game, now, defense) {
    const actor = playerFor(game, effectiveSourceUserId);
    const entry = {
      effectId: effectId(),
      sourceUserId: effectiveSourceUserId,
      targetUserId,
      street: this.#hand().stage,
      maximumTotal: Math.max(0, Number(actor?.bet ?? 0)),
    };
    this.#hand().effects.intimidations.push(entry);
    this.#consume(actorId, now);
    this.#event("intimidation-applied", entry, { visibility: "public" }, now);
    return {
      result: { status: "resolved", skillId: "intimidate", ...entry },
      directives: [
        ...defense.directives,
        { type: HEXTECH_EFFECT_DIRECTIVE_TYPES.RAISE_CAP, ...entry },
        this.#log("恐吓生效：目标下一次加注总额受到限制"),
      ],
    };
  }

  #executeSilence(actorId, effectiveSourceUserId, targetUserId, game, now, defense) {
    const entry = {
      effectId: effectId(),
      sourceUserId: effectiveSourceUserId,
      targetUserId,
      street: this.#hand().stage,
    };
    this.#hand().effects.silences.push(entry);
    this.#consume(actorId, now);
    this.#event("silence-applied", entry, { visibility: "public" }, now);
    return {
      result: { status: "resolved", skillId: "silence", ...entry },
      directives: [
        ...defense.directives,
        { type: HEXTECH_EFFECT_DIRECTIVE_TYPES.SKILL_LOCK, ...entry },
        this.#log("沉默生效：目标本街不能主动发动公共技能"),
      ],
    };
  }

  #executePeaceTreaty(actorId, effectiveSourceUserId, targetUserId, game, now, defense) {
    const entry = {
      effectId: effectId(),
      sourceUserId: effectiveSourceUserId,
      targetUserId,
      userIds: [effectiveSourceUserId, targetUserId],
      street: this.#hand().stage,
    };
    this.#hand().effects.peaceTreaties.push(entry);
    this.#consume(actorId, now);
    this.#event("peace-treaty-applied", entry, { visibility: "public" }, now);
    return {
      result: { status: "resolved", skillId: "peace-treaty", ...entry },
      directives: [
        ...defense.directives,
        { type: HEXTECH_EFFECT_DIRECTIVE_TYPES.MUTUAL_RAISE_LOCK, ...entry },
        this.#log("和平条约生效：双方本街不能加注"),
      ],
    };
  }

  #executeDisarm(actorId, targetUserId, game, now, defense) {
    const targetEquipment = this.#equipment(targetUserId);
    if (targetEquipment.status !== "available" || isPassiveCatalogSkill(targetEquipment.skillId)
      || isReactionCatalogSkill(targetEquipment.skillId)) {
      throw new HextechEffectError("目标装备已经不能被缴械", "invalid_hextech_target");
    }
    targetEquipment.status = "disabled";
    targetEquipment.disabledByUserId = actorId;
    this.#rotateWindow(targetUserId, {
      state: "consumed",
      validTargetUserIds: [],
      expiresAt: null,
      disabledReason: "本手装备已被缴械",
      pendingTargetUserId: null,
    });
    const entry = {
      effectId: effectId(),
      sourceUserId: actorId,
      targetUserId,
      disabledSkillId: targetEquipment.skillId,
      compensation: 80,
    };
    this.#hand().effects.disarms.push(entry);
    this.#consume(actorId, now);
    this.#event("equipment-disarmed", entry, { visibility: "public" }, now);
    return {
      result: { status: "resolved", skillId: "disarm", ...entry },
      directives: [
        ...defense.directives,
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.DISABLE_EQUIPMENT,
          userId: targetUserId,
          skillId: targetEquipment.skillId,
          sourceUserId: actorId,
        },
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT,
          userId: targetUserId,
          amount: 80,
          label: "缴械补偿",
        },
        this.#log("缴械生效：目标装备失效，并从银行获得 80 筹码"),
      ],
    };
  }

  #triggerCharm(actorId, game, now) {
    const hand = this.#hand();
    const sourceWindow = hand.windows[actorId];
    const targetUserId = sourceWindow?.pendingTargetUserId;
    if (!targetUserId || !this.#isCallableTarget(targetUserId, game)) {
      this.#consume(actorId, now, "魅惑目标在全押时已失效");
      this.#event("charm-fizzled", { actorId, targetUserId }, { visibility: "public" }, now);
      return [this.#log("魅惑目标已失效，本次效果未生效")];
    }
    const defense = this.#automaticDefense(actorId, targetUserId, "charm", game, now);
    if (defense.blocked || defense.reflected) {
      this.#consume(actorId, now);
      return [...defense.directives, this.#log("魅惑被防御技能解除")];
    }
    const target = playerFor(game, targetUserId);
    const maximumAmount = Math.min(
      600,
      roundDownChips(Number(target.startingStack ?? target.stack) * 0.3),
      Number(target.stack ?? 0),
    );
    if (maximumAmount < CHIP_UNIT) {
      this.#consume(actorId, now, "目标没有可用于强制跟注的筹码");
      this.#event("charm-fizzled", { actorId, targetUserId }, { visibility: "public" }, now);
      return [this.#log("魅惑目标没有可用于强制跟注的筹码")];
    }
    const forcedCall = {
      effectId: effectId(),
      sourceUserId: actorId,
      targetUserId,
      maximumAmount,
      street: hand.stage,
    };
    hand.effects.forcedCalls.push(forcedCall);
    const targetEquipment = hand.equipments[targetUserId];
    if (targetEquipment?.skillId === "escape" && targetEquipment.status === "available") {
      const escapeCost = Math.max(80, Math.min(160, roundDownChips(Number(target.stack ?? 0) * 0.1)));
      // Like the classic time-extension purchase, a bank fee may not silently
      // turn the current actor into a zero-stack all-in outside poker action
      // settlement. An unaffordable reaction simply remains unused.
      if (Number(target.stack ?? 0) < escapeCost + CHIP_UNIT) {
        this.#consume(actorId, now);
        this.#event("forced-call-created", forcedCall, { visibility: "public" }, now);
        return [
          ...defense.directives,
          {
            type: HEXTECH_EFFECT_DIRECTIVE_TYPES.FORCED_CALL,
            userId: targetUserId,
            sourceUserId: actorId,
            maximumAmount,
            label: "魅惑强制跟注",
          },
          this.#log("目标筹码不足以支付金蝉脱壳，魅惑强制跟注生效"),
        ];
      }
      const reaction = {
        reactionId: effectId(),
        sourceUserId: actorId,
        targetUserId,
        sourceSkillId: "charm",
        reactionSkillId: "escape",
        options: ["escape", "decline"],
        selectedOption: null,
        expiresAt: now + REACTION_WINDOW_MS,
        escapeCost,
        forcedCall,
      };
      hand.activeReaction = reaction;
      this.#equipment(actorId).status = "resolving";
      this.#rotateWindow(actorId, {
        state: "resolving",
        disabledReason: "等待目标的 4 秒反应窗口",
        expiresAt: reaction.expiresAt,
      });
      this.#rotateWindow(targetUserId, {
        state: "armed",
        disabledReason: null,
        expiresAt: reaction.expiresAt,
        maximumChipRisk: escapeCost,
        pendingReactionOption: null,
      });
      this.#event(
        "reaction-opened",
        { reactionId: reaction.reactionId, sourceUserId: actorId, targetUserId, expiresAt: reaction.expiresAt },
        { visibility: "public" },
        now,
      );
      return [
        ...defense.directives,
        {
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.OPEN_REACTION,
          reactionId: reaction.reactionId,
          sourceUserId: actorId,
          targetUserId,
          sourceSkillId: "charm",
          reactionSkillId: "escape",
          options: [...reaction.options],
          expiresAt: reaction.expiresAt,
          maximumChipRisk: escapeCost,
        },
        this.#log("魅惑已触发，目标有 4 秒决定是否使用金蝉脱壳"),
      ];
    }
    this.#consume(actorId, now);
    this.#event("forced-call-created", forcedCall, { visibility: "public" }, now);
    return [
      ...defense.directives,
      {
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.FORCED_CALL,
        userId: targetUserId,
        sourceUserId: actorId,
        maximumAmount,
        label: "魅惑强制跟注",
      },
      this.#log(`魅惑生效：目标强制跟注，上限 ${maximumAmount}`),
    ];
  }

  #resolveActiveReaction(option, game, now, options = {}) {
    const reaction = this.#hand().activeReaction;
    if (!reaction) return [];
    if (reaction.sourceSkillId === "charm") {
      return this.#resolveCharmReaction(option, game, now, options);
    }
    if (reaction.reactionSkillId === "check-raise-hunter") {
      return this.#resolveCheckRaiseHunterReaction(option, game, now, options);
    }
    throw new HextechEffectError("反应效果没有服务端裁决器", "hextech_skill_not_implemented");
  }

  #queueCheckRaiseReactions(checkRaiserUserId, street, game, now) {
    const hand = this.#hand();
    if (game.stage === "finished") return [];
    const candidates = playerList(game)
      .filter((player) => player.userId !== checkRaiserUserId && !player.folded)
      .filter((player) => {
        const equipment = hand.equipments[player.userId];
        if (!equipment || equipment.skillId !== "check-raise-hunter" || equipment.status !== "available") return false;
        const seen = hand.actionMemory.checkRaiseSeenByUserId[player.userId] ?? [];
        return !seen.includes(street);
      })
      .sort((left, right) => Number(left.seat ?? 0) - Number(right.seat ?? 0));
    for (const hunter of candidates) {
      hand.actionMemory.checkRaiseSeenByUserId[hunter.userId] = [
        ...(hand.actionMemory.checkRaiseSeenByUserId[hunter.userId] ?? []),
        street,
      ];
      hand.reactionQueue.push({
        reactionId: effectId(),
        sourceUserId: checkRaiserUserId,
        targetUserId: hunter.userId,
        sourceSkillId: "check-raise-hunter",
        reactionSkillId: "check-raise-hunter",
        street,
        queuedAt: now,
      });
    }
    return this.#openNextQueuedReaction(game, now);
  }

  #openNextQueuedReaction(game, now) {
    const hand = this.#hand();
    if (hand.activeReaction) return [];
    while (hand.reactionQueue.length) {
      const queued = hand.reactionQueue.shift();
      const hunter = playerFor(game, queued.targetUserId);
      const checkRaiser = playerFor(game, queued.sourceUserId);
      const equipment = hand.equipments[queued.targetUserId];
      if (!hunter || hunter.folded || !checkRaiser || checkRaiser.folded
        || !equipment || equipment.skillId !== "check-raise-hunter" || equipment.status !== "available") {
        continue;
      }
      const reaction = {
        ...queued,
        options: ["hunt", "decline"],
        selectedOption: null,
        expiresAt: now + REACTION_WINDOW_MS,
      };
      hand.activeReaction = reaction;
      this.#rotateWindow(queued.targetUserId, {
        state: "armed",
        disabledReason: null,
        expiresAt: reaction.expiresAt,
        maximumChipRisk: 0,
        pendingReactionOption: null,
      });
      this.#event(
        "reaction-opened",
        {
          reactionId: reaction.reactionId,
          sourceUserId: reaction.sourceUserId,
          targetUserId: reaction.targetUserId,
          reactionSkillId: reaction.reactionSkillId,
          expiresAt: reaction.expiresAt,
        },
        { visibility: "public" },
        now,
      );
      return [{
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.OPEN_REACTION,
        reactionId: reaction.reactionId,
        sourceUserId: reaction.sourceUserId,
        targetUserId: reaction.targetUserId,
        sourceSkillId: reaction.sourceSkillId,
        reactionSkillId: reaction.reactionSkillId,
        options: [...reaction.options],
        expiresAt: reaction.expiresAt,
        maximumChipRisk: 0,
      }, this.#log("后手猎人触发：有 4 秒决定是否查看过牌加注者的一张底牌")];
    }
    return [];
  }

  #resolveCheckRaiseHunterReaction(option, game, now, { expired = false } = {}) {
    const hand = this.#hand();
    const reaction = hand.activeReaction;
    if (!reaction || reaction.reactionSkillId !== "check-raise-hunter") return [];
    const directives = [];
    if (option !== "hunt") {
      this.#rotateWindow(reaction.targetUserId, {
        state: "idle",
        disabledReason: "等待合法反应窗口",
        expiresAt: null,
        maximumChipRisk: 0,
        pendingReactionOption: null,
      });
      this.#event(
        "check-raise-hunt-declined",
        { reactionId: reaction.reactionId, hunterUserId: reaction.targetUserId, expired },
        { visibility: "public" },
        now,
      );
      directives.push(this.#log(expired ? "后手猎人反应超时" : "后手猎人放弃本次查看"));
    } else {
      const hunterUserId = reaction.targetUserId;
      const checkRaiserUserId = reaction.sourceUserId;
      const defense = this.#automaticDefense(
        hunterUserId,
        checkRaiserUserId,
        "check-raise-hunter",
        game,
        now,
      );
      directives.push(...defense.directives);
      if (defense.blocked) {
        this.#consume(hunterUserId, now);
        directives.push(this.#log("后手猎人的查看被防御技能抵挡"));
      } else {
        const viewerUserId = defense.reflected ? checkRaiserUserId : hunterUserId;
        const subjectUserId = defense.targetUserId;
        if (this.#consumeSmokeIfAvailable(subjectUserId, now)) {
          this.#consume(hunterUserId, now);
          this.#event(
            "view-failed",
            { actorId: viewerUserId, targetUserId: subjectUserId, skillId: "check-raise-hunter", reason: "obscured" },
            { visibility: "private", userIds: [viewerUserId] },
            now,
          );
          directives.push(this.#log("后手猎人的查看受到未知干扰"));
        } else {
          const cardIndex = this.#randomInt(2);
          const shownCards = this.#maskedCards(subjectUserId, privateCardsFor(game, subjectUserId), now);
          const view = {
            effectId: effectId(),
            sourceSkillId: "check-raise-hunter",
            viewerUserId,
            targetUserId: subjectUserId,
            kind: "one-hole-card",
            cardIndex,
            card: shownCards[cardIndex],
            street: hand.stage,
            expiresAfterActionUserId: viewerUserId,
          };
          hand.effects.privateViews.push(view);
          this.#consume(hunterUserId, now);
          this.#event(
            "private-view-created",
            {
              sourceSkillId: "check-raise-hunter",
              targetUserId: subjectUserId,
              cardIndex,
              card: view.card,
            },
            { visibility: "private", userIds: [viewerUserId] },
            now,
          );
          directives.push({
            type: HEXTECH_EFFECT_DIRECTIVE_TYPES.PRIVATE_REVEAL,
            audienceUserIds: [viewerUserId],
            subjectUserId,
            kind: "one-hole-card",
            cardIndex,
            card: view.card,
            expiresAfterActionUserId: viewerUserId,
          });
          directives.push(this.#log("后手猎人成功查看过牌加注者的一张底牌"));
        }
      }
    }
    hand.activeReaction = null;
    directives.push(...this.#openNextQueuedReaction(game, now));
    return directives;
  }

  #resolveCharmReaction(option, game, now, { expired = false } = {}) {
    const hand = this.#hand();
    const reaction = hand.activeReaction;
    if (!reaction || reaction.sourceSkillId !== "charm") return [];
    const directives = [];
    if (option === "escape") {
      const target = playerFor(game, reaction.targetUserId);
      if (!target || target.stack < reaction.escapeCost + CHIP_UNIT) {
        throw new HextechEffectError("筹码不足，无法使用金蝉脱壳", "insufficient_hextech_chips");
      }
      directives.push({
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.CHARGE_BANK,
        userId: reaction.targetUserId,
        amount: reaction.escapeCost,
        label: "金蝉脱壳",
      });
      this.#consume(reaction.targetUserId, now);
      this.#consume(reaction.sourceUserId, now, "魅惑已被金蝉脱壳解除");
      this.#event(
        "forced-call-escaped",
        { reactionId: reaction.reactionId, targetUserId: reaction.targetUserId, cost: reaction.escapeCost },
        { visibility: "public" },
        now,
      );
      directives.push(this.#log(`金蝉脱壳生效：支付 ${reaction.escapeCost}，解除魅惑强制跟注`));
    } else {
      this.#rotateWindow(reaction.targetUserId, {
        state: "idle",
        disabledReason: "等待合法反应窗口",
        expiresAt: null,
        maximumChipRisk: 0,
        pendingReactionOption: null,
      });
      this.#consume(reaction.sourceUserId, now);
      this.#event(
        "forced-call-created",
        { ...reaction.forcedCall, expired },
        { visibility: "public" },
        now,
      );
      directives.push({
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.FORCED_CALL,
        userId: reaction.targetUserId,
        sourceUserId: reaction.sourceUserId,
        maximumAmount: reaction.forcedCall.maximumAmount,
        label: "魅惑强制跟注",
      });
      directives.push(this.#log(expired ? "金蝉脱壳反应超时，魅惑强制跟注生效" : "目标放弃脱壳，魅惑强制跟注生效"));
    }
    hand.activeReaction = null;
    directives.push(...this.#openNextQueuedReaction(game, now));
    return directives;
  }

  #automaticDefense(actorId, targetUserId, skillId, game, now) {
    const targetEquipment = this.#hand().equipments[targetUserId];
    const directives = [];
    if (!targetEquipment || targetEquipment.status !== "available") {
      return { blocked: false, reflected: false, targetUserId, directives };
    }
    if (targetEquipment.skillId === "shield") {
      this.#consume(targetUserId, now);
      this.#event(
        "skill-blocked",
        { actorId, targetUserId, skillId, defenseSkillId: "shield" },
        { visibility: "public" },
        now,
      );
      directives.push({
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.SKILL_BLOCKED,
        sourceUserId: actorId,
        targetUserId,
        sourceSkillId: skillId,
        defenseSkillId: "shield",
        reflected: false,
      });
      return { blocked: true, reflected: false, targetUserId, defenseSkillId: "shield", directives };
    }
    if (targetEquipment.skillId === "mirror") {
      this.#consume(targetUserId, now);
      const reflected = this.#canReflect(actorId, targetUserId, skillId, game);
      this.#event(
        "skill-blocked",
        { actorId, targetUserId, skillId, defenseSkillId: "mirror", reflected },
        { visibility: "public" },
        now,
      );
      directives.push({
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.SKILL_BLOCKED,
        sourceUserId: actorId,
        targetUserId,
        sourceSkillId: skillId,
        defenseSkillId: "mirror",
        reflected,
      });
      return {
        blocked: !reflected,
        reflected,
        targetUserId: reflected ? actorId : targetUserId,
        defenseSkillId: "mirror",
        directives,
      };
    }
    return { blocked: false, reflected: false, targetUserId, directives };
  }

  #canReflect(actorId, originalTargetUserId, skillId, game) {
    if (["charm", "disarm"].includes(skillId)) return false;
    const actor = playerFor(game, actorId);
    const originalTarget = playerFor(game, originalTargetUserId);
    return Boolean(actor && originalTarget && !actor.folded && !originalTarget.folded && actorId !== originalTargetUserId);
  }

  #consumeSmokeIfAvailable(targetUserId, now) {
    const targetEquipment = this.#hand().equipments[targetUserId];
    if (!targetEquipment || targetEquipment.skillId !== "smoke-bomb" || targetEquipment.status !== "available") {
      return false;
    }
    this.#consume(targetUserId, now);
    this.#event(
      "private-defense-triggered",
      { targetUserId, defenseSkillId: "smoke-bomb" },
      { visibility: "private", userIds: [targetUserId] },
      now,
    );
    return true;
  }

  #maskedCards(targetUserId, realCards, now) {
    const targetEquipment = this.#hand().equipments[targetUserId];
    if (!targetEquipment || targetEquipment.status !== "available") return [...realCards];
    if (!(["fake-weak", "fake-strong"].includes(targetEquipment.skillId))) return [...realCards];
    const maskSkillId = targetEquipment.skillId;
    this.#markCheat(targetUserId, maskSkillId);
    this.#consume(targetUserId, now);
    this.#event(
      "private-mask-triggered",
      { targetUserId, skillId: maskSkillId },
      { visibility: "private", userIds: [targetUserId] },
      now,
    );
    return maskSkillId === "fake-weak" ? ["7c", "2d"] : ["As", "Ah"];
  }

  #validatedChoices(skillId, rawChoices) {
    const steps = choiceStepsFor(skillId);
    if (!steps.length) {
      if (rawChoices != null && (!rawChoices || typeof rawChoices !== "object"
        || Array.isArray(rawChoices) || Object.keys(rawChoices).length > 0)) {
        throw new HextechEffectError("该技能不接受额外选择", "invalid_hextech_choice");
      }
      return {};
    }
    if (!rawChoices || typeof rawChoices !== "object" || Array.isArray(rawChoices)) {
      throw new HextechEffectError("请完成技能所需的全部选择", "invalid_hextech_choice");
    }
    const allowedIds = new Set(steps.map(({ id }) => id));
    if (Object.keys(rawChoices).some((id) => !allowedIds.has(id))) {
      throw new HextechEffectError("技能选择包含未知字段", "invalid_hextech_choice");
    }
    const choices = {};
    for (const step of steps) {
      if (step.kind !== "enum" || !Array.isArray(step.options)
        || !step.options.some((option) => Object.is(option, rawChoices[step.id]))) {
        throw new HextechEffectError(`技能选择“${step.label ?? step.id}”不正确`, "invalid_hextech_choice");
      }
      choices[step.id] = rawChoices[step.id];
    }
    return choices;
  }

  #validTargets(actorId, skillId, game) {
    const hand = this.#hand();
    return playerList(game)
      .filter((player) => (
        hand.playerUserIds.includes(player.userId)
        && player.userId !== actorId
        && !player.folded
      ))
      .filter((player) => {
        if (skillId === "charm") return this.#isCallableTarget(player.userId, game);
        if (skillId === "intimidate") return !player.allIn && player.stack > 0;
        if (skillId === "disarm") {
          const equipment = hand.equipments[player.userId];
          return Boolean(equipment
            && equipment.status === "available"
            && !isPassiveCatalogSkill(equipment.skillId)
            && !isReactionCatalogSkill(equipment.skillId));
        }
        return true;
      })
      .map((player) => player.userId);
  }

  #isCallableTarget(userId, game) {
    const player = playerFor(game, userId);
    return Boolean(player && !player.folded && !player.allIn && player.stack >= CHIP_UNIT);
  }

  #assertTiming(actorId, skillId, game, now) {
    const stage = game.stage;
    const actor = playerFor(game, actorId);
    if (!actor || actor.folded || actor.allIn || !ACTIVE_STAGES.has(stage)) {
      throw new HextechEffectError("当前玩家不能发动技能", "invalid_hextech_skill_timing");
    }
    const isOwnAction = actingUserId(game) === actorId;
    const activation = hextechSkill(skillId)?.rules?.activation;
    if (Array.isArray(activation?.legalStreets) && !activation.legalStreets.includes(stage)) {
      throw new HextechEffectError("当前街道不能发动该技能", "invalid_hextech_skill_timing");
    }
    if ((activation?.requiresOwnAction || ["charm", "last-stand"].includes(skillId)) && !isOwnAction) {
      throw new HextechEffectError("只能在自己的行动前发动该技能", "invalid_hextech_skill_timing");
    }
    if (["silence", "raise-cap"].includes(skillId)
      && now > this.#hand().streetStartedAt + STREET_START_WINDOW_MS) {
      throw new HextechEffectError("该技能只能在本街开始窗口发动", "invalid_hextech_skill_timing");
    }
    if (skillId === "river-veto") {
      if (this.#hand().effects.riverVetoUsedByUserId) {
        throw new HextechEffectError("本手全桌已经使用过河牌否决", "hextech_table_skill_consumed");
      }
      if (!Array.isArray(game.community) || game.community.length !== 5) {
        throw new HextechEffectError("当前没有可否决的河牌", "invalid_hextech_skill_timing");
      }
    }
    if (skillId === "pot-bomb" && potFor(game) >= 800) {
      throw new HextechEffectError("底池已经达到 800，错过了埋设底池炸弹的时机", "invalid_hextech_skill_timing");
    }
    if (skillId === "last-stand") {
      const averageStartingStack = playerList(game)
        .reduce((sum, player) => sum + Number(player.startingStack ?? 0), 0) / playerList(game).length;
      if (Number(actor.startingStack ?? 0) >= averageStartingStack * 0.35) {
        throw new HextechEffectError("起手筹码需低于桌均的 35% 才能发动背水一战", "invalid_hextech_skill_timing");
      }
    }
    if (skillId === "insurance" && Number(actor.stack ?? 0) < 60 + CHIP_UNIT) {
      throw new HextechEffectError("筹码不足，无法购买保险并继续行动", "insufficient_hextech_chips");
    }
    if (skillId === "fixed-deposit" && Number(actor.stack ?? 0) < 200 + CHIP_UNIT) {
      throw new HextechEffectError("筹码不足，无法锁定定期存款并继续行动", "insufficient_hextech_chips");
    }
  }

  #assertNotSilenced(actorId) {
    const hand = this.#hand();
    if (hand.effects.silences.some((entry) => entry.targetUserId === actorId && entry.street === hand.stage)) {
      throw new HextechEffectError("你本街受到沉默，不能主动发动公共技能", "hextech_skill_silenced");
    }
  }

  #disabledReason(userId, game, now) {
    const hand = this.#hand();
    const equipment = hand.equipments[userId];
    if (!equipment) return "本手未装备公共技能";
    if (equipment.status !== "available") return equipment.status === "disabled" ? "本手装备已被缴械" : "本手已经发动";
    if (REACTION_SKILL_IDS.has(equipment.skillId)) return "等待合法反应窗口";
    if (PASSIVE_SKILL_IDS.has(equipment.skillId)) return null;
    if (!IMPLEMENTED_SKILL_IDS.has(equipment.skillId)) return "该技能效果尚未接入当前服务端批次";
    try {
      this.#assertNotSilenced(userId);
      this.#assertTiming(userId, equipment.skillId, game, now);
      if (requiresOpponentTarget(equipment.skillId)
        && !this.#validTargets(userId, equipment.skillId, game).length) return "当前没有合法技能目标";
      return null;
    } catch (error) {
      return error instanceof HextechEffectError ? error.message : "当前不能发动技能";
    }
  }

  #triggerAllInProtections(userId, now) {
    const hand = this.#hand();
    for (const entry of hand.effects.lastStands.filter((candidate) => (
      candidate.sourceUserId === userId && candidate.status === "armed"
    ))) {
      entry.status = "triggered";
      entry.triggeredAt = now;
      const equipment = hand.equipments[userId];
      if (equipment?.skillId === "last-stand" && equipment.status === "armed") {
        equipment.status = "resolving";
        this.#rotateWindow(userId, {
          state: "resolving",
          disabledReason: "全押保障已锁定，等待本手结算",
          expiresAt: null,
        });
      }
      this.#event("last-stand-triggered", { userId, effectId: entry.effectId }, { visibility: "public" }, now);
    }
    for (const entry of hand.effects.insurances.filter((candidate) => (
      candidate.sourceUserId === userId && candidate.status === "armed"
    ))) {
      entry.status = "triggered";
      entry.triggeredAt = now;
      this.#event("insurance-triggered", { userId, effectId: entry.effectId }, { visibility: "public" }, now);
    }
  }

  #triggerPotBombs(game, now) {
    const hand = this.#hand();
    const currentPot = potFor(game);
    const directives = [];
    for (const entry of hand.effects.potBombs.filter((candidate) => (
      candidate.status === "armed" && currentPot >= candidate.threshold
    ))) {
      entry.status = "triggered";
      entry.triggeredAt = now;
      const equipment = hand.equipments[entry.sourceUserId];
      if (equipment?.skillId === "pot-bomb" && equipment.status === "armed") this.#consume(entry.sourceUserId, now);
      this.#event(
        "pot-bomb-triggered",
        { sourceUserId: entry.sourceUserId, threshold: entry.threshold, pot: currentPot },
        { visibility: "public" },
        now,
      );
      directives.push({
        type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_POT,
        sourceUserId: entry.sourceUserId,
        amount: entry.bankContribution,
        label: "底池炸弹",
      });
      directives.push(this.#log(`底池达到 ${entry.threshold}，底池炸弹触发：银行加入 ${entry.bankContribution}`));
    }
    return directives;
  }

  #settleFixedDeposit(entry, returnAmount, resolution, now) {
    if (entry.status !== "locked") return [];
    entry.status = "settled";
    entry.resolvedAt = now;
    entry.returnAmount = returnAmount;
    entry.resolution = resolution;
    this.#event(
      "fixed-deposit-settled",
      {
        sourceUserId: entry.sourceUserId,
        principal: entry.principal,
        returnAmount,
        resolution,
      },
      { visibility: "public" },
      now,
    );
    return [{
      type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT,
      userId: entry.sourceUserId,
      amount: returnAmount,
      label: resolution === "early-fold" ? "定期存款提前支取" : "定期存款到期",
    }, this.#log(resolution === "early-fold"
      ? "定期存款提前弃牌，返还 180"
      : "定期存款坚持到期，返还 230")];
  }

  #resolveFoldedFixedDeposits(game, now) {
    const directives = [];
    for (const entry of this.#hand().effects.fixedDeposits.filter((candidate) => candidate.status === "locked")) {
      if (playerFor(game, entry.sourceUserId)?.folded) {
        directives.push(...this.#settleFixedDeposit(entry, 180, "early-fold", now));
      }
    }
    return directives;
  }

  #resolveMatureFixedDeposits(game, now) {
    const directives = [];
    for (const entry of this.#hand().effects.fixedDeposits.filter((candidate) => candidate.status === "locked")) {
      const player = playerFor(game, entry.sourceUserId);
      if (player && !player.folded) directives.push(...this.#settleFixedDeposit(entry, 230, "river", now));
    }
    return directives;
  }

  #headToHeadWinner(leftUserId, rightUserId, game) {
    if (game.finishedReason !== "showdown" || !Array.isArray(game.community) || game.community.length < 5) return null;
    const left = playerFor(game, leftUserId);
    const right = playerFor(game, rightUserId);
    if (!left || !right || left.folded || right.folded) return null;
    try {
      const leftHand = Hand.solve([...privateCardsFor(game, leftUserId), ...game.community].filter((card) => card !== "BLANK"));
      const rightHand = Hand.solve([...privateCardsFor(game, rightUserId), ...game.community].filter((card) => card !== "BLANK"));
      const winners = Hand.winners([leftHand, rightHand]);
      if (winners.length !== 1) return null;
      return winners[0] === leftHand ? leftUserId : rightUserId;
    } catch {
      return null;
    }
  }

  #handCategoryFor(userId, game) {
    if (!Array.isArray(game.community) || game.community.length < 3) return null;
    try {
      const solved = Hand.solve([...privateCardsFor(game, userId), ...game.community].filter((card) => card !== "BLANK"));
      return HAND_CATEGORY_BY_SOLVER_NAME[solved.name] ?? null;
    } catch {
      return null;
    }
  }

  #pokerLossFor(userId, game) {
    const player = playerFor(game, userId);
    const won = Array.isArray(game.winners)
      ? Number(game.winners.find((winner) => winner.userId === userId)?.amount ?? 0)
      : 0;
    return Math.max(0, Number(player?.totalCommitted ?? 0) - won);
  }

  #settleFinishedHand(game, now) {
    const hand = this.#hand();
    if (hand.activeReaction || hand.reactionQueue.length) {
      this.#event(
        "outstanding-reactions-canceled",
        { activeReactionId: hand.activeReaction?.reactionId ?? null, queuedCount: hand.reactionQueue.length },
        { visibility: "public" },
        now,
      );
      hand.activeReaction = null;
      hand.reactionQueue = [];
    }
    const directives = [
      ...this.#triggerPotBombs(game, now),
      ...this.#resolveFoldedFixedDeposits(game, now),
    ];
    for (const entry of hand.effects.fixedDeposits.filter((candidate) => candidate.status === "locked")) {
      directives.push(...this.#settleFixedDeposit(entry, 230, "hand-survived", now));
    }

    for (const entry of hand.effects.lastStands.filter((candidate) => candidate.status === "triggered")) {
      const loss = this.#pokerLossFor(entry.sourceUserId, game);
      const refund = Math.min(300, roundDownChips(loss * 0.25));
      entry.status = "settled";
      entry.lossAtSettlement = loss;
      entry.refund = refund;
      const equipment = hand.equipments[entry.sourceUserId];
      if (equipment?.skillId === "last-stand" && equipment.status === "resolving") this.#consume(entry.sourceUserId, now);
      this.#event(
        "last-stand-settled",
        { sourceUserId: entry.sourceUserId, loss, refund },
        { visibility: "public" },
        now,
      );
      if (refund >= CHIP_UNIT) {
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT,
          userId: entry.sourceUserId,
          amount: refund,
          label: "背水一战返还",
        });
        directives.push(this.#log(`背水一战结算：返还 ${refund}`));
      }
    }

    for (const entry of hand.effects.insurances.filter((candidate) => candidate.status === "triggered")) {
      const loss = this.#pokerLossFor(entry.sourceUserId, game);
      const refund = Math.min(300, roundDownChips(loss * 0.25));
      entry.status = "settled";
      entry.lossAtSettlement = loss;
      entry.refund = refund;
      this.#event(
        "insurance-settled",
        { sourceUserId: entry.sourceUserId, loss, refund },
        { visibility: "public" },
        now,
      );
      if (refund >= CHIP_UNIT) {
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT,
          userId: entry.sourceUserId,
          amount: refund,
          label: "保险单赔付",
        });
        directives.push(this.#log(`保险单结算：返还 ${refund}`));
      }
    }

    for (const entry of hand.effects.duelContracts.filter((candidate) => candidate.status === "armed")) {
      const winnerUserId = this.#headToHeadWinner(entry.sourceUserId, entry.targetUserId, game);
      entry.status = "settled";
      entry.winnerUserId = winnerUserId;
      this.#event(
        "duel-contract-settled",
        { sourceUserId: entry.sourceUserId, targetUserId: entry.targetUserId, winnerUserId },
        { visibility: "public" },
        now,
      );
      if (winnerUserId) {
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT,
          userId: winnerUserId,
          amount: 180,
          label: "单挑契约胜利",
        });
        directives.push(this.#log("单挑契约完成：胜者从银行获得 180"));
      }
    }

    for (const entry of hand.effects.bounties.filter((candidate) => candidate.status === "armed")) {
      const winnerUserId = this.#headToHeadWinner(entry.sourceUserId, entry.targetUserId, game);
      const reward = winnerUserId === entry.sourceUserId ? 180 : winnerUserId === entry.targetUserId ? 80 : 0;
      entry.status = "settled";
      entry.winnerUserId = winnerUserId;
      entry.reward = reward;
      this.#event(
        "bounty-settled",
        { sourceUserId: entry.sourceUserId, targetUserId: entry.targetUserId, winnerUserId, reward },
        { visibility: "public" },
        now,
      );
      if (winnerUserId && reward) {
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT,
          userId: winnerUserId,
          amount: reward,
          label: "悬赏令结算",
        });
        directives.push(this.#log(`悬赏令完成：胜者从银行获得 ${reward}`));
      }
    }

    for (const entry of hand.effects.handPredictions.filter((candidate) => candidate.status === "pending")) {
      const actualHandCategory = this.#handCategoryFor(entry.sourceUserId, game);
      const success = actualHandCategory != null && actualHandCategory === entry.handCategory;
      entry.status = "settled";
      entry.actualHandCategory = actualHandCategory;
      entry.success = success;
      this.#event(
        "hand-prediction-settled",
        {
          sourceUserId: entry.sourceUserId,
          predictedHandCategory: entry.handCategory,
          actualHandCategory,
          success,
        },
        { visibility: "public" },
        now,
      );
      if (success) {
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT,
          userId: entry.sourceUserId,
          amount: 240,
          label: "牌型预报命中奖励",
        });
        directives.push(this.#log("牌型预报命中，从银行获得 240"));
      } else {
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.CHARGE_POT,
          userId: entry.sourceUserId,
          amount: 60,
          allowPartial: true,
          label: "牌型预报失败",
        });
        directives.push(this.#log("牌型预报未命中，向已结算底池支付 60（不足时支付剩余筹码）"));
      }
    }

    const settledPot = settledPotFor(game);
    const winnerIds = new Set((game.winners ?? []).map((winner) => winner.userId));
    if (game.finishedReason === "showdown" && settledPot >= 800) {
      for (const [userId, equipment] of Object.entries(hand.equipments)) {
        const player = playerFor(game, userId);
        if (equipment.skillId !== "stop-loss" || equipment.status !== "available"
          || winnerIds.has(userId) || !player || player.folded) continue;
        this.#consume(userId, now);
        this.#event(
          "stop-loss-settled",
          { sourceUserId: userId, settledPot, refund: 100 },
          { visibility: "public" },
          now,
        );
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT,
          userId,
          amount: 100,
          label: "止损协议返还",
        });
        directives.push(this.#log("止损协议触发：摊牌输掉至少 800 的底池，返还 100"));
      }
    }
    return directives;
  }

  #advanceStage(game, now) {
    const hand = this.#hand();
    if (game.stage === hand.stage) return [];
    const directives = [];
    if (hand.stage === "preflop" && Array.isArray(game.community) && game.community.length >= 3) {
      directives.push(...this.#resolveProphecies(game, now));
    }
    if ((game.stage === "river" || (Array.isArray(game.community) && game.community.length >= 5))) {
      directives.push(...this.#resolveMatureFixedDeposits(game, now));
    }
    directives.push(...this.#triggerPotBombs(game, now));
    this.#syncStage(game.stage, now);
    return directives;
  }

  #resolveProphecies(game, now) {
    const hand = this.#hand();
    const flop = Array.isArray(game.community) ? game.community.slice(0, 3) : [];
    if (flop.length !== 3) return [];
    const suitNames = { c: "clubs", d: "diamonds", h: "hearts", s: "spades" };
    const counts = new Map();
    for (const card of flop) {
      const suit = typeof card === "string" ? suitNames[card.slice(-1)] : null;
      if (suit) counts.set(suit, (counts.get(suit) ?? 0) + 1);
    }
    let actualMajoritySuit = null;
    for (const [suit, count] of counts) {
      if (count >= 2) actualMajoritySuit = suit;
    }
    const directives = [];
    for (const prediction of hand.effects.predictions.filter((entry) => entry.status === "pending")) {
      const success = actualMajoritySuit != null && prediction.suit === actualMajoritySuit;
      prediction.status = "resolved";
      prediction.resolvedAt = now;
      prediction.actualMajoritySuit = actualMajoritySuit;
      prediction.success = success;
      this.#event(
        "prophecy-resolved",
        {
          sourceUserId: prediction.sourceUserId,
          predictedSuit: prediction.suit,
          actualMajoritySuit,
          success,
        },
        { visibility: "public" },
        now,
      );
      if (success) {
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT,
          userId: prediction.sourceUserId,
          amount: 160,
          label: "预言家命中奖励",
        });
        directives.push(this.#log("预言家命中翻牌多数花色，从银行获得 160 筹码"));
      } else {
        directives.push({
          type: HEXTECH_EFFECT_DIRECTIVE_TYPES.CHARGE_POT,
          userId: prediction.sourceUserId,
          amount: 80,
          allowPartial: true,
          label: "预言家预测失败",
        });
        directives.push(this.#log("预言家未命中翻牌多数花色，向底池支付 80 筹码（不足时支付剩余筹码）"));
      }
    }
    return directives;
  }

  #syncStage(nextStage, now) {
    const hand = this.#hand();
    if (nextStage === hand.stage) return;
    const previousStage = hand.stage;
    hand.effects.privateViews = hand.effects.privateViews.filter((entry) => entry.street !== previousStage);
    hand.effects.intimidations = hand.effects.intimidations.filter((entry) => entry.street !== previousStage);
    hand.effects.silences = hand.effects.silences.filter((entry) => entry.street !== previousStage);
    hand.effects.peaceTreaties = hand.effects.peaceTreaties.filter((entry) => entry.street !== previousStage);
    hand.effects.globalRaiseCaps = hand.effects.globalRaiseCaps.filter((entry) => entry.street !== previousStage);
    for (const [userId, checkedStreet] of Object.entries(hand.actionMemory.checkedStreetsByUserId)) {
      if (checkedStreet === previousStage) delete hand.actionMemory.checkedStreetsByUserId[userId];
    }
    hand.stage = nextStage;
    hand.streetStartedAt = now;
    this.#event("street-changed", { from: previousStage, to: nextStage }, { visibility: "public" }, now);
  }

  #tendencyFor(targetUserId, game) {
    if (typeof game.publicTendencyFor === "function") {
      const serverValue = game.publicTendencyFor(targetUserId);
      if (["保守", "跟随", "进攻"].includes(serverValue)) return serverValue;
    }
    const counts = this.#hand().behaviorByUserId[targetUserId] ?? {};
    const conservative = Number(counts.folds ?? 0) + Number(counts.checks ?? 0);
    const following = Number(counts.calls ?? 0);
    const aggressive = Number(counts.raises ?? 0);
    if (aggressive > 0 && aggressive >= following && aggressive >= conservative) return "进攻";
    if (following > 0 && following >= conservative) return "跟随";
    return "保守";
  }

  #random() {
    const value = Number(this.rng.random());
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new HextechEffectError("服务端随机源返回值不正确", "invalid_server_rng");
    }
    return value;
  }

  #randomInt(maximum) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new HextechEffectError("随机范围不正确", "invalid_server_rng_range");
    }
    if (this.rng.randomInt) {
      const value = this.rng.randomInt(maximum);
      if (Number.isSafeInteger(value) && value >= 0 && value < maximum) return value;
      throw new HextechEffectError("服务端整数随机源返回值不正确", "invalid_server_rng");
    }
    return Math.floor(this.#random() * maximum);
  }

  #log(text) {
    return { type: HEXTECH_EFFECT_DIRECTIVE_TYPES.LOG, text };
  }
}

export function createHextechEffectsEngine(options = {}) {
  return HextechEffectsEngine.create(options);
}

export function restoreHextechEffectsEngine(state, options = {}) {
  return HextechEffectsEngine.restore(state, options);
}
