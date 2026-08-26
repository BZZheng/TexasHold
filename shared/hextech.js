import {
  WENGWENGWEN_CHARACTER,
  WENGWENGWEN_RULES,
} from "./hextech-wengwengwen.js";

export const ROOM_MODES = Object.freeze({
  CLASSIC: "classic",
  HEXTECH_CHAOS: "hextech-chaos",
});

export const HEXTECH_MODE = Object.freeze({
  id: ROOM_MODES.HEXTECH_CHAOS,
  name: "海克斯大乱德",
  minPlayers: 2,
  maxPlayers: 8,
  initialChips: 2000,
  rebuyAmount: 2000,
  maxRebuys: 3,
  maxHands: 15,
  draftSeconds: 60,
  rebuyDecisionSeconds: 30,
  freeRefreshes: 1,
});

export const HEXTECH_TARGET_BY_PLAYERS = Object.freeze({
  2: 4000,
  3: 5400,
  4: 6800,
  5: 8200,
  6: 9600,
  7: 11000,
  8: 12400,
});

export const HEXTECH_BLIND_LEVELS = Object.freeze([
  Object.freeze({ fromHand: 1, toHand: 3, smallBlind: 20, bigBlind: 40, actionSeconds: 60 }),
  Object.freeze({ fromHand: 4, toHand: 6, smallBlind: 30, bigBlind: 60, actionSeconds: 60 }),
  Object.freeze({ fromHand: 7, toHand: 9, smallBlind: 50, bigBlind: 100, actionSeconds: 60 }),
  Object.freeze({ fromHand: 10, toHand: 12, smallBlind: 80, bigBlind: 160, actionSeconds: 60 }),
  Object.freeze({ fromHand: 13, toHand: 15, smallBlind: 120, bigBlind: 240, actionSeconds: 60 }),
]);

export const HEXTECH_RULES_VERSION = 1;

export const HEXTECH_STREETS = Object.freeze(["preflop", "flop", "turn", "river"]);

export const HEXTECH_SKILL_WINDOWS = Object.freeze({
  PASSIVE_HAND: "passive-hand",
  BEFORE_ACTION: "before-action",
  STREET_START: "street-start",
  ON_SELF_ALL_IN: "on-self-all-in",
  BEFORE_SELF_ALL_IN: "before-self-all-in",
  BEFORE_BOARD_DEAL: "before-board-deal",
  AFTER_RIVER_DEAL: "after-river-deal",
  ON_HOLE_CARD_VIEW: "on-hole-card-view",
  ON_FORCED_CALL: "on-forced-call",
  ON_CHECK_RAISE: "on-check-raise",
  ON_POT_CHANGE: "on-pot-change",
  SHOWDOWN: "showdown",
  HAND_SETTLEMENT: "hand-settlement",
});

export const HEXTECH_TARGET_TYPES = Object.freeze({
  NONE: "none",
  SELF: "self",
  OPPONENT: "opponent",
  OWN_HOLE_CARD: "own-hole-card",
  GLOBAL: "global",
});

export const HEXTECH_RANK_CHOICES = Object.freeze([
  "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A",
]);

export const HEXTECH_SUIT_CHOICES = Object.freeze(["clubs", "diamonds", "hearts", "spades"]);

export const HEXTECH_HAND_CATEGORY_CHOICES = Object.freeze([
  "high-card",
  "one-pair",
  "two-pair",
  "three-of-a-kind",
  "straight",
  "flush",
  "full-house",
  "four-of-a-kind",
  "straight-flush",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const noTarget = () => ({ type: HEXTECH_TARGET_TYPES.NONE, minimum: 0, maximum: 0, filters: [] });
const selfTarget = () => ({ type: HEXTECH_TARGET_TYPES.SELF, minimum: 1, maximum: 1, filters: ["seated"] });
const opponentTarget = (...filters) => ({
  type: HEXTECH_TARGET_TYPES.OPPONENT,
  minimum: 1,
  maximum: 1,
  filters: filters.length ? filters : ["seated", "active-in-hand"],
});
const ownCardTarget = () => ({
  type: HEXTECH_TARGET_TYPES.OWN_HOLE_CARD,
  minimum: 1,
  maximum: 1,
  filters: ["non-blank-hole-card"],
});
const perHand = (limit = 1, owner = "player") => ({ scope: "hand", owner, limit });
const activation = (kind, windows, legalStreets, extra = {}) => ({
  kind,
  windows,
  legalStreets,
  requiresOwnAction: false,
  ...extra,
});
const enumStep = (id, label, options, visibility = "private") => ({
  id,
  kind: "enum",
  label,
  options,
  minimumSelections: 1,
  maximumSelections: 1,
  visibility,
});

const ALL_STREETS = HEXTECH_STREETS;
const POSTFLOP_STREETS = ["flop", "turn", "river"];
const TARGETED_DEFENSES = ["shield", "mirror"];
const VIEW_DEFENSES = ["shield", "mirror", "smoke-bomb", "fake-weak", "fake-strong"];

export const HEXTECH_CHARACTER_RULES = deepFreeze({
  fenxiang: {
    resource: { id: "courage", label: "胆识", maximum: 3, initial: 0, visibility: "public" },
    gain: {
      windows: ["after-call"],
      perScope: "hand",
      limit: 1,
      amount: 1,
      conditions: { startingStackAtMostAverageRatio: 0.7, minimumCallBigBlinds: 1 },
    },
    active: {
      id: "small-beats-big",
      windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
      legalStreets: ALL_STREETS,
      cost: 3,
      target: noTarget(),
      usage: perHand(),
      rewardTiers: [
        { opponentStartingStackRatio: 1.5, potRatio: 0.15, cap: 180 },
        { opponentStartingStackRatio: 2, potRatio: 0.25, cap: 300 },
        { opponentStartingStackRatio: 3, potRatio: 0.35, cap: 420 },
      ],
    },
    growth: {
      counters: [{ id: "largeOpponentPotsWon", target: 3, opponentStartingStackRatio: 1.5 }],
      allRequired: true,
    },
    awakening: {
      id: "short-stack-miracle",
      activeCost: 2,
      activeCostCondition: { startingStackBelowAverageRatio: 0.5 },
      maximumRewardCap: 480,
    },
  },
  xu: {
    resource: { id: "coal", label: "炭火", maximum: 4, initial: 0, visibility: "public" },
    gain: {
      windows: ["after-valid-action"],
      perScope: "street",
      limit: 1,
      amount: 1,
      conditions: {
        countdownRemainingAtMostSeconds: 2,
        excludeAutomaticActions: true,
        actions: ["call", "bet", "raise", "all-in"],
        minimumInvestmentBigBlinds: 1,
      },
    },
    active: {
      id: "barbecue",
      windows: [HEXTECH_SKILL_WINDOWS.STREET_START],
      legalStreets: ["preflop", "flop", "turn"],
      cost: 4,
      target: {
        type: HEXTECH_TARGET_TYPES.GLOBAL,
        minimum: 0,
        maximum: 0,
        filters: ["all-opponents-still-in-hand"],
      },
      usage: perHand(),
      opponentSecondsDelta: -15,
      minimumOpponentActionSeconds: 30,
      selfSecondsDelta: 10,
    },
    growth: {
      counters: [
        { id: "effectiveLateInvestments", target: 12 },
        { id: "distinctHandsWithEffectiveLateInvestment", target: 6 },
      ],
      allRequired: true,
    },
    awakening: {
      id: "master-of-fire",
      opponentSecondsDelta: -20,
      selfSecondsDelta: 15,
      bankPotContribution: 80,
    },
  },
  jiansheng: {
    resource: { id: "sword-intent", label: "剑意", maximum: 3, initial: 0, visibility: "public" },
    gain: {
      windows: ["after-flop-raise"],
      perScope: "hand",
      limit: 1,
      amount: 1,
      conditions: { minimumActivePlayers: 3, firstRaiseThisHand: true },
    },
    active: {
      id: "sword-pressure",
      windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
      legalStreets: ALL_STREETS,
      cost: 1,
      target: opponentTarget("active-in-hand", "can-raise"),
      usage: perHand(),
      nextRaiseTotalCap: "caster-street-committed",
    },
    growth: {
      counters: [
        { id: "distinctPlayersAffected", target: 3 },
        { id: "affectedPotsWon", target: 1 },
      ],
      allRequired: true,
    },
    awakening: {
      id: "sword-domain",
      activeCost: 3,
      maximumTargets: 2,
      duration: "street",
    },
  },
  ya: {
    resource: { id: "duck-feather", label: "鸭毛", maximum: 2, initial: 0, visibility: "public" },
    gain: {
      windows: ["after-showdown-from-early-aggressive-all-in"],
      perScope: "hand",
      limit: 1,
      amount: 1,
      conditions: {
        legalAllInStreets: ["preflop", "flop"],
        requiresAggressiveAllIn: true,
        allInCallDoesNotCount: true,
        requiresShowdown: true,
      },
    },
    active: {
      id: "river-current",
      windows: [HEXTECH_SKILL_WINDOWS.ON_SELF_ALL_IN],
      legalStreets: ["preflop", "flop"],
      cost: 2,
      target: noTarget(),
      usage: perHand(),
      conditions: {
        casterAllIn: true,
        earlyAggressiveAllIn: true,
        riverNotDealt: true,
      },
      replacementPolicy: "discard-natural-river-and-deal-next-deck-card",
    },
    growth: {
      counters: [
        { id: "earlyAggressiveAllInsReachingShowdown", target: 3 },
        { id: "earlyAggressiveAllInShowdownWins", target: 1 },
      ],
      allRequired: true,
    },
    awakening: {
      id: "light-boat-countercurrent",
      activeCost: 1,
      replacementPolicy: "discard-natural-river-and-deal-next-deck-card",
    },
  },
  qiwan: {
    resource: { id: "imagination", label: "奇想", maximum: 2, initial: 0, visibility: "public" },
    gain: {
      windows: ["after-preflop-raise-called"],
      perScope: "hand",
      limit: 1,
      amount: 1,
      conditions: { minimumRaiseBigBlinds: 4, mustBeCalled: true },
    },
    active: {
      id: "mystery-replacement",
      windows: [HEXTECH_SKILL_WINDOWS.ON_SELF_ALL_IN],
      legalStreets: ["preflop"],
      cost: 2,
      target: ownCardTarget(),
      usage: perHand(),
      conditions: { casterAllIn: true, flopNotDealt: true },
      replacementPolicy: "discard-selected-hole-card-and-deal-deck-top",
      choiceSchema: { type: "single", steps: [enumStep("holeCardIndex", "替换底牌", [0, 1])] },
    },
    growth: {
      counters: [
        { id: "replacementsCompleted", target: 2 },
        { id: "replacementUsedInFinalHand", target: 1 },
      ],
      allRequired: true,
    },
    awakening: {
      id: "inspiration-echo",
      resourceRefund: 1,
      refundConditions: {
        replacementUsedInBestFive: true,
        wonPot: true,
      },
    },
  },
  zige: {
    resource: { id: "ledger", label: "账本", maximum: null, initial: 0, visibility: "public" },
    gain: {
      windows: ["after-every-third-hand"],
      perScope: "three-hands",
      limit: 1,
      amount: null,
      conditions: { intervalHands: 3, availableStackInterestRatio: 0.03, interestCap: 100, excludeLoanedPrincipal: true },
    },
    active: {
      id: "public-loan",
      windows: ["between-hands"],
      legalStreets: [],
      cost: 0,
      target: opponentTarget("seated", "not-self", "can-accept-loan"),
      usage: { scope: "match", owner: "player", limit: null },
      principal: { minimum: 200, maximum: 600, step: 100 },
      durationHands: 3,
      interestRatio: 0.1,
      maximumOpenLoans: 1,
      requiresBorrowerAcceptance: true,
      overdueNetWinTransferRatio: 0.2,
      allowNegativeStack: false,
    },
    growth: {
      counters: [{ id: "loansSettledNormally", target: 3 }],
      allRequired: true,
    },
    awakening: {
      id: "central-banker",
      maximumOpenLoans: 2,
      normalSettlementBankReward: 30,
    },
    netAssets: {
      terms: ["availableStack", "receivablePrincipal", "accruedInterest", "negativeBorrowerDebt"],
      victoryTargetUsesAvailableStackOnly: true,
    },
  },
  mao: {
    resource: { id: "wangchai", label: "旺柴", maximum: 3, initial: 0, visibility: "public" },
    gain: {
      windows: ["after-correct-challenged-claim"],
      perScope: "claim",
      limit: 1,
      amount: 1,
      conditions: { challenged: true, naturalCardMatchesClaim: true },
    },
    active: {
      id: "suit-bewitchment",
      windows: [HEXTECH_SKILL_WINDOWS.BEFORE_BOARD_DEAL],
      legalStreets: ["turn", "river"],
      cost: 0,
      target: { type: HEXTECH_TARGET_TYPES.GLOBAL, minimum: 0, maximum: 0, filters: ["first-challenger-only"] },
      usage: perHand(),
      responseSeconds: 4,
      choiceSchema: { type: "single", steps: [enumStep("suit", "宣称花色", HEXTECH_SUIT_CHOICES, "public")] },
      noChallengeDealPolicy: "next-legal-card-of-claimed-suit",
      challenge: {
        validation: "natural-next-card",
        mismatchCasterPaysChallenger: 40,
        matchChallengerPaysPot: 40,
        matchResourceGain: 1,
      },
    },
    growth: {
      counters: [
        { id: "unchallengedClaimsResolved", target: 2 },
        { id: "correctChallengedClaims", target: 1 },
      ],
      allRequired: true,
    },
    awakening: {
      id: "true-bewitchment",
      resourceCost: 3,
      usage: { scope: "match", owner: "player", limit: 1 },
      candidateCount: 2,
      choiceSeconds: 6,
    },
  },
  wengwengwen: WENGWENGWEN_RULES,
});

export const HEXTECH_CHARACTERS = Object.freeze([
  Object.freeze({
    id: "fenxiang",
    name: "粉香",
    role: "残血逆袭",
    resource: "胆识",
    summary: "筹码越少，击败大筹码玩家时的额外收益越高。",
    passive: "起手筹码不高于桌均 70%，本手首次跟注至少 1BB 后获得 1 胆识。",
    active: "消耗 3 胆识发动以小搏大，击败筹码更多的对手可获得阶梯式银行奖励。",
    growth: "累计赢下 3 个对手起手筹码至少为自己 1.5 倍的底池。",
    awaken: "小筹码奇迹：低于桌均 50% 时只消耗 2 胆识，最高奖励上限 480。",
    rules: HEXTECH_CHARACTER_RULES.fenxiang,
  }),
  Object.freeze({
    id: "xu",
    name: "许哥",
    role: "时间控火",
    resource: "炭火",
    summary: "把最后几秒的有效操作变成资源，掌控下一街节奏。",
    passive: "在倒计时最后 2 秒手动跟注、下注、加注或全押，且实际投入至少 1BB，获得 1 炭火；每街最多 1。",
    active: "消耗 4 炭火发动烧烤：下一街所有仍在手对手时间 -15 秒（最低 30 秒），自己 +10 秒。",
    growth: "累计 12 次有效压秒投入，且至少覆盖 6 手牌。",
    awaken: "炉火纯青：烧烤升级为所有仍在手对手 -20 秒、自己 +15 秒，并向底池加入 80 银行筹码。",
    rules: HEXTECH_CHARACTER_RULES.xu,
  }),
  Object.freeze({
    id: "jiansheng",
    name: "剑圣哥",
    role: "下注压制",
    resource: "剑意",
    summary: "在多人翻牌池主动施压，把单体剑压成长为剑域。",
    passive: "翻牌仍有至少 3 人时完成本手首次加注，获得 1 剑意。",
    active: "消耗 1 剑意剑压一名玩家，限制其下一次加注总额。",
    growth: "影响 3 名不同玩家，并赢下其中至少 1 个底池。",
    awaken: "剑域：消耗 3 剑意，本街可同时剑压两名玩家。",
    rules: HEXTECH_CHARACTER_RULES.jiansheng,
  }),
  Object.freeze({
    id: "ya",
    name: "鸭哥",
    role: "逆流换河",
    resource: "鸭毛",
    summary: "在翻牌前或翻牌圈主动全押赴险，用不可预知的下一张牌改写河牌。",
    passive: "翻牌前或翻牌圈主动全押下注或加注，并实际进入摊牌，获得 1 鸭毛；全押跟注不算。",
    active: "消耗 2 鸭毛；每手一次，弃置原定自然河牌并改发牌堆顶下一张，不可选牌。",
    growth: "累计 3 次符合条件的主动全押进入摊牌，其中至少 1 次赢池。",
    awaken: "轻舟逆流：发动只消耗 1 鸭毛；仍只随机换一次河牌。",
    rules: HEXTECH_CHARACTER_RULES.ya,
  }),
  Object.freeze({
    id: "qiwan",
    name: "奇玩",
    role: "盲盒换牌",
    resource: "奇想",
    summary: "用大额翻前行动积攒奇想，全押时改造一张底牌。",
    passive: "翻牌前加注到至少 4BB 且被跟注，获得 1 奇想。",
    active: "消耗 2 奇想；每手一次，选择自己 1 张底牌弃置并从牌堆顶补 1 张，不可选择新牌。",
    growth: "完成 2 次换牌，且至少一次用换入牌组成最终牌型。",
    awaken: "灵感回响：觉醒后，换入牌进入最佳五张且赢池时返还 1 奇想。",
    rules: HEXTECH_CHARACTER_RULES.qiwan,
  }),
  Object.freeze({
    id: "zige",
    name: "资哥",
    role: "大银行家",
    resource: "账本",
    summary: "稳定结息并经营公开贷款，靠资金周转成长。",
    passive: "每 3 手按可用筹码结算 3% 利息，单次最多 100。",
    active: "发放 200–600 的 3 手期公开贷款，到期偿还本金加 10%。",
    growth: "累计 3 笔贷款按期或提前结清。",
    awaken: "总行长：同时最多 2 笔，正常结清时额外获得 30。",
    rules: HEXTECH_CHARACTER_RULES.zige,
  }),
  Object.freeze({
    id: "mao",
    name: "毛哥",
    role: "花色蛊惑",
    resource: "旺柴",
    summary: "在转牌与河牌前宣称花色，让全桌决定信或质疑。",
    passive: "转牌或河牌前宣称花色；无人质疑时发出该花色下一张合法牌。",
    active: "质疑触发自然牌验证，错误的一方向对方或底池支付 40。",
    growth: "2 次无人质疑成功，并完成 1 次被质疑后的正确预测。",
    awaken: "真蛊惑：消耗 3 旺柴，每场一次，从该花色 2 张候选中选 1 张。",
    rules: HEXTECH_CHARACTER_RULES.mao,
  }),
  WENGWENGWEN_CHARACTER,
]);

const skillRule = ({
  kind,
  windows,
  legalStreets = ALL_STREETS,
  requiresOwnAction = false,
  target = noTarget(),
  usage = perHand(),
  cost = null,
  maximumChipRisk = 0,
  probabilities = [],
  counterplay = [],
  defense = null,
  requiresConfirmation = false,
  choiceSchema = null,
  effect = {},
  cheat = false,
}) => ({
  activation: activation(kind, windows, legalStreets, { requiresOwnAction }),
  target,
  usage,
  cost,
  maximumChipRisk,
  probabilities,
  counterplay,
  defense,
  requiresConfirmation,
  choiceSchema,
  effect,
  audit: { cheat },
});

const fixedStackCost = (amount, destination = "pot") => ({
  type: "fixed",
  source: "available-stack",
  destination,
  amount,
});

export const HEXTECH_SKILL_RULES = deepFreeze({
  "fake-weak": skillRule({
    kind: "passive",
    windows: [HEXTECH_SKILL_WINDOWS.ON_HOLE_CARD_VIEW],
    usage: perHand(1),
    effect: { type: "replace-view-payload", shownCards: ["7c", "2d"], preserveRealCards: true },
    cheat: true,
  }),
  "fake-strong": skillRule({
    kind: "passive",
    windows: [HEXTECH_SKILL_WINDOWS.ON_HOLE_CARD_VIEW],
    usage: perHand(1),
    effect: { type: "replace-view-payload", shownCards: ["As", "Ah"], preserveRealCards: true },
    cheat: true,
  }),
  xray: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    requiresOwnAction: true,
    target: opponentTarget("active-in-hand", "has-hole-cards"),
    probabilities: [
      { id: "success", probability: 0.6 },
      { id: "failure", probability: 0.4 },
    ],
    counterplay: VIEW_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "private-hole-card-view", successDuration: "street", failureRevealsCards: false },
    cheat: true,
  }),
  "mind-read": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    requiresOwnAction: true,
    target: opponentTarget("active-in-hand"),
    counterplay: TARGETED_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "public-behavior-tendency", values: ["conservative", "follower", "aggressive"], revealsHoleCards: false },
  }),
  "public-reveal": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: POSTFLOP_STREETS,
    requiresOwnAction: true,
    target: opponentTarget("active-in-hand", "has-hole-cards"),
    cost: fixedStackCost(80),
    maximumChipRisk: 80,
    counterplay: VIEW_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "public-random-hole-card-view", cardCount: 1, durationSeconds: 4 },
  }),
  charm: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.ON_SELF_ALL_IN],
    target: opponentTarget("active-in-hand", "can-call"),
    counterplay: ["shield", "mirror", "escape"],
    requiresConfirmation: true,
    effect: {
      type: "forced-call",
      maximumTargetStartingStackRatio: 0.3,
      maximumTargetCommitment: 600,
      capPolicy: "minimum",
    },
  }),
  intimidate: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    requiresOwnAction: true,
    target: opponentTarget("active-in-hand", "can-raise"),
    counterplay: TARGETED_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "next-raise-total-cap", cap: "caster-street-committed", affectsCall: false, affectsExistingAllIn: false },
  }),
  silence: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.STREET_START],
    target: opponentTarget("active-in-hand"),
    counterplay: TARGETED_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "disable-active-public-skill", duration: "street", allowsPassiveDefense: true },
  }),
  "peace-treaty": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    requiresOwnAction: true,
    target: opponentTarget("active-in-hand"),
    counterplay: TARGETED_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "mutual-no-raise", duration: "street", allowedActions: ["check", "call", "fold"] },
  }),
  disarm: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: opponentTarget("active-in-hand", "unused-active-equipment"),
    counterplay: TARGETED_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "consume-target-active-equipment", onlyUnused: true, targetBankCompensation: 80 },
  }),
  gambler: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: ownCardTarget(),
    probabilities: [
      { id: "chosen-rank", probability: 0.3 },
      { id: "small-rank", probability: 0.6 },
      { id: "unchanged", probability: 0.099 },
      { id: "blank", probability: 0.001 },
    ],
    requiresConfirmation: true,
    choiceSchema: {
      type: "sequence",
      steps: [
        enumStep("holeCardIndex", "选择底牌", [0, 1]),
        enumStep("rank", "目标点数", HEXTECH_RANK_CHOICES),
      ],
    },
    effect: {
      type: "probabilistic-hole-card-transform",
      chosenRankPreservesSuit: true,
      smallRankChoices: ["2", "3", "4", "5", "6"],
      blankHasRank: false,
      blankHasSuit: false,
      blankExcludedFromHandEvaluation: true,
    },
    cheat: true,
  }),
  reforge: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: ownCardTarget(),
    requiresConfirmation: true,
    choiceSchema: { type: "single", steps: [enumStep("holeCardIndex", "弃置底牌", [0, 1])] },
    effect: { type: "random-hole-card-replacement", revealDiscard: false, reversible: false },
  }),
  prophet: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: selfTarget(),
    maximumChipRisk: 80,
    requiresConfirmation: true,
    choiceSchema: { type: "single", steps: [enumStep("suit", "翻牌多数花色", HEXTECH_SUIT_CHOICES)] },
    effect: { type: "predict-flop-majority-suit", successBankReward: 160, failurePotPayment: 80 },
  }),
  "swap-trick": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_BOARD_DEAL],
    legalStreets: ["turn"],
    target: ownCardTarget(),
    requiresConfirmation: true,
    choiceSchema: { type: "single", steps: [enumStep("holeCardIndex", "换出底牌", [0, 1])] },
    effect: { type: "random-hole-card-replacement", revealDiscard: true, reversible: false },
    cheat: true,
  }),
  "river-veto": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.AFTER_RIVER_DEAL],
    legalStreets: ["river"],
    target: { type: HEXTECH_TARGET_TYPES.GLOBAL, minimum: 0, maximum: 0, filters: [] },
    usage: perHand(1, "table"),
    cost: fixedStackCost(120, "bank"),
    maximumChipRisk: 120,
    requiresConfirmation: true,
    effect: { type: "discard-and-redeal-river", discardVisible: true, globalOncePerHand: true },
  }),
  shield: skillRule({
    kind: "passive",
    windows: [HEXTECH_SKILL_WINDOWS.PASSIVE_HAND],
    defense: { type: "block", appliesTo: ["targeted-public-skill"], charges: 1, priority: 1 },
    effect: { type: "defense" },
  }),
  mirror: skillRule({
    kind: "passive",
    windows: [HEXTECH_SKILL_WINDOWS.PASSIVE_HAND],
    defense: {
      type: "reflect-or-block",
      appliesTo: ["targeted-public-skill"],
      charges: 1,
      priority: 1,
      reflectWhenCasterIsLegalTarget: true,
    },
    effect: { type: "defense" },
  }),
  "smoke-bomb": skillRule({
    kind: "passive",
    windows: [HEXTECH_SKILL_WINDOWS.ON_HOLE_CARD_VIEW],
    defense: { type: "force-view-failure", appliesTo: ["hole-card-view"], charges: 1, sourceVisibility: "secret", priority: 1 },
    effect: { type: "defense" },
  }),
  escape: skillRule({
    kind: "reaction",
    windows: [HEXTECH_SKILL_WINDOWS.ON_FORCED_CALL],
    target: selfTarget(),
    cost: {
      type: "clamped-ratio",
      source: "remaining-stack",
      destination: "bank",
      ratio: 0.1,
      minimum: 80,
      maximum: 160,
    },
    maximumChipRisk: 160,
    requiresConfirmation: true,
    effect: { type: "remove-forced-call", charges: 1 },
  }),
  "catch-cheater": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop", "flop", "turn"],
    requiresOwnAction: true,
    target: opponentTarget("seated", "active-in-hand"),
    maximumChipRisk: 100,
    counterplay: TARGETED_DEFENSES,
    requiresConfirmation: true,
    effect: {
      type: "audit-cheat-use",
      successPaymentPerOtherSeatedPlayer: 100,
      successTargetExitsHand: true,
      failureCasterPaysTarget: 100,
    },
  }),
  "pot-bomb": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: { type: HEXTECH_TARGET_TYPES.GLOBAL, minimum: 0, maximum: 0, filters: [] },
    requiresConfirmation: true,
    effect: { type: "bank-pot-threshold", threshold: 800, bankPotContribution: 120, firstThresholdOnly: true },
  }),
  "raise-cap": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.STREET_START],
    target: { type: HEXTECH_TARGET_TYPES.GLOBAL, minimum: 0, maximum: 0, filters: ["all-active-players"] },
    requiresConfirmation: true,
    effect: { type: "global-raise-increment-cap", maximumBigBlinds: 3, includesCaster: true, duration: "street" },
  }),
  "duel-contract": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: opponentTarget("active-in-hand"),
    counterplay: TARGETED_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "showdown-duel-reward", requireBothAtShowdown: true, winnerBankReward: 180 },
  }),
  "last-stand": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_SELF_ALL_IN],
    target: selfTarget(),
    requiresConfirmation: true,
    effect: {
      type: "all-in-loss-refund",
      eligibilityStartingStackBelowAverageRatio: 0.35,
      refundLossRatio: 0.25,
      refundCap: 300,
    },
  }),
  "check-raise-hunter": skillRule({
    kind: "reaction",
    windows: [HEXTECH_SKILL_WINDOWS.ON_CHECK_RAISE],
    target: opponentTarget("active-in-hand", "triggered-check-raise"),
    counterplay: VIEW_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "private-random-hole-card-view", cardCount: 1, duration: "until-caster-action-ends", firstPerStreetOnly: true },
  }),
  insurance: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: selfTarget(),
    cost: fixedStackCost(60, "bank"),
    maximumChipRisk: 60,
    requiresConfirmation: true,
    effect: { type: "all-in-loss-refund", refundLossRatio: 0.25, refundCap: 300 },
  }),
  bounty: skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: opponentTarget("active-in-hand"),
    counterplay: TARGETED_DEFENSES,
    requiresConfirmation: true,
    effect: { type: "showdown-bounty", casterWinBankReward: 180, targetWinBankReward: 80 },
  }),
  "hand-prediction": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: selfTarget(),
    maximumChipRisk: 60,
    requiresConfirmation: true,
    choiceSchema: { type: "single", steps: [enumStep("handCategory", "最终牌型", HEXTECH_HAND_CATEGORY_CHOICES)] },
    effect: { type: "predict-final-hand-category", successBankReward: 240, failurePotPayment: 60 },
  }),
  "stop-loss": skillRule({
    kind: "passive",
    windows: [HEXTECH_SKILL_WINDOWS.SHOWDOWN],
    target: selfTarget(),
    effect: { type: "showdown-large-pot-loss-refund", minimumPot: 800, bankRefund: 100 },
  }),
  "fixed-deposit": skillRule({
    kind: "active",
    windows: [HEXTECH_SKILL_WINDOWS.BEFORE_ACTION],
    legalStreets: ["preflop"],
    requiresOwnAction: true,
    target: selfTarget(),
    cost: { type: "lock-stack", source: "available-stack", destination: "escrow", amount: 200 },
    maximumChipRisk: 200,
    requiresConfirmation: true,
    effect: { type: "street-duration-deposit", riverReturn: 230, earlyFoldReturn: 180 },
  }),
});

const skill = (id, name, category, rarity, timing, summary, kind, cheat = false) => Object.freeze({
  id, name, category, rarity, timing, summary, kind, cheat, rules: HEXTECH_SKILL_RULES[id],
});

export const HEXTECH_SKILLS = Object.freeze([
  skill("fake-weak", "装糖阴你一手", "情报", "普通", "被动 · 本手", "对手成功查看你的底牌时看到 7♣2♦，真实底牌不变。", "passive", true),
  skill("fake-strong", "装阴糖你一手", "情报", "普通", "被动 · 本手", "对手成功查看你的底牌时看到 A♠A♥，真实底牌不变。", "passive", true),
  skill("xray", "透视眼", "情报", "稀有", "行动前", "指定仍在本手的对手，60% 成功查看其底牌至本街结束。", "player", true),
  skill("mind-read", "读心术", "情报", "普通", "行动前", "显示目标当前可公开推导的行动倾向。", "player"),
  skill("public-reveal", "明牌审判", "情报", "稀有", "翻牌后", "向底池支付 80，随机公开目标 1 张底牌 4 秒。", "confirm-player"),
  skill("charm", "魅惑", "控制", "金色", "你全押时", "目标被迫跟至其起手筹码 30% 或 600 的较低者。", "confirm-player"),
  skill("intimidate", "恐吓玩家", "控制", "普通", "你的行动前", "目标下一次加注总额不能超过你本街已投入总额。", "player"),
  skill("silence", "沉默是金", "控制", "稀有", "本街开始", "目标本街不能主动发动公共技能。", "player"),
  skill("peace-treaty", "和平条约", "控制", "普通", "行动前", "你与目标本街不能互相加注。", "player"),
  skill("disarm", "缴械", "控制", "稀有", "翻牌前", "目标未发动的主动装备失效，并获得 80 补偿。", "confirm-player"),
  skill("gambler", "我是赌圣", "变牌", "金色", "翻牌前", "选择底牌与目标点数，按 30% / 60% / 9.9% / 0.1% 结果变牌。", "self-card", true),
  skill("reforge", "回炉重造", "变牌", "普通", "翻牌前", "弃掉自己的 1 张底牌，从剩余牌堆随机补 1 张。", "confirm-self-card"),
  skill("prophet", "预言家", "变牌", "普通", "翻牌前", "预测翻牌多数花色；命中获 160，未中支付 80。", "confirm-choice"),
  skill("swap-trick", "偷梁换柱", "变牌", "稀有", "转牌前", "将 1 张底牌换成牌堆随机牌，换出的牌公开弃置。", "confirm-self-card", true),
  skill("river-veto", "河牌否决", "变牌", "金色", "河牌行动前", "支付 120，弃置刚发出的河牌并重发；全桌每手一次。", "confirm"),
  skill("shield", "技能护盾", "防御", "普通", "被动 · 本手", "抵挡第一个以你为目标的公共技能。", "passive"),
  skill("mirror", "反弹镜", "防御", "稀有", "被动 · 本手", "第一个指向你的技能可反弹；施法者非法时仅抵挡。", "passive"),
  skill("smoke-bomb", "烟雾弹", "防御", "普通", "被查看时", "使一次查看你底牌的效果失败，且不公开来源。", "passive"),
  skill("escape", "金蝉脱壳", "防御", "稀有", "被强制跟注时", "支付剩余筹码 10%，最低 80、最高 160，解除强制跟注。", "reaction"),
  skill("catch-cheater", "抓老千", "防御", "金色", "河牌前", "指认作弊玩家；抓中其向其他玩家各付 100，误抓则你付 100。", "confirm-player"),
  skill("pot-bomb", "底池炸弹", "战术", "普通", "翻牌前", "底池首次达到 800 时，银行加入 120。", "confirm"),
  skill("raise-cap", "限高令", "战术", "普通", "本街开始", "本街所有单次加注增量最多 3BB。", "confirm"),
  skill("duel-contract", "单挑契约", "战术", "稀有", "翻牌前", "指定对手；只有双方进入摊牌时胜者获 180。", "player"),
  skill("last-stand", "背水一战", "战术", "稀有", "全押前", "低于桌均 35% 时全押落败返还 25%，最多 300。", "confirm"),
  skill("check-raise-hunter", "后手猎人", "战术", "普通", "对手过牌加注后", "首次有人过牌加注，可查看其随机 1 张底牌。", "reaction"),
  skill("insurance", "保险单", "经济", "普通", "翻牌前", "支付 60；全押落败返还损失 25%，最多 300。", "confirm"),
  skill("bounty", "悬赏令", "经济", "普通", "翻牌前", "标记目标；摊牌击败目标获 180，被击败时目标获 80。", "player"),
  skill("hand-prediction", "牌型预报", "经济", "稀有", "翻牌前", "预测自己的最终牌型；命中获 240，未中支付 60。", "confirm-choice"),
  skill("stop-loss", "止损协议", "经济", "普通", "被动 · 本手", "摊牌输掉至少 800 的底池时返还 100。", "passive"),
  skill("fixed-deposit", "定期存款", "经济", "普通", "翻牌前", "锁定 200；坚持到河牌返还 230，提前弃牌返还 180。", "confirm"),
]);

export const HEXTECH_CHARACTER_IDS = Object.freeze(HEXTECH_CHARACTERS.map(({ id }) => id));
export const HEXTECH_SKILL_IDS = Object.freeze(HEXTECH_SKILLS.map(({ id }) => id));

export function normalizeRoomMode(mode) {
  if (mode == null || mode === "") return ROOM_MODES.CLASSIC;
  if (mode === ROOM_MODES.CLASSIC || mode === ROOM_MODES.HEXTECH_CHAOS) return mode;
  throw new Error("房间模式不正确");
}

export function isHextechMode(mode) {
  return mode === ROOM_MODES.HEXTECH_CHAOS;
}

export function hextechTargetForPlayers(playerCount) {
  const target = HEXTECH_TARGET_BY_PLAYERS[playerCount];
  if (!target) throw new Error("海克斯模式仅支持 2–8 名玩家");
  return target;
}

export function hextechBlindForHand(handNumber) {
  if (!Number.isSafeInteger(handNumber) || handNumber < 1 || handNumber > HEXTECH_MODE.maxHands) {
    throw new Error(`海克斯手数需要是 1–${HEXTECH_MODE.maxHands} 的整数`);
  }
  return HEXTECH_BLIND_LEVELS.find(({ fromHand, toHand }) => (
    handNumber >= fromHand && handNumber <= toHand
  ));
}

export function isHextechCharacterId(characterId) {
  return HEXTECH_CHARACTER_IDS.includes(characterId);
}

export function isHextechSkillId(skillId) {
  return HEXTECH_SKILL_IDS.includes(skillId);
}

export function hextechCharacter(characterId) {
  return HEXTECH_CHARACTERS.find(({ id }) => id === characterId) ?? null;
}

export function hextechSkill(skillId) {
  return HEXTECH_SKILLS.find(({ id }) => id === skillId) ?? null;
}

function validateChoiceSchema(schema, path, errors, { allowDynamicOptions = false } = {}) {
  if (schema == null) return;
  if (!schema || typeof schema !== "object" || !Array.isArray(schema.steps) || schema.steps.length === 0) {
    errors.push(`${path} choiceSchema 必须包含至少一个步骤`);
    return;
  }
  const stepIds = new Set();
  for (const [index, step] of schema.steps.entries()) {
    const stepPath = `${path}.steps[${index}]`;
    if (!step?.id || stepIds.has(step.id)) errors.push(`${stepPath} id 缺失或重复`);
    stepIds.add(step?.id);
    if (step?.kind !== "enum") errors.push(`${stepPath} kind 目前必须为 enum`);
    if (!Array.isArray(step?.options)) {
      errors.push(`${stepPath} options 必须是数组`);
    } else {
      if (!allowDynamicOptions && step.options.length === 0) errors.push(`${stepPath} options 不能为空`);
      if (new Set(step.options).size !== step.options.length) errors.push(`${stepPath} options 不能重复`);
    }
    if (step?.minimumSelections !== 1 || step?.maximumSelections !== 1) {
      errors.push(`${stepPath} v1 必须单选`);
    }
  }
}

export function validateHextechRuleContract({
  skills = HEXTECH_SKILLS,
  characters = HEXTECH_CHARACTERS,
} = {}) {
  const errors = [];
  const windowIds = new Set(Object.values(HEXTECH_SKILL_WINDOWS));
  const streetIds = new Set(HEXTECH_STREETS);
  const skillIds = skills.map(({ id }) => id);
  const characterIds = characters.map(({ id }) => id);

  if (skills.length !== 30) errors.push(`公共技能数量应为 30，当前为 ${skills.length}`);
  if (characters.length !== 8) errors.push(`人物数量应为 8，当前为 ${characters.length}`);
  if (new Set(skillIds).size !== skillIds.length) errors.push("公共技能 id 必须唯一");
  if (new Set(characterIds).size !== characterIds.length) errors.push("人物 id 必须唯一");

  for (const current of skills) {
    const path = `skill:${current.id ?? "unknown"}`;
    const rules = current.rules;
    if (!rules) {
      errors.push(`${path} 缺少 rules`);
      continue;
    }
    if (!new Set(["active", "passive", "reaction"]).has(rules.activation?.kind)) {
      errors.push(`${path} activation.kind 不合法`);
    }
    if (!Array.isArray(rules.activation?.windows) || rules.activation.windows.length === 0) {
      errors.push(`${path} 必须声明合法窗口`);
    } else {
      for (const windowId of rules.activation.windows) {
        if (!windowIds.has(windowId)) errors.push(`${path} 包含未知窗口 ${windowId}`);
      }
    }
    if (!Array.isArray(rules.activation?.legalStreets)) {
      errors.push(`${path} legalStreets 必须是数组`);
    } else {
      for (const street of rules.activation.legalStreets) {
        if (!streetIds.has(street)) errors.push(`${path} 包含未知下注街 ${street}`);
      }
    }
    if (!Object.values(HEXTECH_TARGET_TYPES).includes(rules.target?.type)) {
      errors.push(`${path} target.type 不合法`);
    }
    if (!Number.isSafeInteger(rules.usage?.limit) || rules.usage.limit < 1) {
      errors.push(`${path} usage.limit 必须是正整数`);
    }
    if (!Number.isFinite(rules.maximumChipRisk) || rules.maximumChipRisk < 0) {
      errors.push(`${path} maximumChipRisk 不合法`);
    }
    if (!Array.isArray(rules.probabilities)) {
      errors.push(`${path} probabilities 必须是数组`);
    } else if (rules.probabilities.length > 0) {
      const total = rules.probabilities.reduce((sum, outcome) => sum + outcome.probability, 0);
      if (Math.abs(total - 1) > 1e-9) errors.push(`${path} 概率和必须为 1，当前为 ${total}`);
      if (rules.probabilities.some(({ probability }) => !Number.isFinite(probability) || probability < 0 || probability > 1)) {
        errors.push(`${path} 概率必须介于 0 与 1`);
      }
      if (new Set(rules.probabilities.map(({ id }) => id)).size !== rules.probabilities.length) {
        errors.push(`${path} 概率结果 id 必须唯一`);
      }
    }
    if (!Array.isArray(rules.counterplay)) errors.push(`${path} counterplay 必须是数组`);
    if (Boolean(current.cheat) !== Boolean(rules.audit?.cheat)) {
      errors.push(`${path} 作弊标签与 audit.cheat 不一致`);
    }

    const targetedOrIrreversible = rules.activation?.kind !== "passive" && (
      rules.target?.type !== HEXTECH_TARGET_TYPES.NONE
      || rules.maximumChipRisk > 0
      || rules.effect?.reversible === false
      || rules.effect?.type === "discard-and-redeal-river"
    );
    if (targetedOrIrreversible && !rules.requiresConfirmation) {
      errors.push(`${path} 涉及目标、筹码或不可逆效果时必须二次确认`);
    }
    validateChoiceSchema(rules.choiceSchema, path, errors);
    if (current.kind === "confirm-choice" && !rules.choiceSchema) {
      errors.push(`${path} confirm-choice 必须提供 choiceSchema`);
    }
  }

  const gambler = skills.find(({ id }) => id === "gambler");
  const gamblerRanks = gambler?.rules?.choiceSchema?.steps?.find(({ id }) => id === "rank")?.options;
  if (!gamblerRanks || gamblerRanks.length !== 13 || HEXTECH_RANK_CHOICES.some((rank) => !gamblerRanks.includes(rank))) {
    errors.push("skill:gambler 必须提供完整 13 个目标点数");
  }

  for (const current of characters) {
    const path = `character:${current.id ?? "unknown"}`;
    const rules = current.rules;
    if (!rules) {
      errors.push(`${path} 缺少 rules`);
      continue;
    }
    const maximum = rules.resource?.maximum;
    if (!rules.resource?.id || !rules.resource?.label || (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 1))) {
      errors.push(`${path} resource 配置不完整`);
    }
    if (!Array.isArray(rules.gain?.windows) || rules.gain.windows.length === 0 || !rules.gain?.perScope) {
      errors.push(`${path} gain 必须声明获取窗口与频率`);
    }
    if (!rules.active?.id || !Number.isFinite(rules.active?.cost) || rules.active.cost < 0) {
      errors.push(`${path} active 必须声明非负资源消耗`);
    }
    if (!Array.isArray(rules.active?.legalStreets)) errors.push(`${path} active.legalStreets 必须是数组`);
    if (!Array.isArray(rules.growth?.counters) || rules.growth.counters.length === 0) {
      errors.push(`${path} growth 必须声明觉醒进度`);
    } else if (rules.growth.counters.some(({ id, target }) => !id || !Number.isFinite(target) || target <= 0)) {
      errors.push(`${path} growth counters 必须包含正数门槛`);
    }
    if (!rules.awakening?.id) errors.push(`${path} awakening.id 缺失`);
    validateChoiceSchema(rules.active?.choiceSchema, `${path}.active`, errors, { allowDynamicOptions: true });
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function assertValidHextechRuleContract(options) {
  const result = validateHextechRuleContract(options);
  if (!result.valid) throw new Error(`海克斯规则契约无效：${result.errors.join("；")}`);
  return true;
}
