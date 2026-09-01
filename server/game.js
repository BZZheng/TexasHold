import crypto from "node:crypto";
import pokerSolver from "pokersolver";
import { SecurityError, constantTimeEqual } from "./security.js";
import { holeCardDealDurationMs } from "../shared/dealing.js";
import { CHIP_UNIT, isStandardChipAmount } from "../shared/chips.js";

const { Hand } = pokerSolver;
export const DEFAULT_ACTION_SECONDS = 30;
export const TIME_EXTENSION_COST = 500;
export const TIME_EXTENSION_SECONDS = 60;
export const FOLD_REVEAL_SECONDS = 5;
export const RESTART_RECONNECT_GRACE_MS = 10_000;
export const ALL_IN_RUNOUT_STEP_MS = 1_000;
const MAX_RESTORED_RUNOUT_STEP_MS = 10_000;
const PERSISTED_GAME_VERSION = 4;
const SUITS = ["s", "h", "d", "c"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
export const HEXTECH_BLANK_CARD = "BLANK";
const STAGE_LABELS = {
  preflop: "翻牌前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  showdown: "摊牌",
  finished: "本局结束",
};
const HAND_LABELS = {
  "Royal Flush": "皇家同花顺",
  "Straight Flush": "同花顺",
  "Four of a Kind": "四条",
  "Full House": "葫芦",
  Flush: "同花",
  Straight: "顺子",
  "Three of a Kind": "三条",
  "Two Pair": "两对",
  Pair: "一对",
  "High Card": "高牌",
};

export function createDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => `${rank}${suit}`));
}

export function shuffleDeck(deck = createDeck()) {
  const copy = [...deck];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function clampInteger(value, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function translateHand(hand) {
  return HAND_LABELS[hand?.name] ?? hand?.name ?? "牌型";
}

export class HoldemGame {
  constructor({
    players,
    settings,
    buttonSeat = null,
    actionSeconds = DEFAULT_ACTION_SECONDS,
    deck = null,
    allowLegacyChipAmounts = false,
    deferAutoRunout = false,
    runoutStepMs = 0,
  }) {
    if (players.length < 2 || players.length > 8) {
      throw new Error("牌局需要 2–8 位有筹码的玩家");
    }
    if (new Set(players.map((player) => player.userId)).size !== players.length) {
      throw new Error("牌局玩家标识不能重复");
    }
    if (new Set(players.map((player) => player.seat)).size !== players.length
      || players.some((player) => !Number.isSafeInteger(player.seat) || player.seat < 0 || player.seat > 7)) {
      throw new Error("牌局座位必须唯一且位于 0–7");
    }
    if (players.some((player) => !Number.isSafeInteger(player.stack) || player.stack <= 0)) {
      throw new Error("玩家筹码必须是正整数");
    }
    if (!allowLegacyChipAmounts && players.some((player) => !isStandardChipAmount(player.stack, { allowZero: false }))) {
      throw new Error(`玩家筹码必须是 ${CHIP_UNIT} 的倍数`);
    }
    if (!allowLegacyChipAmounts
      && (!isStandardChipAmount(settings.smallBlind, { allowZero: false })
        || !isStandardChipAmount(settings.bigBlind, { allowZero: false }))) {
      throw new Error(`盲注必须是 ${CHIP_UNIT} 的倍数`);
    }
    this.settings = settings;
    this.handId = crypto.randomUUID();
    this.stateVersion = 0;
    this.actionToken = null;
    this.initialChipTotal = players.reduce((sum, player) => sum + player.stack, 0);
    this.players = players
      .map((player) => ({
        userId: player.userId,
        username: player.username,
        seat: player.seat,
        isBot: Boolean(player.isBot),
        stack: player.stack,
        startingStack: player.stack,
        hand: [],
        spectatorHidden: false,
        folded: false,
        allIn: false,
        bet: 0,
        totalCommitted: 0,
        acted: false,
      }))
      .sort((a, b) => a.seat - b.seat);
    this.spectatorMysteryUserId = this.players[crypto.randomInt(this.players.length)].userId;
    this.deck = deck ? [...deck] : shuffleDeck();
    if (this.deck.length !== 52
      || new Set(this.deck).size !== 52
      || this.deck.some((card) => !createDeck().includes(card))) {
      throw new Error("牌堆必须包含 52 张不重复的标准扑克牌");
    }
    this.burned = [];
    this.community = [];
    // Character abilities may reserve a future turn or river card. Reserved
    // cards leave the deck immediately, stay inside the 52-card integrity
    // set, and are consumed only when that street is actually dealt.
    this.queuedBoardCards = { turn: null, river: null };
    this.riverReplacementArmed = false;
    this.stage = "preflop";
    this.currentBet = 0;
    this.minRaise = settings.bigBlind;
    this.actionSeconds = actionSeconds;
    this.timeExtensionFees = 0;
    this.timeExtensionUsed = false;
    this.actionLog = [];
    // Private, server-owned action facts used to build the immutable hand
    // analysis record at settlement. Unlike actionLog, this is never attached
    // to a socket view or the general application logger because the final
    // record also contains every player's private hole cards.
    this.analysisActions = [];
    this.winners = [];
    this.finishedReason = null;
    // Replacement history and showdown provenance are server-owned facts.
    // They are persisted for crash recovery but are deliberately omitted from
    // viewFor(), because both structures can reveal private card identities.
    this.holeCardReplacements = [];
    this.settlementProvenance = null;
    // Hextech effects may move chips between a player, the public pot and the
    // bank without pretending those chips are a poker bet. Keeping those
    // flows explicit preserves side-pot correctness and lets the integrity
    // check account for every physical chip.
    this.bonusPot = 0;
    this.bankInjected = 0;
    this.bankCollected = 0;
    this.actionPolicy = null;
    this.turnTimePolicy = null;
    this.currentTurnActionSeconds = actionSeconds;
    this.hextechPause = null;
    this.foldReveal = null;
    this.actingSeat = null;
    this.turnDeadline = null;
    this.autoRunoutDeferred = Boolean(deferAutoRunout);
    this.runoutStepMs = Number.isFinite(runoutStepMs)
      ? Math.max(0, Math.min(MAX_RESTORED_RUNOUT_STEP_MS, Math.floor(runoutStepMs)))
      : 0;
    this.runout = null;
    this.buttonSeat = buttonSeat == null
      ? this.players[0].seat
      : this.#nextSeat(buttonSeat, () => true);

    this.#dealHoleCards();
    if (this.players.length === 2) {
      this.smallBlindSeat = this.buttonSeat;
      this.bigBlindSeat = this.#nextSeat(this.smallBlindSeat, () => true);
    } else {
      this.smallBlindSeat = this.#nextSeat(this.buttonSeat, () => true);
      this.bigBlindSeat = this.#nextSeat(this.smallBlindSeat, () => true);
    }
    this.#postBlind(this.smallBlindSeat, settings.smallBlind, "小盲");
    this.#postBlind(this.bigBlindSeat, settings.bigBlind, "大盲");
    this.currentBet = Math.max(...this.players.map((player) => player.bet));

    const firstSeat = this.players.length === 2
      ? this.smallBlindSeat
      : this.#nextSeat(this.bigBlindSeat, (player) => !player.folded && !player.allIn);
    const dealDurationMs = holeCardDealDurationMs(this.players.length);
    this.dealCompleteAt = Date.now() + dealDurationMs;
    this.#setTurn(firstSeat, dealDurationMs);
    this.#record("系统", "底牌已发出");
    if (!this.autoRunoutDeferred) this.#skipIfNoActionPossible();
    this.#assertIntegrity();
  }

  static restore(state, { settings, now = Date.now(), reconnectGraceMs = RESTART_RECONNECT_GRACE_MS } = {}) {
    if (!state || ![1, 2, 3, PERSISTED_GAME_VERSION].includes(state.version) || !Array.isArray(state.players)) {
      throw new Error("牌局恢复数据格式不正确");
    }
    if (!settings || typeof settings !== "object") throw new Error("牌局恢复设置缺失");
    const actionSeconds = Number.isSafeInteger(state.actionSeconds) && state.actionSeconds > 0
      ? state.actionSeconds
      : DEFAULT_ACTION_SECONDS;
    const game = new HoldemGame({
      players: state.players.map((player) => ({
        userId: player.userId,
        username: player.username,
        seat: player.seat,
        isBot: Boolean(player.isBot),
        stack: player.startingStack,
      })),
      settings,
      actionSeconds,
      deck: createDeck(),
      allowLegacyChipAmounts: true,
      deferAutoRunout: Boolean(state.autoRunoutDeferred),
      runoutStepMs: Number.isFinite(state.runoutStepMs) ? state.runoutStepMs : 0,
    });

    game.settings = settings;
    game.handId = String(state.handId ?? "");
    if (!game.handId || game.handId.length > 80) throw new Error("牌局恢复标识不正确");
    game.stateVersion = Number.isSafeInteger(state.stateVersion) ? state.stateVersion + 1 : 1;
    game.initialChipTotal = state.initialChipTotal;
    game.players = state.players.map((player) => ({
      userId: String(player.userId ?? ""),
      username: String(player.username ?? ""),
      seat: player.seat,
      isBot: Boolean(player.isBot),
      stack: player.stack,
      startingStack: player.startingStack,
      hand: Array.isArray(player.hand) ? [...player.hand] : [],
      spectatorHidden: Boolean(player.spectatorHidden),
      folded: Boolean(player.folded),
      allIn: Boolean(player.allIn),
      bet: player.bet,
      totalCommitted: player.totalCommitted,
      acted: Boolean(player.acted),
    })).sort((left, right) => left.seat - right.seat);
    game.spectatorMysteryUserId = game.players.some((player) => player.userId === state.spectatorMysteryUserId)
      ? state.spectatorMysteryUserId
      : game.spectatorMysteryUserId;
    game.deck = Array.isArray(state.deck) ? [...state.deck] : [];
    game.burned = Array.isArray(state.burned) ? [...state.burned] : [];
    game.community = Array.isArray(state.community) ? [...state.community] : [];
    game.queuedBoardCards = {
      turn: typeof state.queuedBoardCards?.turn === "string" ? state.queuedBoardCards.turn : null,
      river: typeof state.queuedBoardCards?.river === "string" ? state.queuedBoardCards.river : null,
    };
    game.riverReplacementArmed = state.riverReplacementArmed === true;
    if (game.riverReplacementArmed
      && (game.queuedBoardCards.river || game.community.length >= 5)) {
      throw new Error("牌局恢复的河牌替换状态冲突");
    }
    game.stage = state.stage;
    if (!Object.hasOwn(STAGE_LABELS, game.stage)) throw new Error("牌局恢复阶段不正确");
    game.currentBet = state.currentBet;
    game.minRaise = state.minRaise;
    game.actionSeconds = actionSeconds;
    game.timeExtensionFees = state.timeExtensionFees;
    game.timeExtensionUsed = Boolean(state.timeExtensionUsed);
    game.actionLog = Array.isArray(state.actionLog) ? state.actionLog.map((entry) => ({ ...entry })) : [];
    game.analysisActions = Array.isArray(state.analysisActions)
      ? state.analysisActions.map((entry) => ({
        ...entry,
        communityCards: Array.isArray(entry.communityCards) ? [...entry.communityCards] : [],
      }))
      : [];
    if (game.analysisActions.some((entry, index) => (
      !entry
      || !Number.isSafeInteger(entry.sequence)
      || entry.sequence !== index + 1
      || !game.players.some((player) => player.userId === entry.userId)
      || !["preflop", "flop", "turn", "river"].includes(entry.street)
      || !["fold", "check", "call", "bet", "raise", "all-in"].includes(entry.action)
    ))) {
      throw new Error("牌局恢复的分析行动记录不正确");
    }
    game.winners = Array.isArray(state.winners) ? state.winners.map((winner) => ({ ...winner })) : [];
    game.finishedReason = state.finishedReason ?? null;
    game.holeCardReplacements = Array.isArray(state.holeCardReplacements)
      ? state.holeCardReplacements
        .filter((entry) => (
          entry
          && game.players.some((player) => player.userId === entry.userId)
          && typeof entry.replacement === "string"
          && ["random", "rank", "specific", "blank"].includes(entry.kind)
        ))
        .map((entry) => ({
          userId: entry.userId,
          cardIndex: [0, 1].includes(entry.cardIndex) ? entry.cardIndex : null,
          discarded: typeof entry.discarded === "string" ? entry.discarded : null,
          replacement: entry.replacement,
          kind: entry.kind,
          source: typeof entry.source === "string"
            ? entry.source
            : entry.kind === "specific" ? "character:qiwan-legacy" : null,
        }))
      : [];
    game.settlementProvenance = game.#restoreSettlementProvenance(state.settlementProvenance);
    game.bonusPot = Number.isSafeInteger(state.bonusPot) && state.bonusPot >= 0 ? state.bonusPot : 0;
    game.bankInjected = Number.isSafeInteger(state.bankInjected) && state.bankInjected >= 0
      ? state.bankInjected
      : 0;
    game.bankCollected = Number.isSafeInteger(state.bankCollected) && state.bankCollected >= 0
      ? state.bankCollected
      : 0;
    game.actionPolicy = null;
    game.turnTimePolicy = null;
    game.currentTurnActionSeconds = Number.isFinite(state.currentTurnActionSeconds)
      ? Math.max(1, state.currentTurnActionSeconds)
      : actionSeconds;
    game.hextechPause = state.hextechPause && Number.isFinite(state.hextechPause.remainingMs)
      ? {
        remainingMs: Math.max(0, state.hextechPause.remainingMs),
        deferStageAdvance: state.hextechPause.deferStageAdvance === true,
      }
      : null;
    if (game.finishedReason === "fold" && state.foldReveal) {
      const winnerUserId = String(state.foldReveal.winnerUserId ?? "");
      const decision = ["show", "muck"].includes(state.foldReveal.decision)
        ? state.foldReveal.decision
        : null;
      if (!game.players.some((player) => player.userId === winnerUserId)) {
        throw new Error("牌局恢复亮牌玩家不正确");
      }
      const remainingMs = Number.isFinite(state.foldReveal.remainingMs)
        ? Math.min(FOLD_REVEAL_SECONDS * 1000, Math.max(0, state.foldReveal.remainingMs))
        : 0;
      game.foldReveal = {
        winnerUserId,
        decision: decision ?? (remainingMs > 0 ? null : "muck"),
        deadline: decision == null && remainingMs > 0 ? now + remainingMs : null,
      };
    } else {
      game.foldReveal = null;
    }
    game.autoRunoutDeferred = Boolean(state.autoRunoutDeferred) && game.stage !== "finished";
    game.runoutStepMs = Number.isFinite(state.runoutStepMs)
      ? Math.max(0, Math.min(MAX_RESTORED_RUNOUT_STEP_MS, Math.floor(state.runoutStepMs)))
      : 0;
    const runoutRemainingMs = Number.isFinite(state.runoutRemainingMs)
      ? Math.max(0, Math.min(MAX_RESTORED_RUNOUT_STEP_MS, state.runoutRemainingMs))
      : null;
    game.runout = game.runoutStepMs > 0
      && ["preflop", "flop", "turn", "river"].includes(game.stage)
      && runoutRemainingMs != null
      ? { nextAt: now + runoutRemainingMs }
      : null;
    game.actingSeat = state.actingSeat ?? null;
    game.buttonSeat = state.buttonSeat;
    game.smallBlindSeat = state.smallBlindSeat;
    game.bigBlindSeat = state.bigBlindSeat;
    for (const seat of [game.buttonSeat, game.smallBlindSeat, game.bigBlindSeat]) {
      if (!Number.isSafeInteger(seat) || seat < 0 || seat > 7 || !game.#playerAt(seat)) {
        throw new Error("牌局恢复庄家或盲注座位不正确");
      }
    }

    const activeTurn = game.stage !== "finished" && game.actingSeat != null;
    const draftPaused = game.autoRunoutDeferred && game.stage !== "finished";
    const interactionPaused = draftPaused || Boolean(game.hextechPause) || Boolean(game.runout);
    if (game.runout && (
      activeTurn
      || draftPaused
      || game.hextechPause
      || !game.#shouldRunOut()
    )) {
      throw new Error("牌局恢复的全押发牌状态冲突");
    }
    if (activeTurn && !interactionPaused && (!game.currentPlayer || game.currentPlayer.folded || game.currentPlayer.allIn)) {
      throw new Error("牌局恢复行动座位不正确");
    }
    if (!activeTurn && game.stage !== "finished" && !interactionPaused) throw new Error("牌局恢复缺少行动座位");
    const maximumRemainingMs = (actionSeconds + TIME_EXTENSION_SECONDS) * 1000
      + holeCardDealDurationMs(game.players.length);
    const remainingMs = Number.isFinite(state.turnRemainingMs)
      ? Math.min(maximumRemainingMs, Math.max(0, state.turnRemainingMs))
      : 0;
    const graceMs = Number.isFinite(reconnectGraceMs) ? Math.max(0, reconnectGraceMs) : 0;
    if (game.hextechPause) game.hextechPause.remainingMs += graceMs;
    game.turnDeadline = activeTurn && !interactionPaused ? now + remainingMs + graceMs : null;
    const dealRemainingMs = Number.isFinite(state.dealRemainingMs)
      ? Math.min(holeCardDealDurationMs(game.players.length), Math.max(0, state.dealRemainingMs))
      : 0;
    game.dealCompleteAt = now + dealRemainingMs;
    // Rotate the one-time action token across a restart so an in-flight request from
    // the previous process cannot be replayed against the restored hand.
    game.actionToken = activeTurn && !interactionPaused ? crypto.randomBytes(18).toString("base64url") : null;
    // Additive provenance fields did not exist in older runtime snapshots.
    // Finished hands can be reconstructed deterministically from their
    // committed levels, private cards and final board.
    if (game.stage === "finished" && !game.settlementProvenance) {
      game.settlementProvenance = game.finishedReason === "showdown"
        ? game.#deriveShowdownProvenance()
        : game.#deriveFoldProvenance();
    }
    game.#assertIntegrity();
    return game;
  }

  exportState(now = Date.now()) {
    return {
      version: PERSISTED_GAME_VERSION,
      handId: this.handId,
      stateVersion: this.stateVersion,
      initialChipTotal: this.initialChipTotal,
      spectatorMysteryUserId: this.spectatorMysteryUserId,
      players: this.players.map((player) => ({ ...player, hand: [...player.hand] })),
      deck: [...this.deck],
      burned: [...this.burned],
      community: [...this.community],
      queuedBoardCards: { ...this.queuedBoardCards },
      riverReplacementArmed: this.riverReplacementArmed,
      stage: this.stage,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      actionSeconds: this.actionSeconds,
      currentTurnActionSeconds: this.currentTurnActionSeconds,
      hextechPause: this.hextechPause ? { ...this.hextechPause } : null,
      autoRunoutDeferred: this.autoRunoutDeferred,
      runoutStepMs: this.runoutStepMs,
      runoutRemainingMs: this.runout
        ? Math.max(0, this.runout.nextAt - now)
        : null,
      timeExtensionFees: this.timeExtensionFees,
      timeExtensionUsed: this.timeExtensionUsed,
      actionLog: this.actionLog.map((entry) => ({ ...entry })),
      analysisActions: this.analysisActions.map((entry) => ({
        ...entry,
        communityCards: [...entry.communityCards],
      })),
      winners: this.winners.map((winner) => ({ ...winner })),
      finishedReason: this.finishedReason,
      holeCardReplacements: this.holeCardReplacements.map((entry) => ({ ...entry })),
      settlementProvenance: this.settlementProvenance ? {
        reason: this.settlementProvenance.reason,
        players: Object.fromEntries(Object.entries(this.settlementProvenance.players).map(([userId, entry]) => [
          userId,
          {
            opponentsBeaten: [...entry.opponentsBeaten],
            bestFiveCardIds: [...entry.bestFiveCardIds],
          },
        ])),
      } : null,
      bonusPot: this.bonusPot,
      bankInjected: this.bankInjected,
      bankCollected: this.bankCollected,
      foldReveal: this.foldReveal ? {
        winnerUserId: this.foldReveal.winnerUserId,
        decision: this.foldReveal.decision,
        remainingMs: this.foldReveal.decision == null && this.foldReveal.deadline
          ? Math.max(0, this.foldReveal.deadline - now)
          : 0,
      } : null,
      actingSeat: this.actingSeat,
      buttonSeat: this.buttonSeat,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      dealRemainingMs: Math.max(0, this.dealCompleteAt - now),
      turnRemainingMs: this.turnDeadline == null ? null : Math.max(0, this.turnDeadline - now),
    };
  }

  resumeAfterDraft() {
    if (this.stage === "finished") return false;
    this.autoRunoutDeferred = false;
    this.dealCompleteAt = Date.now();
    this.#record("系统", "全员装备完成，翻牌前行动开始");
    this.#skipIfNoActionPossible();
    if (this.stage !== "finished" && this.actingSeat != null) this.#setTurn(this.actingSeat);
    this.#assertIntegrity();
    return true;
  }

  #playerAt(seat) {
    return this.players.find((player) => player.seat === seat);
  }

  #nextSeat(fromSeat, predicate) {
    for (let offset = 1; offset <= 8; offset += 1) {
      const seat = (fromSeat + offset) % 8;
      const player = this.#playerAt(seat);
      if (player && predicate(player)) return seat;
    }
    return null;
  }

  #dealHoleCards() {
    const first = this.#nextSeat(this.buttonSeat, () => true);
    const order = [];
    let seat = first;
    for (let count = 0; count < this.players.length; count += 1) {
      order.push(this.#playerAt(seat));
      seat = this.#nextSeat(seat, () => true);
    }
    for (let round = 0; round < 2; round += 1) {
      for (const player of order) player.hand.push(this.deck.pop());
    }
  }

  #postBlind(seat, requestedAmount, label) {
    const player = this.#playerAt(seat);
    const amount = Math.min(requestedAmount, player.stack);
    this.#commit(player, amount);
    this.#record(player.username, `${label} ${amount}`);
  }

  #commit(player, amountValue) {
    const amount = clampInteger(amountValue, 0, player.stack);
    player.stack -= amount;
    player.bet += amount;
    player.totalCommitted += amount;
    if (player.stack === 0) player.allIn = true;
    return amount;
  }

  #record(actor, text) {
    this.actionLog.push({ actor, text, at: new Date().toISOString() });
    this.actionLog = this.actionLog.slice(-40);
  }

  #setTurn(seat, initialDelayMs = 0) {
    this.actingSeat = seat;
    if (seat != null) this.runout = null;
    const turnPlayer = seat == null ? null : this.#playerAt(seat);
    const proposedSeconds = turnPlayer && this.turnTimePolicy
      ? this.turnTimePolicy({
        userId: turnPlayer.userId,
        stage: this.stage,
        baseSeconds: this.actionSeconds,
        players: this.players.map((player) => ({
          userId: player.userId,
          seat: player.seat,
          folded: player.folded,
          allIn: player.allIn,
        })),
      })
      : this.actionSeconds;
    this.currentTurnActionSeconds = Number.isFinite(proposedSeconds)
      ? Math.max(1, Math.min(120, proposedSeconds))
      : this.actionSeconds;
    const interactionPaused = Boolean(this.hextechPause) || this.autoRunoutDeferred;
    this.turnDeadline = seat == null || interactionPaused
      ? null
      : Date.now() + this.currentTurnActionSeconds * 1000 + Math.max(0, Number(initialDelayMs) || 0);
    this.actionToken = seat == null || interactionPaused ? null : crypto.randomBytes(18).toString("base64url");
    this.timeExtensionUsed = false;
    this.stateVersion += 1;
  }

  #touchState({ rotateActionToken = true } = {}) {
    this.stateVersion += 1;
    if (rotateActionToken && this.stage !== "finished" && this.actingSeat != null && !this.autoRunoutDeferred) {
      this.actionToken = crypto.randomBytes(18).toString("base64url");
    }
  }

  get pot() {
    return this.players.reduce((sum, player) => sum + player.totalCommitted, 0) + this.bonusPot;
  }

  get currentPlayer() {
    return this.#playerAt(this.actingSeat);
  }

  setActionPolicy(policy = null) {
    if (policy != null && typeof policy !== "function") throw new Error("行动限制器格式不正确");
    this.actionPolicy = policy;
    return this;
  }

  setTurnTimePolicy(policy = null) {
    if (policy != null && typeof policy !== "function") throw new Error("行动时长策略格式不正确");
    this.turnTimePolicy = policy;
    return this;
  }

  pauseForHextechWindow(now = Date.now()) {
    if (this.hextechPause || this.runout || this.stage === "finished") return false;
    this.hextechPause = {
      remainingMs: this.turnDeadline == null ? 0 : Math.max(0, this.turnDeadline - now),
      deferStageAdvance: false,
    };
    this.turnDeadline = null;
    this.actionToken = null;
    this.#touchState({ rotateActionToken: false });
    return true;
  }

  resumeFromHextechWindow(now = Date.now()) {
    if (!this.hextechPause) return false;
    const remainingMs = Math.max(1_000, this.hextechPause.remainingMs || this.currentTurnActionSeconds * 1000);
    const deferStageAdvance = this.hextechPause.deferStageAdvance === true;
    this.hextechPause = null;
    if (deferStageAdvance && this.stage !== "finished") {
      this.#advanceStage();
    } else if (this.stage !== "finished" && this.actingSeat != null && !this.autoRunoutDeferred) {
      this.turnDeadline = now + remainingMs;
      this.actionToken = crypto.randomBytes(18).toString("base64url");
    }
    this.#touchState({ rotateActionToken: false });
    return true;
  }

  #policyFor(userId) {
    if (!this.actionPolicy) return {};
    const value = this.actionPolicy({
      userId,
      stage: this.stage,
      currentBet: this.currentBet,
      bigBlind: this.settings.bigBlind,
      players: this.players.map((player) => ({
        userId: player.userId,
        folded: player.folded,
        allIn: player.allIn,
        bet: player.bet,
        stack: player.stack,
      })),
    });
    return value && typeof value === "object" ? value : {};
  }

  legalActions(userId) {
    if (this.hextechPause) return null;
    const player = this.players.find((candidate) => candidate.userId === userId);
    if (!player || player.seat !== this.actingSeat || player.folded || player.allIn
      || player.stack <= 0 || this.stage === "finished") return null;
    const toCall = Math.max(0, this.currentBet - player.bet);
    const naturalMaxRaiseTo = player.bet + player.stack;
    const policy = this.#policyFor(userId);
    const policyMaximum = Number.isSafeInteger(policy.maxRaiseTo)
      ? Math.max(0, policy.maxRaiseTo)
      : naturalMaxRaiseTo;
    const maxRaiseTo = Math.min(naturalMaxRaiseTo, policyMaximum);
    const raiseDisabled = Boolean(policy.disableRaise) || maxRaiseTo <= this.currentBet;
    const canReachLegalRaise = maxRaiseTo >= this.currentBet + this.minRaise
      || maxRaiseTo === naturalMaxRaiseTo;
    const allInTarget = naturalMaxRaiseTo;
    const allInWouldRaise = allInTarget > this.currentBet;
    const canAllIn = player.stack > 0
      && !policy.disableAllIn
      && (!allInWouldRaise || (!raiseDisabled && allInTarget <= maxRaiseTo));
    return {
      toCall: Math.min(toCall, player.stack),
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0 && player.stack > 0,
      canRaise: !raiseDisabled
        && canReachLegalRaise
        && player.stack > toCall
        && maxRaiseTo > this.currentBet,
      canAllIn,
      minRaiseTo: Math.min(maxRaiseTo, this.currentBet + this.minRaise),
      maxRaiseTo,
      restrictionReason: typeof policy.reason === "string" ? policy.reason : null,
    };
  }

  privateCardsFor(userId) {
    const player = this.players.find((candidate) => candidate.userId === userId);
    return player ? [...player.hand] : null;
  }

  /**
   * Authoritative, server-only settlement facts. Never attach this result to
   * a socket view: bestFiveCardIds can contain another player's hole cards.
   */
  settlementResults() {
    if (this.stage !== "finished") return [];
    if (!this.settlementProvenance) {
      this.settlementProvenance = this.finishedReason === "showdown"
        ? this.#deriveShowdownProvenance()
        : this.#deriveFoldProvenance();
    }
    return this.players.map((player) => {
      const provenance = this.settlementProvenance.players[player.userId] ?? {
        opponentsBeaten: [],
        bestFiveCardIds: [],
      };
      const specificReplacementCardIds = this.holeCardReplacements
        .filter((entry) => entry.userId === player.userId && entry.kind === "specific")
        .map((entry) => entry.replacement);
      const qiwanReplacementCardIds = this.holeCardReplacements
        .filter((entry) => entry.userId === player.userId && (
          entry.kind === "specific" || entry.source?.startsWith("character:qiwan")
        ))
        .map((entry) => entry.replacement);
      const bestFiveCardIds = [...provenance.bestFiveCardIds];
      return {
        userId: player.userId,
        wonPotAmount: this.winners.find((winner) => winner.userId === player.userId)?.amount ?? 0,
        opponentsBeaten: [...provenance.opponentsBeaten],
        bestFiveCardIds,
        replacementUsedInFinalHand: specificReplacementCardIds
          .some((cardId) => bestFiveCardIds.includes(cardId)),
        qiwanReplacementUsedInFinalHand: qiwanReplacementCardIds
          .some((cardId) => bestFiveCardIds.includes(cardId)),
      };
    });
  }

  playerSnapshot(userId) {
    const player = this.players.find((candidate) => candidate.userId === userId);
    return player ? { ...player, hand: [...player.hand] } : null;
  }

  recordHextechEvent(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("海克斯事件文案不能为空");
    this.#record("海克斯", text.trim().slice(0, 160));
    this.#touchState();
    return this;
  }

  addPlayerChipsToPot({ userId, amount, label = "技能费用", allowPartial = false }) {
    const snapshot = this.#snapshot();
    try {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("技能费用必须是正整数");
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player || (player.folded && !allowPartial)) throw new Error("玩家当前不在本手中");
      if (!allowPartial && player.stack < amount) throw new Error("筹码不足，无法支付技能费用");
      const paid = Math.min(player.stack, amount);
      if (paid <= 0) {
        if (allowPartial) return 0;
        throw new Error("没有可支付的筹码");
      }
      player.stack -= paid;
      if (this.stage === "finished") {
        this.#creditFinishedMainPot(paid);
      } else {
        if (player.stack === 0) player.allIn = true;
        this.bonusPot += paid;
      }
      this.#record(player.username, this.stage === "finished"
        ? `${label} ${paid}，补入已结算底池`
        : `${label} ${paid}，加入底池`);
      if (!this.#reconcileExternalPlayerState(player)) this.#touchState();
      this.#assertIntegrity();
      return paid;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  addBankChipsToPot({ amount, label = "银行奖励" }) {
    const snapshot = this.#snapshot();
    try {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("银行奖励必须是正整数");
      this.bankInjected += amount;
      if (this.stage === "finished") {
        this.#creditFinishedMainPot(amount);
      } else {
        this.bonusPot += amount;
      }
      this.#touchState();
      this.#record("银行", this.stage === "finished"
        ? `${label} ${amount}，补入已结算底池`
        : `${label} ${amount}，加入底池`);
      this.#assertIntegrity();
      return amount;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  #finishedMainPotRecipientIds() {
    if (this.stage !== "finished" || !this.winners.length) return [];
    if (this.finishedReason === "fold") return [this.winners[0].userId];

    const firstLevel = this.players
      .map((player) => player.totalCommitted)
      .filter((amount) => amount > 0)
      .sort((left, right) => left - right)[0];
    if (!firstLevel) return this.winners.map((winner) => winner.userId);
    const eligible = this.players.filter((player) => (
      !player.folded && player.totalCommitted >= firstLevel
    ));
    if (!eligible.length) return [];
    const solved = eligible.map((player) => ({
      player,
      hand: Hand.solve([...player.hand, ...this.community].filter((card) => card !== HEXTECH_BLANK_CARD)),
    }));
    const winningHands = Hand.winners(solved.map(({ hand }) => hand));
    return solved
      .filter(({ hand }) => winningHands.includes(hand))
      .sort((left, right) => {
        const leftDistance = ((left.player.seat - this.buttonSeat + 8) % 8) || 8;
        const rightDistance = ((right.player.seat - this.buttonSeat + 8) % 8) || 8;
        return leftDistance - rightDistance;
      })
      .map(({ player }) => player.userId);
  }

  #creditFinishedMainPot(amount) {
    const recipientIds = this.#finishedMainPotRecipientIds();
    if (!recipientIds.length) throw new Error("本手没有可接收延迟底池筹码的主池赢家");
    let remaining = amount;
    for (let index = 0; index < recipientIds.length; index += 1) {
      const slotsLeft = recipientIds.length - index;
      const share = index === recipientIds.length - 1
        ? remaining
        : Math.floor(remaining / slotsLeft / CHIP_UNIT) * CHIP_UNIT;
      const userId = recipientIds[index];
      const winner = this.winners.find((entry) => entry.userId === userId);
      const winnerPlayer = this.players.find((player) => player.userId === userId);
      if (!winner || !winnerPlayer) throw new Error("主池赢家结算状态不完整");
      winnerPlayer.stack += share;
      winner.amount += share;
      remaining -= share;
    }
  }

  creditPlayerFromBank({ userId, amount, label = "银行奖励" }) {
    const snapshot = this.#snapshot();
    try {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("银行奖励必须是正整数");
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player) throw new Error("玩家不在当前牌局");
      player.stack += amount;
      this.bankInjected += amount;
      this.#touchState();
      this.#record("银行", `${player.username} 获得${label} ${amount}`);
      this.#assertIntegrity();
      return amount;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  collectPlayerChipsToBank({ userId, amount, label = "技能费用" }) {
    const snapshot = this.#snapshot();
    try {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("银行费用必须是正整数");
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player || player.stack < amount) throw new Error("筹码不足，无法支付银行费用");
      player.stack -= amount;
      if (player.stack === 0 && this.stage !== "finished") player.allIn = true;
      this.bankCollected += amount;
      this.#record(player.username, `${label} ${amount}`);
      if (!this.#reconcileExternalPlayerState(player)) this.#touchState();
      this.#assertIntegrity();
      return amount;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  transferPlayerChips({ fromUserId, toUserId, amount, label = "技能结算", allowPartial = true }) {
    const snapshot = this.#snapshot();
    try {
      if (fromUserId === toUserId) throw new Error("筹码转移双方不能相同");
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("筹码转移金额必须是正整数");
      const source = this.players.find((candidate) => candidate.userId === fromUserId);
      const target = this.players.find((candidate) => candidate.userId === toUserId);
      if (!source || !target) throw new Error("筹码转移玩家不在当前牌局");
      if (!allowPartial && source.stack < amount) throw new Error("筹码不足，无法完成转移");
      const paid = Math.min(source.stack, amount);
      if (paid <= 0) throw new Error("没有可转移的筹码");
      source.stack -= paid;
      target.stack += paid;
      if (source.stack === 0 && this.stage !== "finished") source.allIn = true;
      this.#record(source.username, `${label}：向 ${target.username} 支付 ${paid}`);
      if (!this.#reconcileExternalPlayerState(source)) this.#touchState();
      this.#assertIntegrity();
      return paid;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  forceCallContribution({ userId, maximumAmount, label = "强制跟注" }) {
    const snapshot = this.#snapshot();
    try {
      if (this.stage === "finished") throw new Error("本手已经结束");
      if (!Number.isSafeInteger(maximumAmount) || maximumAmount <= 0) throw new Error("强制跟注上限不正确");
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player || player.folded || player.allIn) throw new Error("目标当前不能跟注");
      const analysisBefore = this.#analysisActionContext(player);
      const toCall = Math.max(0, this.currentBet - player.bet);
      const paid = this.#commit(player, Math.min(toCall, maximumAmount, player.stack));
      if (paid <= 0) throw new Error("目标当前无需跟注");
      player.acted = player.bet === this.currentBet;
      this.#record(player.username, `${label} ${paid}${player.allIn ? "，全押" : ""}`);
      this.#recordAnalysisAction({
        player,
        requestedAction: "call",
        requestedAmount: maximumAmount,
        before: analysisBefore,
        automatic: true,
        source: "hextech",
      });
      if (player.seat === this.actingSeat) this.#afterAction(player.seat);
      else this.#touchState();
      this.#assertIntegrity();
      return paid;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  replaceHoleCardFromDeck({
    userId,
    cardIndex,
    publicDiscard = false,
    label = "换牌",
    source = null,
  }) {
    const snapshot = this.#snapshot();
    try {
      if (this.stage === "finished") throw new Error("本手已经结束");
      if (![0, 1].includes(cardIndex)) throw new Error("底牌位置不正确");
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player || player.folded || player.hand.length !== 2) throw new Error("玩家当前不能换牌");
      const discarded = player.hand[cardIndex];
      const replacement = this.deck.pop();
      if (!replacement) throw new Error("牌堆没有可用牌");
      player.hand[cardIndex] = replacement;
      this.burned.push(discarded);
      this.holeCardReplacements.push({
        userId,
        cardIndex,
        discarded,
        replacement,
        kind: "random",
        source: typeof source === "string" ? source : null,
      });
      this.#touchState();
      this.#record(
        player.username,
        publicDiscard ? `${label}：弃置 ${discarded}` : `${label}：替换一张底牌`,
      );
      this.#assertIntegrity();
      return { discarded: publicDiscard ? discarded : null, replacement };
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  replaceHoleCardWithRank({
    userId,
    cardIndex,
    rank,
    preferredSuit = null,
    preserveSuit = true,
    label = "指定点数变牌",
  }) {
    const snapshot = this.#snapshot();
    try {
      if (![0, 1].includes(cardIndex) || !RANKS.includes(rank)) throw new Error("目标底牌或点数不正确");
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player || player.folded || player.hand.length !== 2) throw new Error("玩家当前不能变牌");
      const allCandidates = this.deck
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => card[0] === rank);
      const suit = preferredSuit ?? (preserveSuit ? player.hand[cardIndex]?.at(-1) : null);
      const suitedCandidates = suit
        ? allCandidates.filter(({ card }) => card.endsWith(suit))
        : [];
      const candidateIndexes = suitedCandidates.length ? suitedCandidates : allCandidates;
      if (!candidateIndexes.length) throw new Error("牌堆中没有该点数的合法牌");
      const chosen = candidateIndexes[crypto.randomInt(candidateIndexes.length)];
      const discarded = player.hand[cardIndex];
      player.hand[cardIndex] = chosen.card;
      this.deck.splice(chosen.index, 1);
      this.burned.push(discarded);
      this.holeCardReplacements.push({
        userId,
        cardIndex,
        discarded,
        replacement: chosen.card,
        kind: "rank",
      });
      this.#touchState();
      this.#record(player.username, `${label}：一张底牌已改变`);
      this.#assertIntegrity();
      return { discarded, replacement: chosen.card };
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  replaceHoleCardWithSpecificCard({ userId, cardIndex, card, label = "候选换牌" }) {
    const snapshot = this.#snapshot();
    try {
      if (this.stage === "finished") throw new Error("本手已经结束");
      if (![0, 1].includes(cardIndex) || typeof card !== "string") throw new Error("目标底牌或候选牌不正确");
      const player = this.players.find((candidate) => candidate.userId === userId);
      const deckIndex = this.deck.indexOf(card);
      if (!player || player.folded || player.hand.length !== 2) throw new Error("玩家当前不能换牌");
      if (deckIndex < 0) throw new Error("候选牌已经不在剩余牌堆中");
      const discarded = player.hand[cardIndex];
      player.hand[cardIndex] = card;
      this.deck.splice(deckIndex, 1);
      this.burned.push(discarded);
      this.holeCardReplacements.push({
        userId,
        cardIndex,
        discarded,
        replacement: card,
        kind: "specific",
      });
      this.#touchState();
      this.#record(player.username, `${label}：一张底牌已替换`);
      this.#assertIntegrity();
      return { discarded, replacement: card };
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  replaceHoleCardWithBlank({ userId, cardIndex, label = "白板变牌" }) {
    const snapshot = this.#snapshot();
    try {
      if (this.stage === "finished") throw new Error("本手已经结束");
      if (![0, 1].includes(cardIndex)) throw new Error("目标底牌位置不正确");
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player || player.folded || player.hand.length !== 2) throw new Error("玩家当前不能变成白板牌");
      const discarded = player.hand[cardIndex];
      if (discarded === HEXTECH_BLANK_CARD) throw new Error("该底牌已经是白板牌");
      player.hand[cardIndex] = HEXTECH_BLANK_CARD;
      this.burned.push(discarded);
      this.holeCardReplacements.push({
        userId,
        cardIndex,
        discarded,
        replacement: HEXTECH_BLANK_CARD,
        kind: "blank",
      });
      this.#touchState();
      this.#record(player.username, `${label}：一张底牌失去点数与花色`);
      this.#assertIntegrity();
      return { discarded, replacement: HEXTECH_BLANK_CARD };
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  forceFold({ userId, label = "技能强制离局" }) {
    const snapshot = this.#snapshot();
    try {
      if (this.stage === "finished") throw new Error("本手已经结束");
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player || player.folded) throw new Error("玩家当前不能被强制弃牌");
      const analysisBefore = this.#analysisActionContext(player);
      player.folded = true;
      player.acted = true;
      this.#record(player.username, label);
      this.#recordAnalysisAction({
        player,
        requestedAction: "fold",
        requestedAmount: null,
        before: analysisBefore,
        automatic: true,
        source: "hextech",
      });
      const contenders = this.players.filter((candidate) => !candidate.folded);
      if (contenders.length === 1) this.#finishUncontested(contenders[0]);
      else if (player.seat === this.actingSeat) this.#afterAction(player.seat);
      else this.#touchState();
      this.#assertIntegrity();
      return true;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  nextCommunityCandidates({ street, count, suit = null } = {}) {
    if (!["turn", "river"].includes(street)) throw new Error("候选公共牌街道不正确");
    if (!Number.isSafeInteger(count) || count < 1 || count > 4) throw new Error("候选公共牌数量不正确");
    if (this.queuedBoardCards[street]) throw new Error("该街公共牌已经选定");
    if (street === "river" && this.riverReplacementArmed) throw new Error("河牌已经预约随机替换");
    const expectedCommunity = street === "turn" ? 3 : 4;
    if (this.community.length > expectedCommunity) throw new Error("该公共牌已经发出");
    const suitCode = suit == null ? null : ({ spades: "s", hearts: "h", diamonds: "d", clubs: "c" })[suit];
    if (suit != null && !suitCode) throw new Error("候选公共牌花色不正确");
    // Hold'em burns the current top card before dealing the board card, so
    // character candidates begin one card deeper. This method is read-only;
    // Rooms freezes poker actions while the choice window is open.
    const candidates = [];
    for (let index = this.deck.length - 2; index >= 0 && candidates.length < count; index -= 1) {
      const card = this.deck[index];
      if (!suitCode || card.endsWith(suitCode)) candidates.push(card);
    }
    if (candidates.length !== count) throw new Error("牌堆没有足够的合法候选公共牌");
    return candidates;
  }

  peekNextCommunityCard({ street } = {}) {
    return this.nextCommunityCandidates({ street, count: 1 })[0];
  }

  queueBoardCard({ street, card, label = "人物技能选牌" }) {
    const snapshot = this.#snapshot();
    try {
      if (!["turn", "river"].includes(street) || typeof card !== "string") {
        throw new Error("预约公共牌参数不正确");
      }
      if (this.stage === "finished" || this.community.includes(card) || this.burned.includes(card)) {
        throw new Error("该公共牌当前不可预约");
      }
      if (this.queuedBoardCards[street]) throw new Error("该街公共牌已经预约");
      if (street === "river" && this.riverReplacementArmed) throw new Error("河牌已经预约随机替换");
      const deckIndex = this.deck.indexOf(card);
      if (deckIndex < 0) throw new Error("候选公共牌已经不在剩余牌堆中");
      this.deck.splice(deckIndex, 1);
      this.queuedBoardCards[street] = card;
      this.#touchState();
      this.#record("海克斯", `${label}：${street === "turn" ? "转牌" : "河牌"}已锁定`);
      this.#assertIntegrity();
      return card;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  armRiverReplacementFromDeck({ label = "鸭哥·逆流换河" } = {}) {
    const snapshot = this.#snapshot();
    try {
      if (this.stage === "finished" || this.community.length >= 5) throw new Error("河牌已经发出");
      if (this.queuedBoardCards.river) throw new Error("河牌已经被其他人物技能锁定");
      if (this.riverReplacementArmed) throw new Error("本手河牌已经预约替换");
      this.riverReplacementArmed = true;
      this.#touchState();
      this.#record("海克斯", `${label}：河牌将在发出时随机替换`);
      this.#assertIntegrity();
      return true;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  redealRiver({ label = "河牌否决" } = {}) {
    const snapshot = this.#snapshot();
    try {
      if (this.stage !== "river" || this.community.length !== 5) throw new Error("当前没有可重发的河牌");
      const discarded = this.community.pop();
      const replacement = this.deck.pop();
      if (!replacement) throw new Error("牌堆没有可用牌");
      this.burned.push(discarded);
      this.community.push(replacement);
      this.#touchState();
      this.#record("海克斯", `${label}：河牌已弃置并重新发出`);
      this.#assertIntegrity();
      return { discarded, replacement };
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  act(userId, action, amount = null, {
    pauseAfterCommit = false,
    automatic = false,
    source = "player",
  } = {}) {
    const snapshot = this.#snapshot();
    try {
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player || player.seat !== this.actingSeat) throw new Error("还没有轮到你行动");
      if (player.folded || player.allIn || this.stage === "finished") throw new Error("当前不能执行该操作");

      const legal = this.legalActions(userId);
      const toCall = this.currentBet - player.bet;
      const analysisBefore = this.#analysisActionContext(player);

      if (action === "fold") {
        player.folded = true;
        player.acted = true;
        this.#record(player.username, "弃牌");
      } else if (action === "check") {
        if (!legal.canCheck) throw new Error("当前需要跟注或弃牌");
        player.acted = true;
        this.#record(player.username, "过牌");
      } else if (action === "call") {
        if (!legal.canCall) throw new Error("当前无需跟注");
        const paid = this.#commit(player, Math.min(toCall, player.stack));
        player.acted = true;
        this.#record(player.username, player.allIn ? `跟注 ${paid}，全押` : `跟注 ${paid}`);
      } else if (action === "raise") {
        if (!legal.canRaise) throw new Error("当前不能加注");
        if (!Number.isSafeInteger(amount)) throw new Error("加注金额必须是整数");
        if (!isStandardChipAmount(amount, { allowZero: false })) {
          throw new Error(`加注金额必须是 ${CHIP_UNIT} 的倍数`);
        }
        const target = amount;
        if (target > legal.maxRaiseTo) throw new Error(`最多只能加注至 ${legal.maxRaiseTo}`);
        if (target <= this.currentBet) throw new Error("加注金额必须高于当前下注");
        const fullRaiseMinimum = this.currentBet + this.minRaise;
        const naturalAllInTarget = player.bet + player.stack;
        if (target < fullRaiseMinimum && target !== naturalAllInTarget) {
          throw new Error(`最低需要加注至 ${fullRaiseMinimum}`);
        }
        this.#raiseTo(player, target);
        this.#record(player.username, player.allIn ? `加注至 ${target}，全押` : `加注至 ${target}`);
      } else if (action === "allin") {
        if (!legal.canAllIn) throw new Error("当前不能全押");
        const target = player.bet + player.stack;
        if (target > this.currentBet) {
          this.#raiseTo(player, target);
          this.#record(player.username, `全押至 ${target}`);
        } else {
          const paid = this.#commit(player, player.stack);
          player.acted = true;
          this.#record(player.username, `全押 ${paid}`);
        }
      } else {
        throw new Error("未知操作");
      }

      this.#recordAnalysisAction({
        player,
        requestedAction: action,
        requestedAmount: amount,
        before: analysisBefore,
        automatic,
        source,
      });
      if (pauseAfterCommit) this.pauseForHextechWindow();
      this.#afterAction(player.seat);
      this.#assertIntegrity();
      return this;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  #snapshot() {
    return {
      players: this.players.map((player) => ({ ...player, hand: [...player.hand] })),
      deck: [...this.deck],
      burned: [...this.burned],
      community: [...this.community],
      queuedBoardCards: { ...this.queuedBoardCards },
      riverReplacementArmed: this.riverReplacementArmed,
      hextechPause: this.hextechPause ? { ...this.hextechPause } : null,
      stage: this.stage,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      actionLog: this.actionLog.map((entry) => ({ ...entry })),
      analysisActions: this.analysisActions.map((entry) => ({
        ...entry,
        communityCards: [...entry.communityCards],
      })),
      winners: this.winners.map((winner) => ({ ...winner })),
      finishedReason: this.finishedReason,
      holeCardReplacements: this.holeCardReplacements.map((entry) => ({ ...entry })),
      settlementProvenance: this.settlementProvenance ? structuredClone(this.settlementProvenance) : null,
      foldReveal: this.foldReveal ? { ...this.foldReveal } : null,
      runout: this.runout ? { ...this.runout } : null,
      actingSeat: this.actingSeat,
      turnDeadline: this.turnDeadline,
      actionToken: this.actionToken,
      currentTurnActionSeconds: this.currentTurnActionSeconds,
      timeExtensionFees: this.timeExtensionFees,
      timeExtensionUsed: this.timeExtensionUsed,
      bonusPot: this.bonusPot,
      bankInjected: this.bankInjected,
      bankCollected: this.bankCollected,
      stateVersion: this.stateVersion,
    };
  }

  #restore(snapshot) {
    Object.assign(this, snapshot);
  }

  createTransactionSnapshot() {
    return structuredClone(this.#snapshot());
  }

  restoreTransactionSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("牌局事务快照不正确");
    this.#restore(structuredClone(snapshot));
    this.#assertIntegrity();
    return this;
  }

  submitAction({
    userId,
    action,
    amount = null,
    handId,
    actionToken,
    pauseForHextechWindow = false,
  }) {
    const handMatches = constantTimeEqual(this.handId, handId);
    const tokenMatches = this.actionToken && constantTimeEqual(this.actionToken, actionToken);
    if (!handMatches || !tokenMatches) {
      throw new SecurityError("操作已过期，请以当前牌桌状态为准", "stale_game_action");
    }
    if (!this.turnDeadline || Date.now() >= this.turnDeadline) {
      throw new SecurityError("本回合行动时间已经结束", "expired_game_action");
    }
    return this.act(userId, action, amount, {
      pauseAfterCommit: pauseForHextechWindow,
      automatic: false,
      source: "player",
    });
  }

  buyTimeExtension({ userId, handId, actionToken, now = Date.now() }) {
    const handMatches = constantTimeEqual(this.handId, handId);
    const tokenMatches = this.actionToken && constantTimeEqual(this.actionToken, actionToken);
    if (!handMatches || !tokenMatches) {
      throw new SecurityError("操作已过期，请以当前牌桌状态为准", "stale_time_extension");
    }

    const snapshot = this.#snapshot();
    try {
      const player = this.players.find((candidate) => candidate.userId === userId);
      if (!player || player.seat !== this.actingSeat) {
        throw new SecurityError("只有当前行动玩家可以购买加时", "forbidden_time_extension");
      }
      if (player.folded || player.allIn || this.stage === "finished") throw new Error("当前不能购买加时");
      if (!this.turnDeadline || now >= this.turnDeadline) throw new Error("本回合行动时间已经结束");
      if (this.timeExtensionUsed) throw new Error("本回合已经使用过加时卡");
      if (player.stack < TIME_EXTENSION_COST + CHIP_UNIT) {
        throw new Error(`至少需要 ${TIME_EXTENSION_COST + CHIP_UNIT} 筹码才能购买加时`);
      }

      player.stack -= TIME_EXTENSION_COST;
      this.timeExtensionFees += TIME_EXTENSION_COST;
      this.timeExtensionUsed = true;
      this.turnDeadline += TIME_EXTENSION_SECONDS * 1000;
      this.stateVersion += 1;
      this.#record(
        player.username,
        `购买加时 +${TIME_EXTENSION_SECONDS} 秒，花费 ${TIME_EXTENSION_COST} 筹码`,
      );
      this.#assertIntegrity();
      return this;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  setSpectatorVisibility({ userId, hidden, handId }) {
    if (!constantTimeEqual(this.handId, handId)) {
      throw new SecurityError("手牌隐私设置已过期，请以当前牌局为准", "stale_spectator_visibility");
    }
    if (this.stage === "finished") throw new Error("本局已经结束");
    const player = this.players.find((candidate) => candidate.userId === userId);
    if (!player || player.isBot) {
      throw new SecurityError("只有本局玩家可以设置自己的手牌隐私", "forbidden_spectator_visibility");
    }
    player.spectatorHidden = Boolean(hidden);
    this.stateVersion += 1;
    this.#assertIntegrity();
    return this;
  }

  #raiseTo(player, target) {
    const previousBet = this.currentBet;
    const raiseSize = target - previousBet;
    const isFullRaise = raiseSize >= this.minRaise;
    this.#commit(player, target - player.bet);
    this.currentBet = Math.max(this.currentBet, player.bet);
    if (isFullRaise) {
      this.minRaise = raiseSize;
      for (const other of this.players) {
        if (other.userId !== player.userId && !other.folded && !other.allIn) other.acted = false;
      }
    }
    player.acted = true;
  }

  #analysisActionContext(player, now = Date.now()) {
    const activeOpponents = this.players.filter((candidate) => (
      candidate.userId !== player.userId && !candidate.folded
    ));
    const maximumOpponentStack = Math.max(
      0,
      ...activeOpponents.map((candidate) => candidate.stack + candidate.bet),
    );
    return {
      at: new Date(now).toISOString(),
      street: this.stage,
      seat: player.seat,
      buttonSeat: this.buttonSeat,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      communityCards: [...this.community],
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      playerBet: player.bet,
      stack: player.stack,
      totalCommitted: player.totalCommitted,
      toCall: Math.max(0, this.currentBet - player.bet),
      effectiveStack: Math.min(player.stack + player.bet, maximumOpponentStack),
      activePlayerCount: this.players.filter((candidate) => !candidate.folded).length,
      allInPlayerCount: this.players.filter((candidate) => !candidate.folded && candidate.allIn).length,
      secondsRemaining: this.turnDeadline == null
        ? null
        : Math.max(0, Math.ceil((this.turnDeadline - now) / 1000)),
    };
  }

  #recordAnalysisAction({
    player,
    requestedAction,
    requestedAmount,
    before,
    automatic,
    source,
  }) {
    const amountCommitted = Math.max(0, player.totalCommitted - before.totalCommitted);
    const raiseTo = before.playerBet + amountCommitted;
    const committedAllIn = player.allIn && amountCommitted > 0;
    const allInWouldRaise = committedAllIn && raiseTo > before.currentBet;
    const normalizedAction = committedAllIn
      ? "all-in"
      : requestedAction === "raise" && before.currentBet === 0
        ? "bet"
        : requestedAction;
    const isAggressive = ["bet", "raise"].includes(normalizedAction) || allInWouldRaise;
    const isFullRaise = isAggressive && raiseTo >= before.currentBet + before.minRaise;
    this.analysisActions.push({
      sequence: this.analysisActions.length + 1,
      at: before.at,
      userId: player.userId,
      street: before.street,
      action: normalizedAction,
      requestedAction,
      requestedAmount: Number.isSafeInteger(requestedAmount) ? requestedAmount : null,
      source: ["player", "bot", "timeout", "hextech", "system"].includes(source) ? source : "system",
      automatic: automatic === true,
      seat: before.seat,
      buttonSeat: before.buttonSeat,
      smallBlindSeat: before.smallBlindSeat,
      bigBlindSeat: before.bigBlindSeat,
      communityCards: before.communityCards,
      potBefore: before.pot,
      potAfter: this.pot,
      currentBetBefore: before.currentBet,
      currentBetAfter: this.currentBet,
      minRaiseBefore: before.minRaise,
      playerBetBefore: before.playerBet,
      playerBetAfter: player.bet,
      toCallBefore: before.toCall,
      effectiveStackBefore: before.effectiveStack,
      stackBefore: before.stack,
      stackAfter: player.stack,
      totalCommittedBefore: before.totalCommitted,
      totalCommittedAfter: player.totalCommitted,
      amountCommitted,
      raiseTo: isAggressive ? raiseTo : null,
      isAggressive,
      isFullRaise,
      allInKind: normalizedAction === "all-in" ? (allInWouldRaise ? "raise" : "call") : null,
      allInAfter: player.allIn,
      foldedAfter: player.folded,
      activePlayerCountBefore: before.activePlayerCount,
      allInPlayerCountBefore: before.allInPlayerCount,
      secondsRemainingBefore: before.secondsRemaining,
    });
  }

  latestAnalysisAction() {
    const entry = this.analysisActions.at(-1);
    return entry ? { ...entry, communityCards: [...entry.communityCards] } : null;
  }

  analysisRecord({
    roomCode,
    roomName,
    handNumber,
    roomMode = "classic",
    leaderboardEligible = true,
    createdAt = new Date().toISOString(),
  } = {}) {
    if (this.stage !== "finished") throw new Error("只能归档已经结束的手牌分析");
    const settlementByUserId = new Map(
      this.settlementResults().map((result) => [result.userId, result]),
    );
    return {
      id: this.handId,
      analysisVersion: 1,
      createdAt,
      handId: this.handId,
      roomCode: String(roomCode ?? ""),
      roomName: String(roomName ?? ""),
      handNumber: Number(handNumber),
      roomMode: String(roomMode || "classic"),
      leaderboardEligible: leaderboardEligible !== false,
      settings: {
        smallBlind: this.settings.smallBlind,
        bigBlind: this.settings.bigBlind,
        actionSeconds: this.actionSeconds,
      },
      buttonSeat: this.buttonSeat,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      communityCards: [...this.community],
      finishedReason: this.finishedReason,
      potAwarded: this.winners.reduce((sum, winner) => sum + winner.amount, 0),
      timeExtensionFees: this.timeExtensionFees,
      holeCardReplacements: this.holeCardReplacements.map((entry) => ({ ...entry })),
      actions: this.analysisActions.map((entry) => ({
        ...entry,
        communityCards: [...entry.communityCards],
      })),
      players: this.players.map((player) => {
        const settlement = settlementByUserId.get(player.userId) ?? {};
        const winner = this.winners.find((candidate) => candidate.userId === player.userId);
        const foldedAction = [...this.analysisActions]
          .reverse()
          .find((entry) => entry.userId === player.userId && entry.action === "fold");
        const startingHoleCards = [...this.holeCardReplacements]
          .reverse()
          .filter((entry) => entry.userId === player.userId)
          .reduce((cards, entry) => {
            cards[entry.cardIndex] = entry.discarded;
            return cards;
          }, [...player.hand]);
        return {
          userId: player.userId,
          username: player.username,
          isBot: player.isBot,
          seat: player.seat,
          startingStack: player.startingStack,
          endingStack: player.stack,
          netChipChange: player.stack - player.startingStack,
          totalCommitted: player.totalCommitted,
          startingHoleCards,
          holeCards: [...player.hand],
          folded: player.folded,
          foldedAtStreet: foldedAction?.street ?? null,
          allIn: player.allIn,
          reachedShowdown: this.finishedReason === "showdown" && !player.folded,
          publiclyRevealed: this.finishedReason === "showdown" && !player.folded,
          wonPotAmount: settlement.wonPotAmount ?? 0,
          handName: winner?.handName ?? null,
          bestFiveCardIds: [...(settlement.bestFiveCardIds ?? [])],
          opponentsBeaten: [...(settlement.opponentsBeaten ?? [])],
        };
      }),
      winners: this.winners.map((winner) => ({ ...winner })),
    };
  }

  #afterAction(previousSeat) {
    const contenders = this.players.filter((player) => !player.folded);
    if (contenders.length === 1) {
      this.#finishUncontested(contenders[0]);
      return;
    }
    if (this.#roundComplete()) {
      if (this.hextechPause) {
        this.hextechPause.deferStageAdvance = true;
        this.#setTurn(null);
        return;
      }
      if (this.#shouldRunOut()) {
        this.#scheduleRunoutStep();
        return;
      }
      this.#advanceStage();
      return;
    }
    const next = this.#nextSeat(
      previousSeat,
      (player) => !player.folded && !player.allIn && (!player.acted || player.bet !== this.currentBet),
    );
    if (next == null) this.#advanceStage();
    else this.#setTurn(next);
  }

  #reconcileExternalPlayerState(player) {
    if (!player || this.stage === "finished" || player.seat !== this.actingSeat
      || (!player.folded && !player.allIn && player.stack > 0)) {
      return false;
    }
    player.acted = true;
    this.#afterAction(player.seat);
    return true;
  }

  #roundComplete() {
    return this.players
      .filter((player) => !player.folded && !player.allIn)
      .every((player) => player.acted && player.bet === this.currentBet);
  }

  #shouldRunOut() {
    if (this.autoRunoutDeferred || this.stage === "finished") return false;
    const contenders = this.players.filter((player) => !player.folded);
    const playersWhoCanAct = contenders.filter((player) => !player.allIn);
    return contenders.length > 1 && playersWhoCanAct.length <= 1;
  }

  #scheduleRunoutStep(now = Date.now()) {
    if (this.runoutStepMs <= 0) {
      this.#advanceStage(now);
      return;
    }
    this.#setTurn(null);
    // A blind can put a short stack all-in while the opening orbit is still
    // animating. Keep the preflop reveal leg behind the authoritative deal
    // boundary so the client never has to truncate the hole-card animation.
    const runoutBase = this.stage === "preflop" && this.community.length === 0
      ? Math.max(now, this.dealCompleteAt)
      : now;
    this.runout = { nextAt: runoutBase + this.runoutStepMs };
    if (this.community.length === 0) this.#record("系统", "全押摊牌，公共牌将逐街发出");
  }

  #burnAndDeal(count) {
    this.burned.push(this.deck.pop());
    if (count === 1 && this.stage === "river" && this.riverReplacementArmed) {
      if (this.queuedBoardCards.river) throw new Error("河牌替换状态冲突");
      const discardedNaturalRiver = this.deck.pop();
      const replacement = this.deck.pop();
      if (!discardedNaturalRiver || !replacement) throw new Error("牌堆没有足够牌张替换河牌");
      this.burned.push(discardedNaturalRiver);
      this.community.push(replacement);
      this.riverReplacementArmed = false;
      this.#record("海克斯", "鸭哥·逆流换河：原定河牌已弃置，改发牌堆顶下一张");
      return;
    }
    const queued = count === 1 ? this.queuedBoardCards[this.stage] : null;
    if (queued) {
      this.community.push(queued);
      this.queuedBoardCards[this.stage] = null;
      return;
    }
    for (let index = 0; index < count; index += 1) this.community.push(this.deck.pop());
  }

  #assertIntegrity() {
    if (this.runout && (
      !Number.isFinite(this.runout.nextAt)
      || this.runoutStepMs <= 0
      || !["preflop", "flop", "turn", "river"].includes(this.stage)
      || this.actingSeat != null
      || this.turnDeadline != null
      || this.actionToken != null
      || !this.#shouldRunOut()
    )) {
      throw new Error("牌局完整性校验失败：全押发牌状态异常");
    }
    const allCards = [
      ...this.deck,
      ...this.burned,
      ...this.community,
      ...Object.values(this.queuedBoardCards).filter(Boolean),
      ...this.players.flatMap((player) => player.hand.filter((card) => card !== HEXTECH_BLANK_CARD)),
    ];
    if (allCards.length !== 52 || new Set(allCards).size !== 52) {
      throw new Error("牌局完整性校验失败：牌张数量异常");
    }
    for (const player of this.players) {
      const amounts = [player.stack, player.startingStack, player.bet, player.totalCommitted];
      if (amounts.some((value) => !Number.isSafeInteger(value) || value < 0)
        || player.bet > player.totalCommitted) {
        throw new Error("牌局完整性校验失败：筹码状态异常");
      }
    }
    const stackTotal = this.players.reduce((sum, player) => sum + player.stack, 0);
    if ([this.timeExtensionFees, this.bonusPot, this.bankInjected, this.bankCollected]
      .some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("牌局完整性校验失败：扩展筹码流异常");
    }
    const committedTotal = this.players.reduce((sum, player) => sum + player.totalCommitted, 0);
    const conservedTotal = stackTotal
      + (this.stage === "finished" ? 0 : committedTotal + this.bonusPot)
      + this.timeExtensionFees
      + this.bankCollected;
    if (conservedTotal !== this.initialChipTotal + this.bankInjected) {
      throw new Error("牌局完整性校验失败：筹码总量异常");
    }
  }

  #advanceStage(now = Date.now()) {
    this.runout = null;
    for (const player of this.players) {
      player.bet = 0;
      player.acted = false;
    }
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;

    if (this.stage === "preflop") {
      this.stage = "flop";
      this.#burnAndDeal(3);
      this.#record("系统", "翻牌已发出");
    } else if (this.stage === "flop") {
      this.stage = "turn";
      this.#burnAndDeal(1);
      this.#record("系统", "转牌已发出");
    } else if (this.stage === "turn") {
      this.stage = "river";
      this.#burnAndDeal(1);
      this.#record("系统", "河牌已发出");
    } else {
      this.#showdown();
      return;
    }

    const eligible = this.players.filter((player) => !player.folded && !player.allIn);
    if (eligible.length <= 1) {
      if (this.runoutStepMs > 0) this.#scheduleRunoutStep(now);
      else this.#advanceStage(now);
      return;
    }
    this.#setTurn(this.#nextSeat(this.buttonSeat, (player) => !player.folded && !player.allIn));
  }

  #skipIfNoActionPossible() {
    const eligible = this.players.filter((player) => !player.folded && !player.allIn);
    if (eligible.length <= 1) {
      if (this.#shouldRunOut() && this.runoutStepMs > 0) this.#scheduleRunoutStep();
      else this.#advanceStage();
    }
  }

  #finishUncontested(winner) {
    const amount = this.pot;
    winner.stack += amount;
    this.bonusPot = 0;
    this.winners = [{
      userId: winner.userId,
      username: winner.username,
      amount,
      handName: "其他玩家均已弃牌",
    }];
    this.stage = "finished";
    this.runout = null;
    this.finishedReason = "fold";
    this.settlementProvenance = this.#deriveFoldProvenance();
    this.foldReveal = {
      winnerUserId: winner.userId,
      decision: winner.isBot ? "muck" : null,
      deadline: winner.isBot ? null : Date.now() + FOLD_REVEAL_SECONDS * 1000,
    };
    this.#setTurn(null);
    this.#record("系统", `${winner.username} 赢得底池 ${amount}`);
  }

  chooseFoldReveal({ userId, reveal, handId, now = Date.now() }) {
    if (!constantTimeEqual(this.handId, handId)) {
      throw new SecurityError("亮牌选择已过期，请以当前牌桌状态为准", "stale_fold_reveal");
    }
    if (typeof reveal !== "boolean") throw new Error("亮牌选择格式不正确");
    if (this.finishedReason !== "fold" || !this.foldReveal) throw new Error("当前没有可处理的亮牌选择");
    if (this.foldReveal.winnerUserId !== userId) {
      throw new SecurityError("只有本局获胜玩家可以决定是否亮牌", "forbidden_fold_reveal");
    }
    if (this.foldReveal.decision != null) throw new Error("本局亮牌选择已经完成");
    if (!this.foldReveal.deadline || now >= this.foldReveal.deadline) {
      this.resolveFoldRevealIfNeeded(now);
      throw new Error("5 秒亮牌选择时间已经结束");
    }
    this.foldReveal.decision = reveal ? "show" : "muck";
    this.foldReveal.deadline = null;
    this.stateVersion += 1;
    const winner = this.players.find((player) => player.userId === userId);
    this.#record(winner?.username ?? "获胜玩家", reveal ? "选择亮出手牌" : "选择不亮牌");
    return this;
  }

  resolveFoldRevealIfNeeded(now = Date.now()) {
    if (this.foldReveal?.decision != null || !this.foldReveal?.deadline || now < this.foldReveal.deadline) {
      return false;
    }
    this.foldReveal.decision = "muck";
    this.foldReveal.deadline = null;
    this.stateVersion += 1;
    const winner = this.players.find((player) => player.userId === this.foldReveal.winnerUserId);
    this.#record(winner?.username ?? "获胜玩家", "未在时限内亮牌");
    return true;
  }

  #showdown() {
    this.stage = "showdown";
    this.runout = null;
    const levels = [...new Set(this.players.map((player) => player.totalCommitted).filter(Boolean))]
      .sort((a, b) => a - b);
    const payouts = new Map();
    const handNames = new Map();
    let previousLevel = 0;

    let mainPotBonus = this.bonusPot;
    for (const level of levels) {
      const contributors = this.players.filter((player) => player.totalCommitted >= level);
      const amount = (level - previousLevel) * contributors.length + mainPotBonus;
      mainPotBonus = 0;
      previousLevel = level;
      const eligible = contributors.filter((player) => !player.folded);
      if (!amount || !eligible.length) continue;

      const solved = eligible.map((player) => ({
        player,
        hand: Hand.solve([...player.hand, ...this.community].filter((card) => card !== HEXTECH_BLANK_CARD)),
      }));
      const winningHands = Hand.winners(solved.map((entry) => entry.hand));
      const winners = solved.filter((entry) => winningHands.includes(entry.hand));
      const legacyRemainder = amount % CHIP_UNIT;
      const standardAmount = amount - legacyRemainder;
      const share = Math.floor(standardAmount / winners.length / CHIP_UNIT) * CHIP_UNIT;
      let remainder = standardAmount - share * winners.length;
      let unrepresentedLegacyRemainder = legacyRemainder;
      winners.sort((a, b) => {
        const leftDistance = ((a.player.seat - this.buttonSeat + 8) % 8) || 8;
        const rightDistance = ((b.player.seat - this.buttonSeat + 8) % 8) || 8;
        return leftDistance - rightDistance;
      });
      for (const entry of winners) {
        const oddChip = remainder >= CHIP_UNIT ? CHIP_UNIT : 0;
        const legacyCarry = unrepresentedLegacyRemainder;
        const payout = share + oddChip + legacyCarry;
        remainder = Math.max(0, remainder - oddChip);
        unrepresentedLegacyRemainder = 0;
        entry.player.stack += payout;
        payouts.set(entry.player.userId, (payouts.get(entry.player.userId) ?? 0) + payout);
        handNames.set(entry.player.userId, translateHand(entry.hand));
      }
    }

    this.winners = [...payouts.entries()].map(([userId, amount]) => {
      const player = this.players.find((candidate) => candidate.userId === userId);
      return {
        userId,
        username: player.username,
        amount,
        handName: handNames.get(userId),
      };
    });
    this.settlementProvenance = this.#deriveShowdownProvenance();
    this.bonusPot = 0;
    this.stage = "finished";
    this.finishedReason = "showdown";
    this.#setTurn(null);
    this.#record(
      "系统",
      this.winners.map((winner) => `${winner.username} 赢得 ${winner.amount}`).join("；"),
    );
  }

  #emptySettlementProvenance(reason) {
    return {
      reason,
      players: Object.fromEntries(this.players.map((player) => [player.userId, {
        opponentsBeaten: [],
        bestFiveCardIds: [],
      }])),
    };
  }

  #deriveFoldProvenance() {
    const provenance = this.#emptySettlementProvenance("fold");
    const winnerUserId = this.winners[0]?.userId ?? this.foldReveal?.winnerUserId ?? null;
    if (!winnerUserId || !provenance.players[winnerUserId]) return provenance;
    provenance.players[winnerUserId].opponentsBeaten = this.players
      .filter((player) => player.userId !== winnerUserId && player.totalCommitted > 0)
      .map((player) => player.userId);
    return provenance;
  }

  #deriveShowdownProvenance() {
    const provenance = this.#emptySettlementProvenance("showdown");
    const solvedByUserId = new Map(this.players
      .filter((player) => !player.folded)
      .map((player) => [
        player.userId,
        Hand.solve([...player.hand, ...this.community].filter((card) => card !== HEXTECH_BLANK_CARD)),
      ]));
    for (const [userId, hand] of solvedByUserId) {
      provenance.players[userId].bestFiveCardIds = hand.cards.map((card) => `${card.value}${card.suit}`);
    }

    const levels = [...new Set(this.players.map((player) => player.totalCommitted).filter(Boolean))]
      .sort((left, right) => left - right);
    let previousLevel = 0;
    let mainPotBonus = this.bonusPot;
    for (const level of levels) {
      const contributors = this.players.filter((player) => player.totalCommitted >= level);
      const amount = (level - previousLevel) * contributors.length + mainPotBonus;
      previousLevel = level;
      mainPotBonus = 0;
      const eligible = contributors.filter((player) => !player.folded);
      if (!amount || !eligible.length) continue;
      const winningHands = Hand.winners(eligible.map((player) => solvedByUserId.get(player.userId)));
      const potWinners = eligible.filter((player) => winningHands.includes(solvedByUserId.get(player.userId)));
      const coWinnerIds = new Set(potWinners.map((player) => player.userId));
      for (const winner of potWinners) {
        const beaten = provenance.players[winner.userId].opponentsBeaten;
        for (const contributor of contributors) {
          if (!coWinnerIds.has(contributor.userId) && !beaten.includes(contributor.userId)) {
            beaten.push(contributor.userId);
          }
        }
      }
    }
    return provenance;
  }

  #restoreSettlementProvenance(value) {
    if (!value || !["showdown", "fold"].includes(value.reason) || !value.players) return null;
    const restored = this.#emptySettlementProvenance(value.reason);
    for (const player of this.players) {
      const entry = value.players[player.userId];
      if (!entry) continue;
      restored.players[player.userId] = {
        opponentsBeaten: Array.isArray(entry.opponentsBeaten)
          ? [...new Set(entry.opponentsBeaten.filter((userId) => (
            typeof userId === "string"
            && userId !== player.userId
            && this.players.some((candidate) => candidate.userId === userId)
          )))]
          : [],
        bestFiveCardIds: Array.isArray(entry.bestFiveCardIds)
          ? entry.bestFiveCardIds.filter((cardId) => typeof cardId === "string").slice(0, 5)
          : [],
      };
    }
    return restored;
  }

  timeoutIfNeeded(now = Date.now()) {
    if (!this.turnDeadline || now < this.turnDeadline || !this.currentPlayer) return false;
    const player = this.currentPlayer;
    const legal = this.legalActions(player.userId);
    if (!legal) {
      this.#afterAction(player.seat);
      return true;
    }
    this.act(player.userId, legal.canCheck ? "check" : "fold", null, {
      automatic: true,
      source: "timeout",
    });
    return true;
  }

  advanceRunoutIfNeeded(now = Date.now()) {
    if (!this.runout || now < this.runout.nextAt || this.stage === "finished") return false;
    const snapshot = this.#snapshot();
    try {
      this.runout = null;
      this.#advanceStage(now);
      this.#assertIntegrity();
      return true;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  viewFor(userId, spectatorAccess = false) {
    const isSpectator = spectatorAccess === true || spectatorAccess?.isSpectator === true;
    const spectatorAuthorizedUserIds = new Set(
      typeof spectatorAccess === "object" && Array.isArray(spectatorAccess.authorizedUserIds)
        ? spectatorAccess.authorizedUserIds.filter((candidate) => typeof candidate === "string")
        : [],
    );
    const showdownIsPublic = this.stage === "finished" && this.finishedReason === "showdown";
    const spectatorCanSee = (player) => (
      player.userId !== this.spectatorMysteryUserId
      && (showdownIsPublic
        || !player.spectatorHidden
        || spectatorAuthorizedUserIds.has(player.userId))
    );
    const requestedFocusUserId = typeof spectatorAccess === "object"
      ? spectatorAccess.focusUserId
      : null;
    const strictSpectatorFocus = typeof spectatorAccess === "object"
      && spectatorAccess.strictFocus === true;
    const watchablePlayers = isSpectator
      ? this.players.filter((player) => (
        !player.folded
        && spectatorCanSee(player)
      ))
      : [];
    const requestedFocus = watchablePlayers.find((player) => player.userId === requestedFocusUserId) ?? null;
    const focusedPlayer = requestedFocus ?? (strictSpectatorFocus ? null : watchablePlayers[0] ?? null);
    const legal = isSpectator ? null : this.legalActions(userId);
    const canBuyTimeExtension = Boolean(
      legal
      && !this.timeExtensionUsed
      && this.turnDeadline
      && Date.now() < this.turnDeadline
      && this.currentPlayer?.stack >= TIME_EXTENSION_COST + CHIP_UNIT,
    );
    return {
      handId: this.handId,
      stateVersion: this.stateVersion,
      actionToken: legal ? this.actionToken : null,
      stage: this.stage,
      stageLabel: STAGE_LABELS[this.stage],
      community: [...this.community],
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
      buttonSeat: this.buttonSeat,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      dealCompleteAt: this.dealCompleteAt,
      actingSeat: this.actingSeat,
      turnDeadline: this.turnDeadline,
      actionSeconds: this.currentTurnActionSeconds,
      timeExtension: {
        cost: TIME_EXTENSION_COST,
        seconds: TIME_EXTENSION_SECONDS,
        used: this.timeExtensionUsed,
        canBuy: canBuyTimeExtension,
      },
      legal,
      actionLog: [...this.actionLog].reverse(),
      winners: this.winners.map((winner) => ({ ...winner })),
      finishedReason: this.finishedReason,
      foldReveal: this.foldReveal ? {
        winnerUserId: this.foldReveal.winnerUserId,
        decision: this.foldReveal.decision,
        deadline: this.foldReveal.deadline,
        canChoose: this.foldReveal.winnerUserId === userId && this.foldReveal.decision == null,
      } : null,
      runout: this.runout ? {
        active: true,
        nextAt: this.runout.nextAt,
        stepMs: this.runoutStepMs,
      } : null,
      spectatorView: isSpectator ? {
        focusUserId: focusedPlayer?.userId ?? null,
        mysteryUserId: this.spectatorMysteryUserId,
      } : null,
      players: this.players.map((player) => {
        const reveal = player.userId === userId
          || (Boolean(this.runout) && !isSpectator && !player.folded)
          || (isSpectator
            && this.stage !== "finished"
            && !player.folded
            && spectatorCanSee(player)
            && player.userId === focusedPlayer?.userId
          )
          || (this.stage === "finished"
            && this.finishedReason === "showdown"
            && !player.folded
            && (!isSpectator || spectatorCanSee(player)))
          || (this.stage === "finished"
            && this.finishedReason === "fold"
            && this.foldReveal?.decision === "show"
            && player.userId === this.foldReveal.winnerUserId);
        return {
          userId: player.userId,
          username: player.username,
          seat: player.seat,
          isBot: player.isBot,
          stack: player.stack,
          bet: player.bet,
          totalCommitted: player.totalCommitted,
          folded: player.folded,
          allIn: player.allIn,
          acted: player.acted,
          spectatorHidden: player.spectatorHidden,
          spectatorAccessGranted: isSpectator && spectatorAuthorizedUserIds.has(player.userId),
          cards: reveal ? [...player.hand] : [],
          cardCount: player.hand.length,
        };
      }),
    };
  }
}
