export const DEFAULT_PLAYER_TITLE = "牌桌新秀";

export const AVATAR_TONES = Object.freeze([
  { id: "gold", label: "赭金" },
  { id: "blue", label: "湖蓝" },
  { id: "clay", label: "陶红" },
  { id: "sage", label: "鼠尾草" },
  { id: "plum", label: "暮紫" },
]);

export const ACHIEVEMENT_CATEGORIES = Object.freeze(["全部", "胜利", "技术", "纪律", "倒霉蛋", "彩蛋"]);

export const ACHIEVEMENT_RARITIES = Object.freeze({
  common: Object.freeze({ id: "common", label: "常见", order: 1 }),
  rare: Object.freeze({ id: "rare", label: "稀有", order: 2 }),
  epic: Object.freeze({ id: "epic", label: "史诗", order: 3 }),
  legendary: Object.freeze({ id: "legendary", label: "传说", order: 4 }),
});

// Some achievements can already be derived from the compact settlement history.
// The rest stay at zero until their corresponding authoritative game event is
// recorded; the client never fabricates progress.
const ACHIEVEMENT_DEFINITIONS = [
  { id: "first-hand", title: "初登牌桌", description: "完成第一局牌局", category: "胜利", icon: "Ⅰ", metric: "hands", target: 1 },
  { id: "first-profit", title: "第一桶金", description: "单局净赢超过 500 分", category: "胜利", icon: "金", metric: "largestWin", target: 500 },
  { id: "river-comeback", title: "河牌逆转", description: "河牌阶段反超并赢下底池", category: "胜利", icon: "↗" },
  { id: "all-in-brave", title: "全押勇者", description: "通过 All in 赢下 3 次底池", category: "胜利", icon: "◆" },
  { id: "regular", title: "常客牌友", description: "累计完成 50 局牌局", category: "胜利", icon: "50", metric: "hands", target: 50 },
  { id: "blind-keeper", title: "盲注守门员", description: "在盲注位赢下 10 局", category: "胜利", icon: "盲" },
  { id: "flop-hit", title: "翻牌击中", description: "翻牌直接组成两对或更好", category: "胜利", icon: "♣" },
  { id: "quads-witness", title: "四条见证人", description: "见证或完成一次四条", category: "胜利", icon: "四" },
  { id: "royal-dream", title: "皇家同花梦", description: "组成一次皇家同花顺", category: "胜利", icon: "A" },
  { id: "legendary-hand", title: "一手封神", description: "单局赢得 2,000 分以上", category: "胜利", icon: "封", metric: "largestWin", target: 2000 },
  { id: "river-finish", title: "绝杀河牌", description: "河牌赢下最大底池", category: "胜利", icon: "绝" },
  { id: "top-ranked", title: "积分登顶", description: "登上实时积分榜第 1 名", category: "胜利", icon: "冠" },

  { id: "precise-raise", title: "精准加注", description: "加注后连续获得两次跟注", category: "技术", icon: "＋" },
  { id: "value-bet", title: "价值下注", description: "摊牌前后连续三次价值下注成功", category: "技术", icon: "值" },
  { id: "trap", title: "诱捕成功", description: "用慢打赢下超过 1,000 分底池", category: "技术", icon: "钩" },
  { id: "bluff-master", title: "诈唬大师", description: "诈唬赢下 5 次摊牌前底池", category: "技术", icon: "骗" },
  { id: "reverse-read", title: "反向读牌", description: "准确判断对手成牌类型 10 次", category: "技术", icon: "读" },
  { id: "position-aware", title: "位置意识", description: "利用位置优势赢下 8 个底池", category: "技术", icon: "位" },
  { id: "pot-control", title: "底池控制", description: "用过牌控制底池并赢下 10 局", category: "技术", icon: "控" },
  { id: "odds-calculator", title: "赔率计算器", description: "在正确赔率下完成 20 次跟注", category: "技术", icon: "算" },
  { id: "clockwork", title: "行动如钟", description: "连续 20 次在 10 秒内完成操作", category: "技术", icon: "钟" },
  { id: "cool-fold", title: "冷静弃牌", description: "弃掉第三强牌并避免损失 500 分", category: "技术", icon: "弃" },
  { id: "time-master", title: "延时专家", description: "使用加时卡后成功赢下底池", category: "技术", icon: "时" },
  { id: "preflop-scout", title: "翻前观察员", description: "翻前准确识别对手范围 10 次", category: "技术", icon: "观" },

  { id: "unhurried", title: "不急不躁", description: "连续 5 局没有超时", category: "纪律", icon: "稳" },
  { id: "check-chain", title: "连续过牌", description: "单局连续过牌 3 次并获胜", category: "纪律", icon: "过" },
  { id: "blind-orbit", title: "盲注轮回", description: "完整经历 20 次大小盲轮转", category: "纪律", icon: "轮" },
  { id: "steady-player", title: "稳健牌友", description: "连续 10 局保持正积分", category: "纪律", icon: "稳", metric: "maxWinStreak", target: 10 },
  { id: "fifty-hands", title: "五十局纪念", description: "累计完成 50 局牌局", category: "纪律", icon: "50", metric: "hands", target: 50 },
  { id: "hundred-hands", title: "百局里程碑", description: "累计完成 100 局牌局", category: "纪律", icon: "100", metric: "hands", target: 100 },
  { id: "seven-day-run", title: "积分长跑", description: "连续 7 天都有牌局记录", category: "纪律", icon: "跑" },
  { id: "spectator-scout", title: "观战侦察兵", description: "观战 10 局后成功入座", category: "纪律", icon: "眼" },
  { id: "record-collector", title: "记录收藏家", description: "查看过 30 条历史牌局记录", category: "纪律", icon: "册" },
  { id: "seat-switcher", title: "换位达人", description: "完成 5 次下一局换位", category: "纪律", icon: "换" },
  { id: "chat-crew", title: "聊天气氛组", description: "发送 30 条快捷语或表情", category: "纪律", icon: "聊" },
  { id: "polite-player", title: "礼貌玩家", description: "连续 20 局没有恶意刷屏", category: "纪律", icon: "礼" },

  { id: "unlucky", title: "倒霉蛋", description: "连续 5 局净输分", category: "倒霉蛋", icon: "霉", metric: "maxLossStreak", target: 5 },
  { id: "rivered", title: "河牌被反杀", description: "领先到河牌却输掉底池 3 次", category: "倒霉蛋", icon: "河" },
  { id: "four-two", title: "四二撞坚果", description: "用 42 对上对手坚果", category: "倒霉蛋", icon: "42" },
  { id: "last-second", title: "领先到最后一秒", description: "转牌领先，河牌被反超 5 次", category: "倒霉蛋", icon: "秒" },
  { id: "all-in-gift", title: "All in 送温暖", description: "All in 输掉超过 1,000 分", category: "倒霉蛋", icon: "暖" },
  { id: "deck-against-me", title: "牌面不站我", description: "连续 8 次听牌未中", category: "倒霉蛋", icon: "牌" },
  { id: "air-streak", title: "连续空牌", description: "连续 12 手没有进入成牌", category: "倒霉蛋", icon: "空" },
  { id: "blind-tax", title: "盲注缴税人", description: "一个盲注轮回净亏超过 300 分", category: "倒霉蛋", icon: "税" },
  { id: "one-card-short", title: "差一张先生", description: "完成 10 次差一张成牌", category: "倒霉蛋", icon: "差" },
  { id: "draw-missed", title: "听牌落空", description: "转牌听牌，河牌仍未命中 5 次", category: "倒霉蛋", icon: "落" },
  { id: "chip-vaporizer", title: "筹码蒸发机", description: "单局亏损超过 1,000 分", category: "倒霉蛋", icon: "蒸", metric: "largestLoss", target: 1000 },
  { id: "always-second", title: "永远差一点", description: "连续 3 次获得第二名牌型", category: "倒霉蛋", icon: "二" },

  { id: "reverse-koi", title: "反向锦鲤", description: "拿到好牌却全部弃掉", category: "彩蛋", icon: "鲤" },
  { id: "lowball-collector", title: "冷门专收", description: "用最低牌型赢下一个底池", category: "彩蛋", icon: "冷" },
  { id: "silent-spectator", title: "沉默观众", description: "观战完整一局并没有发言", category: "彩蛋", icon: "默" },
  { id: "river-allergy", title: "河牌过敏", description: "连续 3 次在河牌前领先后输牌", category: "彩蛋", icon: "敏" },
  { id: "dealer-enemy", title: "发牌员的敌人", description: "连续 3 局起手牌低于 20%", category: "彩蛋", icon: "敌" },
  { id: "luck-iou", title: "好运欠条", description: "连续输局后下一局翻倍赢回", category: "彩蛋", icon: "欠" },
  { id: "tomorrow-better", title: "明天会更好", description: "净输 1,000 分后仍完成下一局", category: "彩蛋", icon: "明" },
  { id: "slow-starter", title: "慢热选手", description: "进入牌局 10 分钟后首次赢池", category: "彩蛋", icon: "慢" },
  { id: "fold-regret", title: "翻牌后悔药", description: "弃牌后公共牌组成自己的牌型", category: "彩蛋", icon: "悔" },
  { id: "small-blind-traveler", title: "小盲旅行者", description: "连续 5 次坐到小盲位", category: "彩蛋", icon: "小" },
  { id: "big-blind-watcher", title: "大盲守望者", description: "连续 5 次坐到大盲位", category: "彩蛋", icon: "大" },
  { id: "last-table", title: "最后一桌", description: "在牌局最后一手赢下底池", category: "彩蛋", icon: "终" },

  { id: "ten-victories", title: "十胜牌手", description: "累计赢下 10 局好友正式牌局", category: "胜利", icon: "10", metric: "wins", target: 10, rarity: "common" },
  { id: "fifty-victories", title: "五十胜", description: "累计赢下 50 局好友正式牌局", category: "胜利", icon: "50", metric: "wins", target: 50, rarity: "rare" },
  { id: "century-victories", title: "百胜名家", description: "累计赢下 100 局好友正式牌局", category: "胜利", icon: "百", metric: "wins", target: 100, rarity: "rare" },
  { id: "two-fifty-victories", title: "两百五十胜", description: "累计赢下 250 局好友正式牌局", category: "胜利", icon: "250", metric: "wins", target: 250, rarity: "epic" },
  { id: "five-hundred-victories", title: "五百胜将", description: "累计赢下 500 局好友正式牌局", category: "胜利", icon: "500", metric: "wins", target: 500, rarity: "epic" },
  { id: "thousand-victories", title: "千胜传奇", description: "累计赢下 1,000 局好友正式牌局", category: "胜利", icon: "千", metric: "wins", target: 1000, rarity: "legendary" },
  { id: "four-k-pot", title: "四千大池", description: "单局净赢达到 4,000 分", category: "胜利", icon: "4K", metric: "largestWin", target: 4000, rarity: "rare" },
  { id: "eight-k-pot", title: "八千大池", description: "单局净赢达到 8,000 分", category: "胜利", icon: "8K", metric: "largestWin", target: 8000, rarity: "epic" },
  { id: "sixteen-k-pot", title: "万六巨池", description: "单局净赢达到 16,000 分", category: "胜利", icon: "16K", metric: "largestWin", target: 16000, rarity: "legendary" },
  { id: "streak-five", title: "势如破竹", description: "连续 5 局取得正积分", category: "胜利", icon: "5", metric: "maxWinStreak", target: 5, rarity: "rare" },
  { id: "streak-fifteen", title: "十五连胜", description: "连续 15 局取得正积分", category: "胜利", icon: "15", metric: "maxWinStreak", target: 15, rarity: "epic" },
  { id: "streak-thirty", title: "三十连胜", description: "连续 30 局取得正积分", category: "胜利", icon: "30", metric: "maxWinStreak", target: 30, rarity: "legendary" },

  { id: "squeeze-play", title: "挤压高手", description: "翻前面对加注与跟注完成挤压并收池 10 次", category: "技术", icon: "挤", rarity: "rare" },
  { id: "check-raise", title: "过牌加注", description: "过牌后加注并赢下底池 20 次", category: "技术", icon: "反", rarity: "rare" },
  { id: "triple-barrel", title: "三枪到底", description: "连续在翻牌、转牌和河牌下注并赢池 10 次", category: "技术", icon: "三", rarity: "epic" },
  { id: "hero-call", title: "英雄跟注", description: "河牌用一对或更弱牌力抓诈唬 10 次", category: "技术", icon: "英", rarity: "epic" },
  { id: "blocker-bluff", title: "阻断诈唬", description: "利用关键阻断牌完成河牌诈唬 10 次", category: "技术", icon: "阻", rarity: "epic" },
  { id: "thin-value", title: "薄价值猎手", description: "河牌薄价值下注并被更弱牌跟注 20 次", category: "技术", icon: "薄", rarity: "rare" },
  { id: "float-win", title: "浮动反击", description: "翻牌跟注后在转牌反击收池 20 次", category: "技术", icon: "浮", rarity: "rare" },
  { id: "blind-steal", title: "偷盲专家", description: "从关煞位或庄位翻前偷盲成功 50 次", category: "技术", icon: "偷", rarity: "rare" },
  { id: "multiway-master", title: "多人池猎手", description: "在四人及以上底池中获胜 25 次", category: "技术", icon: "多", rarity: "epic" },
  { id: "heads-up-specialist", title: "单挑专家", description: "单挑底池累计获胜 100 次", category: "技术", icon: "单", rarity: "rare" },
  { id: "range-reader", title: "范围解码者", description: "连续 20 次摊牌前正确缩窄对手范围", category: "技术", icon: "解", rarity: "epic" },
  { id: "no-showdown-artist", title: "无摊牌艺术家", description: "连续赢下 25 个未摊牌底池", category: "技术", icon: "隐", rarity: "legendary" },

  { id: "two-fifty-hands", title: "两百五十局", description: "累计完成 250 局好友正式牌局", category: "纪律", icon: "250", metric: "hands", target: 250, rarity: "rare" },
  { id: "five-hundred-hands", title: "五百局老友", description: "累计完成 500 局好友正式牌局", category: "纪律", icon: "500", metric: "hands", target: 500, rarity: "rare" },
  { id: "thousand-hands", title: "千局常青树", description: "累计完成 1,000 局好友正式牌局", category: "纪律", icon: "1K", metric: "hands", target: 1000, rarity: "epic" },
  { id: "two-five-k-hands", title: "两千五百局", description: "累计完成 2,500 局好友正式牌局", category: "纪律", icon: "2.5K", metric: "hands", target: 2500, rarity: "epic" },
  { id: "five-k-hands", title: "五千局铁人", description: "累计完成 5,000 局好友正式牌局", category: "纪律", icon: "5K", metric: "hands", target: 5000, rarity: "legendary" },
  { id: "ten-k-hands", title: "万局见证者", description: "累计完成 10,000 局好友正式牌局", category: "纪律", icon: "10K", metric: "hands", target: 10000, rarity: "legendary" },
  { id: "twenty-five-k-hands", title: "两万五千局守望", description: "累计完成 25,000 局好友正式牌局", category: "纪律", icon: "25K", metric: "hands", target: 25000, rarity: "legendary" },
  { id: "three-positive", title: "三局连盈", description: "连续 3 局取得正积分", category: "纪律", icon: "3", metric: "maxWinStreak", target: 3, rarity: "common" },
  { id: "hundred-clean-actions", title: "百次准时", description: "连续 100 次在基础思考时间内完成行动", category: "纪律", icon: "准", rarity: "rare" },
  { id: "disciplined-folds", title: "纪律之刃", description: "在投入超过大盲后仍完成 50 次正确弃牌", category: "纪律", icon: "刃", rarity: "epic" },
  { id: "stop-loss-master", title: "止损专家", description: "连续 10 场在触及自定止损线后停止补充筹码", category: "纪律", icon: "止", rarity: "epic" },
  { id: "full-session", title: "全程专注", description: "单场完成 100 局且没有一次超时弃牌", category: "纪律", icon: "专", rarity: "legendary" },

  { id: "eight-losses", title: "八连阴", description: "最长连续 8 局净输分", category: "倒霉蛋", icon: "8", metric: "maxLossStreak", target: 8, rarity: "rare" },
  { id: "twelve-losses", title: "十二连阴", description: "最长连续 12 局净输分", category: "倒霉蛋", icon: "12", metric: "maxLossStreak", target: 12, rarity: "epic" },
  { id: "twenty-losses", title: "二十局低谷", description: "最长连续 20 局净输分", category: "倒霉蛋", icon: "20", metric: "maxLossStreak", target: 20, rarity: "legendary" },
  { id: "thirty-losses", title: "发牌员黑名单", description: "最长连续 30 局净输分", category: "倒霉蛋", icon: "黑", metric: "maxLossStreak", target: 30, rarity: "legendary" },
  { id: "two-k-loss", title: "两千蒸发", description: "单局净输达到 2,000 分", category: "倒霉蛋", icon: "2K", metric: "largestLoss", target: 2000, rarity: "rare" },
  { id: "four-k-loss", title: "四千沉船", description: "单局净输达到 4,000 分", category: "倒霉蛋", icon: "4K", metric: "largestLoss", target: 4000, rarity: "epic" },
  { id: "eight-k-loss", title: "八千黑洞", description: "单局净输达到 8,000 分", category: "倒霉蛋", icon: "8K", metric: "largestLoss", target: 8000, rarity: "legendary" },
  { id: "aces-cracked-five", title: "火箭坠毁", description: "口袋 A 在摊牌中被反超 5 次", category: "倒霉蛋", icon: "AA", rarity: "rare" },
  { id: "big-flush-loses", title: "大同花也输", description: "K 高及以上同花撞上更大同花", category: "倒霉蛋", icon: "花", rarity: "epic" },
  { id: "quads-loses", title: "四条也能输", description: "拿到四条却输给更大四条或同花顺", category: "倒霉蛋", icon: "四", rarity: "legendary" },
  { id: "one-out-rivered", title: "唯一张被击中", description: "转牌领先时被对手唯一胜出张河杀", category: "倒霉蛋", icon: "1", rarity: "legendary" },
  { id: "bubble-specialist", title: "泡沫位专业户", description: "连续 5 场在终局前一名结束", category: "倒霉蛋", icon: "泡", rarity: "epic" },

  { id: "seven-deuce-win", title: "七二奇迹", description: "用 7-2 非同花赢下超过 2,000 分底池", category: "彩蛋", icon: "72", rarity: "rare" },
  { id: "one-chip-comeback", title: "一枚筹码的奇迹", description: "只剩最小筹码单位后逆转赢下整场", category: "彩蛋", icon: "1", rarity: "legendary" },
  { id: "exact-split", title: "一分不差", description: "平分底池后所有获胜者得到完全相同筹码", category: "彩蛋", icon: "平", rarity: "rare" },
  { id: "four-way-chop", title: "四家平分", description: "四位玩家共同平分同一底池", category: "彩蛋", icon: "4", rarity: "epic" },
  { id: "eight-way-showdown", title: "八人摊牌", description: "八名玩家同时进入摊牌阶段", category: "彩蛋", icon: "8", rarity: "legendary" },
  { id: "back-to-back-same-hand", title: "昨日重现", description: "连续两局拿到完全相同点数与花色的底牌", category: "彩蛋", icon: "复", rarity: "epic" },
  { id: "birthday-hand", title: "生日牌", description: "用与自己生日数字相同的底牌赢池", category: "彩蛋", icon: "生", rarity: "rare" },
  { id: "midnight-table", title: "午夜牌局", description: "在本地时间凌晨零点完成并赢下一局", category: "彩蛋", icon: "夜", rarity: "rare" },
  { id: "royal-flush-showdown", title: "皇家现身", description: "在摊牌中亮出皇家同花顺", category: "彩蛋", icon: "皇", rarity: "legendary" },
  { id: "backdoor-straight-flush", title: "后门同花顺", description: "仅靠转牌与河牌完成同花顺", category: "彩蛋", icon: "后", rarity: "legendary" },
  { id: "blind-win", title: "闭眼收池", description: "从未查看自己的底牌却赢下底池", category: "彩蛋", icon: "闭", rarity: "epic" },
  { id: "dealer-button-eight", title: "庄位八连坐", description: "在八个连续完整牌局中都恰好处于庄位", category: "彩蛋", icon: "庄", rarity: "epic" },
];

const RARITY_OVERRIDES = Object.freeze({
  "river-comeback": "rare",
  "all-in-brave": "rare",
  "flop-hit": "rare",
  "quads-witness": "epic",
  "royal-dream": "legendary",
  "legendary-hand": "epic",
  "river-finish": "epic",
  "top-ranked": "rare",
  "trap": "rare",
  "bluff-master": "epic",
  "reverse-read": "rare",
  "odds-calculator": "rare",
  "cool-fold": "epic",
  "time-master": "rare",
  "steady-player": "rare",
  "hundred-hands": "rare",
  "seven-day-run": "rare",
  "rivered": "rare",
  "four-two": "epic",
  "deck-against-me": "rare",
  "one-card-short": "rare",
  "always-second": "rare",
  "reverse-koi": "rare",
  "river-allergy": "rare",
  "dealer-enemy": "rare",
  "luck-iou": "rare",
  "last-table": "epic",
});

export const ACHIEVEMENT_CATALOG = Object.freeze(
  ACHIEVEMENT_DEFINITIONS.map((achievement) => Object.freeze({
    ...achievement,
    rarity: achievement.rarity || RARITY_OVERRIDES[achievement.id] || "common",
  })),
);

export function achievementsForStats(stats = {}) {
  return ACHIEVEMENT_CATALOG.map((achievement) => {
    const tracked = Boolean(achievement.metric && achievement.target);
    const current = tracked ? Math.max(0, Number(stats[achievement.metric]) || 0) : 0;
    const progress = tracked ? Math.min(100, Math.floor((current / achievement.target) * 100)) : 0;
    return { ...achievement, current, progress, unlocked: tracked && current >= achievement.target };
  });
}

export function achievementsForPublicDisplay(ids = [], excludedTitles = []) {
  const achievementById = new Map(ACHIEVEMENT_CATALOG.map((achievement) => [achievement.id, achievement]));
  const excluded = new Set(
    (Array.isArray(excludedTitles) ? excludedTitles : [excludedTitles])
      .map((title) => String(title ?? "").trim())
      .filter(Boolean),
  );
  const seenIds = new Set();
  const seenTitles = new Set(excluded);
  const result = [];

  for (const rawId of Array.isArray(ids) ? ids : []) {
    const id = String(rawId);
    const achievement = achievementById.get(id);
    if (!achievement || seenIds.has(id) || seenTitles.has(achievement.title)) continue;
    seenIds.add(id);
    seenTitles.add(achievement.title);
    result.push(achievement);
  }
  return result;
}
