import {
  WENGWENGWEN_COMMANDS,
  WENGWENGWEN_EVENTS,
  WENGWENGWEN_RULES,
  WENGWENGWEN_RULES_VERSION,
  assertValidWengwengwenRules,
} from "../shared/hextech-wengwengwen.js";

const VALID_STREETS = new Set(["preflop", "flop", "turn", "river"]);
const VALID_ACTIONS = new Set(["check", "call", "bet", "raise", "all-in", "fold"]);
const MAX_RECEIPTS = 256;
const MAX_EVENTS = 96;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} 不能为空`);
  return normalized;
}

function nonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是非负数`);
  return value;
}

function normalizeCardIds(value) {
  if (!Array.isArray(value) || value.length !== 2
    || value.some((cardId) => typeof cardId !== "string" || !/^(?:[2-9TJQKA][cdhs]|blank)$/.test(cardId))) {
    throw new Error("服务端展示牌必须是两张合法牌");
  }
  return [...value];
}

function progressTargets() {
  return Object.fromEntries(WENGWENGWEN_RULES.growth.counters.map(({ id }) => [id, 0]));
}

function freshHand() {
  return {
    handId: null,
    handNumber: 0,
    resourceGained: false,
    activeUsed: false,
    awakeningRefundUsed: false,
    latestAggressor: null,
    chasedAggressorUserId: null,
    reveal: null,
    awaitingImmediateAction: false,
  };
}

function initialState(userId) {
  return {
    version: WENGWENGWEN_RULES_VERSION,
    userId: requiredString(userId, "userId"),
    eventSeq: 0,
    resource: WENGWENGWEN_RULES.resource.initial,
    awakened: false,
    progress: progressTargets(),
    progressMeta: { huntHandIds: [] },
    hand: freshHand(),
    events: [],
    receipts: [],
  };
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== WENGWENGWEN_RULES_VERSION) {
    throw new Error("嗡嗡文状态版本不兼容");
  }
  const restored = clone(snapshot);
  restored.userId = requiredString(restored.userId, "userId");
  restored.eventSeq = Math.max(0, Number(restored.eventSeq) || 0);
  restored.resource = nonNegative(Number(restored.resource), "月痕");
  if (restored.resource > WENGWENGWEN_RULES.resource.maximum) throw new Error("月痕超过上限");
  restored.awakened = Boolean(restored.awakened);
  restored.progress = { ...progressTargets(), ...(restored.progress ?? {}) };
  restored.progressMeta = {
    huntHandIds: Array.isArray(restored.progressMeta?.huntHandIds)
      ? [...new Set(restored.progressMeta.huntHandIds.map(String))].slice(-15)
      : [],
  };
  restored.hand = { ...freshHand(), ...(restored.hand ?? {}) };
  restored.events = Array.isArray(restored.events) ? restored.events.slice(-MAX_EVENTS) : [];
  restored.receipts = Array.isArray(restored.receipts) ? restored.receipts.slice(-MAX_RECEIPTS) : [];
  return restored;
}

export class WengwengwenEngine {
  constructor({ userId, snapshot = null, rng = Math.random } = {}) {
    assertValidWengwengwenRules();
    if (typeof rng !== "function") throw new Error("rng 必须是函数");
    this.rng = rng;
    this.state = snapshot ? normalizeSnapshot(snapshot) : initialState(userId);
  }

  exportState() {
    return clone(this.state);
  }

  beginHand({ eventId, handId, handNumber }) {
    return this.#mutate(eventId, () => {
      const normalizedHandId = requiredString(handId, "handId");
      if (!Number.isSafeInteger(handNumber) || handNumber < 1) throw new Error("handNumber 必须是正整数");
      this.state.hand = { ...freshHand(), handId: normalizedHandId, handNumber };
      return { ok: true };
    });
  }

  afterPokerAction(input = {}) {
    return this.#mutate(input.eventId, () => {
      this.#assertHand(input.handId);
      const actorUserId = requiredString(input.actorUserId, "actorUserId");
      const action = requiredString(input.action, "action");
      const street = requiredString(input.street, "street");
      if (!VALID_ACTIONS.has(action)) throw new Error("不支持的扑克动作");
      if (!VALID_STREETS.has(street)) throw new Error("不支持的下注街");
      const bigBlind = nonNegative(Number(input.bigBlind), "大盲");
      if (bigBlind <= 0) throw new Error("大盲必须大于 0");
      const investment = nonNegative(Number(input.investment), "实际投入");
      const isAutomatic = input.automatic === true;
      const aggressive = input.isAggressive === true
        && ["bet", "raise", "all-in"].includes(action)
        && !isAutomatic;

      if (actorUserId !== this.state.userId) {
        if (aggressive && investment >= WENGWENGWEN_RULES.gain.minimumAggressorInvestmentBigBlinds * bigBlind) {
          this.state.hand.latestAggressor = { userId: actorUserId, street, investment };
        }
        return { ok: true };
      }

      this.#resolveImmediateAction({ action, street, investment, bigBlind, isAutomatic, isFullRaise: input.isFullRaise === true });
      this.#gainFromChase({ action, street, investment, bigBlind, isAutomatic, facingUserId: input.facingAggressorUserId });
      return { ok: true };
    });
  }

  afterStreet({ eventId, handId, nextStreet }) {
    return this.#mutate(eventId, () => {
      this.#assertHand(handId);
      if (nextStreet && !VALID_STREETS.has(nextStreet)) throw new Error("下一街不正确");
      this.state.hand.latestAggressor = null;
      this.state.hand.reveal = null;
      this.state.hand.awaitingImmediateAction = false;
      return { ok: true };
    });
  }

  command(input = {}) {
    if (input.type !== WENGWENGWEN_COMMANDS.ACTIVATE_HUNT) throw new Error("未知嗡嗡文人物命令");
    return this.#mutate(input.commandId, () => this.#activateHunt(input));
  }

  settleHand(input = {}) {
    return this.#mutate(input.eventId, () => {
      this.#assertHand(input.handId);
      const result = input.result ?? {};
      const targetUserId = this.state.hand.chasedAggressorUserId;
      if (targetUserId
        && result.reachedShowdown === true
        && Number(result.wonPotAmount) > 0
        && Array.isArray(result.opponentsBeaten)
        && result.opponentsBeaten.includes(targetUserId)) {
        this.state.progress.showdownWinsAgainstAggressor += 1;
      }
      this.#checkAwakening();
      this.state.hand.reveal = null;
      this.state.hand.awaitingImmediateAction = false;
      return { ok: true };
    });
  }

  viewFor(viewerUserId) {
    const ownView = String(viewerUserId) === this.state.userId;
    const privateReveal = ownView && this.state.hand.reveal
      ? {
        targetUserId: this.state.hand.reveal.targetUserId,
        cardId: this.state.hand.reveal.cardId,
        street: this.state.hand.reveal.street,
      }
      : null;
    return {
      userId: this.state.userId,
      characterId: "wengwengwen",
      resource: this.state.resource,
      resourceMaximum: WENGWENGWEN_RULES.resource.maximum,
      awakened: this.state.awakened,
      progress: clone(this.state.progress),
      activeUsed: this.state.hand.activeUsed,
      latestAggressorUserId: this.state.hand.latestAggressor?.userId ?? null,
      reveal: privateReveal,
      recentEvents: this.state.events.slice(-8).map((event) => ({
        eventSeq: event.eventSeq,
        type: event.type,
        payload: event.privateToUserId && !ownView ? {} : clone(event.payload),
      })),
    };
  }

  #activateHunt(input) {
    this.#assertHand(input.handId);
    const street = requiredString(input.street, "street");
    if (!WENGWENGWEN_RULES.active.legalStreets.includes(street)) throw new Error("只能在翻牌圈或转牌圈追猎");
    if (input.isOwnAction !== true || Number(input.toCall) <= 0) throw new Error("必须在自己面对主动进攻时发动");
    if (this.state.hand.activeUsed) throw new Error("本手已经发动过月蚀追猎");
    if (this.state.resource < WENGWENGWEN_RULES.active.cost) throw new Error("月痕不足");
    const latest = this.state.hand.latestAggressor;
    const targetUserId = requiredString(input.targetUserId, "targetUserId");
    if (!latest || latest.street !== street || latest.userId !== targetUserId) {
      throw new Error("目标必须是本街最后一名主动进攻者");
    }
    const displayedCards = normalizeCardIds(input.displayedCards);
    const index = Math.min(1, Math.floor(Math.max(0, Math.min(0.999999, Number(this.rng()))) * 2));
    this.state.resource -= WENGWENGWEN_RULES.active.cost;
    this.state.hand.activeUsed = true;
    this.state.hand.awaitingImmediateAction = true;
    this.state.hand.reveal = {
      targetUserId,
      cardId: displayedCards[index],
      street,
      masked: input.masked === true,
    };
    this.#event(WENGWENGWEN_EVENTS.HUNT_ACTIVATED, { targetUserId }, { privateToUserId: null });
    this.#event(WENGWENGWEN_EVENTS.PRIVATE_CARD_REVEALED, {
      targetUserId,
      cardId: displayedCards[index],
    }, { privateToUserId: this.state.userId });
    return { ok: true, targetUserId };
  }

  #gainFromChase({ action, street, investment, bigBlind, isAutomatic, facingUserId }) {
    const rules = WENGWENGWEN_RULES.gain;
    const latest = this.state.hand.latestAggressor;
    if (this.state.hand.resourceGained || isAutomatic || !rules.legalStreets.includes(street)
      || !rules.validActions.includes(action) || investment < rules.minimumSelfInvestmentBigBlinds * bigBlind
      || !latest || latest.street !== street || latest.userId !== String(facingUserId ?? "")) return;
    this.state.hand.resourceGained = true;
    this.state.hand.chasedAggressorUserId = latest.userId;
    this.state.resource = Math.min(rules.amount + this.state.resource, WENGWENGWEN_RULES.resource.maximum);
    if (!this.state.progressMeta.huntHandIds.includes(this.state.hand.handId)) {
      this.state.progressMeta.huntHandIds.push(this.state.hand.handId);
      this.state.progress.distinctHuntHands = this.state.progressMeta.huntHandIds.length;
    }
    if (street === "turn") this.state.progress.turnHunts += 1;
    this.#event(WENGWENGWEN_EVENTS.RESOURCE_GAINED, { targetUserId: latest.userId, street });
    this.#checkAwakening();
  }

  #resolveImmediateAction({ action, street, investment, bigBlind, isAutomatic, isFullRaise }) {
    if (!this.state.hand.awaitingImmediateAction) return;
    this.state.hand.awaitingImmediateAction = false;
    const qualifies = this.state.awakened
      && !this.state.hand.awakeningRefundUsed
      && !isAutomatic
      && ["raise", "all-in"].includes(action)
      && isFullRaise
      && investment >= WENGWENGWEN_RULES.awakening.minimumRaiseInvestmentBigBlinds * bigBlind
      && this.state.hand.reveal?.street === street;
    if (!qualifies) return;
    this.state.hand.awakeningRefundUsed = true;
    this.state.resource = Math.min(
      WENGWENGWEN_RULES.resource.maximum,
      this.state.resource + WENGWENGWEN_RULES.awakening.resourceRefund,
    );
    this.#event(WENGWENGWEN_EVENTS.FULL_MOON_REFUND, { street });
  }

  #checkAwakening() {
    if (this.state.awakened) return;
    const complete = WENGWENGWEN_RULES.growth.counters.every(({ id, target }) => (
      Number(this.state.progress[id]) >= target
    ));
    if (!complete) return;
    this.state.awakened = true;
    this.#event(WENGWENGWEN_EVENTS.AWAKENED, {});
  }

  #assertHand(handId) {
    if (!this.state.hand.handId || String(handId) !== this.state.hand.handId) {
      throw new Error("嗡嗡文人物命令对应的手牌已过期");
    }
  }

  #event(type, payload, { privateToUserId = null } = {}) {
    this.state.eventSeq += 1;
    this.state.events.push({ eventSeq: this.state.eventSeq, type, payload: clone(payload), privateToUserId });
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
  }

  #mutate(operationId, operation) {
    const id = requiredString(operationId, "operationId");
    const replay = this.state.receipts.find((receipt) => receipt.id === id);
    if (replay) return { ...clone(replay.result), replayed: true };
    const before = clone(this.state);
    try {
      const result = operation() ?? { ok: true };
      const receipt = { id, result: clone(result) };
      this.state.receipts.push(receipt);
      if (this.state.receipts.length > MAX_RECEIPTS) this.state.receipts.shift();
      return { ...clone(result), replayed: false };
    } catch (error) {
      this.state = before;
      throw error;
    }
  }
}

export function createWengwengwenEngine(options) {
  return new WengwengwenEngine(options);
}

export function restoreWengwengwenEngine(snapshot, options = {}) {
  return new WengwengwenEngine({ ...options, snapshot });
}
