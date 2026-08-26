import { randomInt } from "node:crypto";
import {
  HEXTECH_CHARACTER_RULES,
  isHextechCharacterId,
} from "../shared/hextech.js";

export const HEXTECH_CHARACTER_ENGINE_VERSION = 1;
export const HEXTECH_LOAN_OFFER_SECONDS = 10;

export const HEXTECH_CHARACTER_COMMANDS = Object.freeze({
  FENXIANG_ACTIVATE: "fenxiang:activate",
  XU_BARBECUE: "xu:barbecue",
  JIANSHENG_PRESSURE: "jiansheng:pressure",
  YA_ACTIVATE: "ya:activate",
  YA_CHOOSE: "ya:choose",
  QIWAN_ACTIVATE: "qiwan:activate",
  QIWAN_ARM_CHOICE: "qiwan:arm-choice",
  QIWAN_COMMIT: "qiwan:commit",
  ZIGE_OFFER_LOAN: "zige:offer-loan",
  ZIGE_RESPOND_LOAN: "zige:respond-loan",
  ZIGE_REPAY_LOAN: "zige:repay-loan",
  MAO_CLAIM: "mao:claim",
  MAO_CHALLENGE: "mao:challenge",
  MAO_CHOOSE: "mao:choose",
  WENGWENGWEN_ACTIVATE: "wengwengwen:activate-hunt",
  INTERNAL_SUPPLY_CANDIDATES: "internal:supply-character-candidates",
  INTERNAL_RESOLVE_MAO_CHALLENGE: "internal:resolve-mao-challenge",
});

export const HEXTECH_CHARACTER_DIRECTIVES = Object.freeze({
  BANK_AWARD: "bank-award",
  BANK_TO_POT: "bank-to-pot",
  MODIFY_NEXT_STREET_CLOCK: "modify-next-street-clock",
  CAP_NEXT_RAISE_TOTAL: "cap-next-raise-total",
  TRANSFER_CHIPS: "transfer-chips",
  PAY_TO_POT: "pay-to-pot",
  REQUEST_BOARD_CANDIDATES: "request-board-candidates",
  REQUEST_HOLE_CARD_CANDIDATES: "request-hole-card-candidates",
  DEAL_SELECTED_BOARD_CARD: "deal-selected-board-card",
  REPLACE_UPCOMING_RIVER: "replace-upcoming-river",
  REPLACE_HOLE_CARD: "replace-hole-card",
  DEAL_NEXT_SUIT_CARD: "deal-next-suit-card",
  REVEAL_NATURAL_BOARD_CARD: "reveal-natural-board-card",
});

const VALID_ACTIONS = new Set(["check", "call", "bet", "raise", "all-in", "fold"]);
const VALID_STREETS = new Set(["preflop", "flop", "turn", "river"]);
const VALID_SUITS = new Set(["clubs", "diamonds", "hearts", "spades"]);
const LOAN_PRINCIPALS = new Set([200, 300, 400, 500, 600]);
const INTERNAL_COMMAND_TYPES = new Set([
  HEXTECH_CHARACTER_COMMANDS.INTERNAL_SUPPLY_CANDIDATES,
  HEXTECH_CHARACTER_COMMANDS.INTERNAL_RESOLVE_MAO_CHALLENGE,
]);
const MAX_EVENT_LOG = 160;
const MAX_PROCESSED_IDS = 1024;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是非负数`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是正整数`);
  return value;
}

function timestamp(value = Date.now()) {
  if (!Number.isFinite(value) || value < 0) throw new Error("服务端时间不正确");
  return Math.floor(value);
}

function floorToChip(value) {
  return Math.max(0, Math.floor(finiteNumber(value) / 5) * 5);
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    throw new Error(`${label} 必须是非空字符串数组`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} 不能重复`);
  return [...values];
}

function defaultProgress(characterId) {
  return Object.fromEntries(
    HEXTECH_CHARACTER_RULES[characterId].growth.counters.map(({ id }) => [id, 0]),
  );
}

function emptyHandState() {
  return {
    handNumber: 0,
    startingStack: 0,
    averageStartingStack: 0,
    activeUsed: false,
    fenxiangGained: false,
    fenxiangArmed: false,
    xuGainedStreets: [],
    jianshengGained: false,
    jianshengTargetUserIds: [],
    yaEarlyAggressiveAllIn: false,
    qiwanQualifyingRaise: false,
    qiwanGained: false,
    qiwanReplacementCompleted: false,
    maoClaimed: false,
    wengResourceGained: false,
    wengLatestAggressor: null,
    wengChasedAggressorUserId: null,
    wengReveal: null,
    wengAwaitingImmediateAction: false,
    wengAwakeningRefundUsed: false,
  };
}

function createPlayer(input) {
  const userId = String(input?.userId ?? "").trim();
  const characterId = String(input?.characterId ?? "").trim();
  if (!userId) throw new Error("人物玩家 userId 不能为空");
  if (!isHextechCharacterId(characterId)) throw new Error(`未知海克斯人物：${characterId}`);
  const rules = HEXTECH_CHARACTER_RULES[characterId];
  return {
    userId,
    characterId,
    resource: rules.resource.initial,
    awakened: false,
    progress: defaultProgress(characterId),
    progressMeta: {
      xuHands: [],
      jianshengPlayers: [],
      maoAwakeningUsed: false,
      wengHuntHands: [],
    },
    hand: emptyHandState(),
    window: null,
    knownStack: Math.max(0, finiteNumber(input?.chips ?? input?.stack)),
  };
}

function initialState(players) {
  const entries = players.map(createPlayer);
  const userIds = entries.map(({ userId }) => userId);
  const characterIds = entries.map(({ characterId }) => characterId);
  if (new Set(userIds).size !== userIds.length) throw new Error("人物引擎玩家 userId 必须唯一");
  if (new Set(characterIds).size !== characterIds.length) throw new Error("一场内人物必须唯一");
  return {
    version: HEXTECH_CHARACTER_ENGINE_VERSION,
    eventSeq: 0,
    handNumber: 0,
    players: Object.fromEntries(entries.map((entry) => [entry.userId, entry])),
    loans: [],
    eventLog: [],
    processedIds: [],
    nextWindowId: 1,
    nextLoanId: 1,
  };
}

function normalizeRestoredState(snapshot) {
  if (!snapshot || snapshot.version !== HEXTECH_CHARACTER_ENGINE_VERSION) {
    throw new Error("海克斯人物引擎存档版本不兼容");
  }
  const restored = clone(snapshot);
  if (!restored.players || typeof restored.players !== "object") throw new Error("人物引擎存档缺少玩家");
  if (!Number.isSafeInteger(restored.eventSeq) || restored.eventSeq < 0) throw new Error("人物引擎事件序号不合法");
  if (!Number.isSafeInteger(restored.handNumber) || restored.handNumber < 0) throw new Error("人物引擎手数不合法");
  const restoredPlayers = Object.values(restored.players);
  if (new Set(restoredPlayers.map(({ userId }) => userId)).size !== restoredPlayers.length
    || new Set(restoredPlayers.map(({ characterId }) => characterId)).size !== restoredPlayers.length) {
    throw new Error("人物引擎存档玩家或人物重复");
  }
  for (const player of restoredPlayers) {
    if (!player?.userId || !isHextechCharacterId(player.characterId)) throw new Error("人物引擎玩家存档不合法");
    const restoredProgress = player.progress ?? {};
    if (player.characterId === "xu") {
      if (!Object.hasOwn(restoredProgress, "effectiveLateInvestments")
        && Number.isFinite(restoredProgress.lateValidActions)) {
        restoredProgress.effectiveLateInvestments = Math.max(0, restoredProgress.lateValidActions);
      }
      if (!Object.hasOwn(restoredProgress, "distinctHandsWithEffectiveLateInvestment")
        && Number.isFinite(restoredProgress.distinctHandsWithLateAction)) {
        restoredProgress.distinctHandsWithEffectiveLateInvestment = Math.max(
          0,
          restoredProgress.distinctHandsWithLateAction,
        );
      }
      delete restoredProgress.lateValidActions;
      delete restoredProgress.distinctHandsWithLateAction;
    }
    player.progress = {
      ...defaultProgress(player.characterId),
      ...restoredProgress,
    };
    player.progressMeta = {
      xuHands: [],
      jianshengPlayers: [],
      maoAwakeningUsed: false,
      wengHuntHands: [],
      ...(player.progressMeta ?? {}),
    };
    player.progressMeta.wengHuntHands = Array.isArray(player.progressMeta.wengHuntHands)
      ? [...new Set(player.progressMeta.wengHuntHands.filter(Number.isSafeInteger))].slice(-15)
      : [];
    const legacyYaEarlyAllIn = player.hand?.yaEarlyAllIn === true;
    player.hand = { ...emptyHandState(), ...(player.hand ?? {}) };
    if (player.characterId === "ya" && legacyYaEarlyAllIn) {
      player.hand.yaEarlyAggressiveAllIn = true;
    }
    player.window ??= null;
    if (player.characterId === "ya" && player.window?.type === "ya-river-choice") {
      player.window = {
        windowId: player.window.windowId,
        ownerUserId: player.userId,
        type: "ya-river-replace-legacy",
        state: "armed",
        expiresAt: Number.isFinite(player.window.expiresAt) ? player.window.expiresAt : 0,
      };
    } else if (player.characterId === "qiwan" && player.window?.type === "qiwan-card-swap") {
      player.window = {
        windowId: player.window.windowId,
        ownerUserId: player.userId,
        type: "qiwan-top-deck-swap-legacy",
        state: "armed",
        holeCardIndex: [0, 1].includes(player.window.preselectedHoleCardIndex)
          ? player.window.preselectedHoleCardIndex
          : 0,
        expiresAt: Number.isFinite(player.window.expiresAt) ? player.window.expiresAt : 0,
      };
    }
    player.knownStack = Math.max(0, finiteNumber(player.knownStack));
    const resourceMaximum = HEXTECH_CHARACTER_RULES[player.characterId].resource.maximum;
    if (!Number.isFinite(player.resource) || player.resource < 0
      || (resourceMaximum != null && player.resource > resourceMaximum)) {
      throw new Error("人物引擎资源存档不合法");
    }
  }
  restored.loans = Array.isArray(restored.loans) ? restored.loans : [];
  restored.eventLog = Array.isArray(restored.eventLog) ? restored.eventLog.slice(-MAX_EVENT_LOG) : [];
  restored.processedIds = Array.isArray(restored.processedIds) ? restored.processedIds.slice(-MAX_PROCESSED_IDS) : [];
  restored.nextWindowId = positiveInteger(restored.nextWindowId ?? 1, "nextWindowId");
  restored.nextLoanId = positiveInteger(restored.nextLoanId ?? 1, "nextLoanId");
  return restored;
}

export class HextechCharacterEngine {
  constructor(playersOrSnapshot = [], { restore = false } = {}) {
    this.state = restore ? normalizeRestoredState(playersOrSnapshot) : initialState(playersOrSnapshot);
    this.pendingEvents = [];
    this.pendingDirectives = [];
  }

  export() {
    return clone(this.state);
  }

  exportState() {
    return this.export();
  }

  beginHand(input) {
    const handNumber = positiveInteger(input?.handNumber, "handNumber");
    const operationId = input?.eventId ?? `hand-${handNumber}`;
    return this._transaction("begin-hand", operationId, () => {
      if (handNumber <= this.state.handNumber) throw new Error("人物引擎手数必须单调递增");
      const suppliedPlayers = Array.isArray(input?.players) ? input.players : [];
      const supplied = new Map(suppliedPlayers.map((entry) => [String(entry.userId), entry]));
      const seatedStacks = suppliedPlayers
        .filter((entry) => entry?.seated !== false)
        .map((entry) => Math.max(0, finiteNumber(entry.startingStack ?? entry.chips ?? entry.stack)));
      const averageStartingStack = seatedStacks.length
        ? seatedStacks.reduce((sum, value) => sum + value, 0) / seatedStacks.length
        : 0;

      this.state.handNumber = handNumber;
      for (const player of Object.values(this.state.players)) {
        const suppliedPlayer = supplied.get(player.userId);
        const startingStack = Math.max(0, finiteNumber(
          suppliedPlayer?.startingStack ?? suppliedPlayer?.chips ?? suppliedPlayer?.stack ?? player.knownStack,
        ));
        player.knownStack = startingStack;
        player.hand = {
          ...emptyHandState(),
          handNumber,
          startingStack,
          averageStartingStack,
        };
        player.window = null;
      }
      this._event("character.hand.started", { handNumber, averageStartingStack });
    });
  }

  afterPokerAction(input) {
    return this._transaction("poker-action", input?.eventId, () => {
      this._assertCurrentHand(input?.handNumber);
      const actor = this._player(input?.userId);
      const action = String(input?.action ?? "");
      const street = String(input?.street ?? "");
      if (!VALID_ACTIONS.has(action)) throw new Error("人物引擎不支持该扑克动作");
      if (!VALID_STREETS.has(street)) throw new Error("人物引擎下注街不正确");
      if (Number.isFinite(input?.stackAfter)) actor.knownStack = Math.max(0, input.stackAfter);

      this._afterFenxiangAction(actor, input, action);
      this._afterXuAction(actor, input, action, street);
      this._afterJianshengAction(actor, input, action, street);
      this._afterYaAction(actor, input, action, street);
      this._afterQiwanAction(actor, input, action, street);
      this._afterWengAction(actor, input, action, street);
      this._resolveQiwanCallTrigger(input, action, street);
      this._recordWengAggressor(actor, input, action, street);
    });
  }

  afterStreet(input) {
    return this._transaction("street", input?.eventId, () => {
      this._assertCurrentHand(input?.handNumber);
      const street = String(input?.street ?? "");
      const nextStreet = String(input?.nextStreet ?? "");
      if (!VALID_STREETS.has(street) || (nextStreet && !VALID_STREETS.has(nextStreet))) {
        throw new Error("人物引擎街道切换不正确");
      }
      // Ya progression intentionally settles from the authoritative showdown
      // result, not from merely reaching the river during an automatic runout.
      for (const player of Object.values(this.state.players)) {
        if (player.characterId !== "wengwengwen") continue;
        player.hand.wengLatestAggressor = null;
        player.hand.wengReveal = null;
        player.hand.wengAwaitingImmediateAction = false;
      }
    });
  }

  settleHand(input) {
    return this._transaction("settle-hand", input?.eventId, () => {
      this._assertCurrentHand(input?.handNumber);
      const results = new Map((input?.results ?? input?.players ?? []).map((entry) => [String(entry.userId), entry]));
      for (const player of Object.values(this.state.players)) {
        const result = results.get(player.userId) ?? {};
        const endingStack = result.endingStack ?? result.availableStack ?? result.stack;
        if (Number.isFinite(endingStack)) player.knownStack = Math.max(0, endingStack);
      }

      for (const player of Object.values(this.state.players)) {
        const result = results.get(player.userId) ?? {};
        if (player.characterId === "fenxiang") this._settleFenxiang(player, result);
        if (player.characterId === "jiansheng") this._settleJiansheng(player, result);
        if (player.characterId === "ya") this._settleYa(player, result);
        if (player.characterId === "qiwan") this._settleQiwan(player, result);
        if (player.characterId === "wengwengwen") this._settleWeng(player, result);
      }

      this._settleLoans(results);
      this._settleZigeInterest();
      this._event("character.hand.settled", { handNumber: this.state.handNumber });
    });
  }

  command(input) {
    const type = String(input?.type ?? "");
    const transactionNamespace = INTERNAL_COMMAND_TYPES.has(type) ? "internal-command" : "command";
    return this._transaction(transactionNamespace, input?.commandId, () => {
      this._assertCurrentHand(input?.handNumber, { allowZero: true });
      switch (type) {
        case HEXTECH_CHARACTER_COMMANDS.FENXIANG_ACTIVATE:
          this._activateFenxiang(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.XU_BARBECUE:
          this._activateXu(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.JIANSHENG_PRESSURE:
          this._activateJiansheng(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.YA_ACTIVATE:
          this._activateYa(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.YA_CHOOSE:
          this._chooseYa(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE:
          this._activateQiwan(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.QIWAN_ARM_CHOICE:
          this._armQiwanChoice(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.QIWAN_COMMIT:
          this._commitQiwan(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.ZIGE_OFFER_LOAN:
          this._offerLoan(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN:
          this._respondLoan(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.ZIGE_REPAY_LOAN:
          this._repayLoan(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.MAO_CLAIM:
          this._claimMao(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.MAO_CHALLENGE:
          this._challengeMao(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.MAO_CHOOSE:
          this._chooseMao(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE:
          this._activateWeng(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.INTERNAL_SUPPLY_CANDIDATES:
          this._supplyCandidates(input);
          break;
        case HEXTECH_CHARACTER_COMMANDS.INTERNAL_RESOLVE_MAO_CHALLENGE:
          this._resolveMaoChallenge(input);
          break;
        default:
          throw new Error("未知人物命令");
      }
    });
  }

  tick(input = {}) {
    const now = timestamp(input.now);
    return this._transaction("tick", input.eventId ?? null, () => {
      for (const loan of this.state.loans) {
        if (loan.state === "offered" && loan.expiresAt <= now) {
          loan.state = "rejected";
          loan.resolution = "expired";
          this._event("character.zige.loan.expired", { loanId: loan.loanId });
        }
      }
      for (const player of Object.values(this.state.players)) {
        const window = player.window;
        if (!window || !Number.isFinite(window.expiresAt) || window.expiresAt > now) continue;
        if (window.type === "ya-river-replace-legacy" && window.state === "armed") {
          this._resolveYaReplacement(player, true, window);
        } else if (window.type === "qiwan-top-deck-swap-legacy" && window.state === "armed") {
          this._resolveQiwanReplacement(player, window.holeCardIndex ?? 0, true, window);
        } else if (window.type === "mao-claim" && window.state === "armed") {
          this._resolveUnchallengedMao(player);
        } else if (window.type === "mao-suit-choice" && window.state === "armed") {
          this._resolveMaoChoice(player, window.candidateCardIds[0], true);
        }
      }
    }, { allowMissingId: true });
  }

  viewFor(userId = null, { now = Date.now() } = {}) {
    const viewerId = userId == null ? null : String(userId);
    const characters = Object.values(this.state.players).map((player) => {
      const rules = HEXTECH_CHARACTER_RULES[player.characterId];
      const window = clone(player.window);
      if (["ya-river-choice", "qiwan-card-swap"].includes(window?.type)) {
        delete window.candidateCardIds;
        delete window.selectedCardId;
        delete window.preselectedHoleCardIndex;
        delete window.swapArmed;
      }
      if (window?.expiresAt) window.expiresAt = new Date(window.expiresAt).toISOString();
      return {
        userId: player.userId,
        characterId: player.characterId,
        resource: player.resource,
        resourceMaximum: rules.resource.maximum,
        awakened: player.awakened,
        progress: clone(player.progress),
        activeUsed: player.hand.activeUsed,
        window,
        availableStack: player.knownStack,
        netAssets: this._netAssets(player.userId),
        ...(player.characterId === "wengwengwen" ? {
          latestAggressorUserId: viewerId === player.userId
            ? player.hand.wengLatestAggressor?.userId ?? null
            : null,
          reveal: viewerId === player.userId && player.hand.wengReveal
            ? {
              targetUserId: player.hand.wengReveal.targetUserId,
              cardId: player.hand.wengReveal.cardId,
              street: player.hand.wengReveal.street,
            }
            : null,
        } : {}),
      };
    });
    const events = this.state.eventLog
      .filter((event) => !event.privateTo || event.privateTo === viewerId)
      .map(({ privateTo: _privateTo, ...event }) => {
        const safeEvent = clone(event);
        if (["ya-river-choice", "qiwan-card-swap"].includes(safeEvent.payload?.type)) {
          delete safeEvent.payload.candidateCardIds;
        }
        return safeEvent;
      });
    return {
      version: this.state.version,
      eventSeq: this.state.eventSeq,
      handNumber: this.state.handNumber,
      serverNow: new Date(timestamp(now)).toISOString(),
      characters,
      loans: this.state.loans.map((loan) => ({
        loanId: loan.loanId,
        lenderUserId: loan.lenderUserId,
        borrowerUserId: loan.borrowerUserId,
        principal: loan.principal,
        interestRate: loan.interestRate,
        dueAfterHands: loan.dueAfterHands,
        dueHandNumber: loan.dueHandNumber,
        expiresAt: loan.expiresAt ? new Date(loan.expiresAt).toISOString() : null,
        state: loan.state,
        resolution: loan.resolution ?? null,
        outstanding: loan.principalOutstanding + loan.interestOutstanding,
        principalOutstanding: loan.principalOutstanding,
        accruedInterest: loan.interestOutstanding,
      })),
      events,
    };
  }

  _transaction(namespace, id, callback, { allowMissingId = false } = {}) {
    if (!allowMissingId && (id == null || String(id).trim() === "")) throw new Error(`${namespace} 缺少幂等 id`);
    const key = id == null ? null : `${namespace}:${String(id)}`;
    if (key && this.state.processedIds.includes(key)) {
      return { duplicate: true, stateChanged: false, eventSeq: this.state.eventSeq, events: [], directives: [] };
    }
    const previous = clone(this.state);
    this.pendingEvents = [];
    this.pendingDirectives = [];
    try {
      callback();
      if (key) {
        this.state.processedIds.push(key);
        this.state.processedIds = this.state.processedIds.slice(-MAX_PROCESSED_IDS);
      }
      return {
        duplicate: false,
        stateChanged: JSON.stringify(this.state) !== JSON.stringify(previous),
        eventSeq: this.state.eventSeq,
        events: clone(this.pendingEvents),
        directives: clone(this.pendingDirectives),
      };
    } catch (error) {
      this.state = previous;
      this.pendingEvents = [];
      this.pendingDirectives = [];
      throw error;
    }
  }

  _event(type, payload, { privateTo = null } = {}) {
    this.state.eventSeq += 1;
    const event = {
      eventSeq: this.state.eventSeq,
      type,
      payload: clone(payload),
      ...(privateTo ? { privateTo } : {}),
    };
    this.state.eventLog.push(event);
    this.state.eventLog = this.state.eventLog.slice(-MAX_EVENT_LOG);
    this.pendingEvents.push(event);
    return event;
  }

  _directive(type, payload, options = {}) {
    if (!Object.values(HEXTECH_CHARACTER_DIRECTIVES).includes(type)) throw new Error(`未知人物指令：${type}`);
    const event = this._event(`character.directive.${type}`, payload, options);
    this.pendingDirectives.push({
      directiveId: `character-${event.eventSeq}`,
      eventSeq: event.eventSeq,
      type,
      ...(options.privateTo ? { visibility: "private", userIds: [options.privateTo] } : { visibility: "public" }),
      ...clone(payload),
    });
  }

  _player(userId) {
    const player = this.state.players[String(userId ?? "")];
    if (!player) throw new Error("人物玩家不存在");
    return player;
  }

  _characterPlayer(userId, characterId) {
    const player = this._player(userId);
    if (player.characterId !== characterId) throw new Error("人物命令与所选人物不匹配");
    return player;
  }

  _assertCurrentHand(handNumber, { allowZero = false } = {}) {
    if (allowZero && this.state.handNumber === 0 && (handNumber == null || handNumber === 0)) return;
    if (handNumber !== this.state.handNumber || this.state.handNumber < 1) throw new Error("人物命令手数已过期");
  }

  _gainResource(player, amount, reason) {
    const maximum = HEXTECH_CHARACTER_RULES[player.characterId].resource.maximum;
    if (maximum == null || amount <= 0) return 0;
    const gained = Math.max(0, Math.min(amount, maximum - player.resource));
    if (gained <= 0) return 0;
    player.resource += gained;
    this._event("character.resource.gained", {
      userId: player.userId,
      characterId: player.characterId,
      amount: gained,
      resource: player.resource,
      reason,
    });
    return gained;
  }

  _spendResource(player, amount, reason) {
    nonNegativeNumber(amount, "人物资源消耗");
    if (player.resource < amount) throw new Error("人物资源不足");
    player.resource -= amount;
    this._event("character.resource.spent", {
      userId: player.userId,
      characterId: player.characterId,
      amount,
      resource: player.resource,
      reason,
    });
  }

  _requireUnusedActive(player) {
    if (player.hand.handNumber !== this.state.handNumber || this.state.handNumber === 0) throw new Error("当前没有可用的人物主动");
    if (player.hand.activeUsed) throw new Error("本手人物主动已经使用");
    if (player.window) throw new Error("人物仍有未完成窗口");
  }

  _markActiveUsed(player, reason) {
    player.hand.activeUsed = true;
    this._event("character.active.used", { userId: player.userId, characterId: player.characterId, reason });
  }

  _afterFenxiangAction(player, input, action) {
    if (player.characterId !== "fenxiang" || action !== "call" || player.hand.fenxiangGained) return;
    const callAmount = finiteNumber(input.callAmount ?? input.amount ?? input.delta);
    const bigBlind = Math.max(1, finiteNumber(input.bigBlind, 1));
    if (player.hand.startingStack > player.hand.averageStartingStack * 0.7 || callAmount < bigBlind) return;
    player.hand.fenxiangGained = true;
    this._gainResource(player, 1, "fenxiang.short-stack-call");
  }

  _afterXuAction(player, input, action, street) {
    if (player.characterId !== "xu" || input.automatic === true) return;
    const conditions = HEXTECH_CHARACTER_RULES.xu.gain.conditions;
    if (!conditions.actions.includes(action)) return;
    const investmentDelta = finiteNumber(input.delta ?? input.amount);
    const bigBlind = Math.max(1, finiteNumber(input.bigBlind, 1));
    if (investmentDelta < bigBlind * conditions.minimumInvestmentBigBlinds) return;
    const remaining = input.secondsRemaining;
    const limit = conditions.countdownRemainingAtMostSeconds;
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > limit) return;

    if (player.hand.xuGainedStreets.includes(street)) return;
    player.hand.xuGainedStreets.push(street);
    this._gainResource(player, 1, "xu.effective-late-investment");
    player.progress.effectiveLateInvestments += 1;
    if (!player.progressMeta.xuHands.includes(this.state.handNumber)) {
      player.progressMeta.xuHands.push(this.state.handNumber);
      player.progress.distinctHandsWithEffectiveLateInvestment = player.progressMeta.xuHands.length;
    }
    this._checkAwakening(player);
  }

  _afterJianshengAction(player, input, action, street) {
    if (player.characterId !== "jiansheng" || player.hand.jianshengGained || street !== "flop") return;
    const raises = action === "raise" || action === "bet" || (action === "all-in" && input.isRaise !== false);
    if (!raises || finiteNumber(input.activePlayerCount) < 3) return;
    player.hand.jianshengGained = true;
    this._gainResource(player, 1, "jiansheng.multiplayer-flop-raise");
  }

  _afterYaAction(player, input, action, street) {
    if (player.characterId !== "ya" || !["preflop", "flop"].includes(street)) return;
    const becameAllIn = action === "all-in" || input.isAllInAfter === true;
    if (becameAllIn && input.isRaise === true) player.hand.yaEarlyAggressiveAllIn = true;
  }

  _afterQiwanAction(player, input, action, street) {
    if (player.characterId !== "qiwan" || street !== "preflop" || player.hand.qiwanQualifyingRaise) return;
    const raises = action === "raise" || (action === "all-in" && input.isRaise !== false);
    const bigBlind = Math.max(1, finiteNumber(input.bigBlind, 1));
    const raiseTotal = finiteNumber(input.raiseTo ?? input.toAmount ?? input.totalCommitted);
    if (!raises || raiseTotal < bigBlind * 4) return;
    player.hand.qiwanQualifyingRaise = true;
    if (input.wasCalled === true) this._gainQiwan(player);
  }

  _resolveQiwanCallTrigger(input, action, street) {
    if (street !== "preflop" || action !== "call") return;
    const calledIds = [input.calledRaiseUserId, ...(input.calledRaiseUserIds ?? [])].filter(Boolean).map(String);
    for (const calledId of calledIds) {
      const player = this.state.players[calledId];
      if (player?.characterId === "qiwan" && player.hand.qiwanQualifyingRaise) this._gainQiwan(player);
    }
  }

  _gainQiwan(player) {
    if (player.hand.qiwanGained) return;
    player.hand.qiwanGained = true;
    this._gainResource(player, 1, "qiwan.large-preflop-raise-called");
  }

  _afterWengAction(player, input, action, street) {
    if (player.characterId !== "wengwengwen") return;
    const rules = HEXTECH_CHARACTER_RULES.wengwengwen;
    const investment = finiteNumber(input.delta ?? input.amount);
    const bigBlind = Math.max(1, finiteNumber(input.bigBlind, 1));

    if (player.hand.wengAwaitingImmediateAction) {
      player.hand.wengAwaitingImmediateAction = false;
      const qualifiesForRefund = player.awakened
        && !player.hand.wengAwakeningRefundUsed
        && input.automatic !== true
        && ["raise", "all-in"].includes(action)
        && input.isFullRaise === true
        && investment >= rules.awakening.minimumRaiseInvestmentBigBlinds * bigBlind;
      if (qualifiesForRefund) {
        player.hand.wengAwakeningRefundUsed = true;
        const amount = this._gainResource(player, rules.awakening.resourceRefund, "wengwengwen.full-moon-refund");
        if (amount > 0) {
          this._event("character.wengwengwen.full-moon-refund", {
            userId: player.userId,
            amount,
            street,
          });
        }
      }
    }

    const latest = player.hand.wengLatestAggressor;
    const gain = rules.gain;
    if (player.hand.wengResourceGained
      || input.automatic === true
      || !gain.legalStreets.includes(street)
      || !gain.validActions.includes(action)
      || investment < gain.minimumSelfInvestmentBigBlinds * bigBlind
      || finiteNumber(input.toCallBefore) <= 0
      || !latest
      || latest.street !== street) return;

    player.hand.wengResourceGained = true;
    player.hand.wengChasedAggressorUserId = latest.userId;
    if (!player.progressMeta.wengHuntHands.includes(this.state.handNumber)) {
      player.progressMeta.wengHuntHands.push(this.state.handNumber);
      player.progress.distinctHuntHands = player.progressMeta.wengHuntHands.length;
    }
    if (street === "turn") player.progress.turnHunts += 1;
    const amount = this._gainResource(player, gain.amount, "wengwengwen.manual-chase");
    this._event("character.wengwengwen.resource-gained", {
      userId: player.userId,
      targetUserId: latest.userId,
      amount,
      street,
    });
    this._checkAwakening(player);
  }

  _recordWengAggressor(actor, input, action, street) {
    const gain = HEXTECH_CHARACTER_RULES.wengwengwen.gain;
    const investment = finiteNumber(input.delta ?? input.amount);
    const bigBlind = Math.max(1, finiteNumber(input.bigBlind, 1));
    const aggressive = ["bet", "raise"].includes(action)
      || (action === "all-in" && input.isRaise === true);
    if (input.automatic === true
      || !gain.legalStreets.includes(street)
      || !aggressive
      || investment < gain.minimumAggressorInvestmentBigBlinds * bigBlind) return;
    for (const player of Object.values(this.state.players)) {
      if (player.characterId !== "wengwengwen" || player.userId === actor.userId) continue;
      player.hand.wengLatestAggressor = {
        userId: actor.userId,
        street,
        investment,
      };
    }
  }

  _activateFenxiang(input) {
    const player = this._characterPlayer(input.userId, "fenxiang");
    this._requireUnusedActive(player);
    const shortEnough = player.hand.startingStack < player.hand.averageStartingStack * 0.5;
    const cost = player.awakened && shortEnough
      ? HEXTECH_CHARACTER_RULES.fenxiang.awakening.activeCost
      : HEXTECH_CHARACTER_RULES.fenxiang.active.cost;
    this._spendResource(player, cost, "fenxiang.activate");
    player.hand.fenxiangArmed = true;
    this._markActiveUsed(player, "fenxiang.small-beats-big");
  }

  _activateXu(input) {
    const player = this._characterPlayer(input.userId, "xu");
    this._requireUnusedActive(player);
    const rules = HEXTECH_CHARACTER_RULES.xu.active;
    if (!rules.legalStreets.includes(input.street)) throw new Error("当前街道之后没有可烧烤的下注街");
    this._spendResource(player, rules.cost, "xu.barbecue");
    this._markActiveUsed(player, "xu.barbecue");
    const opponentSecondsDelta = player.awakened
      ? HEXTECH_CHARACTER_RULES.xu.awakening.opponentSecondsDelta
      : rules.opponentSecondsDelta;
    const selfSecondsDelta = player.awakened
      ? HEXTECH_CHARACTER_RULES.xu.awakening.selfSecondsDelta
      : rules.selfSecondsDelta;
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.MODIFY_NEXT_STREET_CLOCK, {
      sourceUserId: player.userId,
      opponentSecondsDelta,
      minimumOpponentActionSeconds: rules.minimumOpponentActionSeconds,
      selfSecondsDelta,
      appliesTo: "next-street",
      targetPolicy: "all-opponents-still-in-hand",
    });
    if (player.awakened) {
      const amount = HEXTECH_CHARACTER_RULES.xu.awakening.bankPotContribution;
      this._directive(HEXTECH_CHARACTER_DIRECTIVES.BANK_TO_POT, {
        userId: player.userId,
        amount,
        reason: "xu.awakened-barbecue",
      });
    }
  }

  _activateJiansheng(input) {
    const player = this._characterPlayer(input.userId, "jiansheng");
    this._requireUnusedActive(player);
    const targetUserIds = uniqueStrings(input.targetUserIds ?? [input.targetUserId].filter(Boolean), "剑压目标");
    if (targetUserIds.includes(player.userId)) throw new Error("剑压不能指定自己");
    if (targetUserIds.some((userId) => !this.state.players[userId])) throw new Error("剑压目标不存在");
    const swordDomain = targetUserIds.length === 2;
    if (targetUserIds.length < 1 || targetUserIds.length > 2) throw new Error("剑压目标数量不正确");
    if (swordDomain && !player.awakened) throw new Error("未觉醒不能发动剑域");
    const cost = swordDomain
      ? HEXTECH_CHARACTER_RULES.jiansheng.awakening.activeCost
      : HEXTECH_CHARACTER_RULES.jiansheng.active.cost;
    this._spendResource(player, cost, swordDomain ? "jiansheng.sword-domain" : "jiansheng.sword-pressure");
    this._markActiveUsed(player, swordDomain ? "jiansheng.sword-domain" : "jiansheng.sword-pressure");
    player.hand.jianshengTargetUserIds = targetUserIds;
    for (const targetUserId of targetUserIds) {
      if (!player.progressMeta.jianshengPlayers.includes(targetUserId)) {
        player.progressMeta.jianshengPlayers.push(targetUserId);
      }
      this._directive(HEXTECH_CHARACTER_DIRECTIVES.CAP_NEXT_RAISE_TOTAL, {
        sourceUserId: player.userId,
        targetUserId,
        maximumRaiseTotal: nonNegativeNumber(input.casterStreetCommitted, "剑压上限"),
        duration: "street",
      });
    }
    player.progress.distinctPlayersAffected = player.progressMeta.jianshengPlayers.length;
    this._checkAwakening(player);
  }

  _activateYa(input) {
    const player = this._characterPlayer(input.userId, "ya");
    this._requireUnusedActive(player);
    if (!HEXTECH_CHARACTER_RULES.ya.active.legalStreets.includes(input.street)
      || !player.hand.yaEarlyAggressiveAllIn
      || input.casterAllIn !== true
      || input.riverDealt === true) {
      throw new Error("鸭哥仅能在翻牌前或翻牌圈主动全押且河牌未发时发动");
    }
    const rules = HEXTECH_CHARACTER_RULES.ya.active;
    const cost = player.awakened
      ? HEXTECH_CHARACTER_RULES.ya.awakening.activeCost
      : rules.cost;
    this._spendResource(player, cost, "ya.river-current");
    this._markActiveUsed(player, "ya.river-current");
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.REPLACE_UPCOMING_RIVER, {
      userId: player.userId,
      replacementPolicy: rules.replacementPolicy,
    });
  }

  _chooseYa(input) {
    const player = this._characterPlayer(input.userId, "ya");
    const window = this._requireWindow(player, "ya-river-replace-legacy", input.windowId, "armed");
    this._assertWindowOpen(window, input.now);
    this._resolveYaReplacement(player, false, window);
  }

  _resolveYaReplacement(player, automatic, suppliedWindow = null) {
    const window = suppliedWindow
      ?? this._requireWindow(player, "ya-river-replace-legacy", player.window?.windowId, "armed");
    window.state = "resolved";
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.REPLACE_UPCOMING_RIVER, {
      windowId: window.windowId,
      userId: player.userId,
      replacementPolicy: HEXTECH_CHARACTER_RULES.ya.active.replacementPolicy,
      automatic,
    });
    player.window = null;
  }

  _activateQiwan(input) {
    const player = this._characterPlayer(input.userId, "qiwan");
    this._requireUnusedActive(player);
    if (input.street !== "preflop" || input.casterAllIn !== true || input.flopDealt === true) {
      throw new Error("奇玩仅能在翻牌前全押时发动");
    }
    const rules = HEXTECH_CHARACTER_RULES.qiwan.active;
    const holeCardIndex = input.holeCardIndex;
    if (![0, 1].includes(holeCardIndex)) throw new Error("奇玩需选择被替换底牌");
    this._spendResource(player, rules.cost, "qiwan.mystery-replacement");
    this._markActiveUsed(player, "qiwan.mystery-replacement");
    player.hand.qiwanReplacementCompleted = true;
    player.progress.replacementsCompleted += 1;
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.REPLACE_HOLE_CARD, {
      userId: player.userId,
      holeCardIndex,
      replacementPolicy: rules.replacementPolicy,
    }, { privateTo: player.userId });
    this._checkAwakening(player);
  }

  _activateWeng(input) {
    const player = this._characterPlayer(input.userId, "wengwengwen");
    this._requireUnusedActive(player);
    const rules = HEXTECH_CHARACTER_RULES.wengwengwen.active;
    if (!rules.legalStreets.includes(input.street)) throw new Error("月蚀追猎只能在翻牌圈或转牌圈发动");
    if (input.isOwnAction !== true || finiteNumber(input.toCall) <= 0) {
      throw new Error("月蚀追猎必须在自己面对主动进攻时发动");
    }
    const latest = player.hand.wengLatestAggressor;
    const targetUserId = String(input.targetUserId ?? "");
    if (!latest || latest.street !== input.street || latest.userId !== targetUserId) {
      throw new Error("月蚀追猎目标必须是本街最后一名主动进攻者");
    }
    const displayedCards = input.displayedCards;
    if (!Array.isArray(displayedCards)
      || displayedCards.length !== 2
      || displayedCards.some((cardId) => typeof cardId !== "string"
        || !/^(?:[2-9TJQKA][cdhs]|blank)$/.test(cardId))) {
      throw new Error("月蚀追猎展示牌必须由服务端提供");
    }
    const cardId = displayedCards[randomInt(displayedCards.length)];
    this._spendResource(player, rules.cost, "wengwengwen.eclipse-hunt");
    this._markActiveUsed(player, "wengwengwen.eclipse-hunt");
    player.hand.wengChasedAggressorUserId = targetUserId;
    player.hand.wengAwaitingImmediateAction = true;
    player.hand.wengReveal = {
      targetUserId,
      cardId,
      street: input.street,
      masked: input.masked === true,
    };
    this._event("character.wengwengwen.hunt-activated", {
      userId: player.userId,
      targetUserId,
      street: input.street,
    });
    this._event("character.wengwengwen.private-card-revealed", {
      userId: player.userId,
      targetUserId,
      cardId,
      street: input.street,
    }, { privateTo: player.userId });
  }

  _armQiwanChoice(input) {
    const player = this._characterPlayer(input.userId, "qiwan");
    const window = this._requireWindow(player, "qiwan-top-deck-swap-legacy", input.windowId, "armed");
    this._assertWindowOpen(window, input.now);
    window.swapArmed = true;
    this._event("character.qiwan.swap-armed", { userId: player.userId, windowId: window.windowId }, { privateTo: player.userId });
  }

  _commitQiwan(input) {
    const player = this._characterPlayer(input.userId, "qiwan");
    const window = this._requireWindow(player, "qiwan-top-deck-swap-legacy", input.windowId, "armed");
    this._assertWindowOpen(window, input.now);
    const holeCardIndex = [0, 1].includes(input.holeCardIndex)
      ? input.holeCardIndex
      : window.holeCardIndex;
    if (![0, 1].includes(holeCardIndex)) throw new Error("奇玩底牌位置无效");
    this._resolveQiwanReplacement(player, holeCardIndex, false, window);
  }

  _resolveQiwanReplacement(player, holeCardIndex, automatic, suppliedWindow = null) {
    const window = suppliedWindow
      ?? this._requireWindow(player, "qiwan-top-deck-swap-legacy", player.window?.windowId, "armed");
    window.state = "resolved";
    player.hand.qiwanReplacementCompleted = true;
    player.progress.replacementsCompleted += 1;
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.REPLACE_HOLE_CARD, {
      windowId: window.windowId,
      userId: player.userId,
      holeCardIndex,
      replacementPolicy: HEXTECH_CHARACTER_RULES.qiwan.active.replacementPolicy,
      automatic,
    }, { privateTo: player.userId });
    player.window = null;
    this._checkAwakening(player);
  }

  _offerLoan(input) {
    const lender = this._characterPlayer(input.userId, "zige");
    this._requireUnusedActive(lender);
    const borrower = this._player(input.borrowerUserId);
    if (borrower.userId === lender.userId) throw new Error("不能向自己发放贷款");
    const principal = input.principal;
    if (!LOAN_PRINCIPALS.has(principal)) throw new Error("贷款本金必须为 200、300、400、500 或 600");
    const maximumOpen = lender.awakened
      ? HEXTECH_CHARACTER_RULES.zige.awakening.maximumOpenLoans
      : HEXTECH_CHARACTER_RULES.zige.active.maximumOpenLoans;
    const openLoans = this.state.loans.filter((loan) => (
      loan.lenderUserId === lender.userId && ["offered", "active", "overdue"].includes(loan.state)
    ));
    if (openLoans.length >= maximumOpen) throw new Error("资哥进行中贷款已达上限");
    const availableStack = finiteNumber(input.lenderAvailableStack, lender.knownStack);
    if (availableStack < principal) throw new Error("资哥可用筹码不足");
    lender.knownStack = availableStack;
    const now = timestamp(input.now);
    const loan = {
      loanId: `loan-${this.state.nextLoanId++}`,
      lenderUserId: lender.userId,
      borrowerUserId: borrower.userId,
      principal,
      interestRate: HEXTECH_CHARACTER_RULES.zige.active.interestRatio,
      dueAfterHands: HEXTECH_CHARACTER_RULES.zige.active.durationHands,
      offeredHandNumber: this.state.handNumber,
      acceptedHandNumber: null,
      dueHandNumber: null,
      expiresAt: now + HEXTECH_LOAN_OFFER_SECONDS * 1000,
      state: "offered",
      resolution: null,
      principalOutstanding: principal,
      interestOutstanding: floorToChip(principal * HEXTECH_CHARACTER_RULES.zige.active.interestRatio),
      everOverdue: false,
    };
    this.state.loans.push(loan);
    this._event("character.zige.loan.offered", {
      loanId: loan.loanId,
      lenderUserId: loan.lenderUserId,
      borrowerUserId: loan.borrowerUserId,
      principal,
      dueAfterHands: loan.dueAfterHands,
      expiresAt: loan.expiresAt,
    });
  }

  _respondLoan(input) {
    const loan = this._loan(input.loanId);
    if (loan.state !== "offered") throw new Error("贷款邀请已经结束");
    if (loan.borrowerUserId !== String(input.userId)) throw new Error("只有借款人能响应贷款");
    const now = timestamp(input.now);
    if (loan.expiresAt <= now) throw new Error("贷款邀请已经过期");
    const accepted = input.accept === true;
    if (!accepted) {
      loan.state = "rejected";
      loan.resolution = "declined";
      this._event("character.zige.loan.rejected", { loanId: loan.loanId, borrowerUserId: loan.borrowerUserId });
      return;
    }
    const lender = this._characterPlayer(loan.lenderUserId, "zige");
    this._requireUnusedActive(lender);
    const lenderAvailableStack = finiteNumber(input.lenderAvailableStack, lender.knownStack);
    if (lenderAvailableStack < loan.principal) throw new Error("贷款接受时资哥筹码不足");
    lender.knownStack = lenderAvailableStack - loan.principal;
    const borrower = this._player(loan.borrowerUserId);
    borrower.knownStack += loan.principal;
    loan.state = "active";
    loan.resolution = "accepted";
    loan.acceptedHandNumber = this.state.handNumber;
    loan.dueHandNumber = this.state.handNumber + loan.dueAfterHands;
    this._markActiveUsed(lender, "zige.loan-accepted");
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.TRANSFER_CHIPS, {
      fromUserId: lender.userId,
      toUserId: borrower.userId,
      amount: loan.principal,
      allowPartial: false,
      reason: "zige.loan-principal",
      loanId: loan.loanId,
    });
  }

  _repayLoan(input) {
    const loan = this._loan(input.loanId);
    if (!["active", "overdue"].includes(loan.state)) throw new Error("贷款当前不能还款");
    if (loan.borrowerUserId !== String(input.userId)) throw new Error("只有借款人能还款");
    const borrower = this._player(loan.borrowerUserId);
    const available = finiteNumber(input.borrowerAvailableStack, borrower.knownStack);
    const requested = input.amount == null ? this._loanBalance(loan) : nonNegativeNumber(input.amount, "还款金额");
    const amount = floorToChip(Math.min(requested, available, this._loanBalance(loan)));
    if (amount <= 0) throw new Error("没有可偿还筹码");
    borrower.knownStack = available;
    this._applyLoanPayment(loan, amount, "borrower-request");
    if (this._loanBalance(loan) === 0) this._completeLoan(loan, !loan.everOverdue, "borrower-request");
  }

  _claimMao(input) {
    const player = this._characterPlayer(input.userId, "mao");
    this._requireUnusedActive(player);
    const suit = String(input.suit ?? "");
    const street = String(input.street ?? "");
    if (!VALID_SUITS.has(suit)) throw new Error("毛哥宣称花色不正确");
    if (!["turn", "river"].includes(street)) throw new Error("毛哥只能在转牌或河牌前宣称");
    const useAwakening = input.useAwakening === true;
    if (useAwakening) {
      if (!player.awakened) throw new Error("毛哥尚未觉醒");
      if (player.progressMeta.maoAwakeningUsed) throw new Error("真蛊惑每场只能使用一次");
      if (player.resource < HEXTECH_CHARACTER_RULES.mao.awakening.resourceCost) throw new Error("旺柴不足");
    }
    this._markActiveUsed(player, "mao.suit-claim");
    player.hand.maoClaimed = true;
    const now = timestamp(input.now);
    this._openWindow(player, {
      type: "mao-claim",
      state: "armed",
      street,
      suit,
      useAwakening,
      expiresAt: now + HEXTECH_CHARACTER_RULES.mao.active.responseSeconds * 1000,
      public: true,
    });
    this._event("character.mao.claimed", {
      userId: player.userId,
      street,
      suit,
      useAwakening,
      expiresAt: player.window.expiresAt,
    });
  }

  _challengeMao(input) {
    const challenger = this._player(input.userId);
    const mao = Object.values(this.state.players).find((player) => player.window?.windowId === input.windowId);
    if (!mao || mao.characterId !== "mao") throw new Error("毛哥质疑窗口不存在");
    const window = this._requireWindow(mao, "mao-claim", input.windowId, "armed");
    if (challenger.userId === mao.userId) throw new Error("毛哥不能质疑自己");
    if (window.expiresAt <= timestamp(input.now)) throw new Error("质疑窗口已经结束");
    window.state = "resolving-challenge";
    window.challengerUserId = challenger.userId;
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.REVEAL_NATURAL_BOARD_CARD, {
      windowId: window.windowId,
      sourceUserId: mao.userId,
      challengerUserId: challenger.userId,
      street: window.street,
      claimedSuit: window.suit,
    });
  }

  _resolveMaoChallenge(input) {
    if (input.trusted !== true) throw new Error("毛哥自然牌只能由服务端判定");
    const mao = Object.values(this.state.players).find((player) => player.window?.windowId === input.windowId);
    if (!mao || mao.characterId !== "mao") throw new Error("毛哥质疑窗口不存在");
    const window = this._requireWindow(mao, "mao-claim", input.windowId, "resolving-challenge");
    const naturalSuit = String(input.naturalSuit ?? "");
    if (!VALID_SUITS.has(naturalSuit)) throw new Error("自然牌花色不正确");
    if (naturalSuit === window.suit) {
      const challenger = this._player(window.challengerUserId);
      challenger.knownStack = Math.max(0, challenger.knownStack - Math.min(40, challenger.knownStack));
      this._directive(HEXTECH_CHARACTER_DIRECTIVES.PAY_TO_POT, {
        userId: window.challengerUserId,
        amount: 40,
        allowPartial: true,
        reason: "mao.failed-challenge",
      });
      this._gainResource(mao, 1, "mao.correct-challenged-claim");
      mao.progress.correctChallengedClaims += 1;
    } else {
      const challenger = this._player(window.challengerUserId);
      const paid = Math.min(40, mao.knownStack);
      mao.knownStack -= paid;
      challenger.knownStack += paid;
      this._directive(HEXTECH_CHARACTER_DIRECTIVES.TRANSFER_CHIPS, {
        fromUserId: mao.userId,
        toUserId: window.challengerUserId,
        amount: 40,
        allowPartial: true,
        reason: "mao.incorrect-claim",
      });
    }
    this._event("character.mao.challenge-resolved", {
      windowId: window.windowId,
      sourceUserId: mao.userId,
      challengerUserId: window.challengerUserId,
      claimedSuit: window.suit,
      naturalSuit,
      correct: naturalSuit === window.suit,
      naturalCardId: input.naturalCardId ?? null,
    });
    mao.window = null;
    this._checkAwakening(mao);
  }

  _resolveUnchallengedMao(player) {
    const window = this._requireWindow(player, "mao-claim", player.window?.windowId, "armed");
    player.progress.unchallengedClaimsResolved += 1;
    this._event("character.mao.unchallenged", {
      windowId: window.windowId,
      userId: player.userId,
      suit: window.suit,
      street: window.street,
    });
    if (window.useAwakening) {
      this._spendResource(player, HEXTECH_CHARACTER_RULES.mao.awakening.resourceCost, "mao.true-bewitchment");
      player.progressMeta.maoAwakeningUsed = true;
      const nextWindow = this._openWindow(player, {
        type: "mao-suit-choice",
        state: "awaiting-candidates",
        candidateCount: HEXTECH_CHARACTER_RULES.mao.awakening.candidateCount,
        choiceSeconds: HEXTECH_CHARACTER_RULES.mao.awakening.choiceSeconds,
        suit: window.suit,
        street: window.street,
        public: true,
      });
      this._directive(HEXTECH_CHARACTER_DIRECTIVES.REQUEST_BOARD_CANDIDATES, {
        windowId: nextWindow.windowId,
        userId: player.userId,
        street: window.street,
        suit: window.suit,
        count: nextWindow.candidateCount,
        visibility: "public",
      });
    } else {
      this._directive(HEXTECH_CHARACTER_DIRECTIVES.DEAL_NEXT_SUIT_CARD, {
        windowId: window.windowId,
        userId: player.userId,
        street: window.street,
        suit: window.suit,
      });
      player.window = null;
    }
    this._checkAwakening(player);
  }

  _chooseMao(input) {
    const player = this._characterPlayer(input.userId, "mao");
    const window = this._requireWindow(player, "mao-suit-choice", input.windowId, "armed");
    this._assertWindowOpen(window, input.now);
    this._resolveMaoChoice(player, input.cardId, false, window);
  }

  _resolveMaoChoice(player, cardId, automatic, suppliedWindow = null) {
    const window = suppliedWindow ?? this._requireWindow(player, "mao-suit-choice", player.window?.windowId, "armed");
    if (!window.candidateCardIds.includes(cardId)) throw new Error("毛哥候选牌无效");
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.DEAL_SELECTED_BOARD_CARD, {
      windowId: window.windowId,
      userId: player.userId,
      street: window.street,
      cardId,
      requiredSuit: window.suit,
      automatic,
    });
    player.window = null;
  }

  _supplyCandidates(input) {
    if (input.trusted !== true) throw new Error("人物候选牌只能由服务端提供");
    if (typeof input.windowId !== "string" || !input.windowId) throw new Error("人物候选窗口不存在");
    const player = Object.values(this.state.players).find((entry) => entry.window?.windowId === input.windowId);
    if (!player) throw new Error("人物候选窗口不存在");
    const window = player.window;
    if (window.state !== "awaiting-candidates") throw new Error("人物候选窗口状态不正确");
    const candidateCardIds = uniqueStrings(input.candidateCardIds, "候选牌");
    if (candidateCardIds.length !== window.candidateCount) throw new Error("候选牌数量不正确");
    window.candidateCardIds = candidateCardIds;
    window.state = "armed";
    window.expiresAt = timestamp(input.now) + finiteNumber(window.choiceSeconds, 6) * 1000;
    this._event("character.choice.armed", {
      windowId: window.windowId,
      userId: player.userId,
      type: window.type,
      candidateCardIds: window.public ? candidateCardIds : undefined,
      expiresAt: window.expiresAt,
    }, window.public ? {} : { privateTo: player.userId });
  }

  _openWindow(player, fields) {
    const window = {
      windowId: `character-window-${this.state.nextWindowId++}`,
      ownerUserId: player.userId,
      ...clone(fields),
    };
    player.window = window;
    return window;
  }

  _requireWindow(player, type, windowId, state) {
    const window = player.window;
    if (!window || window.type !== type || window.windowId !== windowId) throw new Error("人物窗口不存在或已过期");
    if (state && window.state !== state) throw new Error("人物窗口尚不可操作");
    return window;
  }

  _assertWindowOpen(window, now) {
    if (Number.isFinite(window.expiresAt) && window.expiresAt <= timestamp(now)) {
      throw new Error("人物窗口已经过期");
    }
  }

  _settleFenxiang(player, result) {
    const wonPotAmount = Math.max(0, finiteNumber(result.wonPotAmount ?? result.potWon));
    const opponents = uniqueStrings(result.opponentsBeaten ?? result.wonAgainstUserIds ?? [], "击败玩家");
    let bestRatio = 0;
    for (const userId of opponents) {
      const opponent = this.state.players[userId];
      if (!opponent || player.hand.startingStack <= 0) continue;
      bestRatio = Math.max(bestRatio, opponent.hand.startingStack / player.hand.startingStack);
    }
    const qualifies = wonPotAmount > 0 && bestRatio >= 1.5;
    if (qualifies) {
      player.progress.largeOpponentPotsWon += 1;
      this._checkAwakening(player);
    }
    if (!player.hand.fenxiangArmed || !qualifies) return;
    const tiers = HEXTECH_CHARACTER_RULES.fenxiang.active.rewardTiers;
    const tier = [...tiers].reverse().find(({ opponentStartingStackRatio }) => bestRatio >= opponentStartingStackRatio);
    if (!tier) return;
    let cap = tier.cap;
    if (player.awakened && tier === tiers.at(-1)) cap = HEXTECH_CHARACTER_RULES.fenxiang.awakening.maximumRewardCap;
    const amount = floorToChip(Math.min(wonPotAmount * tier.potRatio, cap));
    if (amount <= 0) return;
    player.knownStack += amount;
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.BANK_AWARD, {
      userId: player.userId,
      amount,
      reason: "fenxiang.small-beats-big",
      opponentStartingStackRatio: bestRatio,
      potRatio: tier.potRatio,
      cap,
    });
  }

  _settleJiansheng(player, result) {
    if (player.hand.jianshengTargetUserIds.length === 0) return;
    const defeated = new Set(result.opponentsBeaten ?? result.wonAgainstUserIds ?? []);
    if (finiteNumber(result.wonPotAmount ?? result.potWon) > 0
      && player.hand.jianshengTargetUserIds.some((userId) => defeated.has(userId))) {
      player.progress.affectedPotsWon += 1;
      this._checkAwakening(player);
    }
  }

  _settleYa(player, result) {
    if (!player.hand.yaEarlyAggressiveAllIn || result.reachedShowdown !== true) return;
    this._gainResource(player, 1, "ya.early-aggressive-all-in-showdown");
    player.progress.earlyAggressiveAllInsReachingShowdown += 1;
    const wonPotAmount = Math.max(0, finiteNumber(result.wonPotAmount ?? result.potWon));
    if (wonPotAmount > 0) player.progress.earlyAggressiveAllInShowdownWins += 1;
    this._event("character.ya.early-all-in-showdown", {
      userId: player.userId,
      handNumber: this.state.handNumber,
      wonPot: wonPotAmount > 0,
    });
    this._checkAwakening(player);
  }

  _settleQiwan(player, result) {
    const wasAwakened = player.awakened;
    if (player.hand.qiwanReplacementCompleted && result.replacementUsedInFinalHand === true) {
      player.progress.replacementUsedInFinalHand += 1;
      this._checkAwakening(player);
      if (wasAwakened && finiteNumber(result.wonPotAmount ?? result.potWon) > 0) {
        this._gainResource(
          player,
          HEXTECH_CHARACTER_RULES.qiwan.awakening.resourceRefund,
          "qiwan.inspiration-echo",
        );
      }
    }
  }

  _settleWeng(player, result) {
    const targetUserId = player.hand.wengChasedAggressorUserId;
    const defeated = new Set(result.opponentsBeaten ?? result.wonAgainstUserIds ?? []);
    const wonPotAmount = Math.max(0, finiteNumber(result.wonPotAmount ?? result.potWon));
    if (targetUserId
      && result.reachedShowdown === true
      && wonPotAmount > 0
      && defeated.has(targetUserId)) {
      player.progress.showdownWinsAgainstAggressor += 1;
      this._event("character.wengwengwen.showdown-win", {
        userId: player.userId,
        targetUserId,
        handNumber: this.state.handNumber,
      });
    }
    player.hand.wengReveal = null;
    player.hand.wengAwaitingImmediateAction = false;
    this._checkAwakening(player);
  }

  _settleLoans(results) {
    for (const loan of this.state.loans) {
      if (loan.state === "overdue") {
        const borrower = this._player(loan.borrowerUserId);
        const result = results.get(loan.borrowerUserId) ?? {};
        const netWin = Math.max(0, finiteNumber(result.netWin ?? result.netWon));
        const amount = floorToChip(Math.min(netWin * 0.2, borrower.knownStack, this._loanBalance(loan)));
        if (amount > 0) this._applyLoanPayment(loan, amount, "overdue-net-win");
        if (this._loanBalance(loan) === 0) this._completeLoan(loan, false, "overdue-net-win");
        continue;
      }
      if (loan.state !== "active" || this.state.handNumber < loan.dueHandNumber) continue;
      const borrower = this._player(loan.borrowerUserId);
      const amount = floorToChip(Math.min(borrower.knownStack, this._loanBalance(loan)));
      if (amount > 0) this._applyLoanPayment(loan, amount, "due-date");
      if (this._loanBalance(loan) === 0) {
        this._completeLoan(loan, true, "due-date");
      } else {
        loan.state = "overdue";
        loan.everOverdue = true;
        this._event("character.zige.loan.overdue", {
          loanId: loan.loanId,
          outstanding: this._loanBalance(loan),
        });
      }
    }
  }

  _applyLoanPayment(loan, amount, reason) {
    const borrower = this._player(loan.borrowerUserId);
    const lender = this._player(loan.lenderUserId);
    const paid = floorToChip(Math.min(amount, borrower.knownStack, this._loanBalance(loan)));
    if (paid <= 0) return 0;
    const interestPaid = Math.min(loan.interestOutstanding, paid);
    loan.interestOutstanding -= interestPaid;
    loan.principalOutstanding -= paid - interestPaid;
    borrower.knownStack -= paid;
    lender.knownStack += paid;
    this._directive(HEXTECH_CHARACTER_DIRECTIVES.TRANSFER_CHIPS, {
      fromUserId: borrower.userId,
      toUserId: lender.userId,
      amount: paid,
      allowPartial: false,
      reason: `zige.loan-repayment.${reason}`,
      loanId: loan.loanId,
    });
    return paid;
  }

  _completeLoan(loan, normal, reason) {
    loan.state = "repaid";
    loan.resolution = reason;
    loan.principalOutstanding = 0;
    loan.interestOutstanding = 0;
    this._event("character.zige.loan.repaid", { loanId: loan.loanId, normal, reason });
    if (!normal) return;
    const lender = this._characterPlayer(loan.lenderUserId, "zige");
    lender.progress.loansSettledNormally += 1;
    this._checkAwakening(lender);
    if (lender.awakened) {
      const amount = HEXTECH_CHARACTER_RULES.zige.awakening.normalSettlementBankReward;
      lender.knownStack += amount;
      this._directive(HEXTECH_CHARACTER_DIRECTIVES.BANK_AWARD, {
        userId: lender.userId,
        amount,
        reason: "zige.awakened-normal-settlement",
        loanId: loan.loanId,
      });
    }
  }

  _settleZigeInterest() {
    if (this.state.handNumber % HEXTECH_CHARACTER_RULES.zige.gain.conditions.intervalHands !== 0) return;
    for (const player of Object.values(this.state.players)) {
      if (player.characterId !== "zige") continue;
      const rules = HEXTECH_CHARACTER_RULES.zige.gain.conditions;
      const amount = floorToChip(Math.min(player.knownStack * rules.availableStackInterestRatio, rules.interestCap));
      if (amount <= 0) continue;
      player.knownStack += amount;
      this._directive(HEXTECH_CHARACTER_DIRECTIVES.BANK_AWARD, {
        userId: player.userId,
        amount,
        reason: "zige.three-hand-interest",
      });
    }
  }

  _loan(loanId) {
    const loan = this.state.loans.find((entry) => entry.loanId === loanId);
    if (!loan) throw new Error("贷款不存在");
    return loan;
  }

  _loanBalance(loan) {
    return Math.max(0, loan.principalOutstanding + loan.interestOutstanding);
  }

  _netAssets(userId) {
    const player = this._player(userId);
    const receivables = this.state.loans
      .filter((loan) => loan.lenderUserId === userId && ["active", "overdue"].includes(loan.state))
      .reduce((sum, loan) => sum + this._loanBalance(loan), 0);
    const debts = this.state.loans
      .filter((loan) => loan.borrowerUserId === userId && ["active", "overdue"].includes(loan.state))
      .reduce((sum, loan) => sum + this._loanBalance(loan), 0);
    return player.knownStack + receivables - debts;
  }

  _checkAwakening(player) {
    if (player.awakened) return false;
    const targets = HEXTECH_CHARACTER_RULES[player.characterId].growth.counters;
    if (!targets.every(({ id, target }) => finiteNumber(player.progress[id]) >= target)) return false;
    player.awakened = true;
    this._event("character.awakened", { userId: player.userId, characterId: player.characterId });
    return true;
  }
}

export function createHextechCharacterEngine(options = {}) {
  const players = Array.isArray(options) ? options : options.players ?? [];
  return new HextechCharacterEngine(players);
}

export function restoreHextechCharacterEngine(snapshot) {
  return new HextechCharacterEngine(snapshot, { restore: true });
}

/**
 * rooms.js integration sketch:
 *
 * const outcome = room.characterEngine.afterPokerAction({
 *   eventId: `game-${game.eventSeq}`, handNumber: room.handNumber,
 *   userId, action, street,
 *   // Both values come from the authoritative game snapshots/settings, never the client payload.
 *   delta: after.totalCommitted - before.totalCommitted, bigBlind: game.settings.bigBlind,
 *   secondsRemaining, automatic,
 * });
 * for (const directive of outcome.directives) applyCharacterDirective(room, directive);
 * persist(room.characterEngine.export());
 *
 * Card candidates are drawn only by the authoritative game/deck layer. Feed them back with
 * INTERNAL_SUPPLY_CANDIDATES and trusted:true; never route that command from a client socket.
 */
