import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  CircleHelp,
  Clock3,
  Crosshair,
  LoaderCircle,
  LockKeyhole,
  ShieldAlert,
  Sparkles,
  Target,
  Undo2,
  Zap,
} from "lucide-react";
import { hextechCharacter, hextechSkill } from "../../shared/hextech.js";
import { PlayingCard } from "../cards.jsx";
import { skillImage, skillImageSrcSet } from "./hextech-assets.js";
const SKILL_STATES = new Set([
  "idle",
  "armed",
  "targeting",
  "confirming",
  "reaction",
  "resolving",
  "consumed",
  "disabled",
]);
const EXPANDED_STATES = new Set(["targeting", "confirming", "reaction"]);
const ACTIONABLE_STATES = new Set(["idle", "armed", "targeting", "confirming", "reaction"]);

const DEFAULT_CHOICE_OPTIONS = Object.freeze({
  holeCardIndex: [
    { value: 0, label: "第 1 张底牌" },
    { value: 1, label: "第 2 张底牌" },
  ],
  rank: ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"],
  suit: [
    { value: "clubs", label: "♣ 梅花" },
    { value: "diamonds", label: "♦ 方片" },
    { value: "hearts", label: "♥ 红桃" },
    { value: "spades", label: "♠ 黑桃" },
  ],
  handCategory: [
    { value: "high-card", label: "高牌" },
    { value: "one-pair", label: "一对" },
    { value: "two-pair", label: "两对" },
    { value: "three-of-a-kind", label: "三条" },
    { value: "straight", label: "顺子" },
    { value: "flush", label: "同花" },
    { value: "full-house", label: "葫芦" },
    { value: "four-of-a-kind", label: "四条" },
    { value: "straight-flush", label: "同花顺" },
  ],
  candidateCardIndex: [],
});

const CHOICE_LABELS = Object.freeze({
  holeCardIndex: "选择自己的底牌",
  rank: "选择目标点数",
  suit: "选择花色",
  handCategory: "选择最终牌型",
  candidateCardIndex: "选择候选牌",
});

const CHOICE_ID_ALIASES = Object.freeze({
  card: "holeCardIndex",
  cardIndex: "holeCardIndex",
  "card-index": "holeCardIndex",
  card_index: "holeCardIndex",
  category: "handCategory",
  hand_category: "handCategory",
  candidate: "candidateCardIndex",
  candidateIndex: "candidateCardIndex",
  "candidate-index": "candidateCardIndex",
});

const COUNTERPLAY_LABELS = Object.freeze({
  shield: "技能护盾",
  mirror: "反弹镜",
  "smoke-bomb": "烟雾弹",
  "fake-weak": "装糖阴你一手",
  "fake-strong": "装阴糖你一手",
  escape: "金蝉脱壳",
});

const SUIT_LABELS = Object.freeze({
  clubs: "♣ 梅花",
  diamonds: "♦ 方片",
  hearts: "♥ 红桃",
  spades: "♠ 黑桃",
});

const HAND_CATEGORY_LABELS = Object.freeze(Object.fromEntries(
  DEFAULT_CHOICE_OPTIONS.handCategory.map(({ value, label }) => [value, label]),
));

const STATE_COPY = Object.freeze({
  idle: { eyebrow: "贴纸待命", title: "可以发动", description: "先撕开技能贴纸，再按服务端提示完成选择。" },
  armed: { eyebrow: "贴纸已撕开", title: "等待下一步", description: "技能已进入发动流程；确认前仍可安全取消。" },
  targeting: { eyebrow: "选择目标", title: "瞄准一名玩家", description: "不可选的玩家会保留在名单中，并标明原因。" },
  confirming: { eyebrow: "二次确认", title: "核对代价与风险", description: "确认后将交由服务器结算，本手装备不能再次使用。" },
  reaction: { eyebrow: "限时反制", title: "现在要响应吗？", description: "窗口结束前可发动反制，也可以主动放弃。" },
  resolving: { eyebrow: "服务器结算", title: "技能生效中", description: "结果以服务器回传为准，请勿重复操作。" },
  consumed: { eyebrow: "本手已使用", title: "贴纸已撕掉", description: "下一手三选一时会获得新的技能装备。" },
  disabled: { eyebrow: "当前不可用", title: "贴纸暂时封存", description: "等待合法时机或服务器状态更新。" },
});
const PASSIVE_COPY = Object.freeze({
  eyebrow: "被动守护",
  title: "本手自动生效",
  description: "满足触发条件时由服务器自动结算，无需手动发动。",
});

function commandId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `hextech-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

function useSkillCountdown(skillWindow, serverNow) {
  const explicitDeadline = asTimestamp(
    skillWindow?.expiresAt ?? skillWindow?.deadline ?? skillWindow?.endsAt,
  );
  const parsedServerTimestamp = asTimestamp(serverNow);
  const remainingMs = Number(skillWindow?.remainingMs);
  const windowKey = skillWindow?.windowId ?? skillWindow?.id ?? skillWindow?.token ?? "no-window";
  const [clock, setClock] = useState(() => {
    const client = Date.now();
    const server = parsedServerTimestamp ?? client;
    return {
      client,
      server,
      deadline: explicitDeadline
        ?? (Number.isFinite(remainingMs) ? server + Math.max(0, remainingMs) : null),
    };
  });
  const [clientNow, setClientNow] = useState(Date.now());

  useEffect(() => {
    const client = Date.now();
    const server = parsedServerTimestamp ?? client;
    setClock({
      client,
      server,
      deadline: explicitDeadline
        ?? (Number.isFinite(remainingMs) ? server + Math.max(0, remainingMs) : null),
    });
    setClientNow(client);
  }, [parsedServerTimestamp, explicitDeadline, remainingMs, windowKey]);

  useEffect(() => {
    if (clock.deadline == null) return undefined;
    const timer = globalThis.setInterval(() => {
      const now = Date.now();
      setClientNow(now);
      if (clock.server + (now - clock.client) >= clock.deadline) {
        globalThis.clearInterval(timer);
      }
    }, 250);
    return () => globalThis.clearInterval(timer);
  }, [clock]);

  if (clock.deadline == null) return { seconds: null, expired: false };
  const estimatedServerNow = clock.server + (clientNow - clock.client);
  const milliseconds = Math.max(0, clock.deadline - estimatedServerNow);
  return {
    seconds: Math.ceil(milliseconds / 1000),
    expired: milliseconds <= 0,
  };
}

function resolveSkill(hextech, room) {
  const source = hextech?.equippedSkill
    ?? hextech?.equipment?.skillId
    ?? room?.self?.equippedSkill
    ?? room?.self?.equippedSkillId
    ?? hextech?.selfSkillWindow?.skill
    ?? hextech?.selfSkillWindow?.skillId;
  const sourceId = typeof source === "string" ? source : source?.id ?? source?.skillId;
  const catalogEntry = sourceId ? hextechSkill(sourceId) : null;
  if (!sourceId) return null;
  return { ...catalogEntry, ...(typeof source === "object" ? source : {}), id: sourceId };
}

function normalizeChoiceId(value) {
  const raw = String(value ?? "");
  return CHOICE_ID_ALIASES[raw] ?? raw;
}

function normalizeChoiceOption(option, index, stepId) {
  if (option && typeof option === "object") {
    const value = option.value ?? option.id ?? option.index ?? index;
    return {
      value,
      label: String(option.label ?? option.name ?? option.cardLabel ?? value),
      disabled: Boolean(option.disabled ?? option.isDisabled),
      description: option.description ? String(option.description) : "",
    };
  }
  const defaultMatch = DEFAULT_CHOICE_OPTIONS[stepId]?.find?.((entry) => (
    typeof entry === "object" && Object.is(entry.value, option)
  ));
  return {
    value: option,
    label: String(defaultMatch?.label ?? (stepId === "rank" && option === "T" ? "10" : option)),
    disabled: false,
    description: "",
  };
}

function choiceSteps(skillWindow, skill) {
  const schema = skillWindow?.choiceSchema
    ?? skillWindow?.rules?.choiceSchema
    ?? skill?.rules?.choiceSchema
    ?? null;
  if (!schema) return [];
  let steps;
  if (Array.isArray(schema)) steps = schema;
  else if (Array.isArray(schema.steps)) steps = schema.steps;
  else if (schema.id || schema.kind || schema.key) steps = [schema];
  else {
    steps = Object.entries(schema).map(([id, step]) => (
      step && typeof step === "object" ? { id, ...step } : { id, options: step }
    ));
  }

  const windowSteps = skillWindow?.choiceSteps ?? skillWindow?.choicesSchema?.steps ?? [];
  const overrides = new Map(
    (Array.isArray(windowSteps) ? windowSteps : []).map((step) => [normalizeChoiceId(step.id ?? step.key), step]),
  );

  return steps.map((baseStep, index) => {
    const id = normalizeChoiceId(baseStep.id ?? baseStep.key ?? baseStep.kind ?? `choice-${index + 1}`);
    const override = overrides.get(id) ?? {};
    const merged = { ...baseStep, ...override };
    const rawOptions = Array.isArray(merged.options) && merged.options.length > 0
      ? merged.options
      : DEFAULT_CHOICE_OPTIONS[id] ?? [];
    return {
      id,
      label: String(merged.label ?? CHOICE_LABELS[id] ?? `选择 ${index + 1}`),
      description: merged.description ? String(merged.description) : "",
      required: merged.required !== false && merged.minimumSelections !== 0,
      visibility: merged.visibility ?? "private",
      options: rawOptions.map((option, optionIndex) => normalizeChoiceOption(option, optionIndex, id)),
    };
  });
}

function selectionsFromWindow(skillWindow) {
  const source = skillWindow?.selectedChoices
    ?? skillWindow?.choices
    ?? skillWindow?.selection?.choices
    ?? {};
  if (!source || Array.isArray(source) || typeof source !== "object") return {};
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [normalizeChoiceId(key), value]),
  );
}

function normalizeTargets(skillWindow, characters, room) {
  const characterRows = Array.isArray(characters)
    ? characters
    : characters && typeof characters === "object" ? Object.values(characters) : [];
  const roomRows = Array.isArray(room?.members) ? room.members : [];
  // Room membership owns display names/seat presence; character rows add
  // progression data but must not overwrite those public identity fields.
  const rowById = new Map([...characterRows, ...roomRows].map((row) => [
    String(row.userId ?? row.playerId ?? row.id),
    row,
  ]));
  const rawTargets = Array.isArray(skillWindow?.targets) ? skillWindow.targets : null;
  const validIds = skillWindow?.validTargetUserIds
    ?? skillWindow?.validTargetIds
    ?? skillWindow?.targetUserIds
    ?? null;
  const validSet = Array.isArray(validIds) ? new Set(validIds.map(String)) : null;
  const source = rawTargets ?? [...rowById.values()];

  return source.map((target, index) => {
    const primitive = typeof target === "string" || typeof target === "number";
    const targetId = String(primitive ? target : target.userId ?? target.playerId ?? target.id ?? index);
    const details = rowById.get(targetId) ?? (primitive ? {} : target);
    const character = hextechCharacter(details.characterId);
    const explicitlyValid = primitive ? true : target.valid ?? target.isValid ?? target.canTarget;
    const disabled = explicitlyValid === false || (validSet ? !validSet.has(targetId) : false);
    return {
      id: targetId,
      name: String(details.username ?? details.name ?? details.displayName ?? `玩家 ${index + 1}`),
      characterName: String(details.characterName ?? character?.name ?? "未公开人物"),
      chips: Number.isFinite(Number(details.chips)) ? Number(details.chips) : null,
      isSelf: Boolean(details.isSelf ?? targetId === String(room?.self?.userId ?? "")),
      disabled,
      reason: String((primitive ? "" : target.reason ?? target.disabledReason) || (disabled ? "不符合发动条件" : "")),
    };
  });
}

function selectedTargetFromWindow(skillWindow) {
  const value = skillWindow?.selectedTargetUserId
    ?? skillWindow?.pendingTargetUserId
    ?? skillWindow?.targetUserId
    ?? skillWindow?.selection?.targetUserId
    ?? null;
  return value == null ? null : String(value);
}

function formatCost(cost) {
  if (cost == null || cost === false) return "无需额外支付";
  if (typeof cost === "string") return cost;
  if (typeof cost === "number") return `${cost.toLocaleString("zh-CN")} 筹码`;
  if (typeof cost !== "object") return String(cost);
  if (cost.label || cost.text) return String(cost.label ?? cost.text);
  if (cost.type === "clamped-ratio") {
    const ratio = Number(cost.ratio);
    const minimum = Number(cost.minimum);
    const maximum = Number(cost.maximum);
    const ratioText = Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "按比例";
    if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
      return `剩余筹码 ${ratioText}（${minimum}–${maximum}）`;
    }
    return `剩余筹码 ${ratioText}`;
  }
  const parts = [];
  const chips = Number(cost.chips ?? cost.chipAmount ?? cost.amount);
  if (Number.isFinite(chips) && chips > 0) parts.push(`${chips.toLocaleString("zh-CN")} 筹码`);
  const resourceAmount = Number(cost.resourceAmount ?? cost.resource?.amount);
  const resourceName = cost.resourceName ?? cost.resource?.name;
  if (Number.isFinite(resourceAmount) && resourceAmount > 0) {
    parts.push(`${resourceAmount} ${resourceName ?? "人物资源"}`);
  }
  return parts.length ? parts.join(" + ") : "无需额外支付";
}

function formatRisk(skillWindow, skill) {
  const risk = skillWindow?.riskText
    ?? skillWindow?.maximumChipRisk
    ?? skill?.rules?.maximumChipRisk;
  if (typeof risk === "string") return risk;
  if (typeof risk === "number") {
    return risk > 0 ? `最多损失 ${risk.toLocaleString("zh-CN")} 筹码` : "无额外筹码风险";
  }
  if (risk && typeof risk === "object") return String(risk.label ?? risk.text ?? "按提示承担筹码风险");
  if (skill?.kind === "passive" || skill?.rules?.activation?.kind === "passive") {
    return "无主动支付；触发后消耗装备";
  }
  return skill?.cheat || skill?.rules?.audit?.cheat
    ? "作弊技能可能被「抓老千」追查"
    : "确认后消耗本手装备";
}

function formatCounterplay(skillWindow, skill) {
  const counterplay = skillWindow?.counterplayText
    ?? skillWindow?.counterplayLabels
    ?? skillWindow?.counterplay
    ?? skill?.rules?.counterplay;
  if (Array.isArray(counterplay) && counterplay.length) {
    return counterplay.map((entry) => (
      typeof entry === "string"
        ? COUNTERPLAY_LABELS[entry] ?? entry
        : entry.label ?? entry.text ?? COUNTERPLAY_LABELS[entry.id] ?? entry.id
    )).filter(Boolean).join("；");
  }
  if (typeof counterplay === "string" && counterplay) return counterplay;
  if (skill?.kind === "passive" || skill?.rules?.activation?.kind === "passive") {
    return "自动响应，无需手动确认";
  }
  if (skill?.kind?.includes("player")) return "目标的护盾或反制技能可能介入";
  return "确认前可取消；确认后由服务器结算";
}

function formatSkillMode(skill) {
  const kind = skill?.rules?.activation?.kind;
  if (kind === "passive") return "被动 · 自动触发";
  if (kind === "reaction") return "反应 · 窗口内决定";
  return "主动 · 由你发动";
}

function formatSkillTarget(skill) {
  const target = skill?.rules?.target;
  if (!target) return "以服务器当前提示为准";
  const minimum = Number(target.minimum ?? 0);
  const maximum = Number(target.maximum ?? minimum);
  if (target.type === "none") return "不需要选择目标";
  if (target.type === "self") return "你自己";
  if (target.type === "own-hole-card") return "自己的 1 张可用底牌";
  if (target.type === "global") return "全桌";
  if (target.type === "opponent") {
    return minimum === 1 && maximum === 1
      ? "1 名符合当前条件的对手"
      : `${minimum}–${maximum} 名符合当前条件的对手`;
  }
  return String(target.label ?? target.type);
}

function skillHelpSteps(skill) {
  if (!skill) return [];
  const rules = skill.rules ?? {};
  const kind = rules.activation?.kind;
  const timing = skill.timing;
  if (kind === "passive") {
    return [
      `无需点击发动；在「${timing}」满足条件时由服务器自动处理。`,
      "触发后，本手装备会按规则消耗。",
    ];
  }
  if (kind === "reaction") {
    return [
      `等待「${timing}」的反制窗口出现。`,
      "在窗口内选择发动或放弃；选择发动后核对费用并确认。",
    ];
  }

  const result = [`在「${timing}」技能可用时，点击“撕开并发动”。`];
  const targetType = rules.target?.type;
  if (targetType === "opponent" || targetType === "own-hole-card") {
    result.push(`按提示选择${formatSkillTarget(skill)}。`);
  }
  const choices = choiceSteps(null, skill).map((step) => step.label);
  if (choices.length) result.push(`依次完成：${choices.join("、")}。`);
  result.push(
    rules.requiresConfirmation
      ? "核对目标、费用与风险后，再次确认发动。"
      : "提交后等待服务器返回结算结果。",
  );
  return result;
}

function isSameValue(left, right) {
  return Object.is(left, right) || String(left) === String(right);
}

function moveWithinGroup(event, onMove) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const group = event.currentTarget.closest('[role="radiogroup"], [role="listbox"]');
  const options = [...(group?.querySelectorAll('[role="radio"]:not(:disabled), [role="option"]:not(:disabled)') ?? [])];
  if (!options.length) return;
  event.preventDefault();
  const currentIndex = Math.max(0, options.indexOf(event.currentTarget));
  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = options.length - 1;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + options.length) % options.length;
  else nextIndex = (currentIndex + 1) % options.length;
  const next = options[nextIndex];
  next.focus();
  onMove?.(next);
}

function detailText(value, fallback) {
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

function latestPrivateResult(hextech, skillId) {
  const effects = Array.isArray(hextech?.privateEffects) ? hextech.privateEffects : [];
  return [...effects].reverse().find((entry) => entry?.sourceSkillId === skillId) ?? null;
}

function privateResultCopy(effect, targets) {
  if (!effect) return null;
  const target = targets.find((entry) => entry.id === String(effect.targetUserId ?? ""));
  if (Array.isArray(effect.cards) && effect.cards.length) {
    return {
      eyebrow: "仅你可见 · 本街有效",
      title: target ? `${target.name} 的底牌` : "透视结果",
      description: "这些牌由服务器私密下发；其他玩家与观战者不会收到。",
      cards: effect.cards,
    };
  }
  if (effect.kind === "public-tendency" && effect.tendency) {
    return {
      eyebrow: "仅你可见 · 公开行为推断",
      title: target ? `${target.name}：${effect.tendency}` : `行动倾向：${effect.tendency}`,
      description: "读心术只分析公开下注轨迹，不会泄露目标底牌。",
      cards: [],
    };
  }
  if (effect.kind === "flop-majority-suit-prediction" && effect.suit) {
    return {
      eyebrow: "仅你可见 · 等待翻牌",
      title: `已预言 ${SUIT_LABELS[effect.suit] ?? effect.suit}`,
      description: "翻牌出现后由服务器自动判定；命中获得 160，失败向底池支付 80。",
      cards: [],
    };
  }
  if (effect.kind === "final-hand-category-prediction" && effect.handCategory) {
    return {
      eyebrow: "仅你可见 · 等待结算",
      title: `已预报 ${HAND_CATEGORY_LABELS[effect.handCategory] ?? effect.handCategory}`,
      description: "本手结束后由服务器核验；命中获得 240，失败向底池支付 60。",
      cards: [],
    };
  }
  return null;
}

function ongoingResultCopy(hextech, skillId, selfUserId, targets) {
  const effects = hextech?.publicEffects ?? {};
  const findOwn = (rows) => (Array.isArray(rows)
    ? [...rows].reverse().find((entry) => entry?.sourceUserId === selfUserId)
    : null);
  const targetName = (userId) => targets.find((entry) => entry.id === String(userId ?? ""))?.name ?? "目标玩家";
  if (skillId === "pot-bomb") {
    const effect = findOwn(effects.potBombs);
    if (effect) return { eyebrow: "全桌公开 · 已埋设", title: `等待底池达到 ${effect.threshold}`, description: "首次达到门槛时，银行自动向底池加入 120。", cards: [] };
  }
  if (skillId === "raise-cap") {
    const effect = findOwn(effects.globalRaiseCaps);
    if (effect) return { eyebrow: "全桌公开 · 本街生效", title: `加注增量上限 ${effect.maximumIncrement}`, description: "服务端会对全体仍在手玩家执行同一上限。", cards: [] };
  }
  if (skillId === "duel-contract") {
    const effect = findOwn(effects.duelContracts);
    if (effect) return { eyebrow: "全桌公开 · 等待摊牌", title: `与 ${targetName(effect.targetUserId)} 的单挑契约`, description: "双方都进入摊牌时，胜者由银行奖励 180。", cards: [] };
  }
  if (skillId === "bounty") {
    const effect = findOwn(effects.bounties);
    if (effect) return { eyebrow: "全桌公开 · 等待摊牌", title: `已悬赏 ${targetName(effect.targetUserId)}`, description: "发动者获胜奖励 180；目标反胜奖励 80。", cards: [] };
  }
  if (skillId === "last-stand" && findOwn(effects.lastStands)) {
    return { eyebrow: "全桌公开 · 保障已锁定", title: "背水一战等待结算", description: "全押净损失可返还 25%，最高 300。", cards: [] };
  }
  if (skillId === "insurance" && findOwn(effects.insurances)) {
    return { eyebrow: "全桌公开 · 保单生效", title: "全押损失保障中", description: "已支付 60 保费；净损失返还 25%，最高 300。", cards: [] };
  }
  if (skillId === "fixed-deposit") {
    const effect = findOwn(effects.fixedDeposits);
    if (effect) return { eyebrow: "全桌公开 · 存款锁定", title: "200 筹码定存生效", description: "坚持至河牌返还 230；提前弃牌返还 180。", cards: [] };
  }
  return null;
}

/**
 * Server-authoritative skill control for the player's control rail.
 * onCommand receives (command, payload), where command is one of
 * arm / target / choice / confirm / react / cancel.
 */
export function HextechSkillControl({ room, onCommand }) {
  const hextech = room?.hextech ?? {};
  const skillWindow = hextech.selfSkillWindow ?? null;
  const skill = useMemo(() => resolveSkill(hextech, room), [
    hextech.equippedSkill,
    hextech.equipment?.skillId,
    skillWindow?.skill,
    skillWindow?.skillId,
    room?.self?.equippedSkill,
    room?.self?.equippedSkillId,
  ]);
  const passive = skill?.kind === "passive" || skill?.rules?.activation?.kind === "passive";
  const serverState = skillWindow?.state ?? "disabled";
  const reactionSkill = skill?.kind === "reaction" || skill?.rules?.activation?.kind === "reaction";
  const reactionWindowOpen = reactionSkill
    && serverState === "armed"
    && Boolean(skillWindow?.expiresAt ?? skillWindow?.deadline ?? skillWindow?.endsAt)
    && !skillWindow?.disabledReason;
  const rawState = reactionWindowOpen
    ? "reaction"
    : serverState === "idle" && skillWindow?.disabledReason
      ? "disabled"
      : serverState;
  const state = SKILL_STATES.has(rawState) ? rawState : "disabled";
  const copy = state === "idle" && passive ? PASSIVE_COPY : STATE_COPY[state];
  const titleId = useId();
  const detailsId = useId();
  const helpId = useId();
  const rootRef = useRef(null);
  const helpRef = useRef(null);
  const [localChoices, setLocalChoices] = useState(() => selectionsFromWindow(skillWindow));
  const [helpOpen, setHelpOpen] = useState(false);
  const { seconds, expired } = useSkillCountdown(skillWindow, hextech.serverNow);
  const steps = useMemo(() => choiceSteps(skillWindow, skill), [skillWindow, skill]);
  const characters = hextech.characters ?? room?.members ?? [];
  const targets = useMemo(
    () => normalizeTargets(skillWindow, characters, room),
    [skillWindow, characters, room],
  );
  const selectedTargetId = selectedTargetFromWindow(skillWindow);
  const windowKey = skillWindow?.windowId ?? skillWindow?.id ?? skillWindow?.token ?? "no-window";
  const pendingReactionOption = skillWindow?.pendingReactionOption ?? null;
  const equipmentStatus = hextech.equipment?.status ?? null;
  const armedWaiting = state === "armed" && equipmentStatus === "armed" && Boolean(skillWindow?.disabledReason);
  const isBusy = state === "resolving";
  const locked = state === "consumed" || state === "disabled" || isBusy || expired;
  const requiredChoicesComplete = steps.every((step) => (
    !step.required || localChoices[step.id] !== undefined
  ));
  const targetRule = skill?.rules?.target;
  const targetType = skillWindow?.targetType ?? targetRule?.type;
  const requiresTarget = Boolean(
    skillWindow?.requiresTarget
    ?? (targetType === "opponent" && Number(targetRule?.minimum ?? 1) > 0),
  );
  const targetComplete = !requiresTarget || Boolean(selectedTargetId);
  const defaultCancelable = state === "targeting"
    || (state === "confirming" && !pendingReactionOption)
    || state === "reaction"
    || (state === "armed" && !armedWaiting && !passive && !selectedTargetId);
  const cancelable = Boolean(skillWindow?.cancelable ?? defaultCancelable);
  const canConfirmArmed = Boolean(
    skillWindow?.canConfirm
    ?? (!armedWaiting && !passive && !selectedTargetId && steps.length === 0 && !requiresTarget && !skillWindow?.disabledReason),
  );
  const basePayload = {
    windowId: skillWindow?.windowId ?? skillWindow?.id ?? skillWindow?.token ?? null,
    windowToken: skillWindow?.token ?? skillWindow?.windowToken ?? null,
    windowVersion: skillWindow?.version ?? skillWindow?.windowVersion ?? null,
    skillId: skill?.id ?? skillWindow?.skillId ?? null,
  };

  useEffect(() => {
    setLocalChoices(selectionsFromWindow(skillWindow));
  }, [windowKey, state, skillWindow?.selectedChoices, skillWindow?.choices, skillWindow?.selection]);

  useEffect(() => {
    if (!EXPANDED_STATES.has(state)) return;
    rootRef.current?.focus({ preventScroll: true });
  }, [state, windowKey]);

  useEffect(() => {
    if (!helpOpen) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (!helpRef.current?.contains(event.target)) setHelpOpen(false);
    };
    globalThis.document?.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => globalThis.document?.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [helpOpen]);

  useEffect(() => {
    setHelpOpen(false);
  }, [skill?.id]);

  function command(type, payload = {}) {
    if (!onCommand || !ACTIONABLE_STATES.has(state) || expired) return;
    onCommand(type, { ...basePayload, commandId: commandId(), ...payload });
  }

  function choose(stepId, value) {
    const choices = { ...localChoices, [stepId]: value };
    setLocalChoices(choices);
    command("choice", { choiceId: stepId, value, choices });
  }

  function target(targetUserId) {
    command("target", { targetUserId });
  }

  function confirm() {
    if (!requiredChoicesComplete || !targetComplete) return;
    command("confirm", {
      targetUserId: selectedTargetId,
      choices: localChoices,
      option: pendingReactionOption,
    });
  }

  function cancel() {
    if (!cancelable) return;
    if (state === "reaction") {
      command("react", { option: "decline" });
      return;
    }
    command("cancel", {
      targetUserId: selectedTargetId,
      choices: localChoices,
      option: pendingReactionOption,
    });
  }

  function handleRootKeyDown(event) {
    if (event.key === "Escape" && helpOpen) {
      event.preventDefault();
      setHelpOpen(false);
      return;
    }
    if (event.key !== "Escape" || locked || state === "idle" || !cancelable) return;
    event.preventDefault();
    cancel();
  }

  const disabledReason = detailText(
    skillWindow?.disabledReason ?? skillWindow?.reason,
    skill
      ? skillWindow ? copy.description : "等待服务器开放本手技能窗口。"
      : "本手尚未装备公共技能。",
  );
  const countdownAnnouncement = [5, 3, 1].includes(seconds)
    ? `技能窗口还剩 ${seconds} 秒`
    : expired ? "技能窗口已结束" : "";
  const stateDescription = expired ? "窗口已结束，等待服务器更新。" : disabledReason;
  const statusClass = expired ? "expired" : state;
  const selectedTarget = targets.find(({ id }) => id === selectedTargetId);
  const firstEnabledTargetId = targets.find((candidate) => !candidate.disabled)?.id;
  const skillResult = privateResultCopy(latestPrivateResult(hextech, skill?.id), targets)
    ?? ongoingResultCopy(hextech, skill?.id, String(room?.self?.userId ?? ""), targets);
  const helpSteps = skillHelpSteps(skill);

  return (
    <section
      ref={rootRef}
      className={`hextech-skill-control state-${statusClass}`}
      data-skill-state={statusClass}
      data-control-rail="skill"
      aria-labelledby={titleId}
      aria-describedby={detailsId}
      aria-busy={isBusy}
      tabIndex={EXPANDED_STATES.has(state) ? -1 : undefined}
      onKeyDown={handleRootKeyDown}
    >
      <span className="hextech-skill-sr-only" role="status" aria-live="polite">
        {countdownAnnouncement}
      </span>

      <article className="hextech-skill-sticker" aria-label={skill ? `本手装备：${skill.name}` : "本手未装备技能"}>
        <span className="hextech-skill-sticker-tape" aria-hidden="true" />
        <span className="hextech-skill-sticker-art">
          {skill ? <img src={skillImage(skill.id)} srcSet={skillImageSrcSet(skill.id)} sizes="68px" width="128" height="128" alt="" decoding="async" /> : <LockKeyhole size={30} aria-hidden="true" />}
        </span>
        <span className="hextech-skill-sticker-copy">
          <small>{skill?.category ?? "公共技能"} · {skill?.rarity ?? "本手"}</small>
          <strong id={titleId}>{skill?.name ?? "尚未装备"}</strong>
          <em>{copy.eyebrow}</em>
        </span>
        {state === "consumed" && <b className="hextech-skill-stamp" aria-hidden="true">已用</b>}
      </article>

      <div className="hextech-skill-workspace" id={detailsId}>
        <header className="hextech-skill-workspace-head">
          <span>
            {state === "reaction" ? <ShieldAlert size={16} /> : state === "targeting" ? <Crosshair size={16} /> : <Sparkles size={16} />}
            <b>{expired ? "操作窗口已结束" : copy.title}</b>
          </span>
          {seconds !== null && (
            <time className={`hextech-skill-countdown ${seconds <= 3 ? "urgent" : ""}`}>
              <Clock3 size={14} aria-hidden="true" /> {seconds}s
            </time>
          )}
          {skill && (
            <div ref={helpRef} className={`hextech-skill-help ${helpOpen ? "is-open" : ""}`}>
              <button
                type="button"
                className="hextech-skill-help-trigger"
                aria-label={`查看${skill.name}技能说明`}
                aria-controls={helpId}
                aria-describedby={helpId}
                aria-expanded={helpOpen}
                onClick={() => setHelpOpen((open) => !open)}
              >
                <CircleHelp size={15} aria-hidden="true" />
                <span>说明</span>
              </button>
              <aside id={helpId} className="hextech-skill-help-popover" role="tooltip">
                <header>
                  <span><CircleHelp size={16} aria-hidden="true" /><b>{skill.name}</b></span>
                  <small>再次点击“说明”可关闭</small>
                </header>
                <p>{skill.summary}</p>
                <dl>
                  <div><dt>类型</dt><dd>{formatSkillMode(skill)}</dd></div>
                  <div><dt>时机</dt><dd>{skill.timing}</dd></div>
                  <div><dt>目标</dt><dd>{formatSkillTarget(skill)}</dd></div>
                  <div><dt>代价</dt><dd>{formatCost(skill.rules?.cost)}</dd></div>
                </dl>
                <div className="hextech-skill-help-steps">
                  <b>怎么使用</b>
                  <ol>{helpSteps.map((step) => <li key={step}>{step}</li>)}</ol>
                </div>
              </aside>
            </div>
          )}
        </header>

        <p className="hextech-skill-summary">{skill?.summary ?? stateDescription}</p>

        {skillResult && (
          <aside className="hextech-skill-private-result" aria-label="技能生效状态">
            <span>
              <small>{skillResult.eyebrow}</small>
              <strong>{skillResult.title}</strong>
              <p>{skillResult.description}</p>
            </span>
            {skillResult.cards.length > 0 && (
              <span className="hextech-skill-private-cards" aria-label="查看到的底牌">
                {skillResult.cards.map((card, index) => (
                  <PlayingCard card={card} small key={`${card}-${index}`} />
                ))}
              </span>
            )}
          </aside>
        )}

        {(state === "targeting" || (state === "armed" && targets.length > 0 && requiresTarget)) && (
          <div className="hextech-skill-target-panel">
            <span className="hextech-skill-panel-label"><Target size={14} /> 合法目标</span>
            {targets.length ? (
              <div className="hextech-skill-targets" role="listbox" aria-label="选择技能目标">
                {targets.map((entry) => {
                  const selected = entry.id === selectedTargetId;
                  return (
                    <button
                      type="button"
                      id={`hextech-target-${entry.id}`}
                      className={selected ? "selected" : ""}
                      role="option"
                      aria-selected={selected}
                      aria-label={`${entry.name}，${entry.characterName}${entry.reason ? `，${entry.reason}` : ""}`}
                      disabled={entry.disabled || locked}
                      tabIndex={(selected && !entry.disabled) || (!selectedTargetId && entry.id === firstEnabledTargetId) ? 0 : -1}
                      data-target-id={entry.id}
                      onClick={() => target(entry.id)}
                      onKeyDown={(event) => moveWithinGroup(event)}
                      key={entry.id}
                    >
                      <span><strong>{entry.name}</strong><small>{entry.characterName}{entry.isSelf ? " · 你" : ""}</small></span>
                      <em>{entry.disabled ? entry.reason : entry.chips === null ? "可选择" : `${entry.chips.toLocaleString("zh-CN")} 筹码`}</em>
                      {selected && <Check size={14} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="hextech-skill-empty"><CircleAlert size={14} /> 当前没有合法目标</p>
            )}
          </div>
        )}

        {steps.length > 0 && ["armed", "targeting", "confirming"].includes(state) && (
          <div className="hextech-skill-choice-stack">
            {steps.map((step) => (
              <fieldset className="hextech-skill-choice-group" key={step.id}>
                <legend>{step.label}{step.visibility === "private" ? <small>仅你可见</small> : null}</legend>
                {step.description && <p>{step.description}</p>}
                {step.options.length ? (
                  <div role="radiogroup" aria-label={step.label}>
                    {step.options.map((option, index) => {
                      const selected = isSameValue(localChoices[step.id], option.value);
                      const selectedOptionEnabled = step.options.some((candidate) => (
                        !candidate.disabled && isSameValue(localChoices[step.id], candidate.value)
                      ));
                      const firstEnabledIndex = step.options.findIndex((candidate) => !candidate.disabled);
                      return (
                        <button
                          type="button"
                          role="radio"
                          className={selected ? "selected" : ""}
                          aria-checked={selected}
                          aria-label={option.description ? `${option.label}，${option.description}` : option.label}
                          disabled={option.disabled || locked}
                          tabIndex={(selected && !option.disabled) || (!selectedOptionEnabled && index === firstEnabledIndex) ? 0 : -1}
                          data-choice-value={JSON.stringify(option.value)}
                          onClick={() => choose(step.id, option.value)}
                          onKeyDown={(event) => moveWithinGroup(event, (next) => {
                            const nextOption = step.options.find((candidate) => (
                              JSON.stringify(candidate.value) === next.dataset.choiceValue
                            ));
                            if (nextOption) choose(step.id, nextOption.value);
                          })}
                          key={`${step.id}-${String(option.value)}`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="hextech-skill-empty"><CircleAlert size={14} /> 等待服务器发放候选牌</p>
                )}
              </fieldset>
            ))}
          </div>
        )}

        {["idle", "armed", "targeting", "confirming", "reaction"].includes(state) && (
          <dl className={`hextech-skill-consequences ${state === "confirming" ? "" : "compact"}`}>
            {state === "confirming" && <div><dt>目标 / 选择</dt><dd>{selectedTarget?.name ?? (pendingReactionOption === "escape" ? "使用金蝉脱壳" : pendingReactionOption === "decline" ? "放弃反制" : steps.length ? "已按上方选择" : "无需选择")}</dd></div>}
            <div><dt>发动费用</dt><dd>{formatCost(skillWindow?.cost ?? skill?.rules?.cost)}</dd></div>
            <div><dt>最大风险</dt><dd>{formatRisk(skillWindow, skill)}</dd></div>
            <div><dt>对手反制</dt><dd>{formatCounterplay(skillWindow, skill)}</dd></div>
          </dl>
        )}

        {state === "resolving" && (
          <p className="hextech-skill-resolving" role="status">
            <LoaderCircle size={19} aria-hidden="true" /> 正在等待服务端返回唯一结算结果…
          </p>
        )}
        {(state === "disabled" || expired) && (
          <p className="hextech-skill-disabled-reason"><LockKeyhole size={14} /> {stateDescription}</p>
        )}
      </div>

      <footer className="hextech-skill-actions" aria-label="技能操作">
        {!expired && state === "idle" && !passive && (
          <button type="button" className="hextech-skill-primary" disabled={locked || !skill} onClick={() => command("arm")}>
            <Zap size={16} /> 撕开并发动
          </button>
        )}
        {!expired && state === "idle" && passive && (
          <p className="hextech-skill-passive"><ShieldAlert size={17} /> 被动贴纸已生效</p>
        )}
        {!expired && state === "armed" && canConfirmArmed && (
          <button type="button" className="hextech-skill-primary" disabled={locked} onClick={confirm}>
            <Check size={16} /> 进入确认
          </button>
        )}
        {!expired && state === "confirming" && (
          <button type="button" className="hextech-skill-primary danger" disabled={locked || !requiredChoicesComplete || !targetComplete} onClick={confirm}>
            <Check size={16} /> {pendingReactionOption === "escape" ? "确认支付并脱壳" : pendingReactionOption === "decline" ? "确认放弃反制" : "再次确认发动"}
          </button>
        )}
        {!expired && state === "reaction" && (
          <button type="button" className="hextech-skill-primary reaction" disabled={locked} onClick={() => command("react", { option: "escape" })}>
            <ShieldAlert size={16} /> 立即反制
          </button>
        )}
        {!expired && cancelable && ["armed", "targeting", "confirming", "reaction"].includes(state) && (
          <button type="button" className="hextech-skill-secondary" disabled={locked} onClick={cancel}>
            <Undo2 size={15} /> {state === "reaction" ? "放弃反制" : "取消技能"}
          </button>
        )}
        {!expired && state === "resolving" && <span className="hextech-skill-action-note"><LoaderCircle size={15} /> 结算中</span>}
        {!expired && state === "consumed" && <span className="hextech-skill-action-note"><Check size={15} /> 本手已消耗</span>}
        {!expired && state === "armed" && !canConfirmArmed && !cancelable && <span className="hextech-skill-action-note"><Clock3 size={15} /> {skillWindow?.disabledReason ?? "技能已武装，等待触发"}</span>}
        {(state === "disabled" || expired) && <span className="hextech-skill-action-note"><LockKeyhole size={15} /> 暂不可操作</span>}
        {!expired && !locked && cancelable && state !== "idle" && <small>按 Esc 可取消</small>}
      </footer>
    </section>
  );
}

export default HextechSkillControl;
