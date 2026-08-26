import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  BookOpen,
  Check,
  CircleAlert,
  Clock3,
  Coins,
  HandCoins,
  Landmark,
  Leaf,
  LoaderCircle,
  Moon,
  Sparkles,
  Swords,
  Target,
  WandSparkles,
  Waves,
} from "lucide-react";
import { hextechCharacter } from "../../shared/hextech.js";
import { HEXTECH_CHARACTER_VOICE_LINES } from "../../shared/hextech-character-voice-lines.js";
import { characterImage, characterImageSrcSet } from "./hextech-assets.js";

export const CHARACTER_COMMANDS = Object.freeze({
  FENXIANG_ACTIVATE: "fenxiang:activate",
  XU_BARBECUE: "xu:barbecue",
  JIANSHENG_PRESSURE: "jiansheng:pressure",
  YA_ACTIVATE: "ya:activate",
  QIWAN_ACTIVATE: "qiwan:activate",
  ZIGE_OFFER_LOAN: "zige:offer-loan",
  ZIGE_RESPOND_LOAN: "zige:respond-loan",
  ZIGE_REPAY_LOAN: "zige:repay-loan",
  MAO_CLAIM: "mao:claim",
  MAO_CHALLENGE: "mao:challenge",
  MAO_CHOOSE: "mao:choose",
  WENGWENGWEN_ACTIVATE: "wengwengwen:activate-hunt",
});

const FOLDED_COMMAND_REASON = "已弃牌，本手不能发动人物技能";

const CHARACTER_ICONS = Object.freeze({
  fenxiang: Leaf,
  xu: Sparkles,
  jiansheng: Swords,
  ya: Waves,
  qiwan: WandSparkles,
  zige: Landmark,
  mao: Sparkles,
  wengwengwen: Moon,
});

const PROGRESS_LABELS = Object.freeze({
  largeOpponentPotsWon: "以小胜大底池",
  effectiveLateInvestments: "有效压秒投入",
  distinctHandsWithEffectiveLateInvestment: "覆盖不同手牌",
  distinctPlayersAffected: "影响不同玩家",
  affectedPotsWon: "赢下受压底池",
  earlyAllInsReachingRiver: "提前全押进河牌",
  earlyAllInPotsWon: "提前全押获胜",
  earlyAggressiveAllInsReachingShowdown: "主动全押进入摊牌",
  earlyAggressiveAllInShowdownWins: "主动全押摊牌获胜",
  replacementsCompleted: "完成换牌",
  replacementUsedInFinalHand: "换入牌进入最终牌型",
  loansSettledNormally: "贷款正常结清",
  unchallengedClaimsResolved: "无人质疑成功",
  correctChallengedClaims: "被质疑后猜中",
  distinctHuntHands: "不同手牌追刃",
  turnHunts: "转牌圈追刃",
  showdownWinsAgainstAggressor: "摊牌击败进攻者",
});

const SUITS = Object.freeze([
  { value: "clubs", label: "梅花", mark: "♣", tone: "dark" },
  { value: "diamonds", label: "方片", mark: "♦", tone: "red" },
  { value: "hearts", label: "红桃", mark: "♥", tone: "red" },
  { value: "spades", label: "黑桃", mark: "♠", tone: "dark" },
]);

const LOAN_STATE_LABELS = Object.freeze({
  offered: "等待确认",
  active: "还款中",
  overdue: "已逾期",
  repaid: "已结清",
  rejected: "未生效",
});

function commandId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `character-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatChips(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString("zh-CN") : "—";
}

function asTimestamp(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function useServerClock(serverNow, enabled) {
  const parsedServerNow = asTimestamp(serverNow);
  const [anchor, setAnchor] = useState(() => {
    const client = Date.now();
    return { client, server: parsedServerNow ?? client };
  });
  const [clientNow, setClientNow] = useState(Date.now());

  useEffect(() => {
    const client = Date.now();
    setAnchor({ client, server: parsedServerNow ?? client });
    setClientNow(client);
  }, [parsedServerNow]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = globalThis.setInterval(() => setClientNow(Date.now()), 250);
    return () => globalThis.clearInterval(timer);
  }, [enabled]);

  return anchor.server + (clientNow - anchor.client);
}

function secondsLeft(deadline, now) {
  const timestamp = asTimestamp(deadline);
  if (timestamp == null) return null;
  return Math.max(0, Math.ceil((timestamp - now) / 1000));
}

function normalizeRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function cardValue(card) {
  if (typeof card === "string") return card;
  return card?.cardId ?? card?.id ?? card?.value ?? null;
}

function cardDetails(cardId) {
  const raw = String(cardId ?? "");
  if (raw === "blank") return { id: raw, rank: "白", suit: "", tone: "dark", label: "白板牌" };
  const match = raw.match(/^([2-9TJQKA])([cdhs])$/i);
  if (!match) return { id: raw, rank: raw || "?", suit: "", tone: "dark", label: raw || "未知牌" };
  const rank = match[1].toUpperCase() === "T" ? "10" : match[1].toUpperCase();
  const suits = {
    c: { mark: "♣", name: "梅花", tone: "dark" },
    d: { mark: "♦", name: "方片", tone: "red" },
    h: { mark: "♥", name: "红桃", tone: "red" },
    s: { mark: "♠", name: "黑桃", tone: "dark" },
  };
  const suit = suits[match[2].toLowerCase()];
  return { id: raw, rank, suit: suit.mark, tone: suit.tone, label: `${suit.name} ${rank}` };
}

function moveRoving(event, { select = false } = {}) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const group = event.currentTarget.closest('[role="radiogroup"], [role="listbox"]');
  const options = [...(group?.querySelectorAll('[role="radio"]:not(:disabled), [role="option"]:not(:disabled)') ?? [])];
  if (!options.length) return;
  event.preventDefault();
  const current = Math.max(0, options.indexOf(event.currentTarget));
  let next = current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = options.length - 1;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + options.length) % options.length;
  else next = (current + 1) % options.length;
  options[next].focus();
  if (select) options[next].click();
}

function candidateIds(window) {
  const values = window?.candidateCardIds ?? window?.candidates ?? [];
  return Array.isArray(values) ? values.map(cardValue).filter(Boolean) : [];
}

function eventOwnerName(event, rows, members) {
  const userId = event?.payload?.userId
    ?? event?.payload?.lenderUserId
    ?? event?.payload?.sourceUserId;
  const member = members.find((entry) => entry.userId === userId);
  if (member?.username) return member.username;
  const row = rows.find((entry) => entry.userId === userId);
  return hextechCharacter(row?.characterId)?.name ?? "玩家";
}

function eventText(event, rows, members) {
  if (typeof event?.text === "string" && event.text.trim()) return event.text;
  const type = event?.type;
  const payload = event?.payload ?? {};
  const owner = eventOwnerName(event, rows, members);
  if (type === "character.resource.gained") return `${owner} 获得 ${payload.amount} 点人物资源`;
  if (type === "character.resource.spent") return `${owner} 消耗 ${payload.amount} 点人物资源`;
  if (type === "character.awakened") return `${owner} 已觉醒`;
  if (type === "character.active.used") return `${owner} 本手主动已使用`;
  if (type === "character.zige.loan.offered") return `${owner} 发出 ${formatChips(payload.principal)} 筹码贷款邀请`;
  if (type === "character.zige.loan.rejected") return "贷款邀请被拒绝";
  if (type === "character.zige.loan.expired") return "贷款邀请已超时";
  if (type === "character.zige.loan.repaid") return "贷款已结清";
  if (type === "character.zige.loan.overdue") return `贷款逾期，待还 ${formatChips(payload.outstanding)}`;
  if (type === "character.mao.claimed") {
    const suit = SUITS.find((entry) => entry.value === payload.suit)?.label ?? "所选花色";
    return `${owner} 宣称下一张为${suit}`;
  }
  if (type === "character.mao.challenge-resolved") return payload.correct ? "毛哥的花色宣称正确" : "毛哥的花色宣称错误";
  if (type === "character.wengwengwen.hunt-activated") return `${owner} 发动月蚀追猎`;
  if (type === "character.wengwengwen.private-card-revealed") return "月蚀追猎已返回一张私密展示牌";
  if (type === "character.wengwengwen.full-moon-refund") return `${owner} 的满月双刃返还 1 月痕`;
  if (type === "character.wengwengwen.showdown-win") return `${owner} 在摊牌击败被追猎的进攻者`;
  if (["character.qiwan.swap-armed", "character.choice.armed"].includes(type)) return `${owner} 的旧版人物窗口已安全迁移`;
  return null;
}

function CharacterCardChoices({ label, cards, value, onChange, disabled = false, privacyLabel = null }) {
  const enabledValue = cards.includes(value) ? value : null;
  return (
    <fieldset className="hextech-character-control-card-field">
      <legend>{label}{privacyLabel && <small>{privacyLabel}</small>}</legend>
      <div role="radiogroup" aria-label={label}>
        {cards.map((cardId, index) => {
          const card = cardDetails(cardId);
          const selected = cardId === enabledValue;
          return (
            <button
              type="button"
              className={`hextech-character-control-card ${card.tone} ${selected ? "selected" : ""}`}
              role="radio"
              aria-checked={selected}
              aria-label={card.label}
              disabled={disabled}
              tabIndex={selected || (!enabledValue && index === 0) ? 0 : -1}
              onClick={() => onChange(cardId)}
              onKeyDown={(event) => moveRoving(event, { select: true })}
              key={cardId}
            >
              <strong>{card.rank}</strong><span>{card.suit}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function HoleCardChoices({ value, onChange, disabled = false, label = "选择自己的底牌" }) {
  return (
    <fieldset className="hextech-character-control-choice-field">
      <legend>{label}</legend>
      <div role="radiogroup" aria-label={label}>
        {[0, 1].map((index) => (
          <button
            type="button"
            role="radio"
            aria-checked={value === index}
            className={value === index ? "selected" : ""}
            disabled={disabled}
            tabIndex={value === index || (value == null && index === 0) ? 0 : -1}
            onClick={() => onChange(index)}
            onKeyDown={(event) => moveRoving(event, { select: true })}
            key={index}
          >
            第 {index + 1} 张底牌
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function SuitChoices({ value, onChange, disabled = false }) {
  return (
    <fieldset className="hextech-character-control-choice-field">
      <legend>宣称花色</legend>
      <div role="radiogroup" aria-label="宣称花色">
        {SUITS.map((suit, index) => (
          <button
            type="button"
            role="radio"
            aria-checked={value === suit.value}
            className={`${suit.tone} ${value === suit.value ? "selected" : ""}`}
            disabled={disabled}
            tabIndex={value === suit.value || (!value && index === 0) ? 0 : -1}
            onClick={() => onChange(suit.value)}
            onKeyDown={(event) => moveRoving(event, { select: true })}
            key={suit.value}
          >
            <span aria-hidden="true">{suit.mark}</span> {suit.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Server-authoritative character rail.
 * Reads room.hextech.characters, selfCharacter, characterEvents, loans and serverNow.
 * onCommand receives (characterCommand, clientPayload); the adapter must add userId,
 * handNumber and every authoritative poker-context field before calling the engine.
 */
export function HextechCharacterControl({ room, onCommand }) {
  const hextech = room?.hextech ?? {};
  const members = Array.isArray(room?.members) ? room.members : [];
  const rows = useMemo(() => normalizeRows(hextech.characters), [hextech.characters]);
  const selfUserId = String(room?.self?.userId ?? "");
  const selfCharacter = hextech.selfCharacter
    ?? rows.find((entry) => String(entry.userId) === selfUserId)
    ?? null;
  const characterId = selfCharacter?.characterId ?? room?.self?.characterId ?? null;
  const catalog = hextechCharacter(characterId);
  const rules = catalog?.rules ?? null;
  const ownWindow = selfCharacter?.window ?? selfCharacter?.characterWindow ?? null;
  const presentedOpportunity = hextech.characterOpportunity ?? null;
  const currentHandId = room?.game?.handId ?? null;
  const opportunityHandMatches = presentedOpportunity != null && (
    (presentedOpportunity.handId == null && currentHandId == null)
    || (presentedOpportunity.handId != null
      && currentHandId != null
      && String(presentedOpportunity.handId) === String(currentHandId))
  );
  const matchingOpportunity = presentedOpportunity
    && String(presentedOpportunity.userId) === selfUserId
    && String(presentedOpportunity.characterId) === String(characterId)
    && opportunityHandMatches
    ? presentedOpportunity
    : null;
  const loans = useMemo(
    () => normalizeRows(hextech.loans ?? hextech.characterLoans ?? selfCharacter?.loans),
    [hextech.loans, hextech.characterLoans, selfCharacter?.loans],
  );
  const events = useMemo(
    () => normalizeRows(hextech.characterEvents ?? hextech.recentCharacterEvents),
    [hextech.characterEvents, hextech.recentCharacterEvents],
  );
  const serverNow = hextech.characterServerNow ?? hextech.serverNow;
  const titleId = useId();
  const foldedReasonId = `${titleId}-folded-reason`;
  const workspaceRef = useRef(null);
  const irreversibleConfirmRef = useRef(null);
  const previousIncomingLoanIdsRef = useRef(new Set());
  const [pendingCommand, setPendingCommand] = useState(null);
  const [selectedTargets, setSelectedTargets] = useState([]);
  const [principal, setPrincipal] = useState(200);
  const [borrowerUserId, setBorrowerUserId] = useState("");
  const [selectedSuit, setSelectedSuit] = useState("");
  const [useAwakening, setUseAwakening] = useState(false);
  const [holeCardIndex, setHoleCardIndex] = useState(null);
  const [irreversibleConfirm, setIrreversibleConfirm] = useState(null);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [repayAmounts, setRepayAmounts] = useState({});

  const publicMaoWindow = rows.find((entry) => (
    entry.characterId === "mao"
    && String(entry.userId) !== selfUserId
    && entry.window?.type === "mao-claim"
    && entry.window?.state === "armed"
  )) ?? null;
  const offeredLoans = loans.filter((loan) => loan.state === "offered");
  const activeDeadlines = [ownWindow?.expiresAt, matchingOpportunity?.expiresAt, publicMaoWindow?.window?.expiresAt]
    .concat(offeredLoans.map((loan) => loan.expiresAt))
    .filter(Boolean);
  const now = useServerClock(serverNow, activeDeadlines.length > 0);
  const matchingOpportunitySeconds = matchingOpportunity
    ? secondsLeft(matchingOpportunity.expiresAt, now)
    : null;
  const ownOpportunity = matchingOpportunitySeconds != null && matchingOpportunitySeconds > 0
    ? matchingOpportunity
    : null;
  const opportunityDisabledReason = ownOpportunity
    ? null
    : matchingOpportunity && matchingOpportunitySeconds === 0
      ? "全押后人物技能选择时间已经结束"
      : "当前没有可用的全押人物技能机会";
  const ownCandidates = characterId === "mao" ? candidateIds(ownWindow) : [];
  const ownWindowKey = ownWindow?.windowId ?? "no-character-window";
  const selfResource = Math.max(0, Number(selfCharacter?.resource ?? 0));
  const resourceMaximum = selfCharacter?.resourceMaximum ?? rules?.resource?.maximum ?? null;
  const selfAvailableStack = Number(selfCharacter?.availableStack ?? room?.self?.stack ?? 0);
  const selfGamePlayer = room?.game?.players?.find?.((entry) => entry.userId === selfUserId) ?? null;
  const currentStreetCommitted = Number(selfGamePlayer?.bet ?? selfGamePlayer?.streetCommitted ?? 0);
  const isOwnAction = selfGamePlayer?.seat != null && selfGamePlayer.seat === room?.game?.actingSeat;
  const toCall = selfGamePlayer
    ? Math.max(0, Number(room?.game?.currentBet ?? 0) - Number(selfGamePlayer.bet ?? 0))
    : 0;
  const gameStage = room?.game?.stage ?? null;
  const communityCount = room?.game?.community?.length ?? 0;
  const isPlayingPhase = hextech.phase == null
    ? Boolean(room?.game && gameStage !== "finished")
    : hextech.phase === "playing" && gameStage !== "finished";
  const isBetweenHands = hextech.phase == null
    ? gameStage === "finished"
    : hextech.phase === "hand-result" && gameStage === "finished";
  const isFoldedInHand = Boolean(selfGamePlayer?.folded && !isBetweenHands);

  const allowedCommands = selfCharacter?.availableCommands ?? hextech.characterCommands ?? null;
  const disabledReasons = selfCharacter?.disabledReasons ?? hextech.characterDisabledReasons ?? {};
  function commandAllowed(type) {
    if (Array.isArray(allowedCommands)) return allowedCommands.includes(type);
    if (allowedCommands && typeof allowedCommands === "object" && Object.hasOwn(allowedCommands, type)) {
      return Boolean(allowedCommands[type]);
    }
    return true;
  }

  async function issue(type, payload = {}) {
    if (!onCommand || pendingCommand) return;
    if (isFoldedInHand) return;
    setPendingCommand(type);
    try {
      await onCommand(type, {
        commandId: commandId(),
        ...payload,
      });
    } finally {
      setPendingCommand(null);
    }
  }

  function baseDisabledReason(type, cost = 0, { allowWindow = false, betweenHandsOnly = false } = {}) {
    if (!catalog || !selfCharacter) return "人物状态尚未同步";
    if (typeof onCommand !== "function") return "人物操作连接尚未就绪";
    if (!commandAllowed(type)) return disabledReasons[type] ?? "当前时机不能发动";
    if (pendingCommand) return "正在提交人物操作";
    if (isFoldedInHand) return FOLDED_COMMAND_REASON;
    if (betweenHandsOnly ? !isBetweenHands : !isPlayingPhase) {
      return betweenHandsOnly ? "贷款只能在两手之间处理" : "当前不是人物主动阶段";
    }
    if (selfCharacter.activeUsed) return "本手人物主动已使用";
    if (!allowWindow && ownWindow) return "请先完成人物候选窗口";
    if (resourceMaximum != null && selfResource < cost) return `${rules.resource.label}不足，需要 ${cost}`;
    return null;
  }

  useEffect(() => {
    setSelectedCardId(characterId === "mao" ? ownWindow?.selectedCardId ?? null : null);
  }, [characterId, ownWindowKey, ownWindow?.selectedCardId]);

  useEffect(() => {
    setSelectedTargets([]);
    setHoleCardIndex(null);
    setSelectedSuit("");
    setUseAwakening(false);
    setIrreversibleConfirm(null);
  }, [characterId, room?.handNumber]);

  useEffect(() => {
    if (!irreversibleConfirm) return undefined;
    irreversibleConfirmRef.current?.focus({ preventScroll: true });
    const cancelOnEscape = (event) => {
      if (event.key === "Escape") setIrreversibleConfirm(null);
    };
    globalThis.addEventListener?.("keydown", cancelOnEscape);
    return () => globalThis.removeEventListener?.("keydown", cancelOnEscape);
  }, [irreversibleConfirm]);

  useEffect(() => {
    if (selfCharacter?.activeUsed) setIrreversibleConfirm(null);
  }, [selfCharacter?.activeUsed]);

  useEffect(() => {
    if (!ownOpportunity && ["ya", "qiwan"].includes(irreversibleConfirm)) {
      setIrreversibleConfirm(null);
    }
  }, [irreversibleConfirm, ownOpportunity]);

  const borrowerOptions = useMemo(() => rows.filter((entry) => (
    String(entry.userId) !== selfUserId
    && members.find((member) => String(member.userId) === String(entry.userId))?.role !== "spectator"
  )), [members, rows, selfUserId]);
  useEffect(() => {
    if (!borrowerOptions.some((entry) => String(entry.userId) === borrowerUserId)) {
      setBorrowerUserId(borrowerOptions[0]?.userId ? String(borrowerOptions[0].userId) : "");
    }
  }, [borrowerUserId, borrowerOptions]);

  const debts = loans.filter((loan) => (
    String(loan.borrowerUserId) === selfUserId && ["active", "overdue"].includes(loan.state)
  ));
  useEffect(() => {
    setRepayAmounts((current) => Object.fromEntries(debts.map((loan) => {
      const maximum = Math.max(0, Math.min(Number(loan.outstanding ?? 0), selfAvailableStack));
      const prior = Number(current[loan.loanId]);
      const value = Number.isFinite(prior) && prior > 0 ? Math.min(prior, maximum) : maximum;
      return [loan.loanId, Math.floor(value / 5) * 5];
    })));
  }, [loans, selfAvailableStack]);

  useEffect(() => {
    if (!ownWindow?.windowId) return;
    workspaceRef.current?.focus({ preventScroll: true });
  }, [ownWindowKey]);

  const validTargetIds = selfCharacter?.validTargetUserIds
    ?? hextech.characterTargets?.jiansheng
    ?? null;
  const validTargetSet = Array.isArray(validTargetIds) ? new Set(validTargetIds.map(String)) : null;
  const gamePlayers = new Map((room?.game?.players ?? []).map((entry) => [String(entry.userId), entry]));
  const pressureTargets = rows
    .filter((entry) => String(entry.userId) !== selfUserId)
    .map((entry) => {
      const member = members.find((candidate) => String(candidate.userId) === String(entry.userId));
      const gamePlayer = gamePlayers.get(String(entry.userId));
      const disabled = validTargetSet
        ? !validTargetSet.has(String(entry.userId))
        : Boolean(gamePlayer?.folded || member?.role === "spectator");
      return {
        ...entry,
        name: member?.username ?? hextechCharacter(entry.characterId)?.name ?? "玩家",
        characterName: hextechCharacter(entry.characterId)?.name ?? "未公开人物",
        disabled,
      };
    });

  function togglePressureTarget(userId) {
    const id = String(userId);
    setSelectedTargets((current) => {
      if (current.includes(id)) return current.filter((entry) => entry !== id);
      const maximum = selfCharacter?.awakened ? 2 : 1;
      if (maximum === 1) return [id];
      if (current.length >= maximum) return current;
      return [...current, id];
    });
  }

  const progressRows = (rules?.growth?.counters ?? []).map((counter) => ({
    id: counter.id,
    label: PROGRESS_LABELS[counter.id] ?? counter.id,
    value: Math.max(0, Number(selfCharacter?.progress?.[counter.id] ?? 0)),
    target: Number(counter.target),
  }));
  const progressValue = progressRows.reduce((sum, entry) => sum + Math.min(entry.value, entry.target), 0);
  const progressTarget = progressRows.reduce((sum, entry) => sum + entry.target, 0);
  const visibleEvents = events
    .map((event) => ({ event, text: eventText(event, rows, members) }))
    .filter(({ text }) => Boolean(text))
    .slice(-3)
    .reverse();
  const latestSelfResourceEvent = [...events].reverse().find((event) => (
    ["character.resource.gained", "character.resource.spent"].includes(event?.type)
    && String(event?.payload?.userId) === selfUserId
  ));
  const latestAwakenEvent = [...events].reverse().find((event) => (
    event?.type === "character.awakened" && String(event?.payload?.userId) === selfUserId
  ));
  const latestVoiceEvent = [...events].reverse().find((event) => (
    String(event?.payload?.userId) === selfUserId
    && ["character.awakened", "character.active.used", "character.resource.gained"].includes(event?.type)
  ));
  const voiceLines = HEXTECH_CHARACTER_VOICE_LINES[characterId] ?? null;
  const voiceKey = latestVoiceEvent?.type === "character.awakened"
    ? "awaken"
    : latestVoiceEvent?.type === "character.active.used"
      ? "activate"
      : latestVoiceEvent?.type === "character.resource.gained"
        ? "progress"
        : "select";
  const voiceLine = voiceLines?.[voiceKey] ?? "";

  const incomingLoans = offeredLoans.filter((loan) => String(loan.borrowerUserId) === selfUserId);
  const incomingLoanKey = incomingLoans.map((loan) => String(loan.loanId)).sort().join("|");
  useEffect(() => {
    const nextIds = new Set(incomingLoans.map((loan) => String(loan.loanId)));
    const hasNewInvitation = [...nextIds].some((loanId) => !previousIncomingLoanIdsRef.current.has(loanId));
    previousIncomingLoanIdsRef.current = nextIds;
    if (!hasNewInvitation) return;
    const workspace = workspaceRef.current;
    workspace?.scrollTo?.({ top: 0, left: workspace.scrollLeft, behavior: "auto" });
    workspace?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
  }, [incomingLoanKey]);
  const relevantLoans = loans.filter((loan) => (
    String(loan.lenderUserId) === selfUserId || String(loan.borrowerUserId) === selfUserId
  ));
  const nearestSeconds = activeDeadlines
    .map((deadline) => secondsLeft(deadline, now))
    .filter((value) => value != null)
    .sort((left, right) => left - right)[0] ?? null;
  const liveCountdown = [5, 3, 1].includes(nearestSeconds)
    ? `人物操作窗口还剩 ${nearestSeconds} 秒`
    : nearestSeconds === 0 ? "人物操作窗口已结束" : "";

  const Icon = CHARACTER_ICONS[characterId] ?? Leaf;
  const activeLabel = pendingCommand ? "提交中…" : null;
  let mainControl = null;

  if (characterId === "fenxiang") {
    const cost = Number(selfCharacter?.activeCost ?? rules.active.cost);
    const reason = baseDisabledReason(CHARACTER_COMMANDS.FENXIANG_ACTIVATE, cost);
    mainControl = (
      <section className="hextech-character-control-action-card">
        <header><Leaf size={16} /><span><strong>以小搏大</strong><small>消耗 {cost} {rules.resource.label}</small></span></header>
        <p>本手获胜结算时，击败起手筹码更高的对手可获得阶梯银行奖励。</p>
        <button type="button" className="character-primary" disabled={Boolean(reason)} onClick={() => issue(CHARACTER_COMMANDS.FENXIANG_ACTIVATE)}>
          {pendingCommand === CHARACTER_COMMANDS.FENXIANG_ACTIVATE ? <LoaderCircle size={16} /> : <Check size={16} />}
          {activeLabel ?? "发动以小搏大"}
        </button>
        {reason && <small className="character-disabled-reason">{reason}</small>}
      </section>
    );
  } else if (characterId === "xu") {
    const cost = Number(rules.active.cost);
    const opponentSecondsDelta = Number(selfCharacter.awakened
      ? rules.awakening.opponentSecondsDelta
      : rules.active.opponentSecondsDelta);
    const selfSecondsDelta = Number(selfCharacter.awakened
      ? rules.awakening.selfSecondsDelta
      : rules.active.selfSecondsDelta);
    const minimumOpponentActionSeconds = Number(rules.active.minimumOpponentActionSeconds);
    const bankPotContribution = selfCharacter.awakened
      ? Number(rules.awakening.bankPotContribution)
      : 0;
    const reason = baseDisabledReason(CHARACTER_COMMANDS.XU_BARBECUE, cost)
      ?? (!rules.active.legalStreets.includes(gameStage) ? "河牌后没有可烧烤的下一街" : null);
    mainControl = (
      <section className="hextech-character-control-action-card">
        <header><Sparkles size={16} /><span><strong>烧烤</strong><small>消耗 {cost} {rules.resource.label}</small></span></header>
        <p>{catalog.passive}</p>
        <p>下一街所有仍在手对手 {opponentSecondsDelta} 秒（最低 {minimumOpponentActionSeconds} 秒），自己 +{selfSecondsDelta} 秒。{bankPotContribution > 0 ? `炉火纯青额外向底池加入 ${bankPotContribution} 银行筹码。` : ""}</p>
        <button type="button" className="character-primary" disabled={Boolean(reason)} onClick={() => issue(CHARACTER_COMMANDS.XU_BARBECUE)}>
          {pendingCommand === CHARACTER_COMMANDS.XU_BARBECUE ? <LoaderCircle size={16} /> : <Check size={16} />}
          {activeLabel ?? "发动烧烤"}
        </button>
        {reason && <small className="character-disabled-reason">{reason}</small>}
      </section>
    );
  } else if (characterId === "jiansheng") {
    const swordDomain = selectedTargets.length === 2;
    const cost = swordDomain ? Number(rules.awakening.activeCost) : Number(rules.active.cost);
    const baseReason = baseDisabledReason(CHARACTER_COMMANDS.JIANSHENG_PRESSURE, cost);
    const reason = baseReason ?? (!selectedTargets.length ? "请选择至少一名目标" : null);
    const firstValidTarget = pressureTargets.find((entry) => !entry.disabled)?.userId;
    mainControl = (
      <section className="hextech-character-control-action-card">
        <header><Swords size={16} /><span><strong>{swordDomain ? "剑域" : "剑压"}</strong><small>消耗 {cost} {rules.resource.label}</small></span></header>
        <p>{Number.isFinite(currentStreetCommitted) ? `目标下一次加注总额不能超过你本街已投入的 ${formatChips(currentStreetCommitted)}。` : "限制目标下一次加注总额。"}</p>
        <div className="hextech-character-control-targets" role="listbox" aria-label="选择剑压目标" aria-multiselectable={selfCharacter?.awakened || undefined}>
          {pressureTargets.map((target) => {
            const selected = selectedTargets.includes(String(target.userId));
            return (
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? "selected" : ""}
                disabled={target.disabled || Boolean(baseReason)}
                tabIndex={selected || (!selectedTargets.length && String(target.userId) === String(firstValidTarget)) ? 0 : -1}
                onClick={() => togglePressureTarget(target.userId)}
                onKeyDown={(event) => moveRoving(event)}
                key={target.userId}
              >
                <span><strong>{target.name}</strong><small>{target.characterName}</small></span>
                {selected && <Check size={14} />}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="character-primary"
          disabled={Boolean(reason)}
          onClick={() => issue(CHARACTER_COMMANDS.JIANSHENG_PRESSURE, { targetUserIds: selectedTargets })}
        >
          {pendingCommand === CHARACTER_COMMANDS.JIANSHENG_PRESSURE ? <LoaderCircle size={16} /> : <Target size={16} />}
          {activeLabel ?? (swordDomain ? "发动剑域" : "发动剑压")}
        </button>
        {reason && <small className="character-disabled-reason">{reason}</small>}
      </section>
    );
  } else if (characterId === "ya") {
    const cost = Number(selfCharacter?.activeCost
      ?? (selfCharacter.awakened ? rules.awakening?.activeCost : rules.active.cost)
      ?? rules.active.cost);
    const reason = baseDisabledReason(CHARACTER_COMMANDS.YA_ACTIVATE, cost, { allowWindow: true })
      ?? opportunityDisabledReason
      ?? (!selfGamePlayer?.allIn ? "仅翻牌前或翻牌圈主动全押后可用（全押跟注不算）" : null)
      ?? (communityCount >= 5 ? "自然河牌已经发出" : null);
    const legacyWindow = ["ya-river-choice", "ya-river-replace-legacy"].includes(ownWindow?.type);
    if (legacyWindow) {
      mainControl = (
        <section className="hextech-character-control-window-card legacy-window" role="status">
          <header><CircleAlert size={16} /><strong>旧版河牌窗口正在安全迁移</strong></header>
          <p>本界面不会读取或展示旧候选牌，也不会代替你选择。服务器会按新版随机换河规则安全续局。</p>
        </section>
      );
    } else if (irreversibleConfirm === "ya") {
      mainControl = (
        <section className="hextech-character-control-window-card irreversible-window" ref={irreversibleConfirmRef} tabIndex={-1} aria-labelledby={`${titleId}-ya-confirm`}>
          <header><CircleAlert size={16} /><strong id={`${titleId}-ya-confirm`}>确认不可预知的河牌重发</strong></header>
          <p className="hextech-character-control-confirm-copy">发动后，服务端会弃置原定自然河牌，再发出牌堆顶下一张。你看不到原牌或任何候选，结果不可预知且不可撤销。</p>
          <div className="hextech-character-control-confirm-actions">
            <button type="button" className="character-secondary" disabled={Boolean(pendingCommand)} onClick={() => setIrreversibleConfirm(null)}>返回</button>
            <button type="button" className="character-primary danger" disabled={Boolean(reason)} onClick={async () => {
              await issue(CHARACTER_COMMANDS.YA_ACTIVATE);
              setIrreversibleConfirm(null);
            }}>
              {pendingCommand === CHARACTER_COMMANDS.YA_ACTIVATE ? <LoaderCircle size={16} /> : <Waves size={16} />}
              {pendingCommand === CHARACTER_COMMANDS.YA_ACTIVATE ? "提交中…" : "确认预约随机换河"}
            </button>
          </div>
          {reason && <small className="character-disabled-reason">{reason}</small>}
        </section>
      );
    } else if (!ownWindow) {
      mainControl = (
        <section className="hextech-character-control-action-card">
          <header><Waves size={16} /><span><strong>逆流换河</strong><small>{selfCharacter.awakened ? "觉醒减免 · " : ""}消耗 {cost} {rules.resource.label}</small></span></header>
          <p>预约后，服务端会弃置原定自然河牌，再发出牌堆顶下一张；你看不到原牌或任何候选。</p>
          <button type="button" className="character-primary" disabled={Boolean(reason)} onClick={() => setIrreversibleConfirm("ya")}>
            <Waves size={16} /> 继续确认随机换河
          </button>
          {reason && <small className="character-disabled-reason">{reason}</small>}
        </section>
      );
    } else {
      mainControl = <p className="hextech-character-control-wait" role="status"><LoaderCircle size={17} /> 河牌重发预约正在结算，不会展示候选牌…</p>;
    }
  } else if (characterId === "qiwan") {
    const cost = Number(selfCharacter?.activeCost ?? rules.active.cost);
    const reason = baseDisabledReason(CHARACTER_COMMANDS.QIWAN_ACTIVATE, cost, { allowWindow: true })
      ?? opportunityDisabledReason
      ?? (gameStage !== "preflop" || communityCount > 0 ? "只能在翻牌发出前发动" : null)
      ?? (!selfGamePlayer?.allIn ? "需要先在翻牌前全押" : null);
    const activationReason = reason ?? (holeCardIndex == null ? "请先选择要替换的底牌" : null);
    const legacyWindow = ["qiwan-card-swap", "qiwan-top-deck-swap-legacy"].includes(ownWindow?.type);
    if (legacyWindow) {
      mainControl = (
        <section className="hextech-character-control-window-card legacy-window" role="status">
          <header><CircleAlert size={16} /><strong>旧版换牌窗口正在安全迁移</strong></header>
          <p>本界面不会读取或展示旧候选牌，也不会提交候选编号。服务器会按新版牌堆顶随机补牌规则安全续局。</p>
        </section>
      );
    } else if (irreversibleConfirm === "qiwan") {
      mainControl = (
        <section className="hextech-character-control-window-card private-window irreversible-window" ref={irreversibleConfirmRef} tabIndex={-1} aria-labelledby={`${titleId}-qiwan-confirm`}>
          <header><CircleAlert size={16} /><strong id={`${titleId}-qiwan-confirm`}>确认弃置第 {(holeCardIndex ?? 0) + 1} 张底牌</strong></header>
          <p className="hextech-character-control-confirm-copy">确认后，服务端会弃置所选底牌，并用牌堆顶下一张牌补入。你无法预知补到什么牌，提交后不可撤销。</p>
          <div className="hextech-character-control-confirm-actions">
            <button type="button" className="character-secondary" disabled={Boolean(pendingCommand)} onClick={() => setIrreversibleConfirm(null)}>返回重选</button>
            <button type="button" className="character-primary danger" disabled={Boolean(activationReason)} onClick={async () => {
              await issue(CHARACTER_COMMANDS.QIWAN_ACTIVATE, { holeCardIndex });
              setIrreversibleConfirm(null);
            }}>
              {pendingCommand === CHARACTER_COMMANDS.QIWAN_ACTIVATE ? <LoaderCircle size={16} /> : <WandSparkles size={16} />}
              {pendingCommand === CHARACTER_COMMANDS.QIWAN_ACTIVATE ? "提交中…" : "确认随机换牌"}
            </button>
          </div>
          {activationReason && <small className="character-disabled-reason">{activationReason}</small>}
        </section>
      );
    } else if (!ownWindow) {
      mainControl = (
        <section className="hextech-character-control-action-card">
          <header><WandSparkles size={16} /><span><strong>盲盒换牌</strong><small>消耗 {cost} {rules.resource.label}</small></span></header>
          <p>选择第 1 或第 2 张底牌。确认后由服务端弃置所选底牌，并用不可预知的牌堆顶下一张补牌。{selfCharacter.awakened ? "灵感回响：换入牌进入最佳五张且赢池时返还 1 奇想。" : ""}</p>
          <HoleCardChoices value={holeCardIndex} onChange={(index) => { setHoleCardIndex(index); setIrreversibleConfirm(null); }} disabled={Boolean(reason)} />
          <button type="button" className="character-primary" disabled={Boolean(activationReason)} onClick={() => setIrreversibleConfirm("qiwan")}>
            <WandSparkles size={16} /> 继续确认随机换牌
          </button>
          {activationReason && <small className="character-disabled-reason">{activationReason}</small>}
        </section>
      );
    } else {
      mainControl = <p className="hextech-character-control-wait" role="status"><LoaderCircle size={17} /> 随机换牌正在结算，不会展示候选牌…</p>;
    }
  } else if (characterId === "zige") {
    const openLoans = loans.filter((loan) => (
      String(loan.lenderUserId) === selfUserId && ["offered", "active", "overdue"].includes(loan.state)
    ));
    const maximumOpen = selfCharacter.awakened ? Number(rules.awakening.maximumOpenLoans) : Number(rules.active.maximumOpenLoans);
    const offerReason = baseDisabledReason(CHARACTER_COMMANDS.ZIGE_OFFER_LOAN, 0, { betweenHandsOnly: true })
      ?? (openLoans.length >= maximumOpen ? `进行中贷款已达 ${maximumOpen} 笔上限` : null)
      ?? (!borrowerUserId ? "当前没有可贷款玩家" : null)
      ?? (selfAvailableStack < principal ? "可用筹码不足" : null);
    const repayment = Math.floor(principal * (1 + Number(rules.active.interestRatio)) / 5) * 5;
    mainControl = (
      <section className="hextech-character-control-action-card loan-offer-card">
        <header><HandCoins size={16} /><span><strong>公开贷款</strong><small>{rules.active.durationHands} 手期 · 10% 利息</small></span></header>
        <label>借款人
          <select value={borrowerUserId} disabled={Boolean(offerReason && !borrowerUserId) || Boolean(pendingCommand)} onChange={(event) => setBorrowerUserId(event.target.value)}>
            {borrowerOptions.map((entry) => {
              const member = members.find((candidate) => candidate.userId === entry.userId);
              return <option value={entry.userId} key={entry.userId}>{member?.username ?? hextechCharacter(entry.characterId)?.name ?? "玩家"}</option>;
            })}
          </select>
        </label>
        <label>贷款本金 <output>{formatChips(principal)}</output>
          <input type="range" min="200" max="600" step="100" value={principal} disabled={Boolean(pendingCommand)} onChange={(event) => setPrincipal(Number(event.target.value))} />
        </label>
        <p>接受后立即到账 {formatChips(principal)}，到期应还 {formatChips(repayment)}。</p>
        <button type="button" className="character-primary" disabled={Boolean(offerReason)} onClick={() => issue(CHARACTER_COMMANDS.ZIGE_OFFER_LOAN, { borrowerUserId, principal })}>
          {pendingCommand === CHARACTER_COMMANDS.ZIGE_OFFER_LOAN ? <LoaderCircle size={16} /> : <HandCoins size={16} />}
          {activeLabel ?? "发送贷款邀请"}
        </button>
        {offerReason && <small className="character-disabled-reason">{offerReason}</small>}
      </section>
    );
  } else if (characterId === "mao") {
    const activeCost = useAwakening ? Number(rules.awakening.resourceCost) : 0;
    const baseReason = baseDisabledReason(CHARACTER_COMMANDS.MAO_CLAIM, activeCost, { allowWindow: true });
    const claimStreet = selfCharacter?.claimStreet
      ?? hextech.characterContext?.nextBoardStreet
      ?? (room?.game?.stage === "flop" ? "turn" : room?.game?.stage === "turn" ? "river" : null);
    if (!ownWindow) {
      const reason = baseReason ?? (!selectedSuit ? "请选择宣称花色" : null) ?? (!claimStreet ? "当前不在转牌或河牌发牌前" : null);
      mainControl = (
        <section className="hextech-character-control-action-card">
          <header><Sparkles size={16} /><span><strong>{useAwakening ? "真蛊惑" : "花色蛊惑"}</strong><small>{useAwakening ? `消耗 ${activeCost} ${rules.resource.label}` : "无人质疑则按宣称发牌"}</small></span></header>
          <SuitChoices value={selectedSuit} onChange={setSelectedSuit} disabled={Boolean(baseReason)} />
          {selfCharacter.awakened && (
            <button type="button" className={`hextech-character-control-awaken-toggle ${useAwakening ? "selected" : ""}`} aria-pressed={useAwakening} disabled={selfResource < Number(rules.awakening.resourceCost) || Boolean(baseReason)} onClick={() => setUseAwakening((value) => !value)}>
              <BadgeCheck size={15} /> 使用本场一次的真蛊惑
            </button>
          )}
          <button type="button" className="character-primary" disabled={Boolean(reason)} onClick={() => issue(CHARACTER_COMMANDS.MAO_CLAIM, { suit: selectedSuit, useAwakening })}>
            {pendingCommand === CHARACTER_COMMANDS.MAO_CLAIM ? <LoaderCircle size={16} /> : <Sparkles size={16} />}
            {activeLabel ?? "确认花色宣称"}
          </button>
          {reason && <small className="character-disabled-reason">{reason}</small>}
        </section>
      );
    } else if (ownWindow.type === "mao-suit-choice" && ownWindow.state === "armed") {
      const seconds = secondsLeft(ownWindow.expiresAt, now);
      const choiceReason = isFoldedInHand ? FOLDED_COMMAND_REASON : !selectedCardId ? "请选择候选牌" : null;
      mainControl = (
        <section className="hextech-character-control-window-card">
          <header><Sparkles size={16} /><strong>真蛊惑候选</strong>{seconds != null && <time><Clock3 size={13} /> {seconds}s</time>}</header>
          <CharacterCardChoices label={`${SUITS.find((entry) => entry.value === ownWindow.suit)?.label ?? "宣称花色"}候选`} cards={ownCandidates} value={selectedCardId} onChange={setSelectedCardId} disabled={isFoldedInHand} />
          <button type="button" className="character-primary" disabled={typeof onCommand !== "function" || Boolean(choiceReason) || Boolean(pendingCommand) || seconds === 0} onClick={() => issue(CHARACTER_COMMANDS.MAO_CHOOSE, { windowId: ownWindow.windowId, cardId: selectedCardId })}>
            <Check size={16} /> {pendingCommand ? "提交中…" : "确认发出此牌"}
          </button>
          {choiceReason && <small className="character-disabled-reason">{choiceReason}</small>}
        </section>
      );
    } else if (ownWindow.type === "mao-claim") {
      const seconds = secondsLeft(ownWindow.expiresAt, now);
      const suit = SUITS.find((entry) => entry.value === ownWindow.suit)?.label ?? "所选花色";
      mainControl = <p className="hextech-character-control-wait" role="status"><Clock3 size={17} /> 已宣称{suit}，等待质疑{seconds != null ? ` · ${seconds}s` : ""}</p>;
    } else {
      mainControl = <p className="hextech-character-control-wait" role="status"><LoaderCircle size={17} /> 人物窗口结算中…</p>;
    }
  } else if (characterId === "wengwengwen") {
    const cost = Number(rules.active.cost);
    const targetUserId = selfCharacter.latestAggressorUserId ?? null;
    const targetMember = members.find((entry) => String(entry.userId) === String(targetUserId));
    const targetCharacter = rows.find((entry) => String(entry.userId) === String(targetUserId));
    const targetName = targetMember?.username
      ?? hextechCharacter(targetCharacter?.characterId)?.name
      ?? "当前进攻者";
    const reveal = selfCharacter.reveal ?? null;
    const revealedCard = reveal?.cardId ? cardDetails(reveal.cardId) : null;
    const reason = baseDisabledReason(CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE, cost)
      ?? (!rules.active.legalStreets.includes(gameStage) ? "只能在翻牌圈或转牌圈发动" : null)
      ?? (!isOwnAction ? "等待轮到自己行动" : null)
      ?? (!(toCall > 0) ? "当前没有需要回应的主动进攻" : null)
      ?? (!targetUserId ? "本街尚无符合条件的主动进攻者" : null);
    if (reveal && revealedCard) {
      mainControl = (
        <section className="hextech-character-control-window-card private-window weng-reveal" role="status" aria-live="polite">
          <span className={`hextech-character-control-card ${revealedCard.tone}`} aria-label={revealedCard.label}>
            <strong>{revealedCard.rank}</strong><span aria-hidden="true">{revealedCard.suit}</span>
          </span>
          <span>
            <small>月蚀追猎 · {targetName} 的一张展示底牌</small>
            <strong>只对你可见 · 本街结束后消失</strong>
            <em>伪装技能可能改变展示牌，系统不会提示是否命中。</em>
          </span>
        </section>
      );
    } else if (irreversibleConfirm === "wengwengwen") {
      mainControl = (
        <section className="hextech-character-control-window-card irreversible-window" ref={irreversibleConfirmRef} tabIndex={-1} aria-labelledby={`${titleId}-weng-confirm`}>
          <header><CircleAlert size={16} /><strong id={`${titleId}-weng-confirm`}>确认追猎 {targetName}</strong></header>
          <p className="hextech-character-control-confirm-copy">消耗 {cost} 月痕，由服务端随机展示目标一张底牌。伪装技能可能使牌面失真；获取信息后不可撤销。</p>
          <div className="hextech-character-control-confirm-actions">
            <button type="button" className="character-secondary" disabled={Boolean(pendingCommand)} onClick={() => setIrreversibleConfirm(null)}>返回</button>
            <button type="button" className="character-primary danger" disabled={Boolean(reason)} onClick={async () => {
              await issue(CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE);
              setIrreversibleConfirm(null);
            }}>
              {pendingCommand === CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE ? <LoaderCircle size={16} /> : <Moon size={16} />}
              {pendingCommand === CHARACTER_COMMANDS.WENGWENGWEN_ACTIVATE ? "提交中…" : "确认发动月蚀追猎"}
            </button>
          </div>
          {reason && <small className="character-disabled-reason">{reason}</small>}
        </section>
      );
    } else {
      mainControl = (
        <section className="hextech-character-control-action-card">
          <header><Moon size={16} /><span><strong>月蚀追猎</strong><small>消耗 {cost} {rules.resource.label}</small></span></header>
          <p>目标：{targetUserId ? targetName : "等待本街主动进攻者"}。发动后由服务端随机展示其一张底牌，伪装技能仍可生效。</p>
          {selfCharacter.awakened && <p>满月双刃：查看后的下一次操作若为至少 2BB 的完整加注或全押加注，返还 1 月痕。</p>}
          <button type="button" className="character-primary" disabled={Boolean(reason)} onClick={() => setIrreversibleConfirm("wengwengwen")}>
            <Moon size={16} /> 继续确认月蚀追猎
          </button>
          {reason && <small className="character-disabled-reason">{reason}</small>}
        </section>
      );
    }
  }

  if (!catalog || !selfCharacter) {
    return (
      <section className="hextech-character-control is-empty" aria-label="人物状态">
        <CircleAlert size={20} /><strong>人物状态尚未同步</strong>
      </section>
    );
  }

  return (
    <section className={`hextech-character-control character-${characterId} ${selfCharacter.awakened ? "is-awakened" : ""} ${isFoldedInHand ? "is-folded" : ""}`.trim()} aria-labelledby={titleId} aria-describedby={isFoldedInHand ? foldedReasonId : undefined} aria-disabled={isFoldedInHand || undefined} data-control-rail="character">
      <span className="hextech-character-control-sr-only" role="status" aria-live="polite">{liveCountdown}</span>

      <aside className="hextech-character-control-identity">
        <span className="hextech-character-control-portrait"><img src={characterImage(characterId, selfCharacter.awakened)} srcSet={characterImageSrcSet(characterId, selfCharacter.awakened)} sizes="62px" width="192" height="288" alt={`${catalog.name}人物立绘`} decoding="async" /></span>
        <div className="hextech-character-control-name">
          <small>{catalog.role}</small>
          <h2 id={titleId}>{catalog.name}</h2>
          <span><Icon size={13} /> {selfCharacter.activeUsed ? "本手主动已使用" : "本手主动未使用"}</span>
          {voiceLine && <em className="hextech-character-control-voice" aria-live="polite" aria-atomic="true">“{voiceLine}”</em>}
        </div>
        {selfCharacter.awakened && <b className="hextech-character-control-awaken-stamp" key={`awaken-${latestAwakenEvent?.eventSeq ?? "ready"}`}><BadgeCheck size={14} /> 已觉醒</b>}
        <div className="hextech-character-control-resource" key={`resource-${latestSelfResourceEvent?.eventSeq ?? "steady"}`}>
          <span><strong>{rules.resource.label}</strong><em>{resourceMaximum == null ? `净资产 ${formatChips(selfCharacter.netAssets)}` : `${selfResource}/${resourceMaximum}`}</em></span>
          {resourceMaximum == null ? (
            <div className="ledger-value"><Landmark size={16} /> 可用筹码 {formatChips(selfAvailableStack)}</div>
          ) : (
            <div className="resource-pips" role="meter" aria-label={`${rules.resource.label} ${selfResource}/${resourceMaximum}`} aria-valuemin="0" aria-valuemax={resourceMaximum} aria-valuenow={selfResource}>
              {Array.from({ length: resourceMaximum }, (_, index) => <i className={index < selfResource ? "filled" : ""} key={index} />)}
            </div>
          )}
        </div>
      </aside>

      <section className="hextech-character-control-growth" aria-label="成长与觉醒进度">
        <header><BookOpen size={15} /><strong>{selfCharacter.awakened ? "觉醒完成" : "觉醒进度"}</strong><span>{selfCharacter.awakened ? "完成" : `${progressValue}/${progressTarget}`}</span></header>
        <div className="hextech-character-control-growth-list">
          {progressRows.map((entry) => {
            const value = Math.min(entry.value, entry.target);
            const percentage = entry.target > 0 ? value / entry.target * 100 : 0;
            return (
              <div className={value >= entry.target ? "complete" : ""} key={entry.id}>
                <span><strong>{entry.label}</strong><em>{entry.value}/{entry.target}</em></span>
                <span className="growth-track" role="progressbar" aria-label={entry.label} aria-valuemin="0" aria-valuemax={entry.target} aria-valuenow={value}><i style={{ "--character-progress": `${percentage}%` }} /></span>
              </div>
            );
          })}
        </div>
        {visibleEvents.length > 0 && (
          <ol className="hextech-character-control-events" role="log" aria-label="最近人物事件" aria-live="polite">
            {visibleEvents.map(({ event, text }) => <li key={event.eventSeq ?? `${event.type}-${text}`}><span>{event.eventSeq ?? ""}</span>{text}</li>)}
          </ol>
        )}
      </section>

      <div className="hextech-character-control-workspace" ref={workspaceRef} tabIndex={ownWindow ? -1 : undefined}>
        <header className="hextech-character-control-workspace-head"><span><Icon size={16} /><strong>人物主动</strong></span>{ownWindow?.expiresAt && <time><Clock3 size={13} /> {secondsLeft(ownWindow.expiresAt, now)}s</time>}</header>

        {isFoldedInHand && <p className="hextech-character-control-folded-notice" id={foldedReasonId} role="status"><CircleAlert size={15} /> {FOLDED_COMMAND_REASON}</p>}

        {ownOpportunity && !ownWindow && (
          <p className="hextech-character-control-opportunity" role="status">
            <Clock3 size={15} />
            全押后人物技能机会已保留，{matchingOpportunitySeconds} 秒内决定；超时将自动继续发牌。
          </p>
        )}

        {incomingLoans.map((loan) => {
          const lender = members.find((entry) => entry.userId === loan.lenderUserId);
          const seconds = secondsLeft(loan.expiresAt, now);
          const due = Math.floor(Number(loan.principal) * (1 + Number(loan.interestRate)) / 5) * 5;
          return (
            <section className="hextech-character-control-loan-notice" key={loan.loanId}>
              <span className="hextech-character-control-sr-only" role="alert" aria-live="assertive" aria-atomic="true">收到{lender?.username ?? "资哥"}的贷款邀请：到账 {formatChips(loan.principal)}，请在倒计时结束前选择接受或拒绝。</span>
              <header><HandCoins size={15} /><strong>{lender?.username ?? "资哥"} 的贷款邀请</strong><time role="timer" aria-live="off" aria-label={`剩余 ${seconds} 秒`}>{seconds}s</time></header>
              <p>到账 {formatChips(loan.principal)}，{loan.dueAfterHands} 手后偿还 {formatChips(due)}。</p>
              <div>
                <button type="button" className="character-secondary" disabled={!isBetweenHands || typeof onCommand !== "function" || Boolean(pendingCommand) || seconds === 0} onClick={() => issue(CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN, { loanId: loan.loanId, accept: false })}>拒绝</button>
                <button type="button" className="character-primary" disabled={!isBetweenHands || typeof onCommand !== "function" || Boolean(pendingCommand) || seconds === 0} onClick={() => issue(CHARACTER_COMMANDS.ZIGE_RESPOND_LOAN, { loanId: loan.loanId, accept: true })}>接受并到账</button>
              </div>
            </section>
          );
        })}

        {publicMaoWindow && (
          <section className="hextech-character-control-challenge">
            <header><CircleAlert size={15} /><strong>毛哥宣称下一张是{SUITS.find((entry) => entry.value === publicMaoWindow.window.suit)?.label ?? "所选花色"}</strong><time>{secondsLeft(publicMaoWindow.window.expiresAt, now)}s</time></header>
            <p>质疑后立即公开自然牌；猜错的一方向对方或底池支付 40。</p>
            <button type="button" className="character-secondary danger" disabled={isFoldedInHand || !isPlayingPhase || typeof onCommand !== "function" || Boolean(pendingCommand) || secondsLeft(publicMaoWindow.window.expiresAt, now) === 0} onClick={() => issue(CHARACTER_COMMANDS.MAO_CHALLENGE, { windowId: publicMaoWindow.window.windowId })}>质疑花色</button>
          </section>
        )}

        {mainControl}

        {debts.map((loan) => {
          const maximum = Math.floor(Math.max(0, Math.min(Number(loan.outstanding ?? 0), selfAvailableStack)) / 5) * 5;
          const amount = Math.min(Number(repayAmounts[loan.loanId] ?? maximum), maximum);
          return (
            <section className="hextech-character-control-repay" key={loan.loanId}>
              <header><Coins size={15} /><strong>{loan.state === "overdue" ? "逾期还款" : "主动还款"}</strong><span>待还 {formatChips(loan.outstanding)}</span></header>
              <label>本次偿还 <output>{formatChips(amount)}</output>
                <input type="range" min={Math.min(5, maximum)} max={maximum} step="5" value={amount} disabled={maximum < 5 || Boolean(pendingCommand)} onChange={(event) => setRepayAmounts((current) => ({ ...current, [loan.loanId]: Number(event.target.value) }))} />
              </label>
              <button type="button" className="character-secondary" disabled={!isBetweenHands || typeof onCommand !== "function" || amount < 5 || Boolean(pendingCommand)} onClick={() => issue(CHARACTER_COMMANDS.ZIGE_REPAY_LOAN, { loanId: loan.loanId, amount })}>偿还 {formatChips(amount)}</button>
            </section>
          );
        })}

        {relevantLoans.length > 0 && (
          <details className="hextech-character-control-ledger">
            <summary><Landmark size={14} /> 公开贷款账本 · {relevantLoans.length} 笔</summary>
            <div>
              {relevantLoans.map((loan) => {
                const otherId = String(loan.lenderUserId) === selfUserId ? loan.borrowerUserId : loan.lenderUserId;
                const other = members.find((entry) => entry.userId === otherId);
                return (
                  <p key={loan.loanId}><span><strong>{other?.username ?? "玩家"}</strong><small>{String(loan.lenderUserId) === selfUserId ? "借款人" : "出借人"}</small></span><span>{LOAN_STATE_LABELS[loan.state] ?? loan.state}<b>{formatChips(loan.outstanding)}</b></span></p>
                );
              })}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

export default HextechCharacterControl;
