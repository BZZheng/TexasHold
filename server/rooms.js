import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ALL_IN_RUNOUT_STEP_MS,
  HoldemGame,
  RESTART_RECONNECT_GRACE_MS,
} from "./game.js";
import {
  HEXTECH_EFFECT_DIRECTIVE_TYPES,
  createHextechEffectsEngine,
  restoreHextechEffectsEngine,
} from "./hextech-effects.js";
import {
  HEXTECH_CHARACTER_COMMANDS,
  HEXTECH_CHARACTER_DIRECTIVES,
  createHextechCharacterEngine,
  restoreHextechCharacterEngine,
} from "./hextech-characters.js";
import { CHIP_UNIT, LOW_STACK_REBUY_THRESHOLD, isStandardChipAmount } from "../shared/chips.js";
import {
  HEXTECH_CHARACTER_RULES,
  HEXTECH_CHARACTERS,
  HEXTECH_MODE,
  HEXTECH_SKILLS,
  ROOM_MODES,
  hextechBlindForHand,
  hextechCharacter,
  hextechSkill,
  hextechTargetForPlayers,
  isHextechCharacterId,
  isHextechMode,
  isHextechSkillId,
  normalizeRoomMode,
} from "../shared/hextech.js";
import {
  FixedWindowRateLimiter,
  SecurityError,
  authorizePayload,
  constantTimeEqual,
  tokenDigest,
} from "./security.js";
import { socketLogDomain } from "./logger.js";

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RUNTIME_STATE_VERSION = 3;
const SUPPORTED_RUNTIME_STATE_VERSIONS = new Set([1, 2, RUNTIME_STATE_VERSION]);
const HEXTECH_CHARACTER_OPPORTUNITY_MS = 60_000;
const MAX_RESTORED_HEXTECH_TIMER_MS = 60_000;

function spectatorCardAccessUserIds(member, handId) {
  if (!member || typeof handId !== "string" || member.spectatorCardAccess?.handId !== handId) return [];
  return Array.isArray(member.spectatorCardAccess.userIds)
    ? member.spectatorCardAccess.userIds
    : [];
}

function hasSpectatorCardAccess(member, handId, targetUserId) {
  return spectatorCardAccessUserIds(member, handId).includes(targetUserId);
}

function grantSpectatorCardAccess(member, handId, targetUserId) {
  if (!member || typeof handId !== "string" || typeof targetUserId !== "string") return false;
  if (member.spectatorCardAccess?.handId !== handId
    || !Array.isArray(member.spectatorCardAccess?.userIds)) {
    member.spectatorCardAccess = { handId, userIds: [] };
  }
  if (member.spectatorCardAccess.userIds.includes(targetUserId)) return false;
  member.spectatorCardAccess.userIds.push(targetUserId);
  member.spectatorCardAccess.userIds = member.spectatorCardAccess.userIds.slice(-8);
  return true;
}

function tableChipCap(settings) {
  return settings.initialChips * 2;
}

function emptySettlement(settings) {
  return {
    status: "open",
    tableCap: tableChipCap(settings),
    accounts: new Map(),
    hasPracticeHands: false,
    closedAt: null,
    closedBy: null,
  };
}

function settlementCashOut(account) {
  return account.autoCashOut + account.exitCashOut + account.finalCashOut;
}

function restoreSettlement(saved, members, settings) {
  const settlement = emptySettlement(settings);
  if (saved != null) {
    if (!saved || typeof saved !== "object" || !Array.isArray(saved.accounts)) {
      throw new Error("无法恢复进行中的牌局：结算账本格式不正确");
    }
    if (!["open", "closed"].includes(saved.status)) {
      throw new Error("无法恢复进行中的牌局：结算状态不正确");
    }
    settlement.status = saved.status;
    settlement.hasPracticeHands = Boolean(saved.hasPracticeHands);
    settlement.closedAt = typeof saved.closedAt === "string" ? saved.closedAt : null;
    settlement.closedBy = typeof saved.closedBy === "string" ? saved.closedBy : null;
    for (const value of saved.accounts) {
      const userId = String(value?.userId ?? "");
      const username = String(value?.username ?? "");
      const amounts = [value?.buyIn, value?.autoCashOut, value?.exitCashOut, value?.finalCashOut];
      if (!userId || userId.length > 80 || !username || username.length > 24
        || settlement.accounts.has(userId)
        || amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
        throw new Error("无法恢复进行中的牌局：结算账户数据不正确");
      }
      settlement.accounts.set(userId, {
        userId,
        username,
        accountName: String(value.accountName ?? username),
        isBot: Boolean(value.isBot),
        buyIn: value.buyIn,
        autoCashOut: value.autoCashOut,
        exitCashOut: value.exitCashOut,
        finalCashOut: value.finalCashOut,
        lastSeat: Number.isSafeInteger(value.lastSeat) && value.lastSeat >= 0 && value.lastSeat <= 7
          ? value.lastSeat
          : null,
        rebuyCount: Number.isSafeInteger(value.rebuyCount) && value.rebuyCount >= 0
          ? value.rebuyCount
          : 0,
      });
    }
    return settlement;
  }

  // Runtime snapshots created before the settlement ledger existed are
  // migrated from authoritative room membership. Historical auto-cash-outs
  // cannot exist in those snapshots, so only actual buy-ins are reconstructed.
  for (const member of members.values()) {
    if (!member.everSeated) continue;
    settlement.accounts.set(member.userId, {
      userId: member.userId,
      username: member.username,
      accountName: member.accountName,
      isBot: member.isBot,
      buyIn: settings.initialChips + (member.rebuyCount * settings.rebuyAmount),
      autoCashOut: 0,
      exitCashOut: 0,
      finalCashOut: 0,
      lastSeat: member.seat,
      rebuyCount: member.rebuyCount,
    });
  }
  return settlement;
}

function roomCode() {
  let code = "";
  for (let index = 0; index < 4; index += 1) {
    code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  }
  return code;
}

function integer(value, fallback, min, max, label) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label}需要是 ${min}–${max} 的整数`);
  }
  return value;
}

function chipInteger(value, fallback, min, max, label) {
  const amount = integer(value, fallback, min, max, label);
  if (!isStandardChipAmount(amount, { allowZero: false })) {
    throw new Error(`${label}必须是 ${CHIP_UNIT} 的倍数`);
  }
  return amount;
}

function normalizeSettings(input = {}, mode = ROOM_MODES.CLASSIC) {
  const settings = authorizePayload(input, [
    "maxPlayers",
    "initialChips",
    "smallBlind",
    "bigBlind",
    "allowRebuy",
    "rebuyAmount",
    "maxRebuys",
    "password",
  ]);
  if (settings.password != null && typeof settings.password !== "string") {
    throw new Error("房间密码格式不正确");
  }
  const password = String(settings.password ?? "").trim();
  if (password.length > 20) throw new Error("房间密码最多 20 个字符");
  if (isHextechMode(mode)) {
    return {
      maxPlayers: integer(
        settings.maxPlayers,
        6,
        HEXTECH_MODE.minPlayers,
        HEXTECH_MODE.maxPlayers,
        "玩家人数",
      ),
      initialChips: HEXTECH_MODE.initialChips,
      smallBlind: hextechBlindForHand(1).smallBlind,
      bigBlind: hextechBlindForHand(1).bigBlind,
      allowRebuy: true,
      rebuyAmount: HEXTECH_MODE.rebuyAmount,
      maxRebuys: HEXTECH_MODE.maxRebuys,
      password,
    };
  }
  const smallBlind = chipInteger(settings.smallBlind, 5, CHIP_UNIT, 10000, "小盲");
  const bigBlind = chipInteger(settings.bigBlind, Math.max(10, smallBlind * 2), smallBlind * 2, 20000, "大盲");
  if (settings.allowRebuy != null && typeof settings.allowRebuy !== "boolean") {
    throw new Error("补充筹码开关格式不正确");
  }
  return {
    maxPlayers: integer(settings.maxPlayers, 8, 2, 8, "玩家人数"),
    initialChips: chipInteger(settings.initialChips, Math.max(2000, bigBlind * 20), bigBlind * 20, 1000000, "初始筹码"),
    smallBlind,
    bigBlind,
    allowRebuy: settings.allowRebuy !== false,
    rebuyAmount: chipInteger(settings.rebuyAmount, Math.max(2000, bigBlind * 20), bigBlind * 20, 1000000, "补充筹码"),
    maxRebuys: integer(settings.maxRebuys, 3, 0, 20, "补充次数"),
    password,
  };
}

function emptyHextechState() {
  return {
    phase: "character-select",
    lockedPlayerCount: null,
    targetChips: null,
    participantUserIds: [],
    draft: null,
    effects: null,
    characters: null,
    characterOpportunity: null,
    characterActionEffects: {
      raiseCaps: [],
      clockModifiers: [],
      preflopAggressorUserId: null,
    },
    appliedCharacterDirectiveIds: [],
    matchEnd: null,
  };
}

function rebaseRestoredDeadline(deadline, { savedAtMs, now, reconnectGraceMs }) {
  if (!Number.isFinite(deadline)) return deadline;
  const remainingMs = Math.min(
    MAX_RESTORED_HEXTECH_TIMER_MS,
    Math.max(0, deadline - savedAtMs),
  );
  return now + remainingMs + Math.max(0, reconnectGraceMs);
}

function rebaseRestoredHextechTimers(saved, timing) {
  const rebased = structuredClone(saved);
  const rebase = (value) => rebaseRestoredDeadline(value, timing);
  const effectHand = rebased.effects?.hand;
  if (effectHand?.activeReaction && Number.isFinite(effectHand.activeReaction.expiresAt)) {
    effectHand.activeReaction.expiresAt = rebase(effectHand.activeReaction.expiresAt);
  }
  for (const window of Object.values(effectHand?.windows ?? {})) {
    if (Number.isFinite(window?.expiresAt)) window.expiresAt = rebase(window.expiresAt);
  }
  for (const reveal of effectHand?.effects?.publicReveals ?? []) {
    if (Number.isFinite(reveal?.expiresAt)) reveal.expiresAt = rebase(reveal.expiresAt);
  }
  for (const player of Object.values(rebased.characters?.players ?? {})) {
    if (Number.isFinite(player?.window?.expiresAt)) player.window.expiresAt = rebase(player.window.expiresAt);
  }
  for (const loan of rebased.characters?.loans ?? []) {
    if (loan?.state === "offered" && Number.isFinite(loan.expiresAt)) {
      loan.expiresAt = rebase(loan.expiresAt);
    }
  }
  if (Number.isFinite(rebased.characterOpportunity?.expiresAt)) {
    rebased.characterOpportunity.expiresAt = rebase(rebased.characterOpportunity.expiresAt);
  }
  if (Number.isFinite(rebased.draft?.deadline)) rebased.draft.deadline = rebase(rebased.draft.deadline);
  return rebased;
}

function restoredHextechState(saved, members, handNumber, game, timing) {
  const state = emptyHextechState();
  if (!saved || typeof saved !== "object") return state;
  saved = rebaseRestoredHextechTimers(saved, timing);
  const lockedPlayerCount = saved.lockedPlayerCount;
  if (Number.isSafeInteger(lockedPlayerCount)
    && lockedPlayerCount >= HEXTECH_MODE.minPlayers
    && lockedPlayerCount <= HEXTECH_MODE.maxPlayers) {
    state.lockedPlayerCount = lockedPlayerCount;
    state.targetChips = hextechTargetForPlayers(lockedPlayerCount);
  }
  if (Array.isArray(saved.participantUserIds)) {
    state.participantUserIds = [...new Set(saved.participantUserIds.filter((userId) => (
      typeof userId === "string" && userId.length <= 80
    )))].slice(0, HEXTECH_MODE.maxPlayers);
  }
  if (saved.effects != null) {
    try {
      state.effects = restoreHextechEffectsEngine(saved.effects);
    } catch (error) {
      throw new Error(`无法恢复进行中的牌局：海克斯效果状态不正确（${error.message}）`);
    }
  }
  if (saved.characters != null) {
    try {
      state.characters = restoreHextechCharacterEngine(saved.characters);
    } catch (error) {
      throw new Error(`无法恢复进行中的牌局：海克斯人物状态不正确（${error.message}）`);
    }
  }
  if (saved.characterOpportunity && typeof saved.characterOpportunity === "object"
    && game && game.stage !== "finished"
    && state.participantUserIds.includes(saved.characterOpportunity.userId)
    && ["ya", "qiwan"].includes(saved.characterOpportunity.characterId)
    && Number.isFinite(saved.characterOpportunity.expiresAt)) {
    state.characterOpportunity = {
      userId: saved.characterOpportunity.userId,
      characterId: saved.characterOpportunity.characterId,
      handId: game.handId,
      expiresAt: saved.characterOpportunity.expiresAt,
    };
  }
  if (saved.characterActionEffects && typeof saved.characterActionEffects === "object") {
    const restoredCharacterPlayers = state.characters?.exportState?.().players ?? {};
    state.characterActionEffects = {
      raiseCaps: Array.isArray(saved.characterActionEffects.raiseCaps)
        ? saved.characterActionEffects.raiseCaps
          .filter((entry) => entry && typeof entry.targetUserId === "string"
            && typeof entry.street === "string" && Number.isSafeInteger(entry.maximumRaiseTotal))
          .map((entry) => ({ ...entry }))
        : [],
      clockModifiers: Array.isArray(saved.characterActionEffects.clockModifiers)
        ? saved.characterActionEffects.clockModifiers
          .filter((entry) => entry && typeof entry.sourceUserId === "string"
            && typeof entry.street === "string"
            && (Number.isFinite(entry.opponentSecondsDelta)
              ? Number.isFinite(entry.selfSecondsDelta)
                && Number.isFinite(entry.minimumOpponentActionSeconds)
              : Number.isFinite(entry.opponentsAfterCasterSecondsDelta)))
          .map((entry) => {
            // New-format modifiers are already the authoritative profile for the
            // hand in progress and must survive restart byte-for-byte. Legacy
            // modifiers carried the old -3/+2/min-6 balance, so migrating them
            // requires rebuilding the whole profile from Xu's persisted
            // awakening state instead of merely renaming one field.
            if (Number.isFinite(entry.opponentSecondsDelta)) return { ...entry };
            const sourceCharacter = restoredCharacterPlayers[entry.sourceUserId];
            if (sourceCharacter?.characterId !== "xu") return null;
            const xuRules = HEXTECH_CHARACTER_RULES.xu;
            const profile = sourceCharacter.awakened
              ? {
                opponentSecondsDelta: xuRules.awakening.opponentSecondsDelta,
                selfSecondsDelta: xuRules.awakening.selfSecondsDelta,
              }
              : {
                opponentSecondsDelta: xuRules.active.opponentSecondsDelta,
                selfSecondsDelta: xuRules.active.selfSecondsDelta,
              };
            const normalized = {
              ...entry,
              ...profile,
              minimumOpponentActionSeconds: xuRules.active.minimumOpponentActionSeconds,
              targetPolicy: "all-opponents-still-in-hand",
            };
            delete normalized.opponentsAfterCasterSecondsDelta;
            return normalized;
          })
          .filter(Boolean)
        : [],
      preflopAggressorUserId: typeof saved.characterActionEffects.preflopAggressorUserId === "string"
        ? saved.characterActionEffects.preflopAggressorUserId
        : null,
    };
  }
  state.appliedCharacterDirectiveIds = Array.isArray(saved.appliedCharacterDirectiveIds)
    ? [...new Set(saved.appliedCharacterDirectiveIds.filter((id) => typeof id === "string"))].slice(-512)
    : [];
  if (saved.matchEnd && typeof saved.matchEnd === "object") {
    const standings = Array.isArray(saved.matchEnd.standings)
      ? saved.matchEnd.standings
        .filter((entry) => typeof entry?.userId === "string" && Number.isSafeInteger(entry?.chips))
        .map((entry) => ({
          userId: entry.userId,
          username: String(entry.username ?? "玩家").slice(0, 24),
          characterId: isHextechCharacterId(entry.characterId) ? entry.characterId : null,
          chips: entry.chips,
          netAssets: Number.isSafeInteger(entry.netAssets) ? entry.netAssets : entry.chips,
        }))
      : [];
    if (["target", "hand-cap", "last-player"].includes(saved.matchEnd.reason) && standings.length) {
      const persistedWinnerUserId = typeof saved.matchEnd.winnerUserId === "string"
        && standings.some(({ userId }) => userId === saved.matchEnd.winnerUserId)
        ? saved.matchEnd.winnerUserId
        : standings[0].userId;
      state.matchEnd = {
        reason: saved.matchEnd.reason,
        handNumber: Number.isSafeInteger(saved.matchEnd.handNumber)
          ? saved.matchEnd.handNumber
          : handNumber,
        targetChips: state.targetChips,
        standings,
        winnerUserId: persistedWinnerUserId,
      };
      state.phase = "finished";
      return state;
    }
  }
  if (saved.draft && typeof saved.draft === "object" && Array.isArray(saved.draft.offers)) {
    if (!game || game.stage === "finished" || saved.draft.handNumber !== handNumber) {
      throw new Error("无法恢复进行中的牌局：海克斯技能选择与当前手牌不一致");
    }
    const expectedUserIds = new Set(game.players.map(({ userId }) => userId));
    if (saved.draft.offers.length !== expectedUserIds.size) {
      throw new Error("无法恢复进行中的牌局：海克斯技能选项缺失");
    }
    const offers = new Map();
    for (const raw of saved.draft.offers) {
      if (!members.has(raw?.userId) || !expectedUserIds.has(raw.userId) || !Array.isArray(raw?.skillIds)) {
        throw new Error("无法恢复进行中的牌局：海克斯技能选项玩家不正确");
      }
      const skillIds = raw.skillIds.filter(isHextechSkillId).slice(0, 3);
      if (skillIds.length !== 3 || new Set(skillIds).size !== 3) {
        throw new Error("无法恢复进行中的牌局：海克斯技能选项不完整");
      }
      if (skillIds.filter((skillId) => hextechSkill(skillId)?.rarity === "金色").length > 1) {
        throw new Error("无法恢复进行中的牌局：海克斯技能选项稀有度不正确");
      }
      offers.set(raw.userId, {
        offerId: typeof raw.offerId === "string" ? raw.offerId : crypto.randomUUID(),
        skillIds,
        selectedSkillId: skillIds.includes(raw.selectedSkillId) ? raw.selectedSkillId : null,
      });
    }
    if (offers.size !== expectedUserIds.size) {
      throw new Error("无法恢复进行中的牌局：海克斯技能选项玩家重复或缺失");
    }
    state.draft = {
      handNumber,
      deadline: Number.isFinite(saved.draft.deadline) ? saved.draft.deadline : Date.now(),
      offers,
    };
    state.phase = "skill-draft";
  } else if (handNumber > 0) {
    state.phase = saved.phase === "hand-result" || game?.stage === "finished"
      ? "hand-result"
      : "playing";
  }
  const restoredEffectHand = state.effects?.exportState?.().hand ?? null;
  if (restoredEffectHand && (!game || restoredEffectHand.handId !== game.handId)) {
    throw new Error("无法恢复进行中的牌局：海克斯效果与当前手牌不一致");
  }
  return state;
}

function randomEntry(entries) {
  return entries[crypto.randomInt(entries.length)];
}

function createSkillOffer(previousSkillIds = []) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const selected = new Set();
    let hasGold = false;
    while (selected.size < 3) {
      const candidate = randomEntry(HEXTECH_SKILLS);
      if (candidate.rarity === "金色" && hasGold) continue;
      selected.add(candidate.id);
      if (candidate.rarity === "金色") hasGold = true;
    }
    const skillIds = [...selected];
    if (skillIds.some((id, index) => id !== previousSkillIds[index])) {
      return { offerId: crypto.randomUUID(), skillIds, selectedSkillId: null };
    }
  }
  const fallback = HEXTECH_SKILLS
    .filter(({ id }) => !previousSkillIds.includes(id))
    .slice(0, 3)
    .map(({ id }) => id);
  return { offerId: crypto.randomUUID(), skillIds: fallback, selectedSkillId: null };
}

function publicMatchEnd(matchEnd) {
  return matchEnd ? {
    reason: matchEnd.reason,
    handNumber: matchEnd.handNumber,
    targetChips: matchEnd.targetChips,
    winnerUserId: matchEnd.winnerUserId,
    standings: matchEnd.standings.map((entry) => ({ ...entry })),
  } : null;
}

function firstOpenSeat(room) {
  const occupied = new Set(
    [...room.members.values()]
      .filter((member) => member.role === "player" && member.seat != null)
      .map((member) => member.seat),
  );
  for (let seat = 0; seat < room.settings.maxPlayers; seat += 1) {
    if (!occupied.has(seat)) return seat;
  }
  return null;
}

function seatIsOpen(room, seat) {
  return Number.isInteger(seat)
    && seat >= 0
    && seat < room.settings.maxPlayers
    && ![...room.members.values()].some((member) => member.role === "player" && member.seat === seat);
}

function humanMembers(room) {
  return [...room.members.values()].filter((member) => !member.isBot);
}

function response(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

export class RoomManager {
  constructor(io, store, {
    audit = () => {},
    logger = null,
    runtimeFile = typeof store?.runtimeFile === "string"
      ? store.runtimeFile
      : typeof store?.dataDir === "string"
        ? path.join(store.dataDir, "runtime-rooms.json")
        : null,
    reconnectGraceMs = RESTART_RECONNECT_GRACE_MS,
  } = {}) {
    this.io = io;
    this.store = store;
    this.audit = audit;
    this.logger = logger;
    this.runtimeFile = runtimeFile;
    this.reconnectGraceMs = reconnectGraceMs;
    this.persistenceHealthy = true;
    this.lastCheckpointAt = null;
    this.rooms = new Map();
    this.userRooms = new Map();
    this.onlineUsers = new Map();
    this.lobbyLimiter = new FixedWindowRateLimiter({ limit: 30, windowMs: 10_000 });
    this.mutationLimiter = new FixedWindowRateLimiter({ limit: 30, windowMs: 10_000 });
    this.actionLimiter = new FixedWindowRateLimiter({ limit: 8, windowMs: 5_000 });
    this.chatLimiter = new FixedWindowRateLimiter({ limit: 6, windowMs: 10_000 });
    this.#restoreRooms();
    this.timer = setInterval(() => this.#tick(), 1000);
    this.timer.unref();
    for (const room of this.rooms.values()) this.#scheduleBot(room);
  }

  deploymentStatus() {
    return {
      recoverable: Boolean(this.runtimeFile),
      persistenceHealthy: this.persistenceHealthy,
      activeHands: [...this.rooms.values()].filter(
        (room) => room.game && room.game.stage !== "finished",
      ).length,
      rooms: this.rooms.size,
      lastCheckpointAt: this.lastCheckpointAt,
    };
  }

  checkpoint({ strict = true } = {}) {
    this.#persistRooms({ strict });
    return this.deploymentStatus();
  }

  shutdown() {
    clearInterval(this.timer);
    for (const room of this.rooms.values()) {
      if (room.botTimer) clearTimeout(room.botTimer);
      room.botTimer = null;
    }
    this.checkpoint({ strict: true });
  }

  #restoreRooms() {
    if (!this.runtimeFile) return;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.runtimeFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      this.persistenceHealthy = false;
      this.audit("runtime_state_restore_failed", { reason: error.message });
      throw new Error(`无法恢复进行中的牌局：${error.message}`);
    }
    if (!state || !SUPPORTED_RUNTIME_STATE_VERSIONS.has(state.version) || !Array.isArray(state.rooms)) {
      this.persistenceHealthy = false;
      throw new Error("无法恢复进行中的牌局：快照版本不兼容");
    }

    const now = Date.now();
    const parsedSavedAtMs = typeof state.savedAt === "string" ? Date.parse(state.savedAt) : Number.NaN;
    const savedAtMs = Number.isFinite(parsedSavedAtMs) ? parsedSavedAtMs : now;
    const restoredTimerContext = {
      savedAtMs,
      now,
      reconnectGraceMs: this.reconnectGraceMs,
    };
    for (const savedRoom of state.rooms) {
      if (!savedRoom || typeof savedRoom.code !== "string" || !/^[A-Z2-9]{4}$/.test(savedRoom.code)) {
        throw new Error("无法恢复进行中的牌局：房间码格式不正确");
      }
      if (!Array.isArray(savedRoom.members)) throw new Error("无法恢复进行中的牌局：成员数据缺失");
      const mode = state.version >= 2 ? normalizeRoomMode(savedRoom.mode) : ROOM_MODES.CLASSIC;
      const settings = normalizeSettings(savedRoom.settings, mode);
      const members = new Map();
      for (const savedMember of savedRoom.members) {
        const userId = String(savedMember?.userId ?? "");
        const username = String(savedMember?.username ?? "");
        const role = savedMember?.role;
        if (!userId || userId.length > 80 || !username || username.length > 24 || members.has(userId)) {
          throw new Error("无法恢复进行中的牌局：成员数据不正确");
        }
        if (!["player", "spectator"].includes(role)) throw new Error("无法恢复进行中的牌局：成员角色不正确");
        const seat = savedMember.seat == null ? null : savedMember.seat;
        if (seat != null && (!Number.isSafeInteger(seat) || seat < 0 || seat > 7)) {
          throw new Error("无法恢复进行中的牌局：成员座位不正确");
        }
        if ((role === "player" && seat == null) || (role === "spectator" && seat != null)) {
          throw new Error("无法恢复进行中的牌局：成员角色与座位不一致");
        }
        const integerFields = ["stack", "rebuyCount", "pendingRebuy"];
        if (integerFields.some((field) => !Number.isSafeInteger(savedMember[field]) || savedMember[field] < 0)) {
          throw new Error("无法恢复进行中的牌局：成员筹码数据不正确");
        }
        const member = {
          userId,
          username,
          accountName: String(savedMember.accountName ?? username),
          avatarTone: String(savedMember.avatarTone ?? "gold"),
          title: String(savedMember.title ?? "牌桌新秀"),
          displayedAchievements: Array.isArray(savedMember.displayedAchievements)
            ? savedMember.displayedAchievements.map(String).slice(0, 120)
            : [],
          isBot: Boolean(savedMember.isBot),
          role,
          seat,
          stack: savedMember.stack,
          ready: Boolean(savedMember.ready),
          connected: Boolean(savedMember.isBot),
          socketIds: new Set(),
          rebuyCount: savedMember.rebuyCount,
          pendingRebuy: savedMember.pendingRebuy,
          rebuyDeadline: Number.isFinite(savedMember.rebuyDeadline)
            ? rebaseRestoredDeadline(savedMember.rebuyDeadline, restoredTimerContext)
            : null,
          seatRequest: Boolean(savedMember.seatRequest),
          requestedSeat: savedMember.requestedSeat == null ? null : savedMember.requestedSeat,
          spectatorFocusUserId: typeof savedMember.spectatorFocusUserId === "string"
            ? savedMember.spectatorFocusUserId.slice(0, 80)
            : null,
          spectatorCardAccess: typeof savedMember.spectatorCardAccess?.handId === "string"
            && Array.isArray(savedMember.spectatorCardAccess?.userIds)
            ? {
              handId: savedMember.spectatorCardAccess.handId.slice(0, 80),
              userIds: [...new Set(savedMember.spectatorCardAccess.userIds
                .filter((targetUserId) => typeof targetUserId === "string" && targetUserId.length <= 80))]
                .slice(0, 8),
            }
            : null,
          everSeated: Boolean(savedMember.everSeated),
          characterId: isHextechCharacterId(savedMember.characterId)
            ? savedMember.characterId
            : null,
          equippedSkillId: isHextechSkillId(savedMember.equippedSkillId)
            ? savedMember.equippedSkillId
            : null,
          hextechRefreshesRemaining: Number.isSafeInteger(savedMember.hextechRefreshesRemaining)
            ? Math.max(0, Math.min(HEXTECH_MODE.freeRefreshes, savedMember.hextechRefreshesRemaining))
            : HEXTECH_MODE.freeRefreshes,
        };
        if (member.requestedSeat != null
          && (!Number.isSafeInteger(member.requestedSeat) || member.requestedSeat < 0 || member.requestedSeat > 7)) {
          throw new Error("无法恢复进行中的牌局：申请座位不正确");
        }
        members.set(userId, member);
      }
      const humans = [...members.values()].filter((member) => !member.isBot);
      if (!humans.length) continue;
      if (isHextechMode(mode)) {
        const chosenCharacters = [...members.values()].map(({ characterId }) => characterId).filter(Boolean);
        if (new Set(chosenCharacters).size !== chosenCharacters.length) {
          throw new Error("无法恢复进行中的牌局：海克斯人物被重复占用");
        }
      }
      const restoredHandNumber = Number.isSafeInteger(savedRoom.handNumber) && savedRoom.handNumber >= 0
        ? savedRoom.handNumber
        : 0;
      const restoredGameSettings = isHextechMode(mode) && restoredHandNumber > 0
        ? { ...settings, ...hextechBlindForHand(Math.min(restoredHandNumber, HEXTECH_MODE.maxHands)) }
        : settings;
      const game = savedRoom.game
        ? HoldemGame.restore(savedRoom.game, {
          settings: restoredGameSettings,
          now,
          reconnectGraceMs: this.reconnectGraceMs,
        })
        : null;
      if (game && game.stage !== "finished" && game.players.some((player) => !members.has(player.userId))) {
        throw new Error("无法恢复进行中的牌局：牌局玩家不在房间中");
      }
      for (const member of members.values()) {
        if (!game || member.spectatorCardAccess?.handId !== game.handId) {
          member.spectatorCardAccess = null;
          continue;
        }
        member.spectatorCardAccess.userIds = member.spectatorCardAccess.userIds.filter((targetUserId) => (
          targetUserId !== game.spectatorMysteryUserId
          && game.players.some((player) => player.userId === targetUserId)
        ));
      }
      const hostUserId = members.has(savedRoom.hostUserId) && !members.get(savedRoom.hostUserId).isBot
        ? savedRoom.hostUserId
        : humans[0].userId;
      const room = {
        code: savedRoom.code,
        name: String(savedRoom.name ?? "好友牌局").trim().slice(0, 24) || "好友牌局",
        mode,
        hostUserId,
        settings,
        members,
        settlement: restoreSettlement(savedRoom.settlement, members, settings),
        hextech: isHextechMode(mode)
          ? restoredHextechState(
            savedRoom.hextech,
            members,
            restoredHandNumber,
            game,
            restoredTimerContext,
          )
          : null,
        game,
        gameSynced: Boolean(savedRoom.gameSynced),
        handNumber: restoredHandNumber,
        lastButtonSeat: savedRoom.lastButtonSeat == null ? null : savedRoom.lastButtonSeat,
        lastHandCashOuts: Array.isArray(savedRoom.lastHandCashOuts)
          ? savedRoom.lastHandCashOuts
            .filter((entry) => typeof entry?.userId === "string"
              && Number.isSafeInteger(entry?.amount) && entry.amount > 0)
            .map((entry) => ({ userId: entry.userId, amount: entry.amount }))
          : [],
        chat: Array.isArray(savedRoom.chat)
          ? savedRoom.chat.slice(-50).map((entry) => ({ ...entry }))
          : [],
        botTimer: null,
        createdAt: typeof savedRoom.createdAt === "string" ? savedRoom.createdAt : new Date(now).toISOString(),
      };
      if (room.hextech && room.handNumber > 0 && room.hextech.participantUserIds.length === 0) {
        room.hextech.participantUserIds = [...room.members.values()]
          .filter((member) => member.role === "player" && member.characterId)
          .map(({ userId }) => userId);
        room.hextech.lockedPlayerCount = room.hextech.participantUserIds.length;
        if (room.hextech.lockedPlayerCount >= HEXTECH_MODE.minPlayers) {
          room.hextech.targetChips = hextechTargetForPlayers(room.hextech.lockedPlayerCount);
        }
      }
      this.#attachHextechEffects(room);
      this.rooms.set(room.code, room);
      for (const member of humans) {
        if (this.userRooms.has(member.userId)) {
          throw new Error("无法恢复进行中的牌局：玩家同时存在于多个房间");
        }
        this.userRooms.set(member.userId, room.code);
      }
      this.#syncFinished(room);
      if (!isHextechMode(room.mode)
        && room.settlement.status === "open"
        && (!room.game || room.game.stage === "finished")
        && [...room.members.values()].some((member) => member.stack > room.settlement.tableCap)) {
        this.#applyTableCap(room);
      }
    }
    this.lastCheckpointAt = typeof state.savedAt === "string" ? state.savedAt : null;
    this.#persistRooms({ strict: true });
  }

  #persistRooms({ strict = false } = {}) {
    if (!this.runtimeFile) return;
    const savedAtMs = Date.now();
    const payload = {
      version: RUNTIME_STATE_VERSION,
      savedAt: new Date(savedAtMs).toISOString(),
      rooms: [...this.rooms.values()].map((room) => ({
        code: room.code,
        name: room.name,
        mode: room.mode,
        hostUserId: room.hostUserId,
        settings: { ...room.settings },
        hextech: room.hextech ? {
          phase: room.hextech.phase,
          lockedPlayerCount: room.hextech.lockedPlayerCount,
          targetChips: room.hextech.targetChips,
          participantUserIds: [...room.hextech.participantUserIds],
          matchEnd: publicMatchEnd(room.hextech.matchEnd),
          effects: room.hextech.effects?.exportState?.() ?? null,
          characters: room.hextech.characters?.exportState?.() ?? null,
          characterOpportunity: room.hextech.characterOpportunity
            ? { ...room.hextech.characterOpportunity }
            : null,
          characterActionEffects: {
            raiseCaps: room.hextech.characterActionEffects.raiseCaps.map((entry) => ({ ...entry })),
            clockModifiers: room.hextech.characterActionEffects.clockModifiers.map((entry) => ({ ...entry })),
            preflopAggressorUserId: room.hextech.characterActionEffects.preflopAggressorUserId,
          },
          appliedCharacterDirectiveIds: [...room.hextech.appliedCharacterDirectiveIds],
          draft: room.hextech.draft ? {
            handNumber: room.hextech.draft.handNumber,
            deadline: room.hextech.draft.deadline,
            offers: [...room.hextech.draft.offers.entries()].map(([userId, offer]) => ({
              userId,
              offerId: offer.offerId,
              skillIds: [...offer.skillIds],
              selectedSkillId: offer.selectedSkillId,
            })),
          } : null,
        } : null,
        settlement: {
          status: room.settlement.status,
          tableCap: room.settlement.tableCap,
          hasPracticeHands: room.settlement.hasPracticeHands,
          closedAt: room.settlement.closedAt,
          closedBy: room.settlement.closedBy,
          accounts: [...room.settlement.accounts.values()].map((account) => ({ ...account })),
        },
        members: [...room.members.values()].map((member) => ({
          userId: member.userId,
          username: member.username,
          accountName: member.accountName,
          avatarTone: member.avatarTone,
          title: member.title,
          displayedAchievements: [...(member.displayedAchievements || [])],
          isBot: member.isBot,
          role: member.role,
          seat: member.seat,
          stack: member.stack,
          ready: member.ready,
          rebuyCount: member.rebuyCount,
          pendingRebuy: member.pendingRebuy,
          rebuyDeadline: member.rebuyDeadline,
          seatRequest: member.seatRequest,
          requestedSeat: member.requestedSeat,
          spectatorFocusUserId: member.spectatorFocusUserId,
          spectatorCardAccess: member.spectatorCardAccess ? {
            handId: member.spectatorCardAccess.handId,
            userIds: [...member.spectatorCardAccess.userIds],
          } : null,
          everSeated: member.everSeated,
          characterId: member.characterId,
          equippedSkillId: member.equippedSkillId,
          hextechRefreshesRemaining: member.hextechRefreshesRemaining,
        })),
        game: room.game?.exportState(savedAtMs) ?? null,
        gameSynced: room.gameSynced,
        handNumber: room.handNumber,
        lastButtonSeat: room.lastButtonSeat,
        lastHandCashOuts: room.lastHandCashOuts.map((entry) => ({ ...entry })),
        chat: room.chat.map((entry) => ({ ...entry })),
        createdAt: room.createdAt,
      })),
    };
    const tempFile = `${this.runtimeFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.runtimeFile), { recursive: true });
      fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tempFile, this.runtimeFile);
      this.persistenceHealthy = true;
      this.lastCheckpointAt = payload.savedAt;
    } catch (error) {
      this.persistenceHealthy = false;
      this.audit("runtime_state_checkpoint_failed", { reason: error.message });
      try { fs.unlinkSync(tempFile); } catch { /* Best-effort temporary file cleanup. */ }
      if (strict) throw error;
    }
  }

  register(socket) {
    const user = socket.data.user;
    const presence = this.onlineUsers.get(user.id) || { user, socketIds: new Set() };
    presence.user = user;
    presence.socketIds.add(socket.id);
    this.onlineUsers.set(user.id, presence);
    const existingCode = this.userRooms.get(user.id);
    if (existingCode && this.rooms.has(existingCode)) {
      const room = this.rooms.get(existingCode);
      const member = room.members.get(user.id);
      if (member) {
        member.username = user.displayName || user.username;
        member.accountName = user.username;
        member.avatarTone = user.avatarTone || "gold";
        member.title = user.title || "牌桌新秀";
        member.displayedAchievements = [...(user.displayedAchievements || [])];
        member.socketIds.add(socket.id);
        member.connected = true;
        socket.join(`room:${room.code}`);
        queueMicrotask(() => this.#emitRoom(room));
      }
    }

    this.#listen(socket, "lobby:list", (payload) => {
      authorizePayload(payload, []);
      return { rooms: this.listRooms(), leaderboard: this.listLeaderboard() };
    }, this.lobbyLimiter);
    this.#listen(socket, "room:create", (payload) => this.createRoom(socket, payload));
    this.#listen(socket, "room:join", (payload) => this.joinRoom(socket, payload));
    this.#listen(socket, "room:leave", (payload) => this.leaveRoom(socket, payload));
    this.#listen(socket, "room:select-character", (payload) => this.selectCharacter(socket, payload));
    this.#listen(socket, "room:ready", (payload) => this.setReady(socket, payload));
    this.#listen(socket, "room:start", (payload) => this.startGame(socket, payload));
    this.#listen(socket, "hextech:refresh-offer", (payload) => this.refreshHextechOffer(socket, payload));
    this.#listen(socket, "hextech:select-skill", (payload) => this.selectHextechSkill(socket, payload));
    this.#listen(socket, "hextech:skill-command", (payload) => this.hextechSkillCommand(socket, payload), this.actionLimiter);
    this.#listen(socket, "hextech:character-command", (payload) => this.hextechCharacterCommand(socket, payload), this.actionLimiter);
    this.#listen(socket, "room:final-settlement", (payload) => this.finalSettlement(socket, payload));
    this.#listen(socket, "room:add-bot", (payload) => this.addBot(socket, payload));
    this.#listen(socket, "room:remove-bot", (payload) => this.removeBot(socket, payload));
    this.#listen(socket, "room:kick", (payload) => this.kickMember(socket, payload));
    this.#listen(socket, "room:transfer-host", (payload) => this.transferHost(socket, payload));
    this.#listen(socket, "room:request-seat", (payload) => this.requestSeat(socket, payload));
    this.#listen(socket, "room:approve-seat", (payload) => this.approveSeat(socket, payload));
    this.#listen(socket, "room:confirm-next-seat", (payload) => this.confirmNextSeat(socket, payload));
    this.#listen(socket, "room:defer-seat", (payload) => this.deferSeat(socket, payload));
    this.#listen(socket, "game:watch-player", (payload) => this.watchPlayer(socket, payload));
    this.#listen(socket, "game:spectator-visibility", (payload) => this.setSpectatorVisibility(socket, payload));
    this.#listen(socket, "game:action", (payload) => this.gameAction(socket, payload), this.actionLimiter);
    this.#listen(socket, "game:fold-reveal", (payload) => this.chooseFoldReveal(socket, payload), this.actionLimiter);
    this.#listen(socket, "game:time-extension", (payload) => this.buyTimeExtension(socket, payload), this.actionLimiter);
    this.#listen(socket, "game:rebuy", (payload) => this.rebuy(socket, payload));
    this.#listen(socket, "chat:send", (payload) => this.sendChat(socket, payload), this.chatLimiter);
    socket.on("disconnect", () => this.disconnect(socket));
    this.emitLeaderboard();
  }

  #listen(socket, event, operation, limiter = this.mutationLimiter) {
    socket.on(event, (payload, ack) => {
      const requestId = crypto.randomUUID();
      const startedAt = Date.now();
      if (!this.store.userForToken(socket.data.sessionToken)) {
        this.logger?.warn?.("auth", "socket_session_expired", {
          requestId,
          userId: socket.data.user.id,
          operation: event,
        });
        response(ack, { ok: false, error: "登录状态已失效", requestId });
        socket.disconnect(true);
        return;
      }
      const limit = limiter.consume(`${socket.data.user.id}:${event}`);
      if (!limit.allowed) {
        this.audit("socket_event_rate_limited", { event, userId: socket.data.user.id });
        this.logger?.warn?.(socketLogDomain(event), "socket_operation_rate_limited", {
          ...this.#socketLogContext(socket, requestId),
          operation: event,
        });
        response(ack, { ok: false, error: "操作过于频繁，请稍后重试", requestId });
        return;
      }
      this.#guard(ack, () => operation(payload), socket, event, {
        requestId,
        startedAt,
        metadata: this.#socketOperationMetadata(event, payload),
      });
    });
  }

  #socketLogContext(socket, requestId = null) {
    const userId = socket?.data.user.id ?? null;
    const roomCode = userId ? this.userRooms.get(userId) ?? null : null;
    const room = roomCode ? this.rooms.get(roomCode) : null;
    return {
      requestId,
      userId,
      roomCode,
      handId: room?.game?.handId ?? null,
      handNumber: room?.handNumber ?? null,
      roomMode: room?.mode ?? null,
    };
  }

  #socketOperationMetadata(event, payload) {
    if (event === "game:action" && typeof payload?.action === "string") {
      return { action: payload.action.slice(0, 24) };
    }
    if (event === "game:rebuy" && typeof payload?.accept === "boolean") {
      return { decision: payload.accept ? "accepted" : "declined" };
    }
    if (event === "game:spectator-visibility" && typeof payload?.hidden === "boolean") {
      return { visibility: payload.hidden ? "hidden" : "visible" };
    }
    return {};
  }

  #guard(ack, operation, socket = null, event = null, telemetry = {}) {
    const requestId = telemetry.requestId || crypto.randomUUID();
    const startedAt = Number.isFinite(telemetry.startedAt) ? telemetry.startedAt : Date.now();
    const domain = socketLogDomain(event || "room:unknown");
    try {
      const value = operation();
      this.logger?.info?.(domain, "socket_operation_succeeded", {
        ...this.#socketLogContext(socket, requestId),
        operation: event,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...telemetry.metadata,
      });
      response(ack, { ok: true, ...value, requestId });
    } catch (error) {
      if (error instanceof SecurityError) {
        this.audit("socket_request_rejected", {
          event,
          userId: socket?.data.user.id,
          reason: error.code,
        });
      }
      this.logger?.warn?.(domain, "socket_operation_rejected", {
        ...this.#socketLogContext(socket, requestId),
        operation: event,
        durationMs: Math.max(0, Date.now() - startedAt),
        reason: error instanceof SecurityError ? error.code : "operation_failed",
        error,
        ...telemetry.metadata,
      });
      response(ack, { ok: false, error: error.message || "操作失败", requestId });
    }
  }

  listRooms() {
    return [...this.rooms.values()].map((room) => {
      const playerCount = [...room.members.values()].filter((member) => member.role === "player").length;
      const previewPlayerCount = Math.max(HEXTECH_MODE.minPlayers, playerCount);
      return {
        code: room.code,
        name: room.name,
        mode: room.mode,
        playerCount,
        spectatorCount: [...room.members.values()].filter((member) => member.role === "spectator").length,
        maxPlayers: room.settings.maxPlayers,
        smallBlind: room.settings.smallBlind,
        bigBlind: room.settings.bigBlind,
        targetChips: room.hextech?.targetChips
          ?? (isHextechMode(room.mode) ? hextechTargetForPlayers(previewPlayerCount) : null),
        hasPassword: Boolean(room.settings.password),
        status: room.settlement.status === "closed"
          ? "已结算"
          : room.game && room.game.stage !== "finished" ? "游戏中" : "等待中",
      };
    });
  }

  listLeaderboard() {
    const entries = [...this.onlineUsers.values()].map(({ user }) => {
      const code = this.userRooms.get(user.id);
      const room = code ? this.rooms.get(code) : null;
      const member = room?.members.get(user.id);
      const activeGame = Boolean(room?.game && room.game.stage !== "finished");
      const gamePlayer = activeGame
        ? room.game.players.find((player) => player.userId === user.id)
        : null;

      let score = 0;
      let status = "大厅";
      if (member) {
        if (member.pendingRebuy > 0) score = member.pendingRebuy;
        else if (gamePlayer) score = gamePlayer.stack;
        else score = member.stack;

        if (room.settlement.status === "closed") {
          status = "已结算";
        } else if (member.role === "spectator") {
          status = member.seatRequest ? "等待入座" : activeGame ? "观战中" : "观战席";
        } else if (activeGame) {
          status = gamePlayer?.folded ? "本局观战" : "牌局中";
        } else {
          status = "等待开局";
        }
      }

      return {
        userId: user.id,
        username: user.displayName || user.username,
        accountName: user.username,
        avatarTone: user.avatarTone || "gold",
        title: user.title || "牌桌新秀",
        displayedAchievements: [...(user.displayedAchievements || [])],
        score: Number.isSafeInteger(score) && score > 0 ? score : 0,
        status,
        roomCode: room?.code ?? null,
        roomName: room?.name ?? null,
      };
    });

    entries.sort((left, right) => (
      right.score - left.score
      || left.username.localeCompare(right.username, "zh-CN")
      || left.userId.localeCompare(right.userId)
    ));
    return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  emitLeaderboard() {
    this.io.emit("leaderboard:update", this.listLeaderboard());
  }

  refreshUserProfile(user) {
    const presence = this.onlineUsers.get(user.id);
    if (presence) presence.user = user;
    const code = this.userRooms.get(user.id);
    const room = code ? this.rooms.get(code) : null;
    const member = room?.members.get(user.id);
    if (member) {
      member.username = user.displayName || user.username;
      member.accountName = user.username;
      member.avatarTone = user.avatarTone || "gold";
      member.title = user.title || "牌桌新秀";
      member.displayedAchievements = [...(user.displayedAchievements || [])];
      this.#settlementAccount(room, member);
      const gamePlayer = room.game?.players.find((player) => player.userId === user.id);
      if (gamePlayer) gamePlayer.username = member.username;
      this.#emitRoom(room);
    } else {
      this.emitLeaderboard();
    }
  }

  #roomFor(socket) {
    const code = this.userRooms.get(socket.data.user.id);
    const room = code ? this.rooms.get(code) : null;
    if (!room || !room.members.has(socket.data.user.id)) throw new Error("你当前不在房间中");
    return room;
  }

  #assertHost(socket, room) {
    if (room.hostUserId !== socket.data.user.id) throw new Error("只有房主可以执行该操作");
  }

  #assertSettlementOpen(room) {
    if (room.settlement.status !== "open") throw new Error("本房间已经完成终局结算");
  }

  #settlementAccount(room, member) {
    let account = room.settlement.accounts.get(member.userId);
    if (!account) {
      account = {
        userId: member.userId,
        username: member.username,
        accountName: member.accountName,
        isBot: member.isBot,
        buyIn: 0,
        autoCashOut: 0,
        exitCashOut: 0,
        finalCashOut: 0,
        lastSeat: member.seat,
        rebuyCount: member.rebuyCount,
      };
      room.settlement.accounts.set(member.userId, account);
    }
    account.username = member.username;
    account.accountName = member.accountName;
    account.isBot = member.isBot;
    return account;
  }

  #recordBuyIn(room, member, amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("买入筹码数据不正确");
    const account = this.#settlementAccount(room, member);
    account.lastSeat = member.seat;
    account.rebuyCount = member.rebuyCount;
    account.buyIn += amount;
  }

  #cashOutMember(room, member, kind) {
    const amount = member.stack + member.pendingRebuy;
    if (amount <= 0) return 0;
    const account = this.#settlementAccount(room, member);
    account.lastSeat = member.seat;
    account.rebuyCount = member.rebuyCount;
    if (kind === "final") account.finalCashOut += amount;
    else account.exitCashOut += amount;
    member.stack = 0;
    member.pendingRebuy = 0;
    member.ready = false;
    return amount;
  }

  #applyTableCap(room) {
    if (isHextechMode(room.mode)) return;
    if (room.settlement.status !== "open") return;
    const cashOuts = [];
    for (const member of room.members.values()) {
      const excess = Math.max(0, member.stack - room.settlement.tableCap);
      if (excess <= 0) continue;
      member.stack = room.settlement.tableCap;
      const account = this.#settlementAccount(room, member);
      account.autoCashOut += excess;
      cashOuts.push({ userId: member.userId, amount: excess });
    }
    room.lastHandCashOuts = cashOuts;
  }

  #settlementView(room, userId) {
    const activeGame = Boolean(room.game && room.game.stage !== "finished");
    const accounts = [...room.settlement.accounts.values()]
      .filter((account) => !account.isBot && (account.buyIn > 0 || settlementCashOut(account) > 0))
      .map((account) => {
        const member = room.members.get(account.userId);
        const gamePlayer = activeGame
          ? room.game.players.find((player) => player.userId === account.userId)
          : null;
        const tableChips = room.settlement.status === "closed"
          ? 0
          : Math.max(0, gamePlayer?.stack ?? member?.stack ?? 0);
        const pendingChips = room.settlement.status === "closed"
          ? 0
          : Math.max(0, member?.pendingRebuy ?? 0);
        const cashOut = settlementCashOut(account);
        const settlementPoints = cashOut - account.buyIn;
        return {
          userId: account.userId,
          username: member?.username ?? account.username,
          accountName: member?.accountName ?? account.accountName,
          buyIn: account.buyIn,
          autoCashOut: account.autoCashOut,
          exitCashOut: account.exitCashOut,
          finalCashOut: account.finalCashOut,
          cashOut,
          tableChips,
          pendingChips,
          settlementPoints,
          projectedNet: activeGame ? null : settlementPoints + tableChips + pendingChips,
          connected: Boolean(member?.connected),
          isSelf: account.userId === userId,
        };
      })
      .sort((left, right) => (
        right.settlementPoints - left.settlementPoints
        || left.username.localeCompare(right.username, "zh-CN")
      ));
    const totals = accounts.reduce((summary, account) => ({
      buyIn: summary.buyIn + account.buyIn,
      cashOut: summary.cashOut + account.cashOut,
      tableChips: summary.tableChips + account.tableChips + account.pendingChips,
      settlementPoints: summary.settlementPoints + account.settlementPoints,
    }), { buyIn: 0, cashOut: 0, tableChips: 0, settlementPoints: 0 });
    return {
      status: room.settlement.status,
      tableCap: room.settlement.tableCap,
      hasPracticeHands: room.settlement.hasPracticeHands,
      closedAt: room.settlement.closedAt,
      closedBy: room.settlement.closedBy,
      accounts,
      self: accounts.find((account) => account.userId === userId) ?? null,
      totals: {
        ...totals,
        systemBalance: activeGame ? null : totals.buyIn - totals.cashOut - totals.tableChips,
      },
      lastHandCashOuts: room.lastHandCashOuts.map((entry) => ({ ...entry })),
      canFinalize: room.settlement.status === "open"
        && !isHextechMode(room.mode)
        && !activeGame
        && room.handNumber > 0
        && !room.settlement.hasPracticeHands,
    };
  }

  #attachSocket(socket, room, member) {
    member.socketIds.add(socket.id);
    member.connected = true;
    this.userRooms.set(member.userId, room.code);
    socket.join(`room:${room.code}`);
  }

  createRoom(socket, payload = {}) {
    payload = authorizePayload(payload, ["name", "mode", "settings"]);
    if (this.userRooms.has(socket.data.user.id)) throw new Error("请先退出当前房间");
    this.store.assertCanCreateRoom?.();
    if (payload.name != null && typeof payload.name !== "string") throw new Error("房间名称格式不正确");
    let code = roomCode();
    while (this.rooms.has(code)) code = roomCode();
    const mode = normalizeRoomMode(payload.mode);
    const settings = normalizeSettings(payload.settings, mode);
    const room = {
      code,
      name: String(payload.name ?? "好友牌局").trim().slice(0, 24) || "好友牌局",
      mode,
      hostUserId: socket.data.user.id,
      settings,
      members: new Map(),
      settlement: emptySettlement(settings),
      hextech: isHextechMode(mode) ? emptyHextechState() : null,
      game: null,
      gameSynced: false,
      handNumber: 0,
      lastButtonSeat: null,
      lastHandCashOuts: [],
      chat: [],
      botTimer: null,
      createdAt: new Date().toISOString(),
    };
    const member = this.#newMember(socket.data.user, "player", 0, settings.initialChips);
    member.everSeated = true;
    room.members.set(member.userId, member);
    this.#recordBuyIn(room, member, settings.initialChips);
    this.rooms.set(code, room);
    this.#attachSocket(socket, room, member);
    this.#emitRoom(room);
    this.io.emit("lobby:update", this.listRooms());
    return { room: this.#view(room, member.userId) };
  }

  joinRoom(socket, payload = {}) {
    payload = authorizePayload(payload, ["code", "password", "mode"]);
    if (this.userRooms.has(socket.data.user.id)) throw new Error("请先退出当前房间");
    if (typeof payload.code !== "string" || !/^[A-Z2-9]{4}$/i.test(payload.code.trim())) {
      throw new Error("请输入正确的四位房间码");
    }
    if (payload.password != null && typeof payload.password !== "string") throw new Error("房间密码格式不正确");
    if (payload.password?.length > 20) throw new Error("房间密码格式不正确");
    const code = String(payload.code ?? "").trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) throw new Error("没有找到该房间");
    if (room.settlement.status === "closed") throw new Error("该房间已经完成终局结算");
    // Room creation trims passwords before storing them; normalize the join input
    // the same way so copied passwords with accidental surrounding spaces work.
    const suppliedPassword = String(payload.password ?? "").trim();
    if (room.settings.password && !constantTimeEqual(tokenDigest(room.settings.password), tokenDigest(suppliedPassword))) {
      throw new Error("房间密码不正确");
    }

    // First-time visitors still enter through the spectator/seat-request flow.
    // A previously seated player may return directly between hands; the server
    // restores a valid open seat and records a fresh buy-in before readiness is
    // permitted. Active hands remain spectator-only.
    const priorAccount = room.settlement.accounts.get(socket.data.user.id);
    const canRestorePlayer = payload.mode === "player"
      && (!room.game || room.game.stage === "finished")
      && priorAccount
      && !priorAccount.isBot
      && (!isHextechMode(room.mode) || room.handNumber === 0);
    const restoredSeat = canRestorePlayer
      ? (seatIsOpen(room, priorAccount.lastSeat) ? priorAccount.lastSeat : firstOpenSeat(room))
      : null;
    const role = restoredSeat == null ? "spectator" : "player";
    const member = this.#newMember(
      socket.data.user,
      role,
      restoredSeat,
      role === "player" ? room.settings.initialChips : 0,
    );
    if (role === "player") {
      member.everSeated = true;
      member.rebuyCount = Math.min(priorAccount.rebuyCount || 0, room.settings.maxRebuys);
      this.#recordBuyIn(room, member, room.settings.initialChips);
    }
    room.members.set(member.userId, member);
    this.#attachSocket(socket, room, member);
    this.#addChat(room, "系统", `${member.username} ${role === "player" ? "加入了牌桌" : "进入观战席"}`, true);
    this.#emitRoom(room);
    this.io.emit("lobby:update", this.listRooms());
    return { room: this.#view(room, member.userId), joinedAs: role };
  }

  #newMember(user, role, seat, stack) {
    return {
      userId: user.id,
      username: user.displayName || user.username,
      accountName: user.username,
      avatarTone: user.avatarTone || "gold",
      title: user.title || "牌桌新秀",
      displayedAchievements: [...(user.displayedAchievements || [])],
      isBot: false,
      role,
      seat,
      stack,
      ready: false,
      connected: true,
      socketIds: new Set(),
      rebuyCount: 0,
      pendingRebuy: 0,
      rebuyDeadline: null,
      seatRequest: false,
      requestedSeat: null,
      spectatorFocusUserId: null,
      spectatorCardAccess: null,
      everSeated: false,
      characterId: null,
      equippedSkillId: null,
      hextechRefreshesRemaining: HEXTECH_MODE.freeRefreshes,
    };
  }

  leaveRoom(socket, payload = {}) {
    authorizePayload(payload, []);
    const room = this.#roomFor(socket);
    const member = room.members.get(socket.data.user.id);
    if (isHextechMode(room.mode)
      && room.handNumber > 0
      && !room.hextech?.matchEnd
      && room.hextech?.participantUserIds.includes(member.userId)) {
      throw new Error("海克斯本场进行中不能退出参赛名单；可断线后重新连接");
    }
    if (room.game && room.game.stage !== "finished" && member.role !== "spectator") {
      throw new Error("本局进行中，玩家暂时不能退出房间");
    }
    if (room.settlement.status === "open" && (!room.game || room.game.stage === "finished" || member.role === "spectator")) {
      this.#cashOutMember(room, member, "exit");
    }
    room.members.delete(member.userId);
    this.userRooms.delete(member.userId);
    socket.leave(`room:${room.code}`);
    if (member.userId === room.hostUserId) {
      room.hostUserId = humanMembers(room)[0]?.userId ?? null;
    }
    if (!humanMembers(room).length) {
      this.rooms.delete(room.code);
      this.#persistRooms();
      this.emitLeaderboard();
    } else this.#emitRoom(room);
    this.io.emit("lobby:update", this.listRooms());
    return {};
  }

  setReady(socket, payload = {}) {
    payload = authorizePayload(payload, ["ready"]);
    if (typeof payload.ready !== "boolean") throw new Error("准备状态格式不正确");
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    const member = room.members.get(socket.data.user.id);
    if (member.role !== "player") throw new Error("观战者不能准备");
    if (room.game && room.game.stage !== "finished") throw new Error("牌局进行中不能修改准备状态");
    if (member.stack <= 0 && member.pendingRebuy <= 0) throw new Error("请先补充筹码");
    if (payload.ready && isHextechMode(room.mode) && !member.characterId) {
      throw new Error("请先选择并锁定人物");
    }
    member.ready = payload.ready;
    this.#emitRoom(room);
    return {};
  }

  selectCharacter(socket, payload = {}) {
    payload = authorizePayload(payload, ["characterId"]);
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    if (!isHextechMode(room.mode)) throw new Error("当前房间不是海克斯模式");
    if (room.handNumber > 0 || room.game || room.hextech?.phase === "skill-draft") {
      throw new Error("开局后不能更换人物");
    }
    const member = room.members.get(socket.data.user.id);
    if (!member || member.role !== "player") throw new Error("只有入座玩家可以选择人物");
    if (member.ready) throw new Error("请先取消准备再更换人物");
    if (payload.characterId == null) {
      member.characterId = null;
      this.#emitRoom(room);
      return {};
    }
    if (typeof payload.characterId !== "string" || !isHextechCharacterId(payload.characterId)) {
      throw new Error("人物选择不正确");
    }
    const occupiedBy = [...room.members.values()].find((candidate) => (
      candidate.userId !== member.userId && candidate.characterId === payload.characterId
    ));
    if (occupiedBy) throw new Error(`${hextechCharacter(payload.characterId).name} 已被 ${occupiedBy.username} 锁定`);
    member.characterId = payload.characterId;
    member.equippedSkillId = null;
    this.#emitRoom(room);
    return {};
  }

  startGame(socket, payload = {}) {
    authorizePayload(payload, []);
    const room = this.#roomFor(socket);
    this.#assertHost(socket, room);
    this.#assertSettlementOpen(room);
    if (isHextechMode(room.mode) && room.hextech?.matchEnd) throw new Error("本场海克斯对局已经结束");
    if (isHextechMode(room.mode) && room.hextech?.phase === "skill-draft") throw new Error("正在等待玩家装备技能");
    if (isHextechMode(room.mode) && room.handNumber >= HEXTECH_MODE.maxHands) throw new Error("本场已经达到 15 手上限");
    if (room.game && room.game.stage !== "finished") throw new Error("本局尚未结束");
    room.game?.resolveFoldRevealIfNeeded?.();
    if (room.game?.foldReveal && room.game.foldReveal.decision == null) throw new Error("请等待获胜玩家完成亮牌选择");

    const seatedPlayers = [...room.members.values()].filter((member) => member.role === "player");
    if (seatedPlayers.length < 2) throw new Error("至少需要两位玩家入座");
    if (isHextechMode(room.mode)) {
      const missingCharacters = seatedPlayers.filter((member) => !member.characterId);
      if (missingCharacters.length) {
        throw new Error(`${missingCharacters.map(({ username }) => username).join("、")} 尚未选择人物`);
      }
      const characterIds = seatedPlayers.map(({ characterId }) => characterId);
      if (new Set(characterIds).size !== characterIds.length) throw new Error("人物已被重复占用，请重新选择");
      if (room.hextech.lockedPlayerCount != null) {
        const unexpected = seatedPlayers.filter(({ userId }) => !room.hextech.participantUserIds.includes(userId));
        if (unexpected.length) throw new Error("海克斯开局后不能加入新的参赛玩家");
      }
    }

    const playersWithoutChips = seatedPlayers.filter(
      (member) => member.stack <= 0 && member.pendingRebuy <= 0,
    );
    if (playersWithoutChips.length > 0) {
      const names = playersWithoutChips.map((member) => member.username).join("、");
      throw new Error(`${names} 暂无可用筹码，请先补充筹码或转为观战`);
    }

    const unreadyPlayers = seatedPlayers.filter((member) => !member.isBot && !member.ready);
    if (unreadyPlayers.length > 0) {
      for (const member of unreadyPlayers) {
        if (member.userId === socket.data.user.id) continue;
        for (const socketId of member.socketIds) {
          this.io.to(socketId).emit("room:ready-reminder", {
            roomCode: room.code,
            message: `${socket.data.user.displayName || socket.data.user.username} 正在等待你准备，请点击“准备”后开始牌局`,
          });
        }
      }
      const names = unreadyPlayers
        .map((member) => `${member.username}${member.connected ? "" : "（已断线）"}`)
        .join("、");
      throw new Error(`${names} 尚未准备，已发送准备提醒`);
    }

    for (const member of room.members.values()) {
      if (member.pendingRebuy > 0 && member.role === "player") {
        member.stack += member.pendingRebuy;
        member.pendingRebuy = 0;
      }
    }
    const players = seatedPlayers.filter((member) => member.stack > 0);
    if (players.length < 2) throw new Error("至少需要两位有筹码的玩家");
    if (isHextechMode(room.mode) && room.hextech.lockedPlayerCount == null) {
      room.hextech.lockedPlayerCount = players.length;
      room.hextech.targetChips = hextechTargetForPlayers(players.length);
      room.hextech.participantUserIds = players.map(({ userId }) => userId);
    }

    const nextHandNumber = room.handNumber + 1;
    const hextechLevel = isHextechMode(room.mode) ? hextechBlindForHand(nextHandNumber) : null;
    room.game = new HoldemGame({
      players: players.map((member) => ({
        userId: member.userId,
        username: member.username,
        seat: member.seat,
        stack: member.stack,
        isBot: member.isBot,
      })),
      settings: hextechLevel ? { ...room.settings, ...hextechLevel } : room.settings,
      buttonSeat: room.lastButtonSeat,
      actionSeconds: hextechLevel?.actionSeconds,
      deferAutoRunout: Boolean(hextechLevel),
      runoutStepMs: hextechLevel ? 0 : ALL_IN_RUNOUT_STEP_MS,
    });
    for (const member of room.members.values()) member.spectatorCardAccess = null;
    room.lastButtonSeat = room.game.buttonSeat;
    room.gameSynced = false;
    room.handNumber = nextHandNumber;
    room.lastHandCashOuts = [];
    if (isHextechMode(room.mode)) {
      if (!room.hextech.characters) {
        room.hextech.characters = createHextechCharacterEngine({
          players: room.hextech.participantUserIds.map((userId) => {
            const member = room.members.get(userId);
            return {
              userId,
              characterId: member.characterId,
              stack: member.stack,
            };
          }),
        });
      }
      room.hextech.characterActionEffects = {
        raiseCaps: [],
        clockModifiers: [],
        preflopAggressorUserId: null,
      };
      room.hextech.characterOpportunity = null;
      const characterOutcome = room.hextech.characters.beginHand({
        eventId: `begin:${room.game.handId}`,
        handNumber: room.handNumber,
        players: room.hextech.participantUserIds.map((userId) => {
          const gamePlayer = room.game.players.find((player) => player.userId === userId);
          return {
            userId,
            startingStack: gamePlayer?.startingStack ?? room.members.get(userId)?.stack ?? 0,
            seated: Boolean(gamePlayer),
          };
        }),
      });
      this.#applyHextechCharacterDirectives(room, characterOutcome.directives);
      this.#attachHextechEffects(room);
      this.#beginHextechDraft(room, players);
      this.#addChat(room, "系统", `第 ${room.handNumber} 手开始，等待全员装备技能`, true);
    } else {
      this.#addChat(room, "系统", `第 ${room.handNumber} 局开始`, true);
      if (room.game.stage === "finished") this.#syncFinished(room);
    }
    this.#emitRoom(room);
    this.#scheduleBot(room);
    return {};
  }

  #beginHextechDraft(room, players) {
    const offers = new Map();
    for (const member of players) {
      member.equippedSkillId = null;
      const offer = createSkillOffer();
      if (member.isBot) offer.selectedSkillId = randomEntry(offer.skillIds);
      offers.set(member.userId, offer);
    }
    room.hextech.phase = "skill-draft";
    room.hextech.draft = {
      handNumber: room.handNumber,
      deadline: Date.now() + HEXTECH_MODE.draftSeconds * 1000,
      offers,
    };
    if ([...offers.values()].every(({ selectedSkillId }) => selectedSkillId)) {
      this.#finishHextechDraft(room, "all-locked");
    }
  }

  #finishHextechDraft(room, reason = "timeout") {
    const draft = room.hextech?.draft;
    if (!draft || !room.game || room.game.stage === "finished") return false;
    for (const [userId, offer] of draft.offers) {
      const selectedSkillId = offer.selectedSkillId ?? randomEntry(offer.skillIds);
      offer.selectedSkillId = selectedSkillId;
      const member = room.members.get(userId);
      if (member) member.equippedSkillId = selectedSkillId;
    }
    if (!room.hextech.effects) {
      room.hextech.effects = createHextechEffectsEngine({
        matchId: `${room.code}:${room.createdAt}`,
        participantUserIds: room.hextech.participantUserIds,
      });
    }
    const equipmentByUserId = Object.fromEntries(
      room.game.players.map(({ userId }) => [userId, room.members.get(userId)?.equippedSkillId]),
    );
    room.hextech.effects.beginHand({
      handId: room.game.handId,
      players: room.game.players,
      equipmentByUserId,
      stage: room.game.stage,
    });
    this.#attachHextechEffects(room);
    room.hextech.phase = "playing";
    room.hextech.draft = null;
    room.game.resumeAfterDraft();
    if (room.game.stage === "finished") this.#syncFinished(room);
    this.#addChat(
      room,
      "系统",
      reason === "timeout" ? "装备时间结束，系统已为未选择玩家自动装备" : "全员装备完成，开始翻牌前行动",
      true,
    );
    return true;
  }

  refreshHextechOffer(socket, payload = {}) {
    payload = authorizePayload(payload, ["offerId"]);
    if (typeof payload.offerId !== "string" || payload.offerId.length > 80) throw new Error("技能选项已过期");
    const room = this.#roomFor(socket);
    if (!isHextechMode(room.mode) || room.hextech?.phase !== "skill-draft" || !room.hextech.draft) {
      throw new Error("当前不在技能选择阶段");
    }
    if (Date.now() >= room.hextech.draft.deadline) {
      this.#finishHextechDraft(room, "timeout");
      this.#emitRoom(room);
      this.#scheduleBot(room);
      throw new Error("装备时间已结束，系统已自动选择技能");
    }
    const member = room.members.get(socket.data.user.id);
    const offer = room.hextech.draft.offers.get(member?.userId);
    if (!member || member.role !== "player" || !offer) throw new Error("当前没有你的技能选项");
    if (offer.offerId !== payload.offerId) throw new Error("技能选项已更新，请以最新结果为准");
    if (offer.selectedSkillId) throw new Error("技能已经锁定");
    if (member.hextechRefreshesRemaining <= 0) throw new Error("本场免费刷新已经用完");
    room.hextech.draft.offers.set(member.userId, createSkillOffer(offer.skillIds));
    member.hextechRefreshesRemaining -= 1;
    this.#emitRoom(room);
    return {};
  }

  selectHextechSkill(socket, payload = {}) {
    payload = authorizePayload(payload, ["offerId", "skillId"]);
    if (typeof payload.offerId !== "string" || payload.offerId.length > 80
      || typeof payload.skillId !== "string" || !isHextechSkillId(payload.skillId)) {
      throw new Error("技能选择不正确");
    }
    const room = this.#roomFor(socket);
    if (!isHextechMode(room.mode) || room.hextech?.phase !== "skill-draft" || !room.hextech.draft) {
      throw new Error("当前不在技能选择阶段");
    }
    if (Date.now() >= room.hextech.draft.deadline) {
      this.#finishHextechDraft(room, "timeout");
      this.#emitRoom(room);
      this.#scheduleBot(room);
      throw new Error("装备时间已结束，系统已自动选择技能");
    }
    const member = room.members.get(socket.data.user.id);
    const offer = room.hextech.draft.offers.get(member?.userId);
    if (!member || member.role !== "player" || !offer) throw new Error("当前没有你的技能选项");
    if (offer.offerId !== payload.offerId) throw new Error("技能选项已更新，请以最新结果为准");
    if (!offer.skillIds.includes(payload.skillId)) throw new Error("只能装备本次三选一中的技能");
    if (offer.selectedSkillId) throw new Error("本手技能已经锁定");
    offer.selectedSkillId = payload.skillId;
    member.equippedSkillId = payload.skillId;
    const allLocked = [...room.hextech.draft.offers.values()].every(({ selectedSkillId }) => selectedSkillId);
    if (allLocked) this.#finishHextechDraft(room, "all-locked");
    this.#emitRoom(room);
    if (allLocked) this.#scheduleBot(room);
    return {};
  }

  #attachHextechEffects(room) {
    if (!isHextechMode(room?.mode) || !room.game) return;
    // A few settlement-only recovery/test fixtures intentionally carry a
    // minimal finished-game view object rather than a live HoldemGame.
    if (typeof room.game.setActionPolicy !== "function") return;
    if (!room.hextech.effects
      && room.hextech.phase === "playing"
      && room.game.stage !== "finished") {
      room.hextech.effects = createHextechEffectsEngine({
        matchId: `${room.code}:${room.createdAt}`,
        participantUserIds: room.hextech.participantUserIds,
      });
      room.hextech.effects.beginHand({
        handId: room.game.handId,
        players: room.game.players,
        equipmentByUserId: Object.fromEntries(room.game.players.map(({ userId }) => [
          userId,
          room.members.get(userId)?.equippedSkillId,
        ])),
        stage: room.game.stage,
      });
    }
    room.game.setActionPolicy((context) => {
      const skillPolicy = room.hextech?.effects
        ? room.hextech.effects.actionPolicyFor(context)
        : {};
      const caps = room.hextech.characterActionEffects.raiseCaps.filter((entry) => (
        entry.targetUserId === context.userId && entry.street === context.stage
      ));
      const characterMaximum = caps.length
        ? Math.min(...caps.map(({ maximumRaiseTotal }) => maximumRaiseTotal))
        : null;
      const maximums = [skillPolicy.maxRaiseTo, characterMaximum]
        .filter((value) => Number.isSafeInteger(value));
      return {
        ...skillPolicy,
        ...(maximums.length ? { maxRaiseTo: Math.min(...maximums) } : {}),
        disableRaise: Boolean(skillPolicy.disableRaise)
          || (characterMaximum != null && characterMaximum <= context.currentBet),
        reason: [skillPolicy.reason, characterMaximum != null ? "受到剑压，本次加注受限" : null]
          .filter(Boolean)
          .join("；") || null,
      };
    });
    room.game.setTurnTimePolicy?.(({ userId, stage, baseSeconds }) => {
      let seconds = baseSeconds;
      for (const modifier of room.hextech.characterActionEffects.clockModifiers) {
        if (modifier.street !== stage) continue;
        if (modifier.sourceUserId === userId) seconds += modifier.selfSecondsDelta;
        else seconds = Math.max(
          modifier.minimumOpponentActionSeconds,
          seconds + modifier.opponentSecondsDelta,
        );
      }
      return seconds;
    });
    this.#syncHextechCharacterPause(room);
  }

  #hextechReactionActive(room) {
    return Boolean(room.hextech?.effects?.exportState?.().hand?.activeReaction);
  }

  #runHextechEffectTransaction(room, callback) {
    if (!room.game || !room.hextech?.effects) throw new Error("海克斯牌局状态尚未建立");
    const snapshot = {
      effects: room.hextech.effects.exportState(),
      game: room.game.createTransactionSnapshot(),
      memberStacks: new Map([...room.members].map(([userId, member]) => [userId, member.stack])),
      characters: room.hextech.characters?.exportState?.() ?? null,
      characterActionEffects: structuredClone(room.hextech.characterActionEffects),
      appliedCharacterDirectiveIds: [...room.hextech.appliedCharacterDirectiveIds],
    };
    try {
      return callback();
    } catch (error) {
      room.hextech.effects = restoreHextechEffectsEngine(snapshot.effects, { rotateWindowTokens: false });
      room.game.restoreTransactionSnapshot(snapshot.game);
      for (const [userId, stack] of snapshot.memberStacks) {
        const member = room.members.get(userId);
        if (member) member.stack = stack;
      }
      if (snapshot.characters) {
        room.hextech.characters = restoreHextechCharacterEngine(snapshot.characters);
      }
      room.hextech.characterActionEffects = snapshot.characterActionEffects;
      room.hextech.appliedCharacterDirectiveIds = snapshot.appliedCharacterDirectiveIds;
      this.#attachHextechEffects(room);
      this.#syncHextechCharacterPause(room);
      throw error;
    }
  }

  #applyHextechDirectives(room, directives = []) {
    if (!Array.isArray(directives) || !directives.length) return false;
    if (!room.game) throw new Error("牌局尚未开始");
    for (const directive of directives) {
      if (!directive || typeof directive.type !== "string") throw new Error("海克斯结算指令格式不正确");
      switch (directive.type) {
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.CHARGE_POT:
          room.game.addPlayerChipsToPot({
            userId: directive.userId,
            amount: directive.amount,
            label: directive.label,
            allowPartial: directive.allowPartial === true,
          });
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.CHARGE_BANK:
          room.game.collectPlayerChipsToBank({
            userId: directive.userId,
            amount: directive.amount,
            label: directive.label,
          });
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_CREDIT:
          room.game.creditPlayerFromBank({
            userId: directive.userId,
            amount: directive.amount,
            label: directive.label,
          });
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.BANK_POT:
          room.game.addBankChipsToPot({
            amount: directive.amount,
            label: directive.label,
          });
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.FORCED_CALL:
        {
          const before = room.hextech.characters ? room.game.exportState() : null;
          room.game.forceCallContribution({
            userId: directive.userId,
            maximumAmount: directive.maximumAmount,
            label: directive.label,
          });
          if (before) {
            this.#recordHextechCharacterPokerAction(room, {
              actorId: directive.userId,
              action: "call",
              before,
              automatic: true,
              throwOnError: true,
            });
          }
          break;
        }
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.REPLACE_HOLE_CARD_RANDOM:
          room.game.replaceHoleCardFromDeck({
            userId: directive.userId,
            cardIndex: directive.cardIndex,
            publicDiscard: directive.publicDiscard === true,
            label: directive.label,
          });
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.REPLACE_HOLE_CARD_RANK:
          room.game.replaceHoleCardWithRank({
            userId: directive.userId,
            cardIndex: directive.cardIndex,
            rank: directive.rank,
            preferredSuit: directive.preferredSuit,
            preserveSuit: directive.preserveSuit !== false,
            label: directive.label,
          });
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.BLANK_HOLE_CARD:
          room.game.replaceHoleCardWithBlank({
            userId: directive.userId,
            cardIndex: directive.cardIndex,
            label: directive.label,
          });
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.REDEAL_RIVER:
          room.game.redealRiver({ label: directive.label });
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.TRANSFER_CHIPS:
          room.game.transferPlayerChips({
            fromUserId: directive.fromUserId,
            toUserId: directive.toUserId,
            amount: directive.amount,
            allowPartial: directive.allowPartial === true,
            label: directive.label,
          });
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.FORCE_FOLD:
        {
          const before = room.hextech.characters ? room.game.exportState() : null;
          room.game.forceFold({ userId: directive.userId, label: directive.label });
          if (before) {
            this.#recordHextechCharacterPokerAction(room, {
              actorId: directive.userId,
              action: "fold",
              before,
              automatic: true,
              throwOnError: true,
            });
          }
          break;
        }
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.LOG:
          room.game.recordHextechEvent(directive.text);
          break;
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.PRIVATE_REVEAL:
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.PUBLIC_REVEAL:
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.DISABLE_EQUIPMENT:
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.RAISE_CAP:
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.SKILL_LOCK:
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.MUTUAL_RAISE_LOCK:
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.OPEN_REACTION:
        case HEXTECH_EFFECT_DIRECTIVE_TYPES.SKILL_BLOCKED:
          // These directives are represented by the authoritative effects
          // state itself. The adapter intentionally performs no duplicate
          // mutation; views and actionPolicyFor consume that state directly.
          break;
        default:
          throw new Error(`未知海克斯结算指令：${directive.type}`);
      }
    }
    this.#attachHextechEffects(room);
    return true;
  }

  #activeHextechCharacterWindow(room) {
    const players = room.hextech?.characters?.exportState?.().players;
    if (!players) return null;
    for (const player of Object.values(players)) {
      if (player?.window && ["awaiting-candidates", "armed", "resolving-challenge"].includes(player.window.state)) {
        return { userId: player.userId, window: player.window };
      }
    }
    return null;
  }

  #hextechCharacterWindowActive(room) {
    return Boolean(this.#activeHextechCharacterWindow(room) || room.hextech?.characterOpportunity);
  }

  #syncHextechCharacterPause(room) {
    if (!room.game || typeof room.game.pauseForHextechWindow !== "function") return;
    if (this.#hextechCharacterWindowActive(room) || this.#hextechReactionActive(room)) {
      room.game.pauseForHextechWindow();
    }
    else room.game.resumeFromHextechWindow();
  }

  #beginHextechAllInOpportunity(room, actorId, action, amount = null) {
    if (!room.game || !room.hextech?.characters || room.hextech.characterOpportunity
      || this.#activeHextechCharacterWindow(room) || this.#hextechReactionActive(room)) return false;
    const player = room.game.playerSnapshot(actorId);
    const character = room.hextech.characters.exportState().players?.[actorId];
    if (!player || !character || character.hand?.activeUsed || !["ya", "qiwan"].includes(character.characterId)) {
      return false;
    }
    const toCall = Math.max(0, room.game.currentBet - player.bet);
    const willAllIn = action === "allin"
      || (action === "call" && toCall >= player.stack)
      || (action === "raise" && Number.isSafeInteger(amount) && amount >= player.bet + player.stack);
    if (!willAllIn) return false;
    const rules = hextechCharacter(character.characterId)?.rules;
    const cost = Number(character.characterId === "ya" && character.awakened
      ? rules?.awakening?.activeCost
      : rules?.active?.cost ?? 0);
    if (character.resource < cost) return false;
    if (character.characterId === "qiwan"
      && (room.game.stage !== "preflop" || room.game.community.length > 0)) return false;
    if (character.characterId === "ya") {
      const aggressiveAllIn = player.bet + player.stack > room.game.currentBet;
      const gameState = room.game.exportState();
      if (!["preflop", "flop"].includes(room.game.stage)
        || !aggressiveAllIn
        || room.game.community.length >= 5
        || gameState.queuedBoardCards?.river
        || gameState.riverReplacementArmed) return false;
    }
    room.hextech.characterOpportunity = {
      userId: actorId,
      characterId: character.characterId,
      handId: room.game.handId,
      expiresAt: Date.now() + HEXTECH_CHARACTER_OPPORTUNITY_MS,
    };
    return true;
  }

  #clearHextechAllInOpportunity(room) {
    if (!room.hextech?.characterOpportunity) return false;
    room.hextech.characterOpportunity = null;
    this.#syncHextechCharacterPause(room);
    return true;
  }

  #refreshHextechAllInOpportunity(room, now = Date.now()) {
    if (!room.hextech?.characterOpportunity) return false;
    room.hextech.characterOpportunity.expiresAt = now + HEXTECH_CHARACTER_OPPORTUNITY_MS;
    this.#syncHextechCharacterPause(room);
    return true;
  }

  #hextechStackFor(room, userId) {
    return room.game?.playerSnapshot?.(userId)?.stack ?? room.members.get(userId)?.stack ?? 0;
  }

  #transferHextechChips(room, directive) {
    const sourceGamePlayer = room.game?.playerSnapshot?.(directive.fromUserId);
    const targetGamePlayer = room.game?.playerSnapshot?.(directive.toUserId);
    const sourceMember = room.members.get(directive.fromUserId);
    const targetMember = room.members.get(directive.toUserId);
    if (!sourceMember || !targetMember) throw new Error("人物筹码转移玩家不存在");
    const available = sourceGamePlayer?.stack ?? sourceMember.stack;
    const amount = directive.allowPartial === true
      ? Math.min(available, directive.amount)
      : directive.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0 || available < amount) {
      throw new Error("人物筹码转移余额不足");
    }
    const label = directive.reason ?? "人物技能结算";
    if (sourceGamePlayer && targetGamePlayer) {
      room.game.transferPlayerChips({
        fromUserId: directive.fromUserId,
        toUserId: directive.toUserId,
        amount,
        allowPartial: directive.allowPartial === true,
        label,
      });
      return;
    }
    if (sourceGamePlayer) {
      room.game.collectPlayerChipsToBank({ userId: directive.fromUserId, amount, label });
    } else {
      sourceMember.stack -= amount;
    }
    if (targetGamePlayer) {
      room.game.creditPlayerFromBank({ userId: directive.toUserId, amount, label });
    } else {
      targetMember.stack += amount;
    }
  }

  #runHextechCharacterTransaction(room, callback) {
    if (!room.game || !room.hextech?.characters) throw new Error("人物牌局状态尚未建立");
    const snapshot = {
      characters: room.hextech.characters.exportState(),
      effects: room.hextech.effects?.exportState?.() ?? null,
      game: room.game.createTransactionSnapshot(),
      memberStacks: new Map([...room.members].map(([userId, member]) => [userId, member.stack])),
      characterActionEffects: structuredClone(room.hextech.characterActionEffects),
      appliedCharacterDirectiveIds: [...room.hextech.appliedCharacterDirectiveIds],
    };
    try {
      return callback();
    } catch (error) {
      room.hextech.characters = restoreHextechCharacterEngine(snapshot.characters);
      if (snapshot.effects) {
        room.hextech.effects = restoreHextechEffectsEngine(snapshot.effects, { rotateWindowTokens: false });
      }
      room.game.restoreTransactionSnapshot(snapshot.game);
      for (const [userId, stack] of snapshot.memberStacks) {
        const member = room.members.get(userId);
        if (member) member.stack = stack;
      }
      room.hextech.characterActionEffects = snapshot.characterActionEffects;
      room.hextech.appliedCharacterDirectiveIds = snapshot.appliedCharacterDirectiveIds;
      this.#attachHextechEffects(room);
      this.#syncHextechCharacterPause(room);
      throw error;
    }
  }

  #reconcileHextechBustedParticipants(room) {
    if (!isHextechMode(room.mode) || room.hextech?.matchEnd) return false;
    let changed = false;
    const now = Date.now();
    for (const userId of room.hextech.participantUserIds) {
      const member = room.members.get(userId);
      if (!member || member.role !== "player" || member.stack > 0 || member.pendingRebuy > 0) continue;
      member.ready = false;
      if (member.rebuyCount >= room.settings.maxRebuys) {
        changed = this.#moveBustedMemberToSpectator(
          room,
          member,
          `${member.username} 补筹次数已用完，转入观战席`,
        ) || changed;
      } else if (!member.rebuyDeadline) {
        member.rebuyDeadline = now + HEXTECH_MODE.rebuyDecisionSeconds * 1000;
        this.#addChat(room, "系统", `${member.username} 有 ${HEXTECH_MODE.rebuyDecisionSeconds} 秒决定是否补筹`, true);
        changed = true;
      }
    }
    return changed;
  }

  #applyHextechCharacterDirectives(room, directives = []) {
    if (!Array.isArray(directives) || directives.length === 0) {
      this.#syncHextechCharacterPause(room);
      return false;
    }
    if (!room.game || !room.hextech?.characters) throw new Error("人物牌局状态尚未建立");
    const queue = [...directives];
    let mutated = false;
    const nextStreet = { preflop: "flop", flop: "turn", turn: "river", river: null };
    const suitName = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };
    while (queue.length) {
      const directive = queue.shift();
      if (!directive || typeof directive.directiveId !== "string" || typeof directive.type !== "string") {
        throw new Error("人物结算指令格式不正确");
      }
      if (room.hextech.appliedCharacterDirectiveIds.includes(directive.directiveId)) continue;
      switch (directive.type) {
        case HEXTECH_CHARACTER_DIRECTIVES.BANK_AWARD: {
          if (room.game.playerSnapshot?.(directive.userId)) {
            room.game.creditPlayerFromBank({
              userId: directive.userId,
              amount: directive.amount,
              label: directive.reason ?? "人物奖励",
            });
          } else {
            const member = room.members.get(directive.userId);
            if (!member) throw new Error("人物奖励玩家不存在");
            member.stack += directive.amount;
          }
          mutated = true;
          break;
        }
        case HEXTECH_CHARACTER_DIRECTIVES.BANK_TO_POT:
          room.game.addBankChipsToPot({
            amount: directive.amount,
            label: directive.reason ?? "人物奖励",
          });
          mutated = true;
          break;
        case HEXTECH_CHARACTER_DIRECTIVES.MODIFY_NEXT_STREET_CLOCK: {
          const street = nextStreet[room.game.stage];
          if (!street) throw new Error("当前已经没有下一下注街");
          if (!Number.isFinite(directive.opponentSecondsDelta)
            || !Number.isFinite(directive.selfSecondsDelta)
            || !Number.isFinite(directive.minimumOpponentActionSeconds)
            || directive.targetPolicy !== "all-opponents-still-in-hand") {
            throw new Error("人物行动时长修正不正确");
          }
          room.hextech.characterActionEffects.clockModifiers.push({
            directiveId: directive.directiveId,
            sourceUserId: directive.sourceUserId,
            street,
            selfSecondsDelta: directive.selfSecondsDelta,
            opponentSecondsDelta: directive.opponentSecondsDelta,
            minimumOpponentActionSeconds: directive.minimumOpponentActionSeconds,
            targetPolicy: directive.targetPolicy,
          });
          mutated = true;
          break;
        }
        case HEXTECH_CHARACTER_DIRECTIVES.CAP_NEXT_RAISE_TOTAL:
          room.hextech.characterActionEffects.raiseCaps.push({
            directiveId: directive.directiveId,
            sourceUserId: directive.sourceUserId,
            targetUserId: directive.targetUserId,
            street: room.game.stage,
            maximumRaiseTotal: directive.maximumRaiseTotal,
          });
          mutated = true;
          break;
        case HEXTECH_CHARACTER_DIRECTIVES.TRANSFER_CHIPS:
          this.#transferHextechChips(room, directive);
          mutated = true;
          break;
        case HEXTECH_CHARACTER_DIRECTIVES.PAY_TO_POT:
          room.game.addPlayerChipsToPot({
            userId: directive.userId,
            amount: directive.amount,
            allowPartial: directive.allowPartial === true,
            label: directive.reason ?? "人物技能费用",
          });
          mutated = true;
          break;
        case HEXTECH_CHARACTER_DIRECTIVES.REQUEST_HOLE_CARD_CANDIDATES: {
          const deck = room.game.exportState().deck;
          const candidateCardIds = deck.slice(-directive.count).reverse();
          if (candidateCardIds.length !== directive.count) throw new Error("牌堆候选底牌不足");
          const outcome = room.hextech.characters.command({
            type: HEXTECH_CHARACTER_COMMANDS.INTERNAL_SUPPLY_CANDIDATES,
            commandId: `supply:${directive.directiveId}`,
            handNumber: room.handNumber,
            windowId: directive.windowId,
            candidateCardIds,
            trusted: true,
            now: Date.now(),
          });
          queue.push(...outcome.directives);
          mutated = true;
          break;
        }
        case HEXTECH_CHARACTER_DIRECTIVES.REQUEST_BOARD_CANDIDATES: {
          const candidateCardIds = room.game.nextCommunityCandidates({
            street: directive.street,
            count: directive.count,
            suit: directive.suit ?? null,
          });
          const outcome = room.hextech.characters.command({
            type: HEXTECH_CHARACTER_COMMANDS.INTERNAL_SUPPLY_CANDIDATES,
            commandId: `supply:${directive.directiveId}`,
            handNumber: room.handNumber,
            windowId: directive.windowId,
            candidateCardIds,
            trusted: true,
            now: Date.now(),
          });
          queue.push(...outcome.directives);
          mutated = true;
          break;
        }
        case HEXTECH_CHARACTER_DIRECTIVES.DEAL_SELECTED_BOARD_CARD:
          room.game.queueBoardCard({
            street: directive.street,
            card: directive.cardId,
            label: "人物候选牌",
          });
          mutated = true;
          break;
        case HEXTECH_CHARACTER_DIRECTIVES.REPLACE_UPCOMING_RIVER:
          room.game.armRiverReplacementFromDeck({ label: "鸭哥·逆流换河" });
          mutated = true;
          break;
        case HEXTECH_CHARACTER_DIRECTIVES.REPLACE_HOLE_CARD:
          room.game.replaceHoleCardFromDeck({
            userId: directive.userId,
            cardIndex: directive.holeCardIndex,
            label: "奇玩·顶牌替换",
            source: "character:qiwan",
          });
          mutated = true;
          break;
        case HEXTECH_CHARACTER_DIRECTIVES.DEAL_NEXT_SUIT_CARD: {
          const card = room.game.nextCommunityCandidates({
            street: directive.street,
            count: 1,
            suit: directive.suit,
          })[0];
          room.game.queueBoardCard({ street: directive.street, card, label: "毛哥·花色蛊惑" });
          mutated = true;
          break;
        }
        case HEXTECH_CHARACTER_DIRECTIVES.REVEAL_NATURAL_BOARD_CARD: {
          const naturalCardId = room.game.peekNextCommunityCard({ street: directive.street });
          const naturalSuit = suitName[naturalCardId.at(-1)];
          if (!naturalSuit) throw new Error("自然公共牌花色不正确");
          const outcome = room.hextech.characters.command({
            type: HEXTECH_CHARACTER_COMMANDS.INTERNAL_RESOLVE_MAO_CHALLENGE,
            commandId: `resolve:${directive.directiveId}`,
            handNumber: room.handNumber,
            windowId: directive.windowId,
            naturalCardId,
            naturalSuit,
            trusted: true,
            now: Date.now(),
          });
          queue.push(...outcome.directives);
          mutated = true;
          break;
        }
        default:
          throw new Error(`未知人物结算指令：${directive.type}`);
      }
      room.hextech.appliedCharacterDirectiveIds.push(directive.directiveId);
      room.hextech.appliedCharacterDirectiveIds = room.hextech.appliedCharacterDirectiveIds.slice(-512);
    }
    if (room.game.stage === "finished") {
      for (const gamePlayer of room.game.players) {
        const member = room.members.get(gamePlayer.userId);
        if (member) member.stack = gamePlayer.stack;
      }
    }
    this.#attachHextechEffects(room);
    this.#syncHextechCharacterPause(room);
    return mutated;
  }

  hextechCharacterCommand(socket, payload = {}) {
    payload = authorizePayload(payload, [
      "type",
      "commandId",
      "targetUserId",
      "targetUserIds",
      "windowId",
      "cardId",
      "discardCardId",
      "holeCardIndex",
      "borrowerUserId",
      "principal",
      "loanId",
      "accept",
      "amount",
      "suit",
      "useAwakening",
    ]);
    if (typeof payload.type !== "string"
      || typeof payload.commandId !== "string"
      || payload.commandId.length < 1
      || payload.commandId.length > 128) {
      throw new SecurityError("人物操作已过期，请以当前牌桌状态为准", "invalid_hextech_character_command");
    }
    if (payload.commandId.startsWith("supply:") || payload.commandId.startsWith("resolve:")) {
      throw new SecurityError("人物操作标识使用了服务端保留前缀", "reserved_hextech_character_command_id");
    }
    const clientCommands = new Set(Object.values(HEXTECH_CHARACTER_COMMANDS).filter((type) => !type.startsWith("internal:")));
    if (!clientCommands.has(payload.type)) {
      throw new SecurityError("未知人物操作", "unknown_hextech_character_command");
    }
    for (const value of [payload.targetUserId, payload.borrowerUserId]) {
      if (value != null && (typeof value !== "string" || value.length > 80)) {
        throw new SecurityError("人物目标格式不正确", "invalid_hextech_character_target");
      }
    }
    if (payload.targetUserIds != null && (!Array.isArray(payload.targetUserIds)
      || payload.targetUserIds.length < 1
      || payload.targetUserIds.length > 2
      || payload.targetUserIds.some((value) => typeof value !== "string" || value.length > 80))) {
      throw new SecurityError("人物目标列表不正确", "invalid_hextech_character_targets");
    }
    if (payload.holeCardIndex != null && ![0, 1].includes(payload.holeCardIndex)) {
      throw new SecurityError("底牌位置不正确", "invalid_hextech_hole_card");
    }
    if (payload.principal != null && ![200, 300, 400, 500, 600].includes(payload.principal)) {
      throw new SecurityError("贷款本金不正确", "invalid_hextech_loan_principal");
    }
    if (payload.amount != null && (!Number.isSafeInteger(payload.amount) || payload.amount <= 0)) {
      throw new SecurityError("还款金额不正确", "invalid_hextech_loan_payment");
    }
    const room = this.#roomFor(socket);
    if (!isHextechMode(room.mode) || !room.hextech?.characters || !room.game) {
      throw new Error("当前没有可操作的人物状态");
    }
    if (room.hextech.matchEnd) throw new Error("本场已经结束");
    const member = room.members.get(socket.data.user.id);
    if (!member || !room.hextech.participantUserIds.includes(member.userId)) {
      throw new SecurityError("非参赛者不能执行人物操作", "spectator_hextech_character");
    }
    const loanCommands = new Set([
      HEXTECH_CHARACTER_COMMANDS.ZIGE_OFFER_LOAN,
      HEXTECH_CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN,
      HEXTECH_CHARACTER_COMMANDS.ZIGE_REPAY_LOAN,
    ]);
    if (loanCommands.has(payload.type)) {
      if (room.hextech.phase !== "hand-result" || room.game.stage !== "finished") {
        throw new Error("贷款只能在两手之间处理");
      }
    } else if (room.hextech.phase !== "playing" || room.game.stage === "finished") {
      throw new Error("当前不是人物主动技能的合法窗口");
    }
    if (loanCommands.has(payload.type) && (member.role !== "player" || member.seat == null)) {
      throw new SecurityError("离场玩家不能继续贷款操作", "spectator_hextech_loan");
    }
    if (!loanCommands.has(payload.type) && this.#hextechReactionActive(room)) {
      throw new Error("请先处理当前公共技能反应窗口");
    }
    const allInOpportunity = room.hextech.characterOpportunity;
    const allInActivationCommands = new Set([
      HEXTECH_CHARACTER_COMMANDS.YA_ACTIVATE,
      HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE,
    ]);
    const replayingProcessedActivation = room.hextech.characters.exportState().processedIds
      .includes(`command:${payload.commandId}`);
    if (!loanCommands.has(payload.type)
      && allInActivationCommands.has(payload.type)
      && !allInOpportunity
      && !replayingProcessedActivation) {
      throw new Error("当前没有可用的全押人物技能机会");
    }
    if (!loanCommands.has(payload.type) && allInOpportunity) {
      if (Date.now() >= allInOpportunity.expiresAt) {
        this.#clearHextechAllInOpportunity(room);
        this.#syncFinished(room);
        this.#emitRoom(room);
        throw new Error("全押后人物技能选择时间已经结束");
      }
      const expectedCommand = allInOpportunity.characterId === "ya"
        ? HEXTECH_CHARACTER_COMMANDS.YA_ACTIVATE
        : HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE;
      if (allInOpportunity.userId !== member.userId || payload.type !== expectedCommand) {
        throw new Error("请先处理当前全押人物技能机会");
      }
    }
    const activeCharacterWindow = this.#activeHextechCharacterWindow(room);
    const continuationCommands = new Set([
      HEXTECH_CHARACTER_COMMANDS.YA_CHOOSE,
      HEXTECH_CHARACTER_COMMANDS.QIWAN_ARM_CHOICE,
      HEXTECH_CHARACTER_COMMANDS.QIWAN_COMMIT,
      HEXTECH_CHARACTER_COMMANDS.MAO_CHALLENGE,
      HEXTECH_CHARACTER_COMMANDS.MAO_CHOOSE,
    ]);
    if (!loanCommands.has(payload.type) && activeCharacterWindow) {
      if (!continuationCommands.has(payload.type)
        || payload.windowId !== activeCharacterWindow.window.windowId) {
        throw new Error("请先处理当前人物交互窗口");
      }
    }
    const gamePlayer = room.game.playerSnapshot(member.userId);
    if (!loanCommands.has(payload.type) && (!gamePlayer || gamePlayer.folded)) {
      throw new Error("你当前不在本手可操作玩家中");
    }
    const targetUserIds = payload.targetUserIds ?? [payload.targetUserId].filter(Boolean);
    for (const targetUserId of targetUserIds) {
      const target = room.game.playerSnapshot(targetUserId);
      if (!target || target.folded || target.userId === member.userId) throw new Error("人物技能目标当前不可用");
    }
    const common = {
      type: payload.type,
      commandId: payload.commandId,
      userId: member.userId,
      handNumber: room.handNumber,
      now: Date.now(),
    };
    let command;
    let wengViewRequest = null;
    switch (payload.type) {
      case HEXTECH_CHARACTER_COMMANDS.FENXIANG_ACTIVATE:
        command = common;
        break;
      case HEXTECH_CHARACTER_COMMANDS.XU_BARBECUE:
        command = { ...common, street: room.game.stage };
        break;
      case HEXTECH_CHARACTER_COMMANDS.JIANSHENG_PRESSURE:
        if (!gamePlayer || targetUserIds.length === 0) throw new Error("请选择剑压目标");
        command = {
          ...common,
          targetUserIds,
          casterStreetCommitted: gamePlayer.bet,
        };
        break;
      case HEXTECH_CHARACTER_COMMANDS.YA_ACTIVATE:
        if (!gamePlayer) throw new Error("鸭哥当前不在本手中");
        command = {
          ...common,
          street: room.game.stage,
          casterAllIn: gamePlayer.allIn,
          riverDealt: room.game.community.length >= 5
            || Boolean(room.game.exportState().queuedBoardCards?.river),
        };
        break;
      case HEXTECH_CHARACTER_COMMANDS.YA_CHOOSE:
        command = {
          ...common,
          windowId: payload.windowId,
          cardId: payload.cardId,
          discardCardId: payload.discardCardId,
        };
        break;
      case HEXTECH_CHARACTER_COMMANDS.QIWAN_ACTIVATE:
        if (!gamePlayer) throw new Error("奇玩当前不在本手中");
        command = {
          ...common,
          street: room.game.stage,
          casterAllIn: gamePlayer.allIn,
          flopDealt: room.game.community.length > 0,
          holeCardIndex: payload.holeCardIndex,
        };
        break;
      case HEXTECH_CHARACTER_COMMANDS.QIWAN_ARM_CHOICE:
        command = { ...common, windowId: payload.windowId, cardId: payload.cardId };
        break;
      case HEXTECH_CHARACTER_COMMANDS.QIWAN_COMMIT:
        command = { ...common, windowId: payload.windowId, holeCardIndex: payload.holeCardIndex };
        break;
      case HEXTECH_CHARACTER_COMMANDS.ZIGE_OFFER_LOAN:
        if (!payload.borrowerUserId || !room.hextech.participantUserIds.includes(payload.borrowerUserId)) {
          throw new Error("请选择在场借款人");
        }
        if (room.members.get(payload.borrowerUserId)?.role !== "player"
          || room.members.get(payload.borrowerUserId)?.seat == null) {
          throw new Error("借款人已经离场");
        }
        command = {
          ...common,
          borrowerUserId: payload.borrowerUserId,
          principal: payload.principal,
          lenderAvailableStack: this.#hextechStackFor(room, member.userId),
        };
        break;
      case HEXTECH_CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN: {
        const loanView = room.hextech.characters.viewFor(member.userId).loans
          .find((loan) => loan.loanId === payload.loanId);
        if (!loanView) throw new Error("贷款邀请不存在");
        if (loanView.borrowerUserId !== member.userId
          || room.members.get(loanView.lenderUserId)?.role !== "player"
          || room.members.get(loanView.lenderUserId)?.seat == null) {
          throw new Error("贷款双方当前不在场");
        }
        command = {
          ...common,
          loanId: payload.loanId,
          accept: payload.accept === true,
          lenderAvailableStack: this.#hextechStackFor(room, loanView.lenderUserId),
        };
        break;
      }
      case HEXTECH_CHARACTER_COMMANDS.ZIGE_REPAY_LOAN:
        command = {
          ...common,
          loanId: payload.loanId,
          amount: payload.amount,
          borrowerAvailableStack: this.#hextechStackFor(room, member.userId),
        };
        break;
      case HEXTECH_CHARACTER_COMMANDS.MAO_CLAIM: {
        const street = { flop: "turn", turn: "river" }[room.game.stage];
        if (!street) throw new Error("毛哥只能在转牌或河牌发出前宣称");
        const gameState = room.game.exportState();
        if (gameState.queuedBoardCards?.[street]
          || (street === "river" && gameState.riverReplacementArmed)) {
          throw new Error("该街公共牌已经被其他人物技能锁定");
        }
        command = {
          ...common,
          street,
          suit: payload.suit,
          useAwakening: payload.useAwakening === true,
        };
        break;
      }
      case HEXTECH_CHARACTER_COMMANDS.MAO_CHALLENGE:
        command = { ...common, windowId: payload.windowId };
        break;
      case HEXTECH_CHARACTER_COMMANDS.MAO_CHOOSE:
        command = { ...common, windowId: payload.windowId, cardId: payload.cardId };
        break;
      case HEXTECH_CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE: {
        if (!gamePlayer || room.game.currentPlayer?.userId !== member.userId) {
          throw new Error("月蚀追猎只能在自己行动前发动");
        }
        const characterPlayer = room.hextech.characters.exportState().players?.[member.userId];
        const latest = characterPlayer?.hand?.wengLatestAggressor;
        if (!latest?.userId || latest.street !== room.game.stage) {
          throw new Error("本街尚无符合条件的主动进攻者");
        }
        const target = room.game.playerSnapshot(latest.userId);
        if (!target || target.folded || target.userId === member.userId || target.hand?.length !== 2) {
          throw new Error("月蚀追猎目标当前不可用");
        }
        const toCall = Math.max(0, room.game.currentBet - gamePlayer.bet);
        if (toCall <= 0) throw new Error("当前没有需要回应的主动进攻");
        command = {
          ...common,
          street: room.game.stage,
          isOwnAction: true,
          toCall,
          targetUserId: target.userId,
        };
        wengViewRequest = {
          viewerUserId: member.userId,
          targetUserId: target.userId,
          cards: target.hand,
        };
        break;
      }
      default:
        throw new SecurityError("人物命令不能从客户端调用", "forbidden_hextech_character_command");
    }
    const outcome = this.#runHextechCharacterTransaction(room, () => {
      let authoritativeCommand = command;
      if (wengViewRequest) {
        const displayed = room.hextech.effects.externalHoleCardView(wengViewRequest);
        authoritativeCommand = {
          ...command,
          displayedCards: displayed.cards,
          masked: displayed.masked,
        };
      }
      const commandOutcome = room.hextech.characters.command(authoritativeCommand);
      this.#applyHextechCharacterDirectives(room, commandOutcome.directives);
      return commandOutcome;
    });
    if (allInOpportunity) this.#clearHextechAllInOpportunity(room);
    this.#syncFinished(room);
    if (room.hextech.phase === "hand-result") {
      this.#reconcileHextechBustedParticipants(room);
      this.#updateHextechMatchEnd(room, { allowTarget: false, allowHandCap: false });
    }
    this.#emitRoom(room);
    this.#scheduleBot(room);
    return { eventSeq: outcome.eventSeq, duplicate: outcome.duplicate };
  }

  hextechSkillCommand(socket, payload = {}) {
    payload = authorizePayload(payload, [
      "command",
      "commandId",
      "windowToken",
      "windowVersion",
      "targetUserId",
      "option",
      "choices",
      "choiceId",
      "value",
      "skillId",
      "windowId",
    ]);
    if (typeof payload.command !== "string"
      || typeof payload.commandId !== "string"
      || payload.commandId.length < 1
      || payload.commandId.length > 128
      || typeof payload.windowToken !== "string"
      || payload.windowToken.length < 1
      || payload.windowToken.length > 128
      || (payload.windowVersion != null && !Number.isSafeInteger(payload.windowVersion))) {
      throw new SecurityError("技能操作已过期，请以当前牌桌状态为准", "invalid_hextech_skill_command");
    }
    if (payload.targetUserId != null
      && (typeof payload.targetUserId !== "string" || payload.targetUserId.length > 80)) {
      throw new SecurityError("技能目标格式不正确", "invalid_hextech_skill_target");
    }
    if (payload.choices != null
      && (!payload.choices || Array.isArray(payload.choices) || typeof payload.choices !== "object"
        || Object.keys(payload.choices).length > 8)) {
      throw new SecurityError("技能选择格式不正确", "invalid_hextech_skill_choices");
    }
    const room = this.#roomFor(socket);
    if (!isHextechMode(room.mode) || room.hextech?.phase !== "playing" || !room.hextech.effects) {
      throw new Error("当前没有可操作的海克斯技能窗口");
    }
    if (!room.game || room.game.stage === "finished") throw new Error("本手已经结束");
    const member = room.members.get(socket.data.user.id);
    if (!member || member.role !== "player" || !room.game.players.some(({ userId }) => userId === member.userId)) {
      throw new SecurityError("观战者不能发动技能", "spectator_hextech_skill");
    }
    const reactionBefore = room.hextech.effects.exportState().hand?.activeReaction ?? null;
    const handlesActiveReaction = reactionBefore?.targetUserId === member.userId
      && ["react", "confirm", "cancel"].includes(payload.command);
    if (this.#activeHextechCharacterWindow(room)
      || (room.hextech.characterOpportunity && !handlesActiveReaction)) {
      throw new Error("请先处理当前人物交互窗口");
    }
    const commandMap = {
      arm: "activate",
      target: "select-target",
      confirm: "confirm",
      cancel: "cancel",
      react: "react",
    };
    let engineCommand = commandMap[payload.command];
    if (!engineCommand) {
      if (payload.command === "choice") throw new Error("当前装备不需要额外选项");
      throw new SecurityError("未知技能操作", "unknown_hextech_skill_command");
    }
    const effectView = room.hextech.effects.viewFor(member.userId, room.game);
    if (engineCommand === "confirm" && effectView.activeReaction?.targetUserId === member.userId) {
      engineCommand = "confirm-reaction";
    }
    const outcome = this.#runHextechEffectTransaction(room, () => {
      const commandOutcome = room.hextech.effects.command({
        actorId: member.userId,
        command: engineCommand,
        payload: {
          commandId: payload.commandId,
          windowToken: payload.windowToken,
          windowVersion: payload.windowVersion,
          targetUserId: payload.targetUserId,
          option: payload.option ?? (engineCommand === "react" ? "escape" : undefined),
          choices: payload.choices,
        },
        game: room.game,
      });
      this.#applyHextechDirectives(room, commandOutcome.directives);
      return commandOutcome;
    });
    if (reactionBefore && !this.#hextechReactionActive(room)) {
      // A public-skill reaction has priority over the post-all-in character
      // choice. Once the reaction is fully resolved, restore the owner's full
      // six-second decision window instead of charging them for reaction time.
      this.#refreshHextechAllInOpportunity(room);
    }
    this.#syncFinished(room);
    this.#emitRoom(room);
    this.#scheduleBot(room);
    return { eventSeq: outcome.eventSeq, result: outcome.result, replayed: outcome.replayed };
  }

  addBot(socket, payload = {}) {
    authorizePayload(payload, []);
    const room = this.#roomFor(socket);
    this.#assertHost(socket, room);
    this.#assertSettlementOpen(room);
    if (room.game && room.game.stage !== "finished") throw new Error("牌局进行中不能添加测试玩家");
    if (isHextechMode(room.mode) && room.handNumber > 0) throw new Error("海克斯开局后不能添加新的参赛玩家");
    const playerCount = [...room.members.values()].filter((member) => member.role === "player").length;
    if (playerCount >= room.settings.maxPlayers) throw new Error("玩家席位已满");
    const seat = firstOpenSeat(room);
    const botNumber = [...room.members.values()].filter((member) => member.isBot).length + 1;
    const bot = {
      userId: `bot-${crypto.randomUUID()}`,
      username: `测试玩家 ${botNumber}`,
      accountName: null,
      avatarTone: "sage",
      title: "测试玩家",
      displayedAchievements: [],
      isBot: true,
      role: "player",
      seat,
      stack: room.settings.initialChips,
      ready: true,
      connected: true,
      socketIds: new Set(),
      rebuyCount: 0,
      pendingRebuy: 0,
      rebuyDeadline: null,
      seatRequest: false,
      requestedSeat: null,
      spectatorFocusUserId: null,
      spectatorCardAccess: null,
      everSeated: true,
      characterId: null,
      equippedSkillId: null,
      hextechRefreshesRemaining: HEXTECH_MODE.freeRefreshes,
    };
    if (isHextechMode(room.mode)) {
      const occupied = new Set([...room.members.values()].map((member) => member.characterId).filter(Boolean));
      bot.characterId = HEXTECH_CHARACTERS.find(({ id }) => !occupied.has(id))?.id ?? null;
    }
    room.members.set(bot.userId, bot);
    this.#recordBuyIn(room, bot, room.settings.initialChips);
    this.#emitRoom(room);
    return {};
  }

  removeBot(socket, payload = {}) {
    payload = authorizePayload(payload, ["userId"]);
    if (typeof payload.userId !== "string" || payload.userId.length > 80) throw new Error("玩家标识格式不正确");
    const room = this.#roomFor(socket);
    this.#assertHost(socket, room);
    this.#assertSettlementOpen(room);
    if (room.game && room.game.stage !== "finished") throw new Error("牌局进行中不能移除测试玩家");
    if (isHextechMode(room.mode) && room.handNumber > 0) throw new Error("海克斯开局后不能移除参赛玩家");
    const bot = room.members.get(payload.userId);
    if (!bot?.isBot) throw new Error("没有找到该测试玩家");
    this.#cashOutMember(room, bot, "exit");
    room.members.delete(bot.userId);
    this.#emitRoom(room);
    return {};
  }

  kickMember(socket, payload = {}) {
    payload = authorizePayload(payload, ["userId"]);
    if (typeof payload.userId !== "string" || payload.userId.length > 80) throw new Error("玩家标识格式不正确");
    const room = this.#roomFor(socket);
    this.#assertHost(socket, room);
    this.#assertSettlementOpen(room);
    if (payload.userId === socket.data.user.id) throw new Error("房主不能将自己踢出房间");
    const member = room.members.get(payload.userId);
    if (!member || member.isBot) throw new Error("没有找到可踢出的玩家");
    if (isHextechMode(room.mode)
      && room.handNumber > 0
      && !room.hextech?.matchEnd
      && room.hextech?.participantUserIds.includes(member.userId)) {
      throw new Error("海克斯本场进行中不能移除锁定参赛者");
    }
    const activeParticipant = room.game?.stage !== "finished"
      && room.game?.players.some((player) => player.userId === member.userId);
    if (activeParticipant) throw new Error("牌局进行中不能踢出参局玩家，请在本局结束后操作");

    if (room.settlement.status === "open") this.#cashOutMember(room, member, "exit");
    for (const socketId of member.socketIds) {
      this.io.to(socketId).emit("room:kicked", {
        roomCode: room.code,
        message: `你已被房主移出房间 ${room.code}`,
      });
      this.io.sockets?.sockets?.get?.(socketId)?.leave(`room:${room.code}`);
    }
    room.members.delete(member.userId);
    this.userRooms.delete(member.userId);
    this.#addChat(room, "系统", `${member.username} 已被房主移出房间`, true);
    this.#emitRoom(room);
    this.io.emit("lobby:update", this.listRooms());
    return {};
  }

  transferHost(socket, payload = {}) {
    payload = authorizePayload(payload, ["userId"]);
    if (typeof payload.userId !== "string" || payload.userId.length > 80) throw new Error("玩家标识格式不正确");
    const room = this.#roomFor(socket);
    this.#assertHost(socket, room);
    this.#assertSettlementOpen(room);
    if (payload.userId === socket.data.user.id) throw new Error("你已经是房主");
    const target = room.members.get(payload.userId);
    if (!target || target.isBot || target.role !== "player") throw new Error("只能将房主转让给其他入座玩家");
    if (!target.connected) throw new Error("该玩家当前已断线，不能接任房主");
    room.hostUserId = target.userId;
    this.#addChat(room, "系统", `${target.username} 已成为新房主`, true);
    for (const socketId of target.socketIds) {
      this.io.to(socketId).emit("room:host-transferred", {
        roomCode: room.code,
        message: "房主已转让给你",
      });
    }
    this.#emitRoom(room);
    return {};
  }

  requestSeat(socket, payload = {}) {
    payload = authorizePayload(payload, ["seat"]);
    if (payload.seat != null && !Number.isSafeInteger(payload.seat)) throw new Error("座位编号格式不正确");
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    const member = room.members.get(socket.data.user.id);
    if (member.role !== "spectator") throw new Error("你已经在玩家席");
    if (isHextechMode(room.mode) && room.handNumber > 0
      && !room.hextech.participantUserIds.includes(member.userId)) {
      throw new Error("海克斯开局后不能加入新的参赛玩家");
    }
    const playerCount = [...room.members.values()].filter((candidate) => candidate.role === "player").length;
    if (playerCount >= room.settings.maxPlayers) throw new Error("当前没有空位");
    if (member.everSeated && member.stack <= 0 && member.pendingRebuy <= 0) {
      throw new Error("请先补充筹码，再申请下一局入座");
    }
    const requestedSeat = payload.seat == null ? firstOpenSeat(room) : payload.seat;
    if (!seatIsOpen(room, requestedSeat)) throw new Error("所选座位已被占用，请重新选择");
    member.seatRequest = true;
    member.requestedSeat = requestedSeat;
    this.#emitRoom(room);
    return {};
  }

  approveSeat(socket, payload = {}) {
    payload = authorizePayload(payload, ["userId"]);
    if (typeof payload.userId !== "string" || payload.userId.length > 80) throw new Error("玩家标识格式不正确");
    const room = this.#roomFor(socket);
    this.#assertHost(socket, room);
    this.#assertSettlementOpen(room);
    if (room.game && room.game.stage !== "finished") throw new Error("只能在两局之间安排座位");
    const member = room.members.get(payload.userId);
    if (!member || member.role !== "spectator" || !member.seatRequest) throw new Error("没有找到该入座申请");
    if (isHextechMode(room.mode) && room.handNumber > 0
      && !room.hextech.participantUserIds.includes(member.userId)) {
      throw new Error("海克斯开局后不能批准新的参赛玩家");
    }
    const seat = seatIsOpen(room, member.requestedSeat) ? member.requestedSeat : firstOpenSeat(room);
    if (seat == null) throw new Error("当前没有空位");
    member.role = "player";
    member.seat = seat;
    member.spectatorFocusUserId = null;
    member.seatRequest = false;
    member.requestedSeat = null;
    member.ready = false;
    if (!member.everSeated) {
      member.stack = room.settings.initialChips;
      member.everSeated = true;
      this.#recordBuyIn(room, member, room.settings.initialChips);
    }
    this.#emitRoom(room);
    return {};
  }

  #recordHextechCharacterPokerAction(room, {
    actorId,
    action,
    before,
    automatic = false,
    throwOnError = false,
  }) {
    if (!room.hextech?.characters || !before || !room.game) return false;
    try {
      return this.#runHextechCharacterTransaction(room, () => {
        const after = room.game.exportState();
      const beforePlayer = before.players.find((player) => player.userId === actorId);
      const afterPlayer = after.players.find((player) => player.userId === actorId);
      if (!beforePlayer || !afterPlayer || !["preflop", "flop", "turn", "river"].includes(before.stage)) return false;
      const contribution = Math.max(0, afterPlayer.totalCommitted - beforePlayer.totalCommitted);
      const normalizedAction = action === "allin" ? "all-in" : action;
      const raiseTo = beforePlayer.bet + contribution;
      const isRaise = ["raise", "bet"].includes(normalizedAction)
        || (normalizedAction === "all-in" && raiseTo > before.currentBet);
      const calledRaiseUserId = before.stage === "preflop" && normalizedAction === "call"
        ? room.hextech.characterActionEffects.preflopAggressorUserId
        : null;
      const outcome = room.hextech.characters.afterPokerAction({
        eventId: `action:${room.game.handId}:${before.stateVersion}:${after.stateVersion}`,
        handNumber: room.handNumber,
        userId: actorId,
        action: normalizedAction,
        street: before.stage,
        amount: contribution,
        delta: contribution,
        callAmount: normalizedAction === "call" ? contribution : 0,
        bigBlind: room.game.settings.bigBlind,
        secondsRemaining: Number.isFinite(before.turnRemainingMs) ? before.turnRemainingMs / 1000 : null,
        automatic,
        activePlayerCount: before.players.filter((player) => !player.folded).length,
        isRaise,
        isAllInAfter: afterPlayer.allIn,
        raiseTo,
        totalCommitted: afterPlayer.totalCommitted,
        stackAfter: afterPlayer.stack,
        calledRaiseUserId,
        toCallBefore: Math.max(0, before.currentBet - beforePlayer.bet),
        isFullRaise: isRaise && raiseTo >= before.currentBet + before.minRaise,
      });
      this.#applyHextechCharacterDirectives(room, outcome.directives);

      if (before.stage === "preflop" && isRaise) {
        room.hextech.characterActionEffects.preflopAggressorUserId = actorId;
      }
      // 剑压只约束目标的下一次操作；目标完成该次操作后立即消费。
      room.hextech.characterActionEffects.raiseCaps = room.hextech.characterActionEffects.raiseCaps
        .filter((entry) => entry.targetUserId !== actorId);

      const streetOrder = ["preflop", "flop", "turn", "river"];
      const dealtCount = after.community.length;
      const reachedStreetIndex = dealtCount >= 5 ? 3 : dealtCount >= 4 ? 2 : dealtCount >= 3 ? 1 : 0;
      const startIndex = streetOrder.indexOf(before.stage);
      for (let index = startIndex; index < reachedStreetIndex; index += 1) {
        const street = streetOrder[index];
        const nextStreet = streetOrder[index + 1];
        const streetOutcome = room.hextech.characters.afterStreet({
          eventId: `street:${room.game.handId}:${street}:${nextStreet}`,
          handNumber: room.handNumber,
          street,
          nextStreet,
          players: after.players.map((player) => ({
            userId: player.userId,
            folded: player.folded,
            allIn: player.allIn,
          })),
        });
        this.#applyHextechCharacterDirectives(room, streetOutcome.directives);
      }
      const currentStreet = ["preflop", "flop", "turn", "river"].includes(after.stage) ? after.stage : null;
      room.hextech.characterActionEffects.raiseCaps = currentStreet
        ? room.hextech.characterActionEffects.raiseCaps.filter((entry) => entry.street === currentStreet)
        : [];
      room.hextech.characterActionEffects.clockModifiers = currentStreet
        ? room.hextech.characterActionEffects.clockModifiers.filter((entry) => (
          streetOrder.indexOf(entry.street) >= streetOrder.indexOf(currentStreet)
        ))
        : [];
        this.#attachHextechEffects(room);
        return outcome.stateChanged;
      });
    } catch (error) {
      if (throwOnError) throw error;
      this.audit("hextech_character_action_hook_failed", {
        roomCode: room.code,
        handId: room.game?.handId,
        actorId,
        message: error.message,
      });
      this.#syncHextechCharacterPause(room);
      return false;
    }
  }

  #logPokerAction(room) {
    const entry = room.game?.latestAnalysisAction?.();
    if (!entry) return;
    this.logger?.info?.("action", "poker_action_recorded", {
      roomCode: room.code,
      handId: room.game.handId,
      handNumber: room.handNumber,
      roomMode: room.mode,
      userId: entry.userId,
      actionSequence: entry.sequence,
      street: entry.street,
      action: entry.action,
      source: entry.source,
      automatic: entry.automatic,
      seat: entry.seat,
      buttonSeat: entry.buttonSeat,
      potBefore: entry.potBefore,
      potAfter: entry.potAfter,
      currentBetBefore: entry.currentBetBefore,
      toCallBefore: entry.toCallBefore,
      effectiveStackBefore: entry.effectiveStackBefore,
      stackBefore: entry.stackBefore,
      stackAfter: entry.stackAfter,
      amountCommitted: entry.amountCommitted,
      raiseTo: entry.raiseTo,
      isAggressive: entry.isAggressive,
      isFullRaise: entry.isFullRaise,
      allInKind: entry.allInKind,
      activePlayerCountBefore: entry.activePlayerCountBefore,
      secondsRemainingBefore: entry.secondsRemainingBefore,
    });
  }

  gameAction(socket, payload = {}) {
    payload = authorizePayload(
      payload,
      ["action", "amount", "handId", "actionToken"],
      "客户端无权提交或修改牌局状态",
    );
    if (!["fold", "check", "call", "raise", "allin"].includes(payload.action)) {
      throw new SecurityError("未知操作", "invalid_game_action");
    }
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    if (!room.game) throw new Error("牌局尚未开始");
    if (isHextechMode(room.mode) && room.hextech?.phase === "skill-draft") {
      throw new SecurityError("请先完成本手技能装备", "hextech_draft_active");
    }
    if (isHextechMode(room.mode) && this.#hextechReactionActive(room)) {
      throw new SecurityError("请等待限时技能反应完成", "hextech_reaction_active");
    }
    if (isHextechMode(room.mode) && this.#hextechCharacterWindowActive(room)) {
      throw new SecurityError("请先完成人物技能选择", "hextech_character_window_active");
    }
    if (typeof payload.handId !== "string" || typeof payload.actionToken !== "string") {
      throw new SecurityError("操作已过期，请以当前牌桌状态为准", "missing_action_token");
    }
    if (payload.action === "raise"
      && (!Number.isSafeInteger(payload.amount)
        || !isStandardChipAmount(payload.amount, { allowZero: false }))) {
      throw new SecurityError(`加注金额必须是 ${CHIP_UNIT} 的倍数`, "invalid_raise_amount");
    }
    if (payload.action !== "raise" && payload.amount != null) {
      throw new SecurityError("该操作不能携带筹码金额", "forbidden_action_amount");
    }
    const member = room.members.get(socket.data.user.id);
    if (!member || member.role !== "player") throw new SecurityError("观战者不能操作牌局", "spectator_game_action");
    if (!Number.isFinite(room.game.turnDeadline) || Date.now() >= room.game.turnDeadline) {
      throw new SecurityError("本回合行动时间已经结束", "expired_game_action");
    }
    const before = isHextechMode(room.mode) && (room.hextech?.effects || room.hextech?.characters)
      ? room.game.exportState()
      : null;
    const opportunityStarted = isHextechMode(room.mode)
      ? this.#beginHextechAllInOpportunity(
        room,
        member.userId,
        payload.action,
        payload.amount,
      )
      : false;
    try {
      room.game.submitAction({
        userId: socket.data.user.id,
        action: payload.action,
        amount: payload.amount,
        handId: payload.handId,
        actionToken: payload.actionToken,
        pauseForHextechWindow: opportunityStarted,
      });
    } catch (error) {
      if (opportunityStarted) this.#clearHextechAllInOpportunity(room);
      throw error;
    }
    this.#logPokerAction(room);
    if (opportunityStarted && !room.game.playerSnapshot(member.userId)?.allIn) {
      this.#clearHextechAllInOpportunity(room);
    }
    if (before && room.hextech.characters) {
      this.#recordHextechCharacterPokerAction(room, {
        actorId: member.userId,
        action: payload.action,
        before,
      });
    }
    if (before && room.hextech.effects?.exportState?.().hand) {
      this.#runHextechEffectTransaction(room, () => {
        const outcome = room.hextech.effects.afterPokerAction({
          actorId: member.userId,
          action: payload.action,
          amount: payload.amount,
          before,
          game: room.game,
        });
        this.#applyHextechDirectives(room, outcome.directives);
        return outcome;
      });
    }
    this.#syncFinished(room);
    this.#emitRoom(room);
    this.#scheduleBot(room);
    return {};
  }

  chooseFoldReveal(socket, payload = {}) {
    payload = authorizePayload(
      payload,
      ["reveal", "handId"],
      "客户端无权提交或修改亮牌状态",
    );
    if (typeof payload.reveal !== "boolean" || typeof payload.handId !== "string") {
      throw new SecurityError("亮牌选择格式不正确", "invalid_fold_reveal");
    }
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    if (!room.game) throw new Error("牌局尚未开始");
    const member = room.members.get(socket.data.user.id);
    if (!member || member.role !== "player") {
      throw new SecurityError("观战者不能提交亮牌选择", "spectator_fold_reveal");
    }
    room.game.chooseFoldReveal({
      userId: socket.data.user.id,
      reveal: payload.reveal,
      handId: payload.handId,
    });
    this.#emitRoom(room);
    return {};
  }

  watchPlayer(socket, payload = {}) {
    payload = authorizePayload(payload, ["userId"]);
    if (typeof payload.userId !== "string" || payload.userId.length > 80) {
      throw new Error("观战目标格式不正确");
    }
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    const member = room.members.get(socket.data.user.id);
    if (!room.game || room.game.stage === "finished") throw new Error("当前没有进行中的牌局");
    const selfGamePlayer = room.game.players.find((player) => player.userId === member?.userId);
    const canWatch = member?.role === "spectator"
      || (member?.role === "player" && selfGamePlayer?.folded);
    if (!canWatch) {
      throw new SecurityError("只有观战者或本局已弃牌的玩家可以切换观看视角", "player_watch_player");
    }
    const target = room.game.players.find((player) => player.userId === payload.userId);
    if (!target) throw new Error("没有找到该玩家");
    if (target.userId === room.game.spectatorMysteryUserId) {
      throw new SecurityError("本局神秘玩家的手牌不可观看", "mystery_hand_watch");
    }
    if (target.spectatorHidden
      && !hasSpectatorCardAccess(member, room.game.handId, target.userId)) {
      throw new SecurityError("该玩家已隐藏手牌，当前不可观看", "private_hand_watch");
    }
    if (target.folded) throw new Error("该玩家已经弃牌，请切换其他玩家");
    member.spectatorFocusUserId = target.userId;
    grantSpectatorCardAccess(member, room.game.handId, target.userId);
    if (isHextechMode(room.mode) && room.hextech?.effects?.exportState?.().hand) {
      room.hextech.effects.externalHoleCardView({
        viewerUserId: member.userId,
        targetUserId: target.userId,
        cards: target.hand,
      });
    }
    this.#emitRoom(room);
    return { room: this.#view(room, member.userId) };
  }

  setSpectatorVisibility(socket, payload = {}) {
    payload = authorizePayload(
      payload,
      ["hidden", "handId"],
      "客户端只能设置自己的观战手牌可见性",
    );
    if (typeof payload.hidden !== "boolean" || typeof payload.handId !== "string") {
      throw new SecurityError("手牌隐私设置格式不正确", "invalid_spectator_visibility");
    }
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    const member = room.members.get(socket.data.user.id);
    if (!member || member.role !== "player") {
      throw new SecurityError("观战者不能设置玩家手牌隐私", "spectator_visibility_change");
    }
    if (!room.game) throw new Error("牌局尚未开始");
    room.game.setSpectatorVisibility({
      userId: member.userId,
      hidden: payload.hidden,
      handId: payload.handId,
    });
    this.#emitRoom(room);
    return { room: this.#view(room, member.userId) };
  }

  buyTimeExtension(socket, payload = {}) {
    payload = authorizePayload(
      payload,
      ["handId", "actionToken"],
      "客户端无权提交或修改加时状态",
    );
    if (typeof payload.handId !== "string" || typeof payload.actionToken !== "string") {
      throw new SecurityError("操作已过期，请以当前牌桌状态为准", "missing_time_extension_token");
    }
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    if (isHextechMode(room.mode)) throw new Error("海克斯模式不提供经典加时卡");
    if (!room.game) throw new Error("牌局尚未开始");
    const member = room.members.get(socket.data.user.id);
    if (!member || member.role !== "player") {
      throw new SecurityError("观战者不能购买加时", "spectator_time_extension");
    }
    room.game.buyTimeExtension({
      userId: socket.data.user.id,
      handId: payload.handId,
      actionToken: payload.actionToken,
    });
    this.#emitRoom(room);
    return {};
  }

  rebuy(socket, payload = {}) {
    payload = authorizePayload(payload, ["accept"]);
    if (typeof payload.accept !== "boolean") throw new Error("补充筹码选择格式不正确");
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    if (isHextechMode(room.mode) && room.hextech?.matchEnd) throw new Error("本场海克斯对局已经结束");
    if (!room.game || room.game.stage !== "finished") throw new Error("只能在本局结束后处理筹码");
    const member = room.members.get(socket.data.user.id);
    if (!member || member.role !== "player") throw new Error("只有入座玩家可以补充筹码");
    if (isHextechMode(room.mode) && member.rebuyDeadline && Date.now() >= member.rebuyDeadline) {
      this.#moveBustedMemberToSpectator(room, member, `${member.username} 补筹选择超时，已转入观战席`);
      this.#updateHextechMatchEnd(room, { allowTarget: false, allowHandCap: false });
      this.#emitRoom(room);
      throw new Error("补筹选择时间已结束，你已转入观战席");
    }
    if (isHextechMode(room.mode) ? member.stack !== 0 : member.stack >= LOW_STACK_REBUY_THRESHOLD) {
      if (isHextechMode(room.mode)) throw new Error("海克斯模式只有筹码归零后才能补筹");
      throw new Error(`筹码低于 ${LOW_STACK_REBUY_THRESHOLD} 时才可以补充`);
    }
    if (payload.accept) {
      if (!room.settings.allowRebuy) throw new Error("本房间未开启补充筹码");
      if (member.rebuyCount >= room.settings.maxRebuys) throw new Error("本场补充筹码次数已用完");
      if (member.pendingRebuy > 0) throw new Error("补充筹码已经提交");
      const previousSeat = member.seat;
      member.pendingRebuy = room.settings.rebuyAmount;
      member.rebuyCount += 1;
      member.rebuyDeadline = null;
      this.#recordBuyIn(room, member, room.settings.rebuyAmount);
      if (member.stack <= 0) {
        if (isHextechMode(room.mode)) {
          member.ready = true;
          member.seatRequest = false;
          member.requestedSeat = null;
          this.#addChat(room, "系统", `${member.username} 已补充筹码并准备下一手`, true);
        } else {
          member.role = "spectator";
          member.seat = null;
          member.spectatorFocusUserId = null;
          member.ready = false;
          member.seatRequest = true;
          member.requestedSeat = seatIsOpen(room, previousSeat) ? previousSeat : firstOpenSeat(room);
          this.#addChat(room, "系统", `${member.username} 已补充筹码，进入下一局入座队列`, true);
        }
      } else {
        member.ready = true;
        member.seatRequest = false;
        member.requestedSeat = null;
        this.#addChat(room, "系统", `${member.username} 已补充筹码，将在下一局生效`, true);
      }
    } else {
      if (member.stack > 0) throw new Error("仍有筹码时可以直接继续下一局");
      member.pendingRebuy = 0;
      member.rebuyDeadline = null;
      this.#moveBustedMemberToSpectator(room, member, `${member.username} 转为观战`);
      if (isHextechMode(room.mode)) {
        this.#updateHextechMatchEnd(room, { allowTarget: false, allowHandCap: false });
      }
    }
    this.#emitRoom(room);
    return {};
  }

  confirmNextSeat(socket, payload = {}) {
    authorizePayload(payload, []);
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    if (!room.game || room.game.stage !== "finished") throw new Error("只能在两局之间确认座位");
    const member = room.members.get(socket.data.user.id);
    if (!member || member.role !== "spectator" || member.pendingRebuy <= 0 || !member.seatRequest) {
      throw new Error("当前没有待确认的补筹入座申请");
    }
    const seat = seatIsOpen(room, member.requestedSeat) ? member.requestedSeat : firstOpenSeat(room);
    if (seat == null) throw new Error("当前没有空位，可继续观战并等待下一局");
    member.role = "player";
    member.seat = seat;
    member.spectatorFocusUserId = null;
    member.ready = false;
    member.seatRequest = false;
    member.requestedSeat = null;
    this.#addChat(room, "系统", `${member.username} 已确认下一局入座`, true);
    this.#emitRoom(room);
    return {};
  }

  deferSeat(socket, payload = {}) {
    authorizePayload(payload, []);
    const room = this.#roomFor(socket);
    this.#assertSettlementOpen(room);
    const member = room.members.get(socket.data.user.id);
    if (!member || member.role !== "spectator" || member.pendingRebuy <= 0) {
      throw new Error("当前没有可暂缓的入座申请");
    }
    member.seatRequest = false;
    member.requestedSeat = null;
    this.#emitRoom(room);
    return {};
  }

  finalSettlement(socket, payload = {}) {
    authorizePayload(payload, []);
    const room = this.#roomFor(socket);
    this.#assertHost(socket, room);
    this.#assertSettlementOpen(room);
    if (isHextechMode(room.mode)) throw new Error("海克斯模式由动态目标或 15 手上限自动结算");
    if (room.game && room.game.stage !== "finished") throw new Error("请等待本局结束后再进行终局结算");
    if (room.handNumber <= 0) throw new Error("房间尚未完成任何牌局");
    this.#syncFinished(room);
    if (room.settlement.hasPracticeHands) {
      throw new Error("包含测试玩家的练习牌局不进入好友终局结算");
    }

    for (const member of room.members.values()) {
      this.#cashOutMember(room, member, "final");
      member.ready = false;
      member.seatRequest = false;
      member.requestedSeat = null;
    }
    room.settlement.status = "closed";
    room.settlement.closedAt = new Date().toISOString();
    room.settlement.closedBy = socket.data.user.id;
    room.lastHandCashOuts = [];
    this.#addChat(room, "系统", "房主已完成终局结算，系统已买回所有剩余筹码", true);
    this.audit("room_final_settlement", {
      roomCode: room.code,
      handNumber: room.handNumber,
      closedBy: socket.data.user.id,
    });
    this.#emitRoom(room);
    this.io.emit("lobby:update", this.listRooms());
    return { settlement: this.#settlementView(room, socket.data.user.id) };
  }

  sendChat(socket, payload = {}) {
    payload = authorizePayload(payload, ["text"]);
    if (typeof payload.text !== "string" || payload.text.length > 200) throw new Error("消息需要在 1–200 个字符内");
    const room = this.#roomFor(socket);
    const text = payload.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    if (!text) throw new Error("消息不能为空");
    this.#addChat(room, socket.data.user.displayName || socket.data.user.username, text, false, socket.data.user.id);
    this.#emitRoom(room);
    return {};
  }

  #addChat(room, username, text, system = false, userId = null) {
    room.chat.push({
      id: crypto.randomUUID(),
      userId,
      username,
      text,
      system,
      createdAt: new Date().toISOString(),
    });
    room.chat = room.chat.slice(-50);
  }

  #syncFinished(room) {
    if (!room.game || room.game.stage !== "finished" || room.gameSynced) return;
    if (isHextechMode(room.mode)) {
      const effectHand = room.hextech?.effects?.exportState?.().hand;
      if (effectHand?.handId === room.game.handId) {
        this.#runHextechEffectTransaction(room, () => {
          const effectOutcome = room.hextech.effects.finishHand({
            handId: room.game.handId,
            game: room.game,
            now: Date.now(),
          });
          this.#applyHextechDirectives(room, effectOutcome.directives);
          return effectOutcome;
        });
      }
      if (room.hextech?.characters) {
        this.#runHextechCharacterTransaction(room, () => {
          const settlementByUserId = new Map(
            room.game.settlementResults().map((result) => [result.userId, result]),
          );
          const characterOutcome = room.hextech.characters.settleHand({
            eventId: `settle:${room.game.handId}`,
            handNumber: room.handNumber,
            results: room.game.players.map((gamePlayer) => {
              const winner = room.game.winners.find((candidate) => candidate.userId === gamePlayer.userId);
              const settlement = settlementByUserId.get(gamePlayer.userId);
              return {
                userId: gamePlayer.userId,
                endingStack: gamePlayer.stack,
                wonPotAmount: winner?.amount ?? 0,
                opponentsBeaten: settlement?.opponentsBeaten ?? [],
                netWin: Math.max(0, (winner?.amount ?? 0) - gamePlayer.totalCommitted),
                reachedShowdown: room.game.finishedReason === "showdown" && !gamePlayer.folded,
                replacementUsedInFinalHand: settlement?.qiwanReplacementUsedInFinalHand === true,
              };
            }),
          });
          this.#applyHextechCharacterDirectives(room, characterOutcome.directives);
          return characterOutcome;
        });
      }
      room.game.setActionPolicy(null);
      room.game.setTurnTimePolicy?.(null);
    }
    const leaderboardEligible = !room.game.players.some((player) => player.isBot);
    this.store.addHandAnalysis?.(room.game.analysisRecord({
      roomCode: room.code,
      roomName: room.name,
      handNumber: room.handNumber,
      roomMode: room.mode,
      leaderboardEligible,
    }));
    room.gameSynced = true;
    const bustedHextechBots = [];
    const bustedHextechHumans = [];
    if (!leaderboardEligible) room.settlement.hasPracticeHands = true;
    for (const gamePlayer of room.game.players) {
      const member = room.members.get(gamePlayer.userId);
      if (!member) continue;
      member.stack = gamePlayer.stack;
      member.ready = gamePlayer.stack > 0;
      if (isHextechMode(room.mode) && member.isBot && member.stack === 0) bustedHextechBots.push(member);
      if (isHextechMode(room.mode) && !member.isBot && member.stack === 0) bustedHextechHumans.push(member);
      if (!member.isBot) {
        const winner = room.game.winners.find((candidate) => candidate.userId === member.userId);
        this.store.addHistory({
          userId: member.userId,
          roomCode: room.code,
          roomName: room.name,
          handNumber: room.handNumber,
          chipChange: gamePlayer.stack - gamePlayer.startingStack,
          result: winner ? "获胜" : "结束",
          detail: winner?.handName ?? room.game.finishedReason,
          leaderboardEligible,
          roomMode: room.mode,
        });
      }
    }
    if (isHextechMode(room.mode)) {
      this.#updateHextechMatchEnd(room, { allowLastPlayer: false });
      if (!room.hextech.matchEnd) {
        for (const member of bustedHextechBots) {
          if (member.rebuyCount < room.settings.maxRebuys) {
            member.pendingRebuy = room.settings.rebuyAmount;
            member.rebuyCount += 1;
            this.#recordBuyIn(room, member, room.settings.rebuyAmount);
            this.#addChat(
              room,
              "系统",
              `${member.username} 自动使用第 ${member.rebuyCount}/${room.settings.maxRebuys} 次补筹`,
              true,
            );
          } else {
            member.role = "spectator";
            member.seat = null;
            member.ready = false;
            member.rebuyDeadline = null;
            this.#addChat(room, "系统", `${member.username} 补筹次数已用完，转入观战席`, true);
          }
        }
        for (const member of bustedHextechHumans) {
          if (member.rebuyCount >= room.settings.maxRebuys) {
            this.#moveBustedMemberToSpectator(room, member, `${member.username} 补筹次数已用完，转入观战席`);
          } else {
            member.rebuyDeadline = Date.now() + HEXTECH_MODE.rebuyDecisionSeconds * 1000;
            this.#addChat(room, "系统", `${member.username} 有 ${HEXTECH_MODE.rebuyDecisionSeconds} 秒决定是否补筹`, true);
          }
        }
        this.#updateHextechMatchEnd(room);
      } else {
        for (const member of room.members.values()) member.rebuyDeadline = null;
      }
    } else this.#applyTableCap(room);
  }

  #moveBustedMemberToSpectator(room, member, message) {
    if (!member || member.stack !== 0 || member.pendingRebuy > 0) return false;
    member.role = "spectator";
    member.seat = null;
    member.spectatorFocusUserId = null;
    member.ready = false;
    member.seatRequest = false;
    member.requestedSeat = null;
    member.rebuyDeadline = null;
    this.#addChat(room, "系统", message, true);
    return true;
  }

  #updateHextechMatchEnd(room, {
    allowLastPlayer = true,
    allowTarget = true,
    allowHandCap = true,
  } = {}) {
    const assetByUserId = new Map(
      (room.hextech.characters?.viewFor?.(null)?.characters ?? [])
        .map((character) => [character.userId, character.netAssets]),
    );
    const standings = room.hextech.participantUserIds
      .map((userId) => room.members.get(userId))
      .filter(Boolean)
      .map((member) => ({
        userId: member.userId,
        username: member.username,
        characterId: member.characterId,
        chips: member.stack,
        netAssets: Number.isSafeInteger(assetByUserId.get(member.userId))
          ? assetByUserId.get(member.userId)
          : member.stack,
      }));
    const reachedTarget = allowTarget
      && standings.some(({ chips }) => chips >= room.hextech.targetChips);
    const reachedHandCap = allowHandCap && room.handNumber >= HEXTECH_MODE.maxHands;
    standings.sort((left, right) => (
      reachedHandCap
        ? right.netAssets - left.netAssets || right.chips - left.chips
        : right.chips - left.chips
    ) || left.username.localeCompare(right.username, "zh-CN"));
    const remainingPlayers = room.hextech.participantUserIds
      .map((userId) => room.members.get(userId))
      .filter((member) => member?.role === "player"
        && (member.stack > 0 || member.pendingRebuy > 0 || member.rebuyDeadline));
    const reachedLastPlayer = allowLastPlayer
      && room.handNumber > 0
      && remainingPlayers.length < HEXTECH_MODE.minPlayers;
    if (!reachedTarget && !reachedHandCap && !reachedLastPlayer) {
      room.hextech.phase = "hand-result";
      return;
    }
    room.hextech.phase = "finished";
    room.hextech.matchEnd = {
      reason: reachedTarget ? "target" : reachedHandCap ? "hand-cap" : "last-player",
      handNumber: room.handNumber,
      targetChips: room.hextech.targetChips,
      winnerUserId: reachedLastPlayer
        ? remainingPlayers[0]?.userId ?? standings[0]?.userId ?? null
        : standings[0]?.userId ?? null,
      standings,
    };
    for (const member of room.members.values()) member.ready = false;
    this.#addChat(
      room,
      "系统",
      reachedTarget
        ? `${standings[0]?.username ?? "领先玩家"} 达到 ${room.hextech.targetChips}，本场结束`
        : reachedHandCap
          ? `第 ${HEXTECH_MODE.maxHands} 手结束，按结算净资产排定名次`
          : `仅剩 ${remainingPlayers[0]?.username ?? "一名玩家"} 留场，本场结束`,
      true,
    );
  }

  #scheduleBot(room) {
    if (room.botTimer) clearTimeout(room.botTimer);
    if (isHextechMode(room.mode) && room.hextech?.phase !== "playing") return;
    if (isHextechMode(room.mode) && this.#hextechReactionActive(room)) return;
    if (isHextechMode(room.mode) && this.#hextechCharacterWindowActive(room)) return;
    if (!room.game || room.game.stage === "finished" || !room.game.currentPlayer?.isBot) return;
    const actorId = room.game.currentPlayer.userId;
    const dealWaitMs = Math.max(0, Number(room.game.dealCompleteAt) - Date.now());
    room.botTimer = setTimeout(() => {
      if (!room.game || room.game.currentPlayer?.userId !== actorId) return;
      try {
        const legal = room.game.legalActions(actorId);
        const action = legal.canCheck ? "check" : "call";
        const before = isHextechMode(room.mode) && (room.hextech?.effects || room.hextech?.characters)
          ? room.game.exportState()
          : null;
        const opportunityStarted = isHextechMode(room.mode)
          ? this.#beginHextechAllInOpportunity(room, actorId, action)
          : false;
        try {
          room.game.act(actorId, action, null, {
            pauseAfterCommit: opportunityStarted,
            automatic: true,
            source: "bot",
          });
        } catch (error) {
          if (opportunityStarted) this.#clearHextechAllInOpportunity(room);
          throw error;
        }
        this.#logPokerAction(room);
        if (opportunityStarted && !room.game.playerSnapshot(actorId)?.allIn) {
          this.#clearHextechAllInOpportunity(room);
        }
        if (before && room.hextech.characters) {
          this.#recordHextechCharacterPokerAction(room, {
            actorId,
            action,
            before,
            automatic: true,
          });
        }
        if (before && room.hextech.effects?.exportState?.().hand) {
          this.#runHextechEffectTransaction(room, () => {
            const outcome = room.hextech.effects.afterPokerAction({
              actorId,
              action,
              before,
              game: room.game,
            });
            this.#applyHextechDirectives(room, outcome.directives);
            return outcome;
          });
        }
        this.#syncFinished(room);
        this.#emitRoom(room);
        this.#scheduleBot(room);
      } catch {
        // A simultaneous player action may have moved the turn already.
      }
    }, dealWaitMs + 650);
    room.botTimer.unref();
  }

  #tick() {
    for (const room of this.rooms.values()) {
      try {
      if (isHextechMode(room.mode) && !room.hextech?.matchEnd) {
        let rebuyExpired = false;
        for (const member of room.members.values()) {
          if (member.rebuyDeadline && Date.now() >= member.rebuyDeadline) {
            rebuyExpired = this.#moveBustedMemberToSpectator(
              room,
              member,
              `${member.username} 补筹选择超时，已转入观战席`,
            ) || rebuyExpired;
          }
        }
        if (rebuyExpired) {
          this.#updateHextechMatchEnd(room, { allowTarget: false, allowHandCap: false });
          this.#emitRoom(room);
        }
      }
      if (isHextechMode(room.mode) && room.hextech?.phase === "skill-draft") {
        if (room.hextech.draft && Date.now() >= room.hextech.draft.deadline) {
          this.#finishHextechDraft(room, "timeout");
          this.#emitRoom(room);
          this.#scheduleBot(room);
        }
        continue;
      }
      if (isHextechMode(room.mode) && room.hextech?.characterOpportunity
        && Date.now() >= room.hextech.characterOpportunity.expiresAt) {
        this.#clearHextechAllInOpportunity(room);
        this.#syncFinished(room);
        this.#emitRoom(room);
        this.#scheduleBot(room);
        if (room.hextech.phase !== "playing") continue;
      }
      if (isHextechMode(room.mode) && room.hextech?.characters) {
        const { outcome, mutatedGame } = this.#runHextechCharacterTransaction(room, () => {
          const tickOutcome = room.hextech.characters.tick({ now: Date.now() });
          return {
            outcome: tickOutcome,
            mutatedGame: this.#applyHextechCharacterDirectives(room, tickOutcome.directives),
          };
        });
        if (mutatedGame || outcome.stateChanged) {
          this.#syncFinished(room);
          this.#emitRoom(room);
          this.#scheduleBot(room);
        }
        if (this.#activeHextechCharacterWindow(room)) continue;
        if (room.hextech.characterOpportunity && !this.#hextechReactionActive(room)) continue;
      }
      if (isHextechMode(room.mode)
        && room.hextech?.effects?.exportState?.().hand
        && room.game
        && room.game.stage !== "finished") {
        const previousEventSeq = room.hextech.effects.exportState().eventSeq;
        const reactionWasActive = this.#hextechReactionActive(room);
        const { outcome, mutatedGame } = this.#runHextechEffectTransaction(room, () => {
          const tickOutcome = room.hextech.effects.tick({ game: room.game });
          return {
            outcome: tickOutcome,
            mutatedGame: this.#applyHextechDirectives(room, tickOutcome.directives),
          };
        });
        if (reactionWasActive && !this.#hextechReactionActive(room)) {
          this.#refreshHextechAllInOpportunity(room);
        }
        if (mutatedGame || outcome.eventSeq !== previousEventSeq) {
          this.#syncFinished(room);
          this.#emitRoom(room);
          this.#scheduleBot(room);
        }
        if (this.#hextechReactionActive(room)) continue;
      }
      if (room.game?.advanceRunoutIfNeeded()) {
        this.#syncFinished(room);
        this.#emitRoom(room);
        this.#scheduleBot(room);
        continue;
      }
      if (room.game?.resolveFoldRevealIfNeeded()) this.#emitRoom(room);
      const timeoutBefore = isHextechMode(room.mode)
        && (room.hextech?.characters || room.hextech?.effects)
        && room.game?.currentPlayer
        ? room.game.exportState()
        : null;
      const timeoutActorId = room.game?.currentPlayer?.userId ?? null;
      const timeoutAction = timeoutActorId
        ? (room.game.legalActions(timeoutActorId)?.canCheck ? "check" : "fold")
        : null;
      if (room.game?.timeoutIfNeeded()) {
        this.#logPokerAction(room);
        if (timeoutBefore && timeoutActorId && timeoutAction) {
          if (room.hextech.characters) {
            this.#recordHextechCharacterPokerAction(room, {
              actorId: timeoutActorId,
              action: timeoutAction,
              before: timeoutBefore,
              automatic: true,
            });
          }
          if (room.hextech.effects?.exportState?.().hand) {
            this.#runHextechEffectTransaction(room, () => {
              const outcome = room.hextech.effects.afterPokerAction({
                actorId: timeoutActorId,
                action: timeoutAction,
                before: timeoutBefore,
                game: room.game,
                automatic: true,
              });
              this.#applyHextechDirectives(room, outcome.directives);
              return outcome;
            });
          }
        }
        this.#syncFinished(room);
        this.#emitRoom(room);
        this.#scheduleBot(room);
      }
      } catch (error) {
        this.audit("room_tick_failed", {
          roomCode: room.code,
          handId: room.game?.handId ?? null,
          message: error.message,
        });
      }
    }
  }

  disconnect(socket) {
    const user = socket.data.user;
    const presence = this.onlineUsers.get(user.id);
    presence?.socketIds.delete(socket.id);
    if (presence && presence.socketIds.size === 0) this.onlineUsers.delete(user.id);
    const code = this.userRooms.get(user.id);
    const room = code ? this.rooms.get(code) : null;
    const member = room?.members.get(user.id);
    if (!member) {
      this.emitLeaderboard();
      return;
    }
    member.socketIds.delete(socket.id);
    member.connected = member.socketIds.size > 0;
    this.#emitRoom(room);
  }

  #emitRoom(room) {
    this.#persistRooms();
    for (const member of humanMembers(room)) {
      for (const socketId of member.socketIds) {
        this.io.to(socketId).emit("room:state", this.#view(room, member.userId));
      }
    }
    this.emitLeaderboard();
  }

  #view(room, userId) {
    const self = room.members.get(userId);
    this.#attachHextechEffects(room);
    const { password: _password, ...publicSettings } = room.settings;
    const selfGamePlayer = room.game?.players?.find((player) => player.userId === self?.userId) ?? null;
    const spectatorAccess = self && room.game && (
      !selfGamePlayer
      || self.role === "spectator"
      || (room.game.stage !== "finished" && selfGamePlayer.folded)
    ) ? {
      isSpectator: true,
      focusUserId: self.spectatorFocusUserId,
      strictFocus: isHextechMode(room.mode),
      authorizedUserIds: spectatorCardAccessUserIds(self, room.game.handId),
    } : false;
    let rawGameView = room.game?.viewFor(userId, spectatorAccess) ?? null;
    if (spectatorAccess
      && room.game?.stage !== "finished"
      && rawGameView?.spectatorView?.focusUserId) {
      const focusedUserId = rawGameView.spectatorView.focusUserId;
      const focusedPlayer = rawGameView.players.find(({ userId: playerUserId }) => playerUserId === focusedUserId);
      if (focusedPlayer?.cards?.length === 2) {
        grantSpectatorCardAccess(self, room.game.handId, focusedUserId);
        rawGameView = {
          ...rawGameView,
          players: rawGameView.players.map((player) => (
            player.userId === focusedUserId
              ? { ...player, spectatorAccessGranted: true }
              : player
          )),
        };
      }
    }
    if (isHextechMode(room.mode)
      && room.game?.stage !== "finished"
      && room.hextech?.effects?.exportState?.().hand
      && rawGameView?.spectatorView?.focusUserId) {
      const focusedUserId = rawGameView.spectatorView.focusUserId;
      const focusedPlayer = rawGameView.players.find(({ userId: playerUserId }) => playerUserId === focusedUserId);
      if (focusedPlayer?.cards?.length === 2) {
        const externalView = room.hextech.effects.externalHoleCardView({
          viewerUserId: userId,
          targetUserId: focusedUserId,
          cards: focusedPlayer.cards,
        });
        rawGameView = {
          ...rawGameView,
          players: rawGameView.players.map((player) => (
            player.userId === focusedUserId
              ? { ...player, cards: [...externalView.cards] }
              : player
          )),
        };
      }
    }
    const hextechEffectView = isHextechMode(room.mode) && room.hextech?.effects
      ? room.hextech.effects.viewFor(userId, room.game)
      : null;
    const hextechCharacterView = isHextechMode(room.mode) && room.hextech?.characters
      ? room.hextech.characters.viewFor(userId, { now: Date.now() })
      : null;
    const visibleCharacters = (hextechCharacterView?.characters ?? []).map((character) => {
      const actualStack = room.game?.playerSnapshot?.(character.userId)?.stack
        ?? room.members.get(character.userId)?.stack
        ?? character.availableStack;
      const stackDelta = actualStack - character.availableStack;
      return {
        ...character,
        availableStack: actualStack,
        netAssets: character.netAssets + stackDelta,
      };
    });
    const selfCharacter = visibleCharacters
      ?.find((character) => character.userId === userId) ?? null;
    const draftActive = isHextechMode(room.mode) && room.hextech?.phase === "skill-draft";
    const gameView = rawGameView && draftActive ? {
      ...rawGameView,
      legal: null,
      actionToken: null,
      turnDeadline: null,
      timeExtension: { ...rawGameView.timeExtension, canBuy: false },
    } : rawGameView;
    const playerCount = [...room.members.values()].filter((member) => member.role === "player").length;
    const previewPlayerCount = Math.max(
      HEXTECH_MODE.minPlayers,
      Math.min(HEXTECH_MODE.maxPlayers, playerCount),
    );
    const ownDraftOffer = draftActive ? room.hextech.draft?.offers.get(userId) : null;
    let selfSkillWindow = hextechEffectView?.skillWindow
      ? { ...hextechEffectView.skillWindow }
      : null;
    if (selfSkillWindow) {
      const currentSkill = hextechSkill(selfSkillWindow.skillId);
      const reacting = hextechEffectView.activeReaction?.targetUserId === userId;
      if (reacting && selfSkillWindow.state === "armed") selfSkillWindow.state = "reaction";
      else if (currentSkill?.rules?.activation?.kind === "passive" && selfSkillWindow.state === "armed") {
        selfSkillWindow.state = "idle";
      } else if (selfSkillWindow.state === "idle" && selfSkillWindow.disabledReason) {
        selfSkillWindow.state = "disabled";
      }
      selfSkillWindow = {
        ...selfSkillWindow,
        windowId: `${hextechEffectView.handId}:${selfSkillWindow.version}`,
        windowToken: selfSkillWindow.token,
        windowVersion: selfSkillWindow.version,
        requiresTarget: currentSkill?.rules?.target?.type === "opponent",
        choiceSchema: currentSkill?.rules?.choiceSchema ?? null,
        cost: currentSkill?.rules?.cost ?? null,
      };
    }
    return {
      code: room.code,
      name: room.name,
      mode: room.mode,
      hostUserId: room.hostUserId,
      handNumber: room.handNumber,
      settings: {
        ...publicSettings,
        hasPassword: Boolean(room.settings.password),
      },
      members: [...room.members.values()]
        .map((member) => ({
          userId: member.userId,
          username: member.username,
          accountName: member.accountName,
          avatarTone: member.avatarTone || "gold",
          title: member.title || "牌桌新秀",
          displayedAchievements: [...(member.displayedAchievements || [])],
          isBot: member.isBot,
          role: member.role,
          seat: member.seat,
          stack: member.stack,
          ready: member.ready,
          connected: member.connected,
          rebuyCount: member.rebuyCount,
          pendingRebuy: member.pendingRebuy,
          rebuyDeadline: member.rebuyDeadline,
          seatRequest: member.seatRequest,
          requestedSeat: member.requestedSeat,
          characterId: member.characterId,
          hasEquipment: Boolean(member.equippedSkillId),
          equippedSkillId: member.userId === userId ? member.equippedSkillId : null,
          isSelf: member.userId === userId,
        }))
        .sort((a, b) => (a.role === b.role ? (a.seat ?? 99) - (b.seat ?? 99) : a.role.localeCompare(b.role))),
      chat: room.chat,
      settlement: this.#settlementView(room, userId),
      self: self ? {
        userId: self.userId,
        role: self.role,
        seat: self.seat,
        stack: self.stack,
        ready: self.ready,
        rebuyCount: self.rebuyCount,
        pendingRebuy: self.pendingRebuy,
        rebuyDeadline: self.rebuyDeadline,
        seatRequest: self.seatRequest,
        requestedSeat: self.requestedSeat,
        everSeated: self.everSeated,
        characterId: self.characterId,
        equippedSkillId: self.equippedSkillId,
        hextechRefreshesRemaining: self.hextechRefreshesRemaining,
      } : null,
      hextech: isHextechMode(room.mode) ? {
        phase: room.hextech.phase,
        lockedPlayerCount: room.hextech.lockedPlayerCount,
        participantUserIds: [...room.hextech.participantUserIds],
        targetChips: room.hextech.targetChips ?? hextechTargetForPlayers(previewPlayerCount),
        targetLocked: room.hextech.targetChips != null,
        maxHands: HEXTECH_MODE.maxHands,
        draftSeconds: HEXTECH_MODE.draftSeconds,
        nextBlind: room.handNumber < HEXTECH_MODE.maxHands
          ? { ...hextechBlindForHand(room.handNumber + 1) }
          : null,
        serverNow: Date.now(),
        eventSeq: hextechEffectView?.eventSeq ?? room.hextech.effects?.exportState?.().eventSeq ?? 0,
        equipment: hextechEffectView?.equipment ?? null,
        selfSkillWindow,
        activeReaction: hextechEffectView?.activeReaction ?? null,
        privateEffects: hextechEffectView?.privateEffects ?? [],
        publicEffects: hextechEffectView?.publicEffects ?? null,
        recentSkillEvents: hextechEffectView?.recentEvents ?? [],
        characterEventSeq: hextechCharacterView?.eventSeq ?? 0,
        characters: visibleCharacters,
        selfCharacter,
        loans: hextechCharacterView?.loans ?? [],
        characterEvents: hextechCharacterView?.events ?? [],
        characterOpportunity: room.hextech.characterOpportunity?.userId === userId
          ? { ...room.hextech.characterOpportunity }
          : null,
        draft: draftActive ? {
          handNumber: room.hextech.draft.handNumber,
          deadline: room.hextech.draft.deadline,
          lockedCount: [...room.hextech.draft.offers.values()].filter(({ selectedSkillId }) => selectedSkillId).length,
          playerCount: room.hextech.draft.offers.size,
          selfOffer: ownDraftOffer ? {
            offerId: ownDraftOffer.offerId,
            skillIds: [...ownDraftOffer.skillIds],
            selectedSkillId: ownDraftOffer.selectedSkillId,
            refreshesRemaining: self?.hextechRefreshesRemaining ?? 0,
          } : null,
        } : null,
        matchEnd: publicMatchEnd(room.hextech.matchEnd),
      } : null,
      game: gameView,
    };
  }
}
