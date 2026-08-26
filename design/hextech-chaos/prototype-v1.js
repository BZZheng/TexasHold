const frame = document.querySelector('.app-frame');
const screenSelect = document.querySelector('#screenSelect');
const controlContent = document.querySelector('#controlContent');
const sidebarContent = document.querySelector('#sidebarContent');
const handRail = document.querySelector('#handRail');
const holeCards = document.querySelector('#holeCards');
const handPlaceholder = document.querySelector('#handPlaceholder');
const eventLane = document.querySelector('.event-lane');
const eventTitle = document.querySelector('#eventTitle');
const eventCopy = document.querySelector('#eventCopy');
const eventAction = document.querySelector('#eventAction');
const targetHint = document.querySelector('#targetHint');

const assetRoot = './assets/v1';

const characters = [
  {
    id: 'fenxiang', name: '粉香', role: '残血逆袭', resource: '胆识 0/3',
    summary: '筹码越少，击败大筹码玩家时的额外收益越高。',
    passive: '起手筹码不高于桌均 70%，本手首次跟注至少 1BB 后获得 1 胆识；每手最多 1 点。',
    active: '消耗 3 胆识发动「以小搏大」。击败起手筹码为你 1.5/2/3 倍的对手，分别获得底池 15%/25%/35% 银行奖励，上限 180/300/420。',
    growth: '累计赢下 3 个“对手起手筹码 ≥ 自己 1.5 倍”的底池。',
    awaken: '小筹码奇迹：低于桌均 50% 时只消耗 2 胆识，最高奖励上限 480。',
  },
  {
    id: 'xu', name: '许哥', role: '时间控火', resource: '炭火 0/4',
    summary: '把最后两秒仍敢投入筹码的决定炼成炭火，再压住下一街全桌节奏。',
    passive: '倒计时最后 2 秒手动跟注、下注、加注或全押，且本次实际投入至少 1BB，获得 1 炭火；过牌、弃牌、自动操作与不足 1BB 均不计。每街最多 1 点。',
    active: '消耗 4 炭火发动「烧烤」。下一条街所有对手的每次行动时间减少 15 秒（最低 30 秒），你的时间增加 10 秒。',
    growth: '累计 12 次符合条件的压秒投入，且至少覆盖 6 手牌。',
    awaken: '炉火纯青：烧烤升级为所有对手 −20 秒、自己 +15 秒，并向底池加入 80 银行筹码。',
  },
  {
    id: 'jiansheng', name: '剑圣哥', role: '下注压制', resource: '剑意 0/3',
    summary: '翻牌多人池主动施压，逐步把单体恐吓升级成剑域。',
    passive: '翻牌仍有至少 3 人时完成首次加注，获得 1 剑意；每手最多 1 点。',
    active: '消耗 1 剑意「剑压」一名玩家：其下一次加注总额不能超过你本街已投入的总额。',
    growth: '用剑压影响 3 名不同玩家，并赢下其中至少 1 个底池。',
    awaken: '剑域：消耗 3 剑意，本街同时剑压两名玩家；仍不能作用于已全押玩家。',
  },
  {
    id: 'ya', name: '鸭哥', role: '逆流换河', resource: '鸭毛 0/2',
    summary: '在前两条街主动全押并打到摊牌，以风险换取一次随机改写河牌的机会。',
    passive: '仅翻牌前或翻牌圈通过下注／加注主动全押，且本手实际进入摊牌时获得 1 鸭毛；全押跟注与逼退全桌均不算。',
    active: '消耗 2 鸭毛，每手最多一次。确认后弃置原定自然河牌，并发出牌堆顶下一张；没有候选，不能指定牌面。',
    growth: '累计 3 次符合条件的主动全押进入摊牌，并至少赢下其中 1 次。',
    awaken: '轻舟逆流：发动只消耗 1 鸭毛；仍只能随机替换一次河牌。',
  },
  {
    id: 'qiwan', name: '奇玩', role: '盲盒换牌', resource: '奇想 0/2',
    summary: '大额翻前行动积攒奇想，全押时改造一张底牌。',
    passive: '翻牌前加注到至少 4BB 且被跟注，获得 1 奇想；每手最多 1 点。',
    active: '消耗 2 奇想，每手最多一次。翻牌前全押时选择自己的 1 张底牌弃置，并立即用牌堆顶下一张补入；不能预览换入牌。',
    growth: '完成 2 次换牌，并至少让 1 张换入牌进入最终最佳五张。',
    awaken: '灵感回响：换入牌进入最终最佳五张且赢池时，结算返还 1 奇想，资源不超过 2。',
  },
  {
    id: 'zige', name: '资哥', role: '大银行家', resource: '账本 0/3',
    summary: '稳定结息并经营公开贷款，靠资金周转成长。',
    passive: '每 3 手按可用筹码结算 3% 利息，单次最多 100；贷款本金不参与结息。',
    active: '向一名玩家发放 200–600 的 3 手期贷款。对方确认后到账，到期偿还本金 +10%；同时最多 1 笔。',
    growth: '累计有 3 笔贷款按期结清；提前归还也计入，拒绝不计入。',
    awaken: '总行长：同时最多 2 笔贷款；每笔正常结清时银行额外奖励资哥 30。',
  },
  {
    id: 'mao', name: '毛哥', role: '花色蛊惑', resource: '旺柴 0/3',
    summary: '在转牌与河牌前宣称花色，让全桌决定信还是质疑。',
    passive: '转牌或河牌前可宣称一种花色。4 秒内无人质疑，发牌器从牌堆中发出该花色的下一张合法牌。',
    active: '首位质疑者触发自然牌验证：不符宣称，毛哥支付 40；符合宣称，质疑者向底池支付 40，毛哥获得 1 旺柴。',
    growth: '累计 2 次无人质疑成功，并完成 1 次被质疑后的正确预测。',
    awaken: '真蛊惑：消耗 3 旺柴，本场一次；无人质疑时从该花色 2 张候选牌中选择 1 张。',
  },
  {
    id: 'wengwengwen', name: '嗡嗡文', role: '月刃行者', resource: '月痕 0/3',
    summary: '追随翻牌与转牌上的主动进攻，以月痕换取一张受伪装规则保护的私密情报。',
    passive: '翻牌或转牌面对至少 2BB 的手动下注／加注时，手动跟注、加注或全押且实际投入至少 2BB，获得 1 月痕；每手最多 1 点。',
    active: '消耗 2 月痕发动「月蚀追猎」：服务端随机向你展示本街最后一名合格进攻者的一张底牌，持续到本街结束。',
    growth: '在 5 手牌完成追刃，至少 1 次发生在转牌，并在摊牌击败至少 1 名当手被追猎的进攻者。',
    awaken: '满月双刃：发动后立即完成至少 2BB 的完整加注或全押加注，返还 1 月痕；每手最多返还 1。',
  },
];

const skills = [
  { id: 'fake-weak', name: '装糖阴你一手', category: '情报', palette: 'lavender', rarity: '普通', timing: '被动 · 本手', summary: '对手成功查看你的底牌时，看到 7♣2♦；真实底牌不改变。', kind: 'passive', cheat: true },
  { id: 'fake-strong', name: '装阴糖你一手', category: '情报', palette: 'lavender', rarity: '普通', timing: '被动 · 本手', summary: '对手成功查看你的底牌时，看到 A♠A♥；真实底牌不改变。', kind: 'passive', cheat: true },
  { id: 'xray', name: '透视眼', category: '情报', palette: 'lavender', rarity: '稀有', timing: '行动前', summary: '选择一名仍在牌局的对手，60% 成功查看其底牌直到本街结束。', kind: 'player', cheat: true },
  { id: 'mind-read', name: '读心术', category: '情报', palette: 'lavender', rarity: '普通', timing: '行动前', summary: '查看一名对手当前公开可推导的行动倾向：保守、跟随或进攻。', kind: 'player', cheat: false },
  { id: 'public-reveal', name: '明牌审判', category: '情报', palette: 'lavender', rarity: '稀有', timing: '翻牌后', summary: '向底池支付 80，随机公开目标的一张底牌 4 秒，全桌可见。', kind: 'confirm-player', cheat: false, risk: 80 },
  { id: 'charm', name: '魅惑', category: '控制', palette: 'coral', rarity: '金色', timing: '全押时', summary: '目标被迫跟至其起手筹码 30% 或 600 的较低者；护盾与金蝉脱壳可解除。', kind: 'confirm-player', cheat: false, risk: 600 },
  { id: 'intimidate', name: '恐吓玩家', category: '控制', palette: 'coral', rarity: '普通', timing: '你的行动前', summary: '目标下一次加注总额不能超过你本街已投入的总额。', kind: 'player', cheat: false },
  { id: 'silence', name: '沉默是金', category: '控制', palette: 'coral', rarity: '稀有', timing: '本街开始', summary: '目标本街不能主动发动公共技能，被动防御仍可生效。', kind: 'player', cheat: false },
  { id: 'peace-treaty', name: '和平条约', category: '控制', palette: 'coral', rarity: '普通', timing: '行动前', summary: '你与目标本街不能互相加注，仍可过牌、跟注或弃牌。', kind: 'player', cheat: false },
  { id: 'disarm', name: '缴械', category: '控制', palette: 'coral', rarity: '稀有', timing: '翻牌前', summary: '使目标未发动的主动装备失效；目标从银行获得 80 补偿。', kind: 'confirm-player', cheat: false, risk: 80 },
  { id: 'gambler', name: '我是赌圣', category: '变牌', palette: 'gold', rarity: '金色', timing: '翻牌前', summary: '选 1 张底牌与目标点数：30% 命中，60% 变为 2–6，9.9% 不变，0.1% 成白板。', kind: 'self-card', cheat: true },
  { id: 'reforge', name: '回炉重造', category: '变牌', palette: 'gold', rarity: '普通', timing: '翻牌前', summary: '弃掉自己 1 张底牌，并从剩余牌堆随机补 1 张；不可撤销。', kind: 'confirm-self-card', cheat: false },
  { id: 'prophet', name: '预言家', category: '变牌', palette: 'gold', rarity: '普通', timing: '翻牌前', summary: '预测翻牌三张中的多数花色；命中获 160，未中向底池支付 80。', kind: 'confirm-choice', cheat: false, risk: 80 },
  { id: 'swap-trick', name: '偷梁换柱', category: '变牌', palette: 'gold', rarity: '稀有', timing: '转牌前', summary: '将 1 张底牌换成牌堆随机牌；换出的牌公开弃置且不能换回。', kind: 'confirm-self-card', cheat: true },
  { id: 'river-veto', name: '河牌否决', category: '变牌', palette: 'gold', rarity: '金色', timing: '河牌行动前', summary: '支付 120，将刚发出的河牌公开弃置并重发 1 张；每手全桌仅一次。', kind: 'confirm', cheat: false, risk: 120 },
  { id: 'shield', name: '技能护盾', category: '防御', palette: 'sage', rarity: '普通', timing: '被动 · 本手', summary: '抵挡第一个以你为目标的公共技能，然后失效。', kind: 'passive', cheat: false },
  { id: 'mirror', name: '反弹镜', category: '防御', palette: 'sage', rarity: '稀有', timing: '被动 · 本手', summary: '第一个以你为目标的技能：施法者是合法目标时反弹，否则仅抵挡。', kind: 'passive', cheat: false },
  { id: 'smoke-bomb', name: '烟雾弹', category: '防御', palette: 'sage', rarity: '普通', timing: '被查看时', summary: '使一次查看你底牌的效果失败，并且不公开烟雾弹来源。', kind: 'passive', cheat: false },
  { id: 'escape', name: '金蝉脱壳', category: '防御', palette: 'sage', rarity: '稀有', timing: '被强制跟注时', summary: '支付剩余筹码的 10%，最低 80、最高 160，解除一次强制跟注。', kind: 'reaction', cheat: false, risk: 160 },
  { id: 'catch-cheater', name: '抓老千', category: '防御', palette: 'sage', rarity: '金色', timing: '河牌前', summary: '指认一名玩家。若其本手用过作弊技能，向其他在座玩家各付 100 并退出本手；误抓则你付其 100。', kind: 'confirm-player', cheat: false, risk: 100 },
  { id: 'pot-bomb', name: '底池炸弹', category: '战术', palette: 'sky', rarity: '普通', timing: '翻牌前', summary: '设置 800 阈值；本手底池首次达到阈值时，银行再加入 120。', kind: 'confirm', cheat: false },
  { id: 'raise-cap', name: '限高令', category: '战术', palette: 'sky', rarity: '普通', timing: '本街开始', summary: '本街所有单次加注增量最多 3BB，包括你自己。', kind: 'confirm', cheat: false },
  { id: 'duel-contract', name: '单挑契约', category: '战术', palette: 'sky', rarity: '稀有', timing: '翻牌前', summary: '指定对手；若只有你们两人进入摊牌，胜者从银行额外获得 180。', kind: 'player', cheat: false },
  { id: 'last-stand', name: '背水一战', category: '战术', palette: 'sky', rarity: '稀有', timing: '全押前', summary: '起手低于桌均 35% 时生效；若全押落败，返还损失的 25%，最多 300。', kind: 'confirm', cheat: false },
  { id: 'check-raise-hunter', name: '后手猎人', category: '战术', palette: 'sky', rarity: '普通', timing: '对手过牌加注后', summary: '本街首次有人过牌加注时，可查看其一张随机底牌至行动结束。', kind: 'reaction', cheat: false },
  { id: 'insurance', name: '保险单', category: '经济', palette: 'gold', rarity: '普通', timing: '翻牌前', summary: '支付 60 保费；本手全押落败返还损失的 25%，最多 300。', kind: 'confirm', cheat: false, risk: 60 },
  { id: 'bounty', name: '悬赏令', category: '经济', palette: 'gold', rarity: '普通', timing: '翻牌前', summary: '标记目标；摊牌击败目标获 180，若被目标击败则目标获 80。', kind: 'player', cheat: false },
  { id: 'hand-prediction', name: '牌型预报', category: '经济', palette: 'gold', rarity: '稀有', timing: '翻牌前', summary: '预测自己的最终牌型类别；命中获 240，未命中向底池支付 60。', kind: 'confirm-choice', cheat: false, risk: 60 },
  { id: 'stop-loss', name: '止损协议', category: '经济', palette: 'gold', rarity: '普通', timing: '被动 · 本手', summary: '摊牌输掉至少 800 的底池时，从银行返还 100；每手一次。', kind: 'passive', cheat: false },
  { id: 'fixed-deposit', name: '定期存款', category: '经济', palette: 'gold', rarity: '普通', timing: '翻牌前', summary: '锁定 200；坚持到河牌返还 230，提前弃牌返还 180。', kind: 'confirm', cheat: false, risk: 200 },
];

const targetByPlayers = { 2: 4000, 3: 5400, 4: 6800, 5: 8200, 6: 9600, 7: 11000, 8: 12400 };
const characterFixtures = {
  fenxiang: { chips: 620, seatResource: '胆识 3/3 · 已行动', publicResource: '胆识 3' },
  xu: { chips: 980, seatResource: '炭火 4/4 · 待行动', publicResource: '炭火 4' },
  jiansheng: { chips: 2040, seatResource: '剑意 2/3 · 待行动', publicResource: '剑意 2' },
  ya: { chips: 1760, seatResource: '鸭毛 2/2 · 已全押', publicResource: '鸭毛 2' },
  qiwan: { chips: 1420, seatResource: '奇想 2/2 · 已全押', publicResource: '奇想 2' },
  zige: { chips: 2380, seatResource: '账本 1 · 可放贷', publicResource: '利息待结' },
  mao: { chips: 2120, seatResource: '旺柴 1/3 · 待行动', publicResource: '旺柴 1' },
  wengwengwen: { chips: 1880, seatResource: '月痕 2/3 · 待行动', publicResource: '月痕 2' },
};
const occupiedByName = { xu: '阿诚', jiansheng: '小林', ya: '老周', qiwan: '米米', zige: '北哥', mao: '阿哲', wengwengwen: '月仔' };
const skillChoiceSchemas = {
  prophet: ['♠', '♥', '♣', '♦'],
  'hand-prediction': ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'],
};
const spectatorSharedHandIds = new Set(['fenxiang', 'ya', 'zige']);
const screenMeta = {
  'create-room': ['创建房间', '人数决定胜利目标，开局后不随掉线人数变化', 'neutral'],
  'character-select': ['选择人物', '人物不可重复；预览不会占用，锁定后才同步给全桌', 'neutral'],
  'character-locked': ['等待开局', '6/6 已选人物，5/6 已准备；房主可在全员准备后开始', 'neutral'],
  draft: ['底牌已发', '从 3 个公共技能中装备 1 个；三张卡在手机端同屏', 'neutral'],
  'draft-loading': ['正在刷新', '旧选项已冻结，等待服务端返回新的 offerId', 'warning'],
  'draft-error': ['刷新失败', '网络中断；旧选项仍有效，倒计时以服务端为准', 'danger'],
  'draft-timeout': ['自动装备', '选择超时，服务端已自动装备技能护盾', 'warning'],
  'skill-library': ['技能图鉴', '30 个公共技能按情报、控制、变牌、防御、战术、经济分组', 'neutral'],
  play: ['轮到你行动', '翻牌 · 跟注 120 · 还剩 60 秒', 'neutral'],
  target: ['选择目标', '透视眼：请选择一名仍在本手的有效玩家', 'warning'],
  confirm: ['风险确认', '魅惑会产生不可逆的跟注约束，提交前必须二次确认', 'warning'],
  'skill-cooldown': ['技能不可用', '本手装备与人物主动均已消耗；原因以服务端状态为准', 'neutral'],
  'loan-offer': ['发起贷款', '选择借款人并确认金额；贷款必须由对方主动接受', 'warning'],
  'loan-response': ['贷款邀请', '借款人需要主动接受或拒绝，接受前双方筹码都不会变化', 'warning'],
  'loan-ledger': ['公开账本', '资哥的本金、利息、到期手数和违约状态对全桌可见', 'neutral'],
  'mao-challenge': ['花色宣称', '毛哥宣称河牌为红桃；首位质疑者进入自然牌验证', 'warning'],
  'ya-river-choice': ['逆流换河', '鸭哥已主动全押；60 秒内决定是否随机替换一次河牌', 'warning'],
  'qiwan-card-swap': ['盲盒换牌', '奇玩已翻牌前全押；60 秒内选择要随机替换的底牌', 'warning'],
  'catch-result': ['抓老千成功', '被指认玩家本手使用过作弊技能，向其他在座玩家各支付 100', 'success'],
  'catch-miss': ['抓老千误抓', '被指认玩家本手没有使用作弊技能，你需要向其支付 100', 'danger'],
  awaken: ['人物觉醒', '粉香达成成长条件，“小筹码奇迹”已解锁', 'awaken'],
  spectator: ['授权观战', '正在观看鸭哥的公开观战手牌；牌面始终位于独立轨道', 'neutral'],
  'spectator-hidden': ['不可查看', '该玩家未授权公开手牌；浏览器不会收到真实牌值', 'danger'],
  'spectator-failed': ['切换失败', '网络请求失败，继续保留上一个已授权的观战手牌', 'danger'],
  'activity-log': ['牌局记录', '移动端记录位于操作轨道，不依赖隐藏的桌面侧栏', 'neutral'],
  'hand-result': ['本手结算', '粉香赢得 1,240，并触发“以小搏大”额外奖励 300', 'success'],
  rebuy: ['补筹窗口', '你的筹码为 0；可补筹 2,000，本场还剩 2 次', 'warning'],
  'match-end': ['整场结束', '领先玩家在单手完整结算后达到本房间动态目标', 'success'],
  'match-end-cap': ['15 手兜底结束', '无人达到动态目标，按第 15 手结算净资产排名', 'success'],
};

const state = {
  screen: 'create-room',
  handNumber: 0,
  roomMode: 'hextech',
  playerCount: 6,
  isReady: false,
  characterId: 'fenxiang',
  occupiedIds: ['xu', 'jiansheng', 'ya', 'qiwan', 'zige'],
  selectedSkillId: 'xray',
  draftOfferIds: ['xray', 'gambler', 'shield'],
  selectedTargetId: null,
  loanAmount: 400,
  loanTargetId: 'xu',
  loanActive: false,
  sideTab: 'players',
  libraryFilter: '全部',
  confirmContext: 'skill',
  selectedCard: null,
  selfCards: ['Q♥', '8♣'],
  selectedRank: 'A',
  selectedChoiceBySkill: { prophet: '♥', 'hand-prediction': '一对' },
  selectedMaoSuit: '♥',
  selectedHoleIndex: 0,
  previewAwakened: false,
  characterDetailsOpen: false,
  mobilePanel: 'log',
  spectatorId: 'ya',
  lastSpectatorId: 'ya',
  spectatorAttemptId: 'zige',
  skillConsumed: false,
  characterSkillConsumed: false,
  awakenedCharacterIds: [],
  streetKey: 'flop',
  reactionWindowSkillId: null,
  libraryReturnScreen: 'play',
  activityReturnScreen: 'play',
  zonesVisible: false,
};

function formatChips(value) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function blindLabelForHand(handNumber) {
  if (handNumber <= 3) return '盲注 20/40';
  if (handNumber <= 6) return '盲注 30/60';
  if (handNumber <= 9) return '盲注 50/100';
  if (handNumber <= 12) return '盲注 80/160';
  return '盲注 120/240';
}

function blindValuesForHand(handNumber) {
  if (handNumber <= 3) return [20, 40];
  if (handNumber <= 6) return [30, 60];
  if (handNumber <= 9) return [50, 100];
  if (handNumber <= 12) return [80, 160];
  return [120, 240];
}

function getCharacter(id) {
  return characters.find((character) => character.id === id) || characters[0];
}

function getSkill(id) {
  return skills.find((skill) => skill.id === id) || skills[0];
}

function isCharacterAwakened(id) {
  return state.awakenedCharacterIds.includes(id);
}

function markCharacterAwakened(id) {
  if (!isCharacterAwakened(id)) state.awakenedCharacterIds.push(id);
}

function occupiedCharacterIds() {
  return new Set(state.occupiedIds);
}

function buildFixtureOccupants(selfId, requiredIds = []) {
  return [...new Set([...requiredIds, ...characters.map((character) => character.id)])]
    .filter((id) => id !== selfId)
    .slice(0, Math.max(0, state.playerCount - 1));
}

function setFixtureCharacter(characterId, requiredOpponentIds = []) {
  state.characterId = characterId;
  state.occupiedIds = buildFixtureOccupants(characterId, requiredOpponentIds);
}

function availableChipsFor(characterId) {
  let chips = state.handNumber <= 1 ? 2000 : characterFixtures[characterId].chips;
  if (state.screen === 'hand-result' && characterId === 'fenxiang') return 2160;
  if (state.screen === 'rebuy' && characterId === state.characterId) return 0;
  if (['match-end', 'match-end-cap'].includes(state.screen)) {
    const target = targetByPlayers[state.playerCount];
    const winnerChips = state.screen === 'match-end-cap' ? Math.max(3200, Math.round(target * 0.72 / 20) * 20) : target + 80;
    const rankIndex = rankedParticipantIds().indexOf(characterId);
    if (rankIndex >= 0) return Math.max(1200, winnerChips - [0, 1240, 1880, 2200, 2480, 2720, 2960][rankIndex]);
  }
  if (!state.loanActive) return chips;
  if (characterId === 'zige') chips -= state.loanAmount;
  if (characterId === state.loanTargetId) chips += state.loanAmount;
  return chips;
}

function initialResourceFor(characterId) {
  return {
    fenxiang: '胆识 0/3', xu: '炭火 0/4', jiansheng: '剑意 0/3', ya: '鸭毛 0/2',
    qiwan: '奇想 0/2', zige: '账本 0/3', mao: '旺柴 0/3', wengwengwen: '月痕 0/3',
  }[characterId];
}

function seatResourceFor(characterId) {
  if (characterId === 'zige' && state.loanActive) return '贷款中 1/1 · 第 9 手到期';
  if (state.screen === 'rebuy' && characterId === state.characterId) return '筹码归零 · 等待补筹';
  if (characterId === state.characterId && state.characterSkillConsumed) {
    const fenxiangRemaining = isCharacterAwakened('fenxiang') && characterActionFor('fenxiang').cost.includes('2') ? '胆识 1/3' : '胆识 0/3';
    const consumed = {
      fenxiang: `${fenxiangRemaining} · 人物技能已用`,
      xu: '炭火 0/4 · 人物技能已用',
      jiansheng: '剑意 1/3 · 人物技能已用',
      ya: '鸭毛 0/2 · 人物技能已用',
      qiwan: '奇想 0/2 · 人物技能已用',
      zige: '账本 1 · 人物技能已用',
      mao: '旺柴 1/3 · 人物技能已用',
      wengwengwen: '月痕 0/3 · 人物技能已用',
    };
    return consumed[characterId];
  }
  if (state.handNumber <= 1) return `${initialResourceFor(characterId)} · ${characterId === 'zige' ? '可放贷' : characterId === 'mao' ? '可宣称' : '积攒中'}`;
  return characterFixtures[characterId].seatResource;
}

function characterResourceFor(characterId) {
  if (characterId === 'zige') return `可用筹码 ${formatChips(availableChipsFor('zige'))}`;
  if (characterId === state.characterId && state.characterSkillConsumed) {
    const fenxiangRemaining = isCharacterAwakened('fenxiang') && characterActionFor('fenxiang').cost.includes('2') ? '胆识 1/3' : '胆识 0/3';
    const consumed = { fenxiang: fenxiangRemaining, xu: '炭火 0/4', jiansheng: '剑意 1/3', ya: '鸭毛 0/2', qiwan: '奇想 0/2', mao: '旺柴 1/3', wengwengwen: '月痕 0/3' };
    return consumed[characterId];
  }
  if (state.handNumber <= 1) return initialResourceFor(characterId);
  return characterActionFor(characterId).resource;
}

function publicResourceFor(characterId) {
  if (characterId === 'zige' && state.loanActive) return '贷款中 1/1';
  if (characterId === state.characterId && state.characterSkillConsumed) return seatResourceFor(characterId).split(' · ')[0];
  if (state.handNumber <= 1) return initialResourceFor(characterId);
  if (characterId === 'fenxiang' && isCharacterAwakened(characterId)) return '小筹码奇迹';
  return characterFixtures[characterId].publicResource;
}

function participantCharacterIds() {
  return [state.characterId, ...state.occupiedIds.filter((id) => id !== state.characterId)].slice(0, state.playerCount);
}

function rankedParticipantIds() {
  const participants = participantCharacterIds();
  const preferredOrder = ['zige', 'fenxiang', 'jiansheng', 'xu', 'ya', 'qiwan', 'mao', 'wengwengwen'];
  return preferredOrder.filter((id) => participants.includes(id));
}

function isLobbyContext(screen = state.screen) {
  const contextScreen = screen === 'skill-library' ? state.libraryReturnScreen : screen;
  return ['create-room', 'character-select', 'character-locked'].includes(contextScreen);
}

function openSkillLibrary() {
  if (state.screen !== 'skill-library') state.libraryReturnScreen = state.screen;
  setScreen('skill-library');
}

function closeSkillLibrary() {
  const returnScreen = state.libraryReturnScreen || 'play';
  setScreen(returnScreen);
}

function activityLogItems() {
  const ids = participantCharacterIds();
  const actor = getCharacter(ids[0]);
  const firstOpponent = getCharacter(ids[1] || ids[0]);
  const secondOpponent = getCharacter(ids[2] || ids[1] || ids[0]);
  return [
    [`#031 ${actor.name}跟注 120`, `${publicResourceFor(actor.id)} · 行动已确认`],
    [`#030 ${firstOpponent.name}过牌`, '服务端行动序号已同步'],
    [`#029 ${secondOpponent.name}装备状态校验`, '仅下发当前视角可见的判定结果'],
    ['#028 翻牌 A♥ 10♣ 7♦', '底池 1,240'],
  ];
}

function characterImage(id, awakened) {
  const useAwakenedArt = awakened ?? isCharacterAwakened(id);
  if (id === 'wengwengwen') return `./assets/parallel-wengwengwen/characters/${id}-${useAwakenedArt ? 'awaken' : 'normal'}.png`;
  return `${assetRoot}/characters/${id}-${useAwakenedArt ? 'awaken' : 'normal'}.png`;
}

function skillImage(id) {
  return `${assetRoot}/skills/${id}.png`;
}

function holeCardButton(value) {
  const rank = value.slice(0, -1);
  const suit = value.slice(-1);
  return `<button class="playing-card large ${/[♦♥]/.test(value) ? 'red' : ''}" type="button" data-card="${value}" aria-label="底牌 ${value}"><b>${rank}</b><i>${suit}</i></button>`;
}

function selfHandLabel() {
  if (state.streetKey !== 'preflop') return 'A 高';
  const [first, second] = state.selfCards.map((value) => value.slice(0, -1));
  if (first === second) return `一对 ${first}`;
  const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  return `${rankOrder[Math.max(rankOrder.indexOf(first), rankOrder.indexOf(second))]} 高`;
}

function resetCommunityCards(screen = 'play') {
  const preflopScreens = new Set(['draft', 'draft-loading', 'draft-error', 'draft-timeout', 'qiwan-card-swap']);
  const turnScreens = new Set(['mao-challenge']);
  const showdownScreens = new Set(['hand-result', 'rebuy', 'match-end', 'match-end-cap']);
  state.streetKey = preflopScreens.has(screen) ? 'preflop' : turnScreens.has(screen) ? 'turn' : showdownScreens.has(screen) ? 'showdown' : 'flop';
  const cards = {
    flop: '<span class="playing-card red"><b>A</b><i>♥</i></span><span class="playing-card"><b>10</b><i>♣</i></span><span class="playing-card red"><b>7</b><i>♦</i></span>',
    turn: '<span class="playing-card"><b>4</b><i>♠</i></span>',
    river: '<span class="playing-card red"><b>K</b><i>♦</i></span>',
    placeholderFlop: '<span class="playing-card placeholder" aria-label="未发出的翻牌"></span>',
    placeholderTurn: '<span class="playing-card placeholder" aria-label="未发出的转牌"></span>',
    placeholderRiver: '<span class="playing-card placeholder" aria-label="未发出的河牌"></span>',
  };
  const board = state.streetKey === 'preflop'
    ? `${cards.placeholderFlop}${cards.placeholderFlop}${cards.placeholderFlop}${cards.placeholderTurn}${cards.placeholderRiver}`
    : state.streetKey === 'turn'
      ? `${cards.flop}${cards.turn}${cards.placeholderRiver}`
      : state.streetKey === 'showdown'
        ? `${cards.flop}${cards.turn}${cards.river}`
        : `${cards.flop}${cards.placeholderTurn}${cards.placeholderRiver}`;
  document.querySelector('#communityCards').innerHTML = board;
  const streetCopy = document.querySelector('#streetCopy');
  const potValue = document.querySelector('#potValue');
  if (state.streetKey === 'preflop') { const [smallBlind, bigBlind] = blindValuesForHand(state.handNumber); streetCopy.textContent = '翻牌前 · 技能选择'; potValue.textContent = formatChips(smallBlind + bigBlind); }
  else if (state.streetKey === 'turn') { streetCopy.textContent = '转牌 · 河牌未发'; potValue.textContent = '1,820'; }
  else if (state.streetKey === 'showdown') {
    streetCopy.textContent = ['match-end', 'match-end-cap'].includes(screen) ? '整场已结束' : screen === 'rebuy' ? '本手结束 · 补筹窗口' : '摊牌 · 已结算';
    potValue.textContent = screen === 'hand-result' ? '1,240' : '3,120';
  } else { streetCopy.textContent = '翻牌 · 还剩 60 秒'; potValue.textContent = '1,240'; }
}

function dealRiverCard(value) {
  const rank = value.slice(0, -1);
  const suit = value.slice(-1);
  const river = `<span class="playing-card ${/[♦♥]/.test(value) ? 'red' : ''}"><b>${rank}</b><i>${suit}</i></span>`;
  document.querySelector('#communityCards').lastElementChild.outerHTML = river;
  state.streetKey = 'river';
  document.querySelector('#streetCopy').textContent = '河牌 · 等待行动';
  document.querySelector('#potValue').textContent = '2,440';
}

function resetPerHandState() {
  state.skillConsumed = false;
  state.characterSkillConsumed = false;
  state.reactionWindowSkillId = null;
  state.selectedTargetId = null;
  state.selectedCard = null;
  state.selfCards = ['Q♥', '8♣'];
  state.selectedHoleIndex = 0;
}

function startNewHand() {
  resetPerHandState();
  resetCommunityCards('draft');
  setScreen('draft');
}

function advanceToNextHand() {
  state.handNumber = Math.min(15, Math.max(1, state.handNumber + 1));
  startNewHand();
}

function syncSelfSeat() {
  const selected = getCharacter(state.characterId);
  const selectedFixture = characterFixtures[selected.id];
  const selfSeat = document.querySelector('.self-seat');
  selfSeat.querySelector('strong').textContent = `你 · ${selected.name}`;
  selfSeat.querySelector('small').textContent = formatChips(availableChipsFor(selected.id));
  selfSeat.querySelector('em').textContent = seatResourceFor(selected.id);
  const opponentCharacters = participantCharacterIds().slice(1).map(getCharacter);
  const opponentSeats = [...document.querySelectorAll('.seat:not(.self-seat)')];
  opponentSeats.forEach((seat, index) => {
    const character = opponentCharacters[index];
    seat.hidden = !character;
    if (!character) return;
    seat.dataset.userId = character.id;
    seat.dataset.validTarget = 'true';
    seat.querySelector('img').src = characterImage(character.id);
    seat.querySelector('strong').textContent = character.name;
    seat.querySelector('small').textContent = formatChips(availableChipsFor(character.id));
    seat.querySelector('em').textContent = seatResourceFor(character.id);
  });
}

function skillCardTemplate(skill, selected = false, disabled = false) {
  return `
    <button type="button" class="skill-card ${selected ? 'selected' : ''}" data-skill-id="${skill.id}" data-palette="${skill.palette}" role="option" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" ${disabled ? 'disabled aria-disabled="true"' : ''}>
      <span class="skill-art"><img src="${skillImage(skill.id)}" alt="" /></span>
      <small>${skill.rarity} · ${skill.category}</small>
      <strong>${skill.name}</strong>
      <p>${skill.summary}</p>
      <em>${skill.cheat ? '作弊技能' : skill.timing}</em>
    </button>`;
}

function renderCreateRoom() {
  const isHextech = state.roomMode === 'hextech';
  return `
    <section class="panel room-panel" aria-label="创建房间">
      <div class="room-intro">
        <span class="eyebrow">新增房间模式</span>
        <strong>先选人物，再逐手选装备</strong>
        <p>目标在开局时按座位数锁定；达到目标或第 15 手结算后结束。</p>
      </div>
      <div class="mode-choice" role="radiogroup" aria-orientation="horizontal" aria-label="房间玩法">
        <button type="button" class="mode-card ${!isHextech ? 'selected' : ''}" data-room-mode="classic" role="radio" aria-checked="${!isHextech}" tabindex="${!isHextech ? 0 : -1}">
          <span class="mode-icon">♣</span><small>经典模式</small><strong>私人俱乐部牌局</strong><span>不含人物与公共技能</span>
        </button>
        <button type="button" class="mode-card ${isHextech ? 'selected' : ''}" data-room-mode="hextech" role="radio" aria-checked="${isHextech}" tabindex="${isHextech ? 0 : -1}">
          <span class="mode-icon">✦</span><small>娱乐模式</small><strong>海克斯大乱德</strong><span>8 人物 · 每手技能三选一</span>
        </button>
      </div>
      <div class="room-settings">
        <div class="setting-row">
          <label><strong>座位人数</strong><small>支持 2–8 人</small></label>
          <div class="stepper"><button type="button" data-step-player="-1" aria-label="减少人数">−</button><output>${state.playerCount}</output><button type="button" data-step-player="1" aria-label="增加人数">＋</button></div>
        </div>
        <div class="room-goal-preview"><span>${isHextech ? '动态胜利目标' : '经典房间规则'}</span><strong>${isHextech ? formatChips(targetByPlayers[state.playerCount]) : '原配置'}</strong></div>
        <button type="button" class="primary-action" data-action="create-room">创建${isHextech ? '海克斯' : '经典'}房间</button>
      </div>
    </section>`;
}

function renderCharacterSelect() {
  const selected = getCharacter(state.characterId);
  const occupiedIds = occupiedCharacterIds();
  return `
    <section class="panel character-panel" aria-label="人物选择">
      <div class="character-detail">
        <img src="${characterImage(selected.id, state.previewAwakened)}" alt="${selected.name}${state.previewAwakened ? '觉醒' : ''}" />
        <div class="character-name-row"><strong>${selected.name}</strong><em>${selected.role}</em><button type="button" class="awaken-toggle" data-action="toggle-awaken">${state.previewAwakened ? '看普通' : '看觉醒'}</button></div>
        <div class="character-kit">
          <span><b>定位：</b>${selected.summary}</span>
          <span><b>资源：</b>${selected.resource}</span>
          <span><b>成长：</b>${selected.growth}</span>
          <span><b>觉醒：</b>${selected.awaken}</span>
          <button type="button" class="character-detail-toggle" data-action="toggle-character-details">${state.characterDetailsOpen ? '返回人物列表' : '完整技能 / 成长'}</button>
        </div>
        <button type="button" class="primary-action" data-action="lock-character">锁定 ${selected.name}</button>
      </div>
      ${state.characterDetailsOpen ? `<div class="character-full-detail panel-scroll"><span class="eyebrow">${selected.name} · 完整人物能力</span><strong>被动</strong><p>${selected.passive}</p><strong>主动</strong><p>${selected.active}</p><strong>成长条件</strong><p>${selected.growth}</p><strong>觉醒</strong><p>${selected.awaken}</p><button type="button" class="quiet-action" data-action="toggle-character-details">返回人物列表</button></div>` : `<div class="character-gallery" role="listbox" aria-orientation="horizontal" aria-label="8 名人物">
        ${characters.map((character) => {
          const occupied = occupiedIds.has(character.id);
          return `<button type="button" class="character-card ${character.id === selected.id ? 'selected' : ''} ${occupied ? 'occupied' : ''}" data-character-id="${character.id}" role="option" aria-selected="${character.id === selected.id}" tabindex="${character.id === selected.id ? 0 : -1}" ${occupied ? 'disabled' : ''}>
            ${occupied ? `<em class="occupied-ribbon">已被 ${occupiedByName[character.id] || '其他玩家'} 选择</em>` : ''}
            <img src="${characterImage(character.id)}" alt="${character.name}" />
            <span>${character.name}</span><small>${character.role}</small>
          </button>`;
        }).join('')}
      </div>`}
    </section>`;
}

function renderCharacterLocked() {
  const selected = getCharacter(state.characterId);
  const readyIds = participantCharacterIds().map(getCharacter);
  const readyCount = state.isReady ? state.playerCount : Math.max(1, state.playerCount - 1);
  return `
    <section class="panel locked-panel" aria-label="人物锁定与准备">
      <div class="locked-hero">
        <img src="${characterImage(selected.id)}" alt="" />
        <div><span class="eyebrow">你已锁定</span><strong>${selected.name}</strong><small>${selected.role}</small></div>
      </div>
      <div class="ready-track">
        <div><h3>房间 H3X7</h3><span>${readyCount}/${state.playerCount} 已准备</span></div>
        <div class="ready-players">
          ${readyIds.map((character) => { const ready = character.id === state.characterId ? state.isReady : true; return `<div class="ready-player"><img src="${characterImage(character.id)}" alt="" /><strong>${character.name}</strong><small>${ready ? '已准备' : '选择完成 · 未准备'}</small></div>`; }).join('')}
        </div>
      </div>
      <div class="locked-actions"><button type="button" class="secondary-action" data-action="change-character">更换人物</button><button type="button" class="primary-action" data-action="ready">${state.isReady ? '开始牌局' : '准备'}</button></div>
    </section>`;
}

function renderDraft() {
  const offers = state.draftOfferIds.map(getSkill);
  const selected = getSkill(state.selectedSkillId);
  return `
    <section class="panel draft-panel" aria-label="每手技能三选一">
      <div class="draft-meta">
        <div><span class="eyebrow">本手装备</span><strong>三选一</strong></div>
        <span class="draft-timer" aria-label="剩余 60 秒">60</span>
        <button type="button" data-action="reroll">刷新 · 1</button>
      </div>
      <div class="skill-cards" role="listbox" aria-orientation="horizontal" aria-label="三个技能选项">${offers.map((skill) => skillCardTemplate(skill, skill.id === state.selectedSkillId)).join('')}</div>
      <div class="draft-submit"><button type="button" class="primary-action" data-action="equip-skill">装备${selected.name}</button><small>预选不会提交。超时由服务端自动装备并标记。</small></div>
    </section>`;
}

function renderDraftLoading() {
  const offers = state.draftOfferIds.map(getSkill);
  return `
    <section class="panel draft-panel is-loading" aria-label="技能刷新加载">
      <div class="draft-meta"><div><span class="eyebrow">旧选项已冻结</span><strong>刷新中</strong></div><span class="spinner" aria-hidden="true"></span><button type="button" data-action="cancel-loading">取消刷新</button></div>
      <div class="skill-cards" role="listbox" aria-orientation="horizontal" aria-busy="true">${offers.map((skill) => skillCardTemplate(skill, skill.id === state.selectedSkillId, true)).join('')}</div>
      <div class="draft-submit"><button type="button" class="primary-action" disabled>等待新 offerId…</button><small>服务端确认前不扣刷新次数，旧选项禁止提交。</small></div>
    </section>`;
}

function renderDraftError() {
  const offers = state.draftOfferIds.map(getSkill);
  return `
    <section class="panel draft-panel has-error" aria-label="技能刷新失败">
      <div class="draft-meta"><div><span class="eyebrow">刷新失败 · 未扣次数</span><strong>旧选项有效</strong></div><span class="draft-timer">5</span><button type="button" data-action="retry-reroll">重试</button></div>
      <div class="skill-cards" role="listbox" aria-orientation="horizontal">${offers.map((skill) => skillCardTemplate(skill, skill.id === state.selectedSkillId)).join('')}</div>
      <div class="draft-submit"><button type="button" class="primary-action" data-action="return-draft">使用旧选项</button><small>倒计时已与服务端重新同步。</small></div>
    </section>`;
}

function renderDraftTimeout() {
  const shield = getSkill('shield');
  return `
    <section class="panel status-panel" aria-label="超时自动装备">
      <div class="status-art"><img src="${skillImage(shield.id)}" alt="" /></div>
      <div class="status-copy"><span class="eyebrow">autoSelected · true</span><strong>已自动装备「技能护盾」</strong><p>选择时间结束后由服务端从有效选项中确定。被动技能会抵挡本手第一个指向你的装备技能。</p></div>
      <div class="status-actions"><button type="button" class="primary-action" data-action="continue-play">进入翻牌前</button><button type="button" class="secondary-action" data-action="open-library">查看技能详情</button></div>
    </section>`;
}

function renderSkillLibrary() {
  const filters = ['全部', '情报', '控制', '变牌', '防御', '战术', '经济'];
  const visible = state.libraryFilter === '全部' ? skills : skills.filter((skill) => skill.category === state.libraryFilter);
  const returnLabel = isLobbyContext() ? '返回房间设置' : '返回牌局';
  return `
    <section class="panel library-panel" aria-label="30 个公共技能图鉴">
      <div class="library-summary">
        <span class="eyebrow">公共技能池</span><div class="library-heading"><h2>30 个技能</h2><button type="button" class="quiet-action" data-action="close-library" aria-label="${returnLabel}">返回</button></div><p>每手由服务端发 3 个选项；金色技能最多出现 1 张，概率与合法目标均由服务端决定。</p>
        <div class="library-filters" role="group" aria-label="技能分类">${filters.map((filter) => `<button type="button" class="${state.libraryFilter === filter ? 'active' : ''}" data-skill-filter="${filter}" aria-pressed="${state.libraryFilter === filter}">${filter}</button>`).join('')}</div>
      </div>
      <div class="skill-library-grid panel-scroll">${visible.map((skill) => `<button type="button" class="skill-mini" data-library-skill="${skill.id}"><img src="${skillImage(skill.id)}" alt="" /><strong>${skill.name}</strong><span>${skill.rarity} · ${skill.category} · ${skill.cheat ? '作弊技能' : '合法技能'} · ${skill.timing}</span><small>${skill.summary}</small></button>`).join('')}</div>
    </section>`;
}

const characterActionUi = {
  fenxiang: { resource: '胆识 3/3', status: '低筹码奖励档位 +25%', active: '以小搏大', cost: '消耗 3 胆识', confirm: '本手赢池且击败起手筹码为你 1.5/2/3 倍的对手时，获得底池 15%/25%/35% 的银行奖励，上限 180/300/420。' },
  xu: { resource: '炭火 4/4', status: '最后 2 秒投入至少 1BB 才能积攒', active: '烧烤', cost: '消耗 4 炭火', confirm: '下一条街，所有对手的每次行动时间减少 15 秒（最低 30 秒），你的行动时间增加 10 秒；不再受行动顺序限制。' },
  jiansheng: { resource: '剑意 2/3', status: '本手翻牌多人池已触发', active: '剑压', cost: '消耗 1 剑意', confirm: '指定目标下一次加注总额不能超过你本街已投入的总额；不影响跟注与已全押。' },
  ya: { resource: '鸭毛 2/2', status: '前两街主动全押 · 60 秒机会', active: '逆流换河', cost: '消耗 2 鸭毛', confirm: '每手最多一次：弃置原定自然河牌，并发出不可预知的牌堆顶下一张；没有候选，不能指定牌面。' },
  qiwan: { resource: '奇想 2/2', status: '翻牌前全押 · 60 秒机会', active: '盲盒换牌', cost: '消耗 2 奇想', confirm: '选择自己的第 1 或第 2 张底牌弃置，并立即用不可预知的牌堆顶下一张补入；没有候选。' },
  zige: { resource: '可用筹码 2,380', status: '同时 0/1 笔贷款', active: '短期贷款', button: '发起贷款', cost: '本金 200–600', confirm: '向目标发送 3 手期贷款邀请，对方接受前双方筹码不变化。' },
  mao: { resource: '旺柴 1/3', status: '河牌宣称窗口可用', active: '花色蛊惑', button: '宣称花色', cost: '转牌 / 河牌前', confirm: '宣称下一张公共牌花色，并打开 4 秒全桌质疑窗口。' },
  wengwengwen: { resource: '月痕 2/3', status: '已锁定本街最后一名合格进攻者', active: '月蚀追猎', cost: '消耗 2 月痕', confirm: '服务端随机私密展示目标的一张底牌至本街结束；伪装技能可能改变展示结果，且不会提示是否命中伪装。' },
};

function characterActionFor(id) {
  const base = characterActionUi[id];
  if (id !== 'fenxiang') return base;
  const rosterIds = participantCharacterIds();
  const tableAverage = rosterIds.reduce((total, characterId) => total + availableChipsFor(characterId), 0) / rosterIds.length;
  const stackRatio = availableChipsFor(id) / tableAverage;
  const fenxiangBase = { ...base, status: stackRatio <= 0.7 ? '低筹码进度门槛已满足' : '当前未满足 70% 低筹码门槛' };
  if (!isCharacterAwakened(id)) return fenxiangBase;
  const lowStackDiscount = availableChipsFor(id) <= tableAverage * 0.5;
  return {
    ...fenxiangBase,
    status: lowStackDiscount ? '小筹码奇迹 · 觉醒折扣已生效' : '小筹码奇迹 · 已永久解锁',
    cost: lowStackDiscount ? '消耗 2 胆识' : '消耗 3 胆识',
    confirm: '本手赢池且击败起手筹码为你 1.5/2/3 倍的对手时，获得底池 15%/25%/35% 的银行奖励；觉醒后的最高奖励上限为 480。',
  };
}

function renderPlay(cooldown = false) {
  const selectedCharacter = getCharacter(state.characterId);
  const skill = getSkill(state.selectedSkillId);
  const characterUi = characterActionFor(selectedCharacter.id);
  const insufficientResource = state.handNumber <= 1 && ['fenxiang', 'xu', 'jiansheng', 'ya', 'qiwan', 'wengwengwen'].includes(selectedCharacter.id);
  const characterUnavailable = cooldown || state.characterSkillConsumed || insufficientResource || (selectedCharacter.id === 'zige' && state.loanActive);
  const characterUnavailableLabel = selectedCharacter.id === 'zige' && state.loanActive ? '已有进行中贷款' : insufficientResource ? '资源不足 · 先完成进度条件' : `${characterUi.active}本手不可用`;
  const canOpenLoanLedger = selectedCharacter.id === 'zige' && state.loanActive;
  const characterResource = characterResourceFor(selectedCharacter.id);
  const reactionWaiting = skill.kind === 'reaction' && state.reactionWindowSkillId !== skill.id;
  const equipmentUnavailable = cooldown || state.skillConsumed || reactionWaiting;
  const equipmentStatus = state.skillConsumed || cooldown ? '本手已消耗' : reactionWaiting ? '等待合法反应窗口' : skill.kind === 'passive' ? '被动生效中' : '可发动 · 1 次';
  return `
    <section class="panel action-panel" aria-label="下注与技能操作">
      <div class="character-hud">
        <span class="hud-portrait"><img src="${characterImage(selectedCharacter.id)}" alt="" /></span>
        <div><small>${selectedCharacter.name} · ${selectedCharacter.role}</small><strong>${characterResource}</strong><span>${characterUnavailable ? characterUnavailableLabel : characterUi.status}</span></div>
        <button type="button" class="character-skill" data-action="${canOpenLoanLedger ? 'view-ledger' : 'character-skill'}" ${characterUnavailable && !canOpenLoanLedger ? 'disabled' : ''}>${canOpenLoanLedger ? '查看公开账本' : insufficientResource ? '资源不足' : characterUnavailable ? '人物技能已用' : characterUi.button || `发动${characterUi.active}`}</button>
      </div>
      <div class="poker-actions">
        <button type="button" data-poker-action="弃牌">弃牌</button><button type="button" data-poker-action="过牌">过牌</button><button type="button" class="call" data-poker-action="跟注 120">跟注 120</button><button type="button" class="raise" data-poker-action="加注至 360">加注至 360</button>
      </div>
      <button type="button" class="equipped-skill" data-action="use-skill" ${equipmentUnavailable || skill.kind === 'passive' ? 'disabled' : ''}>
        <span><img src="${skillImage(skill.id)}" alt="" /></span><div><small>本手装备</small><strong>${skill.name}</strong></div><em>${equipmentStatus}</em>
      </button>
      <div class="mobile-context-actions" aria-label="移动端牌局信息"><button type="button" data-action="show-players">玩家</button><button type="button" data-action="show-log">记录</button><button type="button" data-action="show-skills">技能</button></div>
    </section>`;
}

function renderDecision(type) {
  if (type === 'target') {
    if (state.confirmContext === 'character-target') {
      const character = getCharacter(state.characterId);
      const characterUi = characterActionFor(character.id);
      return `<section class="panel decision-panel" aria-label="选择人物技能目标"><div class="decision-art"><img src="${characterImage(character.id)}" alt="" /></div><div class="decision-copy"><span class="eyebrow">人物主动 · 有效目标来自服务端</span><strong>${characterUi.active}</strong><p>${characterUi.confirm}</p><div class="risk-list"><span>${characterUi.cost}</span><span>座位金框 = 可选</span><span>Esc 可取消</span></div></div><div class="decision-actions"><button type="button" class="secondary-action full" data-action="cancel-target">取消选择</button></div></section>`;
    }
    const skill = getSkill(state.selectedSkillId);
    return `<section class="panel decision-panel" aria-label="选择技能目标"><div class="decision-art"><img src="${skillImage(skill.id)}" alt="" /></div><div class="decision-copy"><span class="eyebrow">步骤 1/2 · 有效目标来自服务端</span><strong>${skill.name}</strong><p>${skill.summary}</p><div class="risk-list"><span>座位金框 = 可选</span><span>牌面保持可见</span><span>Esc 可取消</span></div></div><div class="decision-actions"><button type="button" class="secondary-action full" data-action="cancel-target">取消选择</button></div></section>`;
  }
  if (state.confirmContext === 'mao-suit') {
    const suitNames = { '♠': '黑桃', '♥': '红桃', '♣': '梅花', '♦': '方片' };
    return `<section class="panel decision-panel" aria-label="毛哥选择宣称花色"><div class="decision-art"><img src="${characterImage('mao')}" alt="" /></div><div class="decision-copy"><span class="eyebrow">人物主动 · 河牌发出前</span><strong>宣称下一张是${suitNames[state.selectedMaoSuit]}</strong><p>提交后打开 4 秒全桌质疑窗口；无人质疑时，发牌器发出该花色的下一张合法牌。</p><div class="rank-picker" role="group" aria-label="选择宣称花色">${Object.entries(suitNames).map(([suit, name]) => `<button type="button" data-mao-suit="${suit}" aria-label="${name}" aria-pressed="${state.selectedMaoSuit === suit}" class="${state.selectedMaoSuit === suit ? 'selected' : ''}">${suit}</button>`).join('')}</div><div class="risk-list"><span>首位质疑者进入验证</span><span>双方风险 40</span><span>提交后不可撤回</span></div></div><div class="decision-actions"><button type="button" class="secondary-action" data-action="cancel-confirm">返回</button><button type="button" class="primary-action" data-action="confirm-mao-claim">宣称${suitNames[state.selectedMaoSuit]}</button></div></section>`;
  }
  if (state.confirmContext === 'character') {
    const character = getCharacter(state.characterId);
    const characterUi = characterActionFor(character.id);
    return `<section class="panel decision-panel" aria-label="人物技能确认"><div class="decision-art"><img src="${characterImage(character.id)}" alt="" /></div><div class="decision-copy"><span class="eyebrow">人物主动 · ${characterUi.cost}</span><strong>发动「${characterUi.active}」？</strong><p>${characterUi.confirm}</p><div class="risk-list"><span>${characterUi.resource}</span><span>服务端校验条件</span><span>提交后不可撤回</span></div></div><div class="decision-actions"><button type="button" class="secondary-action" data-action="cancel-confirm">返回</button><button type="button" class="primary-action" data-action="confirm-skill">${characterUi.cost}发动</button></div></section>`;
  }
  const skill = getSkill(state.selectedSkillId);
  const targetName = state.selectedTargetId ? document.querySelector(`[data-user-id="${state.selectedTargetId}"] strong`)?.textContent : null;
  const subject = skill.kind.includes('self-card') ? `对底牌 ${state.selectedCard || 'Q♥'} 使用${skill.name}？` : targetName ? `对${targetName}发动${skill.name}？` : `发动${skill.name}？`;
  const rankPicker = skill.id === 'gambler' ? `<div class="rank-picker gambler-ranks" role="group" aria-label="想要的点数">${['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'].map((rank) => `<button type="button" class="${state.selectedRank === rank ? 'selected' : ''}" data-rank="${rank}" aria-pressed="${state.selectedRank === rank}">${rank}</button>`).join('')}</div>` : '';
  const choiceOptions = skillChoiceSchemas[skill.id] || [];
  const choicePicker = choiceOptions.length ? `<div class="rank-picker choice-picker" role="group" aria-label="${skill.name}选项">${choiceOptions.map((choice) => `<button type="button" class="${state.selectedChoiceBySkill[skill.id] === choice ? 'selected' : ''}" data-skill-choice="${choice}" aria-pressed="${state.selectedChoiceBySkill[skill.id] === choice}">${choice}</button>`).join('')}</div>` : '';
  const choiceLabel = choiceOptions.length ? ` · 选择 ${state.selectedChoiceBySkill[skill.id]}` : '';
  return `<section class="panel decision-panel" aria-label="不可逆技能确认"><div class="decision-art"><img src="${skillImage(skill.id)}" alt="" /></div><div class="decision-copy"><span class="eyebrow">确认 · 不可逆</span><strong>${subject}</strong><p>${skill.summary}</p>${rankPicker}${choicePicker}<div class="risk-list"><span>最大筹码风险 ${skill.risk || 0}</span><span>${skill.kind.includes('player') ? '目标可反制' : '服务端执行牌堆'}</span><span>提交后不可撤回</span></div></div><div class="decision-actions"><button type="button" class="secondary-action" data-action="cancel-confirm">返回</button><button type="button" class="danger-action" data-action="confirm-skill">确认发动${skill.id === 'gambler' ? ` · 想要 ${state.selectedRank}` : choiceLabel}</button></div></section>`;
}

function renderLoanOffer() {
  const target = getCharacter(state.loanTargetId);
  const repayment = Math.round(state.loanAmount * 1.1);
  return `
    <section class="panel loan-panel" aria-label="资哥发起贷款">
      <div class="loan-owner"><img src="${characterImage('zige')}" alt="" /><div><span class="eyebrow">人物主动</span><strong>短期贷款</strong><span>可用筹码 ${formatChips(availableChipsFor('zige'))}</span><span>同时 ${state.loanActive ? '1/1' : '0/1'} 笔</span></div></div>
      <div class="loan-builder">
        <div class="loan-field"><label>借款人</label><div class="loan-target"><img src="${characterImage(target.id)}" alt="" /><span><strong>${target.name}</strong><small>点击牌桌更换</small></span></div></div>
        <div class="loan-field"><label id="loanPrincipalLabel" for="loanRange">本金 ${formatChips(state.loanAmount)}</label><input id="loanRange" type="range" min="200" max="600" step="100" value="${state.loanAmount}" /></div>
        <div class="loan-field"><label>到期偿还</label><strong id="loanRepayment">${formatChips(repayment)}</strong><small>第 9 手结算 · 10% 利息</small></div>
      </div>
      <div class="loan-actions"><button type="button" class="primary-action" data-action="send-loan">发送贷款邀请</button><button type="button" class="secondary-action" data-action="cancel-loan">取消</button></div>
    </section>`;
}

function renderLoanResponse() {
  const lender = getCharacter('zige');
  const borrower = getCharacter(state.loanTargetId);
  const repayment = Math.round(state.loanAmount * 1.1);
  return `
    <section class="panel decision-panel" aria-label="借款人响应贷款邀请">
      <div class="decision-art"><img src="${characterImage(lender.id)}" alt="" /></div>
      <div class="decision-copy"><span class="eyebrow">贷款邀请 · 还剩 10 秒</span><strong>${lender.name}向${borrower.name}提供 ${formatChips(state.loanAmount)}</strong><p>接受后本金立即到账；第 9 手结算偿还 ${formatChips(repayment)}。不足偿还时，之后每次净赢额的 20% 自动划转。</p><div class="risk-list"><span>期限 3 手</span><span>利率 10%</span><span>接受前不扣双方筹码</span></div></div>
      <div class="decision-actions"><button type="button" class="secondary-action" data-action="reject-loan">拒绝</button><button type="button" class="primary-action" data-action="accept-loan">接受并到账</button><button type="button" class="quiet-action full" data-action="expire-loan">演示邀请过期</button></div>
    </section>`;
}

function renderLoanLedger() {
  const interest = Math.round(state.loanAmount * 0.1);
  const availableChips = availableChipsFor('zige');
  const netAssets = availableChips + state.loanAmount + interest;
  const historyRows = participantCharacterIds()
    .filter((id) => !['zige', state.loanTargetId].includes(id))
    .slice(0, 2)
    .map((id, index) => {
      const principal = index === 0 ? 300 : 500;
      return `<div class="ledger-row"><strong>${getCharacter(id).name}</strong><span>${formatChips(principal)}</span><span>${index === 0 ? '已结清' : '第 6 手'}</span><em>${formatChips(Math.round(principal * 1.1))}</em><span>${index === 0 ? '按期' : '已提前还款'}</span></div>`;
    }).join('');
  return `
    <section class="panel ledger-panel" aria-label="贷款账本">
      <div class="ledger-summary"><span class="eyebrow">资哥 · 公开净资产</span><strong>${formatChips(netAssets)}</strong><p>可用筹码 ${formatChips(availableChips)}<br />应收本金 ${formatChips(state.loanAmount)}<br />待收利息 ${formatChips(interest)}</p><button class="quiet-action" data-action="new-loan" ${state.loanActive ? 'disabled' : ''}>${state.loanActive ? '已有 1/1 笔贷款' : '新建贷款'}</button><button class="quiet-action" data-action="return-ledger">返回牌局</button></div>
      <div class="ledger-table panel-scroll">
        <div class="ledger-row header"><span>借款人</span><span>本金</span><span>到期</span><span>应还</span><span>状态</span></div>
        <div class="ledger-row"><strong>${getCharacter(state.loanTargetId).name}</strong><span>${formatChips(state.loanAmount)}</span><span>第 9 手</span><em>${formatChips(state.loanAmount + interest)}</em><span>正常</span></div>
        ${historyRows}
      </div>
    </section>`;
}

function renderMaoChallenge() {
  const suitNames = { '♠': '黑桃', '♥': '红桃', '♣': '梅花', '♦': '方片' };
  const suitName = suitNames[state.selectedMaoSuit];
  return `
    <section class="panel challenge-panel" aria-label="质疑毛哥的花色宣称">
      <div class="challenge-character"><img src="${characterImage('mao')}" alt="毛哥" /><span class="suit-bubble">${state.selectedMaoSuit}</span></div>
      <div class="challenge-copy"><span class="eyebrow">河牌发出前 · 全桌窗口</span><h2>毛哥宣称：${suitName}</h2><p>无人质疑，将发出牌堆中下一张合法${suitName}。首位质疑者会改为翻开自然牌验证。</p><span class="challenge-timer">还剩 4 秒</span></div>
      <div class="challenge-actions"><button type="button" class="danger-action" data-action="challenge-mao">质疑 · 风险 40</button><button type="button" class="secondary-action" data-action="trust-mao">不质疑</button><small>预测错误：毛哥付你 40；预测正确：你向底池支付 40，毛哥获得 1 旺柴。</small></div>
    </section>`;
}

function renderYaRiverChoice() {
  return `
    <section class="panel card-choice-panel" aria-label="鸭哥随机替换河牌">
      <div class="choice-character"><img src="${characterImage('ya')}" alt="鸭哥" /><span><small>消耗 2 鸭毛 · 每手一次</small><strong>逆流换河</strong></span></div>
      <div class="candidate-zone"><span class="eyebrow">人物机会 · 还剩 60 秒</span><h2>预约随机替换河牌？</h2><div class="risk-list"><span>不展示候选牌</span><span>不能指定点数或花色</span><span>确认后不可撤销</span></div></div>
      <div class="choice-actions"><p>发河牌时，服务端会弃置原定自然河牌，再发出牌堆顶下一张。结果只有真正发出后才可见。</p><button type="button" class="primary-action" data-action="confirm-river">确认随机换河</button><button type="button" class="secondary-action" data-action="cancel-river">暂不发动</button></div>
    </section>`;
}

function renderQiwanCardSwap() {
  const cardButtons = state.selfCards.map((value, index) => {
    const rank = value.slice(0, -1);
    const suit = value.slice(-1);
    const selected = state.selectedHoleIndex === index;
    return `<button type="button" class="playing-card choice-card ${/[♦♥]/.test(value) ? 'red' : ''} ${selected ? 'selected' : ''}" data-qiwan-hole-index="${index}" aria-label="第 ${index + 1} 张底牌 ${value}" aria-pressed="${selected}"><b>${rank}</b><i>${suit}</i></button>`;
  }).join('');
  return `
    <section class="panel card-choice-panel" aria-label="奇玩盲盒换牌">
      <div class="choice-character"><img src="${characterImage('qiwan')}" alt="奇玩" /><span><small>消耗 2 奇想 · 每手一次</small><strong>盲盒换牌</strong></span></div>
      <div class="candidate-zone"><span class="eyebrow">人物机会 · 还剩 60 秒</span><h2>弃置哪一张底牌？</h2><div class="candidate-cards" role="group" aria-label="选择要弃置的底牌">${cardButtons}</div></div>
      <div class="choice-actions"><p>确认后立即弃置第 ${state.selectedHoleIndex + 1} 张底牌，并用不可预知的牌堆顶下一张补入；不会先展示换入牌。</p><button type="button" class="primary-action" data-action="confirm-qiwan-swap">确认替换第 ${state.selectedHoleIndex + 1} 张</button><button type="button" class="secondary-action" data-action="cancel-swap">暂不发动</button></div>
    </section>`;
}

function renderCatchResult(missed = false) {
  const otherPlayers = state.playerCount - 1;
  const opponentIds = participantCharacterIds().filter((id) => id !== state.characterId);
  const auditedTargetId = state.selectedTargetId && opponentIds.includes(state.selectedTargetId) ? state.selectedTargetId : null;
  const targetId = auditedTargetId || (missed ? (opponentIds.includes('xu') ? 'xu' : opponentIds[0]) : (opponentIds.includes('ya') ? 'ya' : opponentIds[0]));
  const target = getCharacter(targetId);
  return `
    <section class="panel result-panel" aria-label="抓老千结果">
      <div class="result-hero"><img src="${characterImage(target.id)}" alt="" /><div><span class="eyebrow">${missed ? '判定失败' : '判定成功'}</span><strong>${missed ? '误抓了' : '抓到了'}</strong><small>${missed ? `${target.name}继续本手` : `${target.name}退出本手`}</small></div></div>
      <div class="result-breakdown"><h3>服务端审计结果</h3><div><span>已使用的作弊技能</span><strong>${missed ? '无' : '透视眼'}</strong></div><div><span>${missed ? `你向${target.name}支付` : `向 ${otherPlayers} 名其他玩家支付`}</span><strong class="negative">−${missed ? 100 : otherPlayers * 100}</strong></div><div><span>当前手牌状态</span><strong>${missed ? '双方继续' : '强制弃牌'}</strong></div></div>
      <div class="result-actions"><button type="button" class="primary-action" data-action="ack-catch">继续本手</button><button type="button" class="secondary-action" data-action="show-log">查看审计记录</button></div>
    </section>`;
}

function renderAwaken() {
  const character = getCharacter('fenxiang');
  if (state.characterDetailsOpen) {
    return `<section class="panel activity-panel" aria-label="粉香完整人物卡">
      <div class="activity-summary"><span class="eyebrow">只读人物详情 · 牌局继续保留</span><strong>${character.name} · ${character.role}</strong><p>${character.summary}</p><button type="button" class="quiet-action" data-action="close-character-detail">返回觉醒结果</button></div>
      <div class="activity-list panel-scroll"><div class="log-item"><strong>被动</strong><span>${character.passive}</span></div><div class="log-item"><strong>主动 · 以小搏大</strong><span>${character.active}</span></div><div class="log-item"><strong>成长条件</strong><span>${character.growth}</span></div><div class="log-item"><strong>觉醒能力</strong><span>${character.awaken}</span></div></div>
    </section>`;
  }
  return `
    <section class="panel awaken-panel" aria-label="粉香人物觉醒">
      <div class="awaken-portrait"><img src="${characterImage('fenxiang', true)}" alt="粉香觉醒" /></div>
      <div class="awaken-copy"><span class="eyebrow">成长 3/3 · 永久解锁</span><h2>小筹码奇迹</h2><p>粉香已经三次击败起手筹码至少为自己 1.5 倍的对手。觉醒只替换操作轨道，不遮挡公共牌与手牌。</p><div class="upgrade-list"><span><b>消耗降低</b> · 低于桌均 50% 时，胆识消耗 3 → 2</span><span><b>上限提高</b> · 最高银行奖励 420 → 480</span><span><b>视觉识别</b> · 头像与 HUD 使用觉醒立绘</span></div></div>
      <div class="awaken-actions"><button type="button" class="primary-action" data-action="ack-awaken">继续行动</button><button type="button" class="secondary-action" data-action="view-character">查看完整人物卡</button></div>
    </section>`;
}

function renderSpectator(hidden = false) {
  if (hidden) {
    const deniedOwner = getCharacter(state.spectatorId);
    document.querySelector('.portrait-chip img').src = characterImage(deniedOwner.id);
    return `<section class="panel status-panel" aria-label="观战无查看权限"><div class="status-art">⌁</div><div class="status-copy"><span class="eyebrow">HAND_NOT_SHARED</span><strong>${deniedOwner.name}没有公开观战手牌</strong><p>为避免数据泄漏，真实牌值不会下发到浏览器。切换失败时可恢复上一个合法视角，不出现空白闪烁。</p></div><div class="status-actions"><button type="button" class="primary-action" data-action="return-spectator">恢复${getCharacter(state.lastSpectatorId).name}视角</button><button type="button" class="secondary-action" data-action="table-view">全桌视角</button></div></section>`;
  }
  const pickerIds = participantCharacterIds();
  return `<section class="panel spectator-panel" aria-label="授权观战手牌切换"><div class="spectator-copy"><span class="eyebrow">已弃牌 · 观战</span><h2>手牌只在上方独立轨道切换</h2><p>选择玩家不会创建覆盖公共牌的弹层。</p><button type="button" class="quiet-action" data-action="table-view">返回全桌视角</button></div><div class="spectator-picker" role="group" aria-label="选择观战玩家">${pickerIds.map((id) => { const character = getCharacter(id); const allowed = spectatorSharedHandIds.has(id); return `<button type="button" class="spectator-person ${id === state.spectatorId ? 'selected' : ''}" data-spectator-id="${id}" aria-pressed="${id === state.spectatorId}"><img src="${characterImage(id)}" alt="" /><span><strong>${character.name}</strong><small>${allowed ? '允许查看' : '未公开'}</small></span></button>`; }).join('')}</div></section>`;
}

function renderSpectatorFailed() {
  return `<section class="panel status-panel" aria-label="观战切换网络失败"><div class="status-art">↻</div><div class="status-copy"><span class="eyebrow">SPECTATOR_SWITCH_TIMEOUT</span><strong>没有切换到${getCharacter(state.spectatorAttemptId).name}</strong><p>上方仍保留${getCharacter(state.lastSpectatorId).name}的最后一个合法授权视角；不会先清空再闪回。</p></div><div class="status-actions"><button type="button" class="primary-action" data-action="retry-spectator">重试切换</button><button type="button" class="secondary-action" data-action="return-spectator">保持当前视角</button></div></section>`;
}

function renderActivityLog() {
  if (state.mobilePanel === 'players') {
    const ids = participantCharacterIds();
    return `<section class="panel activity-panel" aria-label="移动端玩家列表"><div class="activity-summary"><span class="eyebrow">移动端信息抽屉</span><strong>${state.playerCount} 名玩家</strong><p>信息只替换操作轨道，不覆盖公共牌或手牌。</p><button type="button" class="quiet-action" data-action="return-from-log">返回操作</button></div><div class="activity-list panel-scroll">${ids.map((id) => `<div class="log-item"><strong>${id === state.characterId ? '你 · ' : ''}${getCharacter(id).name} · ${formatChips(availableChipsFor(id))}</strong><span>${seatResourceFor(id)}</span></div>`).join('')}${state.loanActive ? '<button type="button" class="quiet-action" data-action="view-ledger">查看资哥公开贷款账本</button>' : ''}</div></section>`;
  }
  if (state.mobilePanel === 'skills') {
    const skill = getSkill(state.selectedSkillId);
    const character = getCharacter(state.characterId);
    const characterUi = characterActionFor(character.id);
    const characterStatus = state.characterSkillConsumed || (character.id === 'zige' && state.loanActive) ? '本手已消耗 / 不可用' : '本手可用';
    const equipmentStatus = state.skillConsumed ? '本手已消耗' : skill.kind === 'passive' ? '被动生效中' : skill.kind === 'reaction' && state.reactionWindowSkillId !== skill.id ? '等待合法反应窗口' : '本手可发动 1 次';
    return `<section class="panel activity-panel" aria-label="移动端技能信息"><div class="activity-summary"><span class="eyebrow">移动端信息抽屉</span><strong>人物与装备</strong><p>作弊标签、时机、成长与觉醒均保留文本。</p><button type="button" class="quiet-action" data-action="return-from-log">返回操作</button></div><div class="activity-list panel-scroll"><div class="log-item"><strong>${character.name} · ${characterUi.active}</strong><span>${characterStatus} · ${characterUi.cost} · ${characterUi.confirm}</span></div><div class="log-item"><strong>成长条件</strong><span>${character.growth}</span></div><div class="log-item"><strong>觉醒能力${isCharacterAwakened(character.id) ? ' · 已解锁' : ''}</strong><span>${character.awaken}</span></div><div class="log-item"><strong>${skill.name} · ${skill.category}</strong><span>${equipmentStatus} · ${skill.timing} · ${skill.cheat ? '作弊技能' : '合法技能'} · ${skill.summary}</span></div>${state.loanActive ? '<button type="button" class="quiet-action" data-action="view-ledger">查看公开贷款账本</button>' : ''}<button type="button" class="quiet-action" data-action="open-library">打开 30 技能图鉴</button></div></section>`;
  }
  const items = activityLogItems();
  return `<section class="panel activity-panel" aria-label="牌局事件记录"><div class="activity-summary"><span class="eyebrow">服务端事件序号</span><strong>第 ${state.handNumber} 手 · 翻牌</strong><p>手机与桌面都可在操作轨道阅读；不会覆盖牌面。</p><button type="button" class="quiet-action" data-action="return-from-log">返回操作</button></div><div class="activity-list panel-scroll">${items.map(([title, copy]) => `<div class="log-item"><strong>${title}</strong><span>${copy}</span></div>`).join('')}</div></section>`;
}

function renderHandResult() {
  return `
    <section class="panel result-panel" aria-label="单手结算">
      <div class="result-hero"><img src="${characterImage('fenxiang')}" alt="" /><div><span class="eyebrow">第 ${state.handNumber} 手胜者</span><strong>+1,540</strong><small>结算后筹码 2,160</small></div></div>
      <div class="result-breakdown"><h3>结算明细</h3><div><span>主底池</span><strong class="positive">+1,240</strong></div><div><span>以小搏大 · 2.4 倍档</span><strong class="positive">+300</strong></div><div><span>胆识消耗</span><strong class="negative">3 → ${isCharacterAwakened('fenxiang') ? 1 : 0}</strong></div><div class="progress-bar" style="--progress: 67%"><i></i></div></div>
      <div class="result-actions"><button type="button" class="primary-action" data-action="next-hand">下一手</button><button type="button" class="secondary-action" data-action="show-log">查看结算日志</button></div>
    </section>`;
}

function renderRebuy() {
  const target = targetByPlayers[state.playerCount];
  return `
    <section class="panel decision-panel" aria-label="补筹确认">
      <div class="decision-art">＋</div><div class="decision-copy"><span class="eyebrow">仅在筹码归零后开放 · 30 秒</span><strong>补筹 2,000？</strong><p>本场最多补筹 3 次，你已经使用 1 次。补筹会在下一手开始前到账，不改变 ${state.playerCount} 人胜利目标 ${formatChips(target)}。</p><div class="risk-list"><span>剩余 2 次</span><span>下一手生效</span><span>不能超额补筹</span></div></div><div class="decision-actions"><button type="button" class="secondary-action" data-action="spectate-after-bust">不补筹，继续观战</button><button type="button" class="primary-action" data-action="confirm-rebuy">确认补筹 2,000</button></div>
    </section>`;
}

function renderMatchEnd(byCap = false) {
  const target = targetByPlayers[state.playerCount];
  const winnerChips = byCap ? Math.max(3200, Math.round(target * 0.72 / 20) * 20) : target + 80;
  const endTitles = { zige: '总行长', fenxiang: '小筹码奇迹', jiansheng: '剑域', xu: '炉火纯青', ya: '轻舟逆流', qiwan: '灵感回响', mao: '真蛊惑', wengwengwen: '满月双刃' };
  const standings = rankedParticipantIds().slice(0, Math.min(3, state.playerCount)).map((id, index) => ({
    id,
    rank: index + 1,
    label: `${getCharacter(id).name} · ${endTitles[id]}`,
    value: Math.max(1600, winnerChips - [0, 1240, 1880][index]),
  }));
  const winner = getCharacter(standings[0].id);
  return `
    <section class="panel match-end-panel" aria-label="整场终局">
      <div class="winner"><img src="${characterImage(winner.id, true)}" alt="" /><span><small>${byCap ? '第 15 手按结算净资产排名' : '第 14 手达到目标'}</small><strong>${winner.name}获胜</strong><em>${formatChips(winnerChips)}${byCap ? ' 净资产' : ` / ${formatChips(target)}`}</em></span></div>
      <div class="podium">${standings.map((entry) => `<div class="podium-row"><b>${entry.rank}</b><strong>${entry.label}</strong><em>${formatChips(entry.value)}${byCap ? ' 净资产' : ''}</em></div>`).join('')}</div>
      <div class="match-actions"><button type="button" class="primary-action" data-action="play-again">同配置再来一场</button><button type="button" class="secondary-action" data-action="exit-room">返回房间</button></div>
    </section>`;
}

function renderControl() {
  const renderers = {
    'create-room': renderCreateRoom,
    'character-select': renderCharacterSelect,
    'character-locked': renderCharacterLocked,
    draft: renderDraft,
    'draft-loading': renderDraftLoading,
    'draft-error': renderDraftError,
    'draft-timeout': renderDraftTimeout,
    'skill-library': renderSkillLibrary,
    play: () => renderPlay(false),
    target: () => renderDecision('target'),
    confirm: () => renderDecision('confirm'),
    'skill-cooldown': () => renderPlay(true),
    'loan-offer': renderLoanOffer,
    'loan-response': renderLoanResponse,
    'loan-ledger': renderLoanLedger,
    'mao-challenge': renderMaoChallenge,
    'ya-river-choice': renderYaRiverChoice,
    'qiwan-card-swap': renderQiwanCardSwap,
    'catch-result': () => renderCatchResult(false),
    'catch-miss': () => renderCatchResult(true),
    awaken: renderAwaken,
    spectator: () => renderSpectator(false),
    'spectator-hidden': () => renderSpectator(true),
    'spectator-failed': renderSpectatorFailed,
    'activity-log': renderActivityLog,
    'hand-result': renderHandResult,
    rebuy: renderRebuy,
    'match-end': () => renderMatchEnd(false),
    'match-end-cap': () => renderMatchEnd(true),
  };
  controlContent.innerHTML = (renderers[state.screen] || renderPlay)();
}

function renderHand() {
  const lobby = isLobbyContext();
  const hidden = state.screen === 'spectator-hidden';
  const spectator = ['spectator', 'spectator-hidden', 'spectator-failed'].includes(state.screen);
  document.querySelectorAll('[data-self-image]').forEach((image) => { image.src = characterImage(state.characterId, state.screen === 'awaken' ? true : undefined); });
  syncSelfSeat();
  handRail.classList.toggle('is-hidden', hidden);
  if (lobby) {
    handPlaceholder.hidden = false;
    document.querySelector('.hand-context').hidden = true;
    holeCards.hidden = true;
    document.querySelector('.hand-summary').hidden = true;
    return;
  }
  handPlaceholder.hidden = true;
  document.querySelector('.hand-context').hidden = false;
  holeCards.hidden = false;
  document.querySelector('.hand-summary').hidden = false;
  if (hidden) {
    const deniedOwner = characters.find((character) => character.id === state.spectatorId);
    document.querySelector('#handEyebrow').textContent = '观战权限受限';
    document.querySelector('#handOwner').textContent = `${deniedOwner?.name || '该玩家'} · 未公开手牌`;
    document.querySelector('#handDescription').textContent = '真实牌值未下发；这里只渲染不可识别的牌背';
    holeCards.innerHTML = '<span class="card-back" aria-label="隐藏牌"></span><span class="card-back" aria-label="隐藏牌"></span>';
    document.querySelector('#handSummaryLabel').textContent = '数据策略';
    document.querySelector('#handSummaryValue').textContent = '未下发';
    document.querySelector('#handSummaryMeta').textContent = '不是仅用 CSS 隐藏';
    return;
  }
  if (spectator) {
    const visibleSpectatorId = state.screen === 'spectator-failed' ? state.lastSpectatorId : state.spectatorId;
    const sharedHands = {
      ya: { html: '<button class="playing-card large" type="button" data-card="A♣"><b>A</b><i>♣</i></button><button class="playing-card large" type="button" data-card="J♣"><b>J</b><i>♣</i></button>', value: state.streetKey === 'preflop' ? 'A 高' : '一对 A', meta: '鸭毛 2/2' },
      fenxiang: { html: '<button class="playing-card large red" type="button" data-card="Q♥"><b>Q</b><i>♥</i></button><button class="playing-card large" type="button" data-card="8♣"><b>8</b><i>♣</i></button>', value: state.streetKey === 'preflop' ? 'Q 高' : 'A 高', meta: '胆识 3/3' },
      zige: { html: '<button class="playing-card large" type="button" data-card="9♠"><b>9</b><i>♠</i></button><button class="playing-card large red" type="button" data-card="9♦"><b>9</b><i>♦</i></button>', value: '一对 9', meta: '利息待结' },
    };
    const shared = sharedHands[visibleSpectatorId];
    if (!shared) {
      const requestedOwner = characters.find((character) => character.id === visibleSpectatorId);
      document.querySelector('#handEyebrow').textContent = visibleSpectatorId ? '观战手牌未授权' : '全桌观战';
      document.querySelector('#handOwner').textContent = requestedOwner ? `${requestedOwner.name} · 未公开手牌` : '全桌视角 · 未选择玩家';
      document.querySelector('#handDescription').textContent = '只显示公共牌与公开状态；浏览器没有可回退的真实牌值';
      holeCards.innerHTML = '<span class="card-back" aria-label="未授权牌"></span><span class="card-back" aria-label="未授权牌"></span>';
      document.querySelector('#handSummaryLabel').textContent = '数据策略';
      document.querySelector('#handSummaryValue').textContent = '未下发';
      document.querySelector('#handSummaryMeta').textContent = '失败关闭';
      return;
    }
    const owner = getCharacter(visibleSpectatorId);
    document.querySelector('.portrait-chip img').src = characterImage(owner.id);
    document.querySelector('#handEyebrow').textContent = `正在观看${owner.name}`;
    document.querySelector('#handOwner').textContent = `${owner.name} · 公开观战手牌`;
    document.querySelector('#handDescription').textContent = '已由服务端授权，仅观战者可见';
    holeCards.innerHTML = shared.html;
    document.querySelector('#handSummaryLabel').textContent = '当前牌型';
    document.querySelector('#handSummaryValue').textContent = shared.value;
    document.querySelector('#handSummaryMeta').textContent = shared.meta;
    return;
  }
  const selectedCharacter = getCharacter(state.characterId);
  const rosterIds = participantCharacterIds();
  const tableAverage = rosterIds.reduce((total, id) => total + availableChipsFor(id), 0) / rosterIds.length;
  const stackVsAverage = Math.round((availableChipsFor(selectedCharacter.id) / tableAverage) * 100);
  document.querySelector('#handEyebrow').textContent = '你的手牌';
  document.querySelector('#handOwner').textContent = `${selectedCharacter.name} · ${selectedCharacter.id === 'fenxiang' ? '以小搏大就绪' : selectedCharacter.role}`;
  document.querySelector('#handDescription').textContent = selectedCharacter.id === 'fenxiang'
    ? `当前筹码为桌均 ${stackVsAverage}%，${stackVsAverage <= 70 ? '已满足低筹码进度门槛' : '尚未达到 70% 被动门槛'}`
    : selectedCharacter.summary;
  holeCards.innerHTML = state.selfCards.map(holeCardButton).join('');
  document.querySelector('#handSummaryLabel').textContent = '当前牌型';
  document.querySelector('#handSummaryValue').textContent = selfHandLabel();
  document.querySelector('#handSummaryMeta').textContent = `距目标还差 ${formatChips(Math.max(0, targetByPlayers[state.playerCount] - availableChipsFor(selectedCharacter.id)))}`;
}

function renderSidebar() {
  document.querySelectorAll('[data-side-tab]').forEach((button) => {
    const selected = button.dataset.sideTab === state.sideTab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  if (state.sideTab === 'skills') {
    const shown = ['xray', 'shield', 'gambler', 'catch-cheater'].map(getSkill);
    sidebarContent.innerHTML = `<div class="side-skills"><div class="sidebar-goal"><small>本手公共技能</small><strong>1 / 人</strong><span>秘密装备不会出现在其他玩家座位</span></div>${shown.map((skill) => `<div class="side-skill"><img src="${skillImage(skill.id)}" alt="" /><strong>${skill.name}</strong><span>${skill.category} · ${skill.cheat ? '作弊' : '合法'}</span></div>`).join('')}<button class="quiet-action" data-sidebar-action="library">打开 30 技能图鉴</button></div>`;
    return;
  }
  if (state.sideTab === 'log') {
    const items = activityLogItems();
    sidebarContent.innerHTML = `<div class="side-log"><div class="sidebar-goal"><small>第 ${state.handNumber} 手</small><strong>翻牌</strong><span>所有判定记录使用服务端序号</span></div>${items.map(([title, copy]) => `<div class="log-item"><strong>${title}</strong><span>${copy}</span></div>`).join('')}</div>`;
    return;
  }
  const rosterIds = participantCharacterIds();
  const highestChips = Math.max(...rosterIds.map(availableChipsFor));
  const handProgress = state.handNumber ? `第 ${state.handNumber}/15 手` : '尚未开局';
  sidebarContent.innerHTML = `<div class="sidebar-goal"><small>${state.playerCount} 人动态胜利目标</small><strong>${formatChips(targetByPlayers[state.playerCount])}</strong><span>${handProgress} · 当前最高 ${formatChips(highestChips)}</span></div><div class="roster">${rosterIds.map((id) => { const character = getCharacter(id); return `<div><span class="tiny-face"><img src="${characterImage(id, state.screen === 'awaken' && id === 'fenxiang' ? true : undefined)}" alt="" /></span><p><strong>${id === state.characterId ? '你 · ' : ''}${character.name}</strong><small>${state.screen === 'match-end-cap' ? '净资产' : '筹码'} ${formatChips(availableChipsFor(id))}</small></p><em>${publicResourceFor(id)}</em></div>`; }).join('')}</div>${state.loanActive ? '<button type="button" class="quiet-action" data-sidebar-action="ledger">查看公开贷款账本</button>' : ''}<div class="sidebar-note"><strong>牌面可见性合同</strong><p>任何技能、贷款、质疑、觉醒或结算只替换下方操作轨道。公共牌与自己/授权观战手牌不会被浮层覆盖。</p></div>`;
}

function updateHeaderAndEvent() {
  const meta = screenMeta[state.screen] || screenMeta.play;
  eventTitle.textContent = meta[0];
  eventCopy.textContent = meta[1];
  eventLane.dataset.tone = meta[2];
  if (state.screen === 'target') {
    const characterTarget = state.confirmContext === 'character-target';
    eventTitle.textContent = characterTarget ? '选择人物技能目标' : '选择技能目标';
    eventCopy.textContent = characterTarget
      ? `${characterActionFor(state.characterId).active}：请选择一名仍可被影响的玩家`
      : `${getSkill(state.selectedSkillId).name}：${getSkill(state.selectedSkillId).summary}`;
  }
  if (state.screen === 'confirm') {
    if (state.confirmContext === 'mao-suit') { eventTitle.textContent = '选择宣称花色'; eventCopy.textContent = `毛哥将在河牌前宣称${state.selectedMaoSuit}，提交后开启 4 秒质疑窗口`; }
    else if (state.confirmContext === 'character') { eventTitle.textContent = '确认人物技能'; eventCopy.textContent = characterActionFor(state.characterId).confirm; }
    else { eventTitle.textContent = '确认公共技能'; eventCopy.textContent = `${getSkill(state.selectedSkillId).name}：${getSkill(state.selectedSkillId).summary}`; }
  }
  if (state.screen === 'play' && state.streetKey !== 'flop') {
    const streetLabels = { preflop: ['翻牌前行动', '翻牌前 · 底牌与装备已确认'], turn: ['转牌行动', '转牌已发 · 河牌尚未发出'], river: ['河牌行动', '河牌已发 · 等待最后行动'] };
    const [title, copy] = streetLabels[state.streetKey] || streetLabels.preflop;
    eventTitle.textContent = title;
    eventCopy.textContent = copy;
  }
  if (state.screen === 'mao-challenge') {
    const suitNames = { '♠': '黑桃', '♥': '红桃', '♣': '梅花', '♦': '方片' };
    eventCopy.textContent = `毛哥宣称河牌为${suitNames[state.selectedMaoSuit]}；首位质疑者进入自然牌验证`;
  }
  if (state.screen === 'character-locked') eventCopy.textContent = `${state.isReady ? state.playerCount : Math.max(1, state.playerCount - 1)}/${state.playerCount} 已准备；${state.isReady ? '房主可开始牌局' : '全员准备后房主可开始'}`;
  if (state.screen === 'loan-response') eventCopy.textContent = `${getCharacter(state.loanTargetId).name}需要主动接受或拒绝，接受前双方筹码都不会变化`;
  if (state.screen === 'spectator') eventCopy.textContent = state.spectatorId
    ? `正在观看${getCharacter(state.spectatorId).name}的公开观战手牌；牌面始终位于独立轨道`
    : '全桌视角只显示公共牌与公开状态，不下发任何玩家底牌';
  if (state.screen === 'match-end') eventCopy.textContent = `${getCharacter(rankedParticipantIds()[0]).name}在第 14 手达到 ${formatChips(targetByPlayers[state.playerCount])} 的动态目标`;
  if (state.screen === 'match-end-cap') eventCopy.textContent = `第 15 手结算完成，无人达到 ${formatChips(targetByPlayers[state.playerCount])}，按结算净资产排名`;
  const lobby = isLobbyContext();
  document.querySelector('#handStatus').textContent = lobby ? '准备阶段' : ['match-end', 'match-end-cap'].includes(state.screen) ? '整场结束' : `第 ${state.handNumber}/15 手`;
  document.querySelector('#goalStatus').textContent = `${state.playerCount} 人目标 ${formatChips(targetByPlayers[state.playerCount])}`;
  document.querySelector('#blindStatus').textContent = lobby ? '预计 30 分钟' : blindLabelForHand(state.handNumber);
  document.querySelector('#roomCode').textContent = state.screen === 'create-room' ? '新房间 · 私人俱乐部' : '房间 H3X7 · 娱乐模式';
  eventAction.hidden = !['draft-error', 'skill-cooldown', 'spectator-hidden'].includes(state.screen);
  eventAction.textContent = state.screen === 'draft-error' ? '诊断' : state.screen === 'skill-cooldown' ? '详情' : '权限说明';
}

function applyFixture(screen) {
  setFixtureCharacter('fenxiang');
  state.handNumber = ['create-room', 'character-select', 'character-locked'].includes(screen) ? 0 : screen === 'match-end' ? 14 : screen === 'match-end-cap' ? 15 : 6;
  state.awakenedCharacterIds = [];
  state.isReady = false;
  state.previewAwakened = false;
  state.characterDetailsOpen = false;
  state.selectedTargetId = null;
  state.selectedCard = null;
  state.selfCards = ['Q♥', '8♣'];
  state.selectedHoleIndex = 0;
  state.selectedMaoSuit = '♥';
  state.confirmContext = 'skill';
  state.skillConsumed = false;
  state.characterSkillConsumed = false;
  state.loanActive = false;
  state.reactionWindowSkillId = null;
  state.spectatorId = 'ya';
  state.lastSpectatorId = 'ya';
  state.spectatorAttemptId = 'zige';
  if (screen === 'skill-library') state.libraryReturnScreen = 'play';
  if (['draft', 'draft-loading', 'draft-error'].includes(screen)) {
    state.draftOfferIds = ['xray', 'gambler', 'shield'];
    state.selectedSkillId = 'xray';
  }
  if (screen === 'draft-timeout') state.selectedSkillId = 'shield';
  if (screen === 'play') state.selectedSkillId = 'xray';
  if (screen === 'target') state.selectedSkillId = 'xray';
  if (screen === 'confirm') { state.selectedSkillId = 'charm'; state.selectedTargetId = 'xu'; }
  if (screen === 'skill-cooldown') { state.selectedSkillId = 'mirror'; state.skillConsumed = true; state.characterSkillConsumed = true; }
  if (screen === 'hand-result') state.characterSkillConsumed = true;
  if (['catch-result', 'catch-miss'].includes(screen)) { state.selectedSkillId = 'catch-cheater'; state.skillConsumed = true; setFixtureCharacter('fenxiang', [screen === 'catch-result' ? 'ya' : 'xu']); }
  if (['loan-offer', 'loan-ledger'].includes(screen)) { state.loanAmount = 400; state.loanTargetId = state.playerCount >= 3 ? 'xu' : 'fenxiang'; setFixtureCharacter('zige', [state.loanTargetId]); }
  if (screen === 'loan-ledger') { state.loanActive = true; state.characterSkillConsumed = true; }
  if (screen === 'loan-response') { state.loanAmount = 400; state.loanTargetId = state.playerCount >= 3 ? 'xu' : 'fenxiang'; setFixtureCharacter(state.loanTargetId, ['zige']); }
  if (screen === 'ya-river-choice') setFixtureCharacter('ya');
  if (screen === 'qiwan-card-swap') { setFixtureCharacter('qiwan'); state.selectedHoleIndex = 0; }
  if (screen === 'spectator') { setFixtureCharacter('fenxiang', ['ya']); state.spectatorId = 'ya'; state.lastSpectatorId = 'ya'; }
  if (screen === 'spectator-hidden') { setFixtureCharacter('fenxiang', ['mao']); state.spectatorId = 'mao'; state.lastSpectatorId = 'fenxiang'; }
  if (screen === 'spectator-failed') {
    state.spectatorAttemptId = state.playerCount >= 3 ? 'zige' : 'ya';
    setFixtureCharacter('fenxiang', [state.spectatorAttemptId]);
    state.spectatorId = state.spectatorAttemptId;
    state.lastSpectatorId = 'fenxiang';
  }
  if (screen === 'activity-log') { state.mobilePanel = 'log'; state.activityReturnScreen = 'play'; }
  if (screen === 'awaken') markCharacterAwakened('fenxiang');
}

function setScreen(screen, { fixture = false } = {}) {
  if (fixture) { applyFixture(screen); resetCommunityCards(screen); }
  state.screen = screen;
  frame.dataset.screen = screen;
  frame.dataset.tableMode = isLobbyContext(screen) ? 'lobby' : 'play';
  const selfCardTarget = state.confirmContext !== 'character-target' && getSkill(state.selectedSkillId).kind.includes('self-card');
  frame.dataset.targetKind = selfCardTarget ? 'self-card' : 'player';
  screenSelect.value = screen;
  targetHint.hidden = !['target', 'loan-offer'].includes(screen);
  targetHint.textContent = screen === 'loan-offer' ? '点击金框座位选择借款人' : selfCardTarget ? '请选择上方自己的一张底牌' : '请选择金色描边的玩家';
  updateHeaderAndEvent();
  renderHand();
  renderControl();
  renderSidebar();
  const panel = controlContent.firstElementChild;
  if (panel) {
    panel.tabIndex = -1;
    window.requestAnimationFrame(() => panel.focus({ preventScroll: true }));
  }
}

function announce(title, copy, tone = 'success') {
  eventTitle.textContent = title;
  eventCopy.textContent = copy;
  eventLane.dataset.tone = tone;
}

function restoreControlFocus(selector) {
  window.requestAnimationFrame(() => controlContent.querySelector(selector)?.focus({ preventScroll: true }));
}

screenSelect.addEventListener('change', (event) => setScreen(event.target.value, { fixture: true }));

document.querySelectorAll('.segmented [data-device]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.segmented button').forEach((item) => { item.classList.remove('active'); item.setAttribute('aria-pressed', 'false'); });
    button.classList.add('active');
    button.setAttribute('aria-pressed', 'true');
    frame.dataset.device = button.dataset.device;
    if (button.dataset.frameWidth) {
      frame.style.setProperty('--preview-width', `${button.dataset.frameWidth}px`);
      frame.style.setProperty('--preview-height', `${button.dataset.frameHeight}px`);
    } else {
      frame.style.removeProperty('--preview-width');
      frame.style.removeProperty('--preview-height');
    }
  });
});

document.querySelector('#toggleZones').addEventListener('click', (event) => {
  state.zonesVisible = !state.zonesVisible;
  frame.classList.toggle('zones-visible', state.zonesVisible);
  event.currentTarget.textContent = state.zonesVisible ? '隐藏安全区' : '显示安全区';
  event.currentTarget.setAttribute('aria-pressed', String(state.zonesVisible));
});

document.querySelector('#resetState').addEventListener('click', () => setScreen(state.screen, { fixture: true }));
document.querySelector('#openRulebook').addEventListener('click', openSkillLibrary);

document.querySelectorAll('[data-side-tab]').forEach((button) => {
  button.addEventListener('click', () => { state.sideTab = button.dataset.sideTab; renderSidebar(); });
});

document.querySelector('#tableZone').addEventListener('click', (event) => {
  const seat = event.target.closest('.seat');
  if (!seat || seat.dataset.validTarget !== 'true') return;
  const userId = seat.dataset.userId;
  if (state.screen === 'loan-offer') {
    state.loanTargetId = userId;
    renderControl();
    announce('已选择借款人', `贷款邀请将发送给${seat.querySelector('strong').textContent}`, 'warning');
    return;
  }
  if (state.screen !== 'target') return;
  state.selectedTargetId = userId;
  if (state.confirmContext === 'character-target') {
    state.characterSkillConsumed = true;
    const active = characterActionFor(state.characterId).active;
    setScreen('play');
    announce(`${active}已发动`, `目标：${seat.querySelector('strong').textContent}；结果由服务端事件确认`, 'success');
    return;
  }
  const skill = getSkill(state.selectedSkillId);
  if (skill.kind.includes('self-card')) return;
  if (skill.kind.startsWith('confirm')) {
    setScreen('confirm');
  } else {
    state.skillConsumed = true;
    setScreen('play');
    announce('技能已发动', `已对${seat.querySelector('strong').textContent}发动${skill.name}`, 'success');
  }
});

handRail.addEventListener('click', (event) => {
  const card = event.target.closest('[data-card]');
  if (!card || state.screen !== 'target' || !getSkill(state.selectedSkillId).kind.includes('self-card')) return;
  state.selectedCard = card.dataset.card;
  state.confirmContext = 'skill';
  setScreen(getSkill(state.selectedSkillId).kind.startsWith('confirm') || state.selectedSkillId === 'gambler' ? 'confirm' : 'play');
  announce('已选择底牌', `${getSkill(state.selectedSkillId).name}将作用于 ${card.dataset.card}`, 'warning');
});

controlContent.addEventListener('input', (event) => {
  if (event.target.id === 'loanRange') {
    state.loanAmount = Number(event.target.value);
    document.querySelector('#loanPrincipalLabel').textContent = `本金 ${formatChips(state.loanAmount)}`;
    document.querySelector('#loanRepayment').textContent = formatChips(Math.round(state.loanAmount * 1.1));
  }
});

controlContent.addEventListener('click', (event) => {
  const roomMode = event.target.closest('[data-room-mode]');
  if (roomMode) {
    state.roomMode = roomMode.dataset.roomMode;
    renderControl();
    restoreControlFocus(`[data-room-mode="${state.roomMode}"]`);
    announce(state.roomMode === 'hextech' ? '已选择海克斯大乱德' : '已选择经典模式', state.roomMode === 'hextech' ? '创建后进入人物选择流程' : '创建后进入项目现有经典房间流程', 'neutral');
    return;
  }
  const rankButton = event.target.closest('[data-rank]');
  if (rankButton) { state.selectedRank = rankButton.dataset.rank; renderControl(); controlContent.querySelector(`[data-rank="${state.selectedRank}"]`)?.focus(); return; }
  const maoSuitButton = event.target.closest('[data-mao-suit]');
  if (maoSuitButton) { state.selectedMaoSuit = maoSuitButton.dataset.maoSuit; renderControl(); restoreControlFocus(`[data-mao-suit="${state.selectedMaoSuit}"]`); return; }
  const skillChoiceButton = event.target.closest('[data-skill-choice]');
  if (skillChoiceButton) {
    state.selectedChoiceBySkill[state.selectedSkillId] = skillChoiceButton.dataset.skillChoice;
    renderControl();
    restoreControlFocus(`[data-skill-choice="${skillChoiceButton.dataset.skillChoice}"]`);
    return;
  }
  const qiwanHoleButton = event.target.closest('[data-qiwan-hole-index]');
  if (qiwanHoleButton) {
    state.selectedHoleIndex = Number(qiwanHoleButton.dataset.qiwanHoleIndex);
    renderControl();
    restoreControlFocus(`[data-qiwan-hole-index="${state.selectedHoleIndex}"]`);
    return;
  }
  const characterCard = event.target.closest('[data-character-id]');
  if (characterCard && !characterCard.disabled) {
    state.characterId = characterCard.dataset.characterId;
    renderHand(); renderControl(); renderSidebar();
    controlContent.querySelector(`[data-character-id="${state.characterId}"]`)?.focus();
    return;
  }
  const skillCard = event.target.closest('[data-skill-id]');
  if (skillCard) {
    state.selectedSkillId = skillCard.dataset.skillId;
    renderControl();
    controlContent.querySelector(`[data-skill-id="${state.selectedSkillId}"]`)?.focus();
    return;
  }
  const filter = event.target.closest('[data-skill-filter]');
  if (filter) { state.libraryFilter = filter.dataset.skillFilter; renderControl(); restoreControlFocus(`[data-skill-filter="${state.libraryFilter}"]`); return; }
  const librarySkill = event.target.closest('[data-library-skill]');
  if (librarySkill) { const skill = getSkill(librarySkill.dataset.librarySkill); announce(skill.name, `${skill.category} · ${skill.timing} · ${skill.cheat ? '作弊技能' : '合法技能'} · ${skill.summary}`, skill.cheat ? 'warning' : 'neutral'); return; }
  const spectatorPerson = event.target.closest('[data-spectator-id]');
  if (spectatorPerson) {
    const spectatorId = spectatorPerson.dataset.spectatorId;
    if (!spectatorSharedHandIds.has(spectatorId)) { state.spectatorId = spectatorId; setScreen('spectator-hidden'); }
    else { state.spectatorId = spectatorId; state.lastSpectatorId = spectatorId; setScreen('spectator'); announce('观战视角已切换', `正在观看${getCharacter(spectatorId).name}的授权手牌`, 'neutral'); }
    return;
  }
  const pokerAction = event.target.closest('[data-poker-action]');
  if (pokerAction) { announce('行动已提交', `${getCharacter(state.characterId).name}${pokerAction.dataset.pokerAction} · 等待其他玩家`, 'success'); return; }
  const step = event.target.closest('[data-step-player]');
  if (step) {
    const stepValue = step.dataset.stepPlayer;
    state.playerCount = Math.min(8, Math.max(2, state.playerCount + Number(step.dataset.stepPlayer)));
    state.occupiedIds = buildFixtureOccupants(state.characterId);
    updateHeaderAndEvent(); renderHand(); renderControl(); renderSidebar();
    restoreControlFocus(`[data-step-player="${stepValue}"]`);
    return;
  }
  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  const actions = {
    'create-room': () => state.roomMode === 'hextech' ? setScreen('character-select') : announce('经典模式沿用现有流程', '本 v1 稿聚焦海克斯新增流程；正式开发跳转到现有经典房间等待页', 'neutral'),
    'lock-character': () => setScreen('character-locked'),
    'toggle-awaken': () => { state.previewAwakened = !state.previewAwakened; renderControl(); restoreControlFocus('[data-action="toggle-awaken"]'); },
    'toggle-character-details': () => { state.characterDetailsOpen = !state.characterDetailsOpen; renderControl(); restoreControlFocus('[data-action="toggle-character-details"]'); },
    'change-character': () => { state.isReady = false; setScreen('character-select'); },
    ready: () => {
      if (!state.isReady) {
        state.isReady = true;
        renderControl();
        updateHeaderAndEvent();
        restoreControlFocus('[data-action="ready"]');
        announce('全员已准备', `${state.playerCount}/${state.playerCount} 已准备，房主可以开始牌局`, 'success');
        return;
      }
      state.handNumber = 1;
      startNewHand();
      announce('第 1 手牌已发', '请在 60 秒内从 3 个公共技能中装备 1 个', 'neutral');
    },
    reroll: () => { setScreen('draft-loading'); window.setTimeout(() => { if (state.screen !== 'draft-loading') return; state.draftOfferIds = ['silence', 'bounty', 'reforge']; state.selectedSkillId = 'silence'; setScreen('draft'); announce('刷新完成', '已获得新的 3 个选项，本场免费刷新剩余 0 次', 'success'); }, 720); },
    'cancel-loading': () => setScreen('draft'),
    'retry-reroll': () => { setScreen('draft-loading'); window.setTimeout(() => { if (state.screen === 'draft-loading') { state.draftOfferIds = ['silence', 'bounty', 'reforge']; state.selectedSkillId = 'silence'; setScreen('draft'); } }, 720); },
    'return-draft': () => setScreen('draft'),
    'continue-play': () => { state.selectedSkillId = 'shield'; state.skillConsumed = false; state.characterSkillConsumed = false; state.reactionWindowSkillId = null; setScreen('play'); },
    'open-library': openSkillLibrary,
    'close-library': closeSkillLibrary,
    'equip-skill': () => { state.skillConsumed = false; state.characterSkillConsumed = false; state.reactionWindowSkillId = null; setScreen('play'); },
    'use-skill': () => {
      const skill = getSkill(state.selectedSkillId);
      if (skill.kind === 'passive') return;
      if (skill.kind === 'reaction') {
        if (state.reactionWindowSkillId !== skill.id) { announce('等待反应窗口', `${skill.name}只能在服务端下发的合法反应窗口发动`, 'warning'); return; }
        state.skillConsumed = true;
        state.reactionWindowSkillId = null;
        setScreen('play');
        announce('反应技能已提交', `${skill.name}已进入服务端结算队列`, 'success');
        return;
      }
      state.confirmContext = 'skill';
      if (['confirm', 'confirm-choice'].includes(skill.kind)) setScreen('confirm');
      else setScreen('target');
    },
    'character-skill': () => {
      const characterId = state.characterId;
      if (characterId === 'zige') { setScreen('loan-offer'); return; }
      if (characterId === 'ya') { resetCommunityCards('ya-river-choice'); setScreen('ya-river-choice'); return; }
      if (characterId === 'qiwan') { state.selectedHoleIndex = 0; resetCommunityCards('qiwan-card-swap'); setScreen('qiwan-card-swap'); return; }
      if (characterId === 'mao') { state.confirmContext = 'mao-suit'; resetCommunityCards('mao-challenge'); setScreen('confirm'); return; }
      if (characterId === 'jiansheng') { state.confirmContext = 'character-target'; setScreen('target'); announce('剑压：选择目标', '请选择一名本街仍可加注的玩家', 'warning'); return; }
      state.confirmContext = 'character';
      setScreen('confirm');
      announce('人物技能确认', `${characterActionFor(characterId).active}将由服务端校验条件后生效`, 'warning');
    },
    'cancel-target': () => setScreen('play'),
    'cancel-confirm': () => setScreen('play'),
    'confirm-skill': () => {
      const characterConfirm = state.confirmContext === 'character';
      const confirmedSkill = getSkill(state.selectedSkillId);
      if (characterConfirm) state.characterSkillConsumed = true;
      else state.skillConsumed = true;
      if (!characterConfirm && confirmedSkill.id === 'catch-cheater') {
        setScreen('catch-result');
        announce('服务端审计完成', `${getCharacter(state.selectedTargetId).name}本手使用过作弊技能，进入抓老千成功结算`, 'success');
        return;
      }
      const characterUi = characterActionFor(state.characterId);
      setScreen('play');
      announce(characterConfirm ? `${characterUi.active}已生效` : '不可逆技能已提交', characterConfirm ? characterUi.confirm : `${confirmedSkill.name}已交由服务端执行`, 'success');
    },
    'confirm-mao-claim': () => { state.characterSkillConsumed = true; setScreen('mao-challenge'); announce('花色宣称已提交', `毛哥宣称${state.selectedMaoSuit}，4 秒质疑窗口已向全桌打开`, 'warning'); },
    'send-loan': () => { const borrowerId = state.loanTargetId; setFixtureCharacter(borrowerId, ['zige']); setScreen('loan-response'); announce('已切换到借款人响应视角', `${getCharacter(borrowerId).name}可接受或拒绝 ${formatChips(state.loanAmount)} 筹码贷款`, 'warning'); },
    'accept-loan': () => { state.loanActive = true; state.characterSkillConsumed = state.characterId === 'zige'; setScreen('loan-ledger'); announce('贷款已接受', `${formatChips(state.loanAmount)} 已到账；到期偿还 ${formatChips(Math.round(state.loanAmount * 1.1))}`, 'success'); },
    'reject-loan': () => { state.loanActive = false; setScreen('play'); announce('贷款被拒绝', '双方筹码和账本均未变化', 'neutral'); },
    'expire-loan': () => { state.loanActive = false; setScreen('play'); announce('贷款邀请已过期', '对方未在 10 秒内响应，双方筹码不变', 'neutral'); },
    'cancel-loan': () => setScreen('play'),
    'new-loan': () => { if (!state.loanActive) setScreen('loan-offer'); },
    'view-ledger': () => setScreen('loan-ledger'),
    'return-ledger': () => setScreen('play'),
    'challenge-mao': () => {
      const predictionCorrect = state.selectedMaoSuit === '♣';
      state.characterSkillConsumed = true;
      setScreen('play');
      dealRiverCard('9♣');
      announce(predictionCorrect ? '质疑失败' : '质疑成功', predictionCorrect ? '自然河牌为 9♣，质疑者向底池支付 40，毛哥获得 1 旺柴' : '自然河牌为 9♣，毛哥向首位质疑者支付 40', predictionCorrect ? 'danger' : 'success');
    },
    'trust-mao': () => { actionTarget.disabled = true; actionTarget.textContent = '你已选择不质疑'; announce('等待其他玩家', '你的选择不会替其他玩家关闭 4 秒质疑窗口', 'warning'); },
    'confirm-river': () => { state.characterSkillConsumed = true; setScreen('play'); announce('随机换河已预约', '正常牌局继续；真正发河时服务端才会弃置原定自然河牌，并发出不可预知的牌堆顶下一张', 'success'); },
    'cancel-river': () => { setScreen('play'); announce('未发动逆流换河', '鸭毛未消耗，后续按自然牌序继续发牌', 'neutral'); },
    'confirm-qiwan-swap': () => {
      const replacedCard = state.selfCards[state.selectedHoleIndex];
      state.selfCards[state.selectedHoleIndex] = 'K♦';
      state.characterSkillConsumed = true;
      setScreen('play');
      announce('随机换牌已结算', `${replacedCard} 已弃置；服务端从牌堆顶补入 K♦，发动前未展示换入牌`, 'success');
    },
    'cancel-swap': () => { setScreen('play'); announce('未发动盲盒换牌', '奇想未消耗，底牌保持不变', 'neutral'); },
    'ack-catch': () => setScreen('play'),
    'show-players': () => { state.mobilePanel = 'players'; state.activityReturnScreen = state.screen; setScreen('activity-log'); },
    'show-log': () => { state.mobilePanel = 'log'; state.activityReturnScreen = state.screen; setScreen('activity-log'); },
    'show-skills': () => { state.mobilePanel = 'skills'; state.activityReturnScreen = state.screen; setScreen('activity-log'); },
    'return-from-log': () => setScreen(state.activityReturnScreen || 'play'),
    'ack-awaken': () => setScreen('play'),
    'view-character': () => { state.characterDetailsOpen = true; renderControl(); restoreControlFocus('[data-action="close-character-detail"]'); },
    'close-character-detail': () => { state.characterDetailsOpen = false; renderControl(); restoreControlFocus('[data-action="view-character"]'); },
    'return-spectator': () => { state.spectatorId = state.lastSpectatorId; setScreen('spectator'); },
    'retry-spectator': () => {
      state.spectatorId = state.spectatorAttemptId;
      if (!spectatorSharedHandIds.has(state.spectatorId)) { setScreen('spectator-hidden'); return; }
      state.lastSpectatorId = state.spectatorId;
      setScreen('spectator');
      announce('观战切换成功', `正在观看${getCharacter(state.spectatorId).name}的授权手牌`, 'success');
    },
    'table-view': () => { state.spectatorId = null; setScreen('spectator'); announce('全桌观战', '只显示公共牌与公开状态，不显示未授权底牌', 'neutral'); },
    'next-hand': advanceToNextHand,
    'spectate-after-bust': () => setScreen('spectator'),
    'confirm-rebuy': () => { advanceToNextHand(); announce('补筹成功', '2,000 将在下一手开始前到账；剩余补筹次数 1', 'success'); },
    'play-again': () => { state.isReady = false; state.handNumber = 0; state.loanActive = false; state.awakenedCharacterIds = []; resetPerHandState(); setScreen('character-select'); },
    'exit-room': () => { state.isReady = false; state.handNumber = 0; state.loanActive = false; state.awakenedCharacterIds = []; resetPerHandState(); setScreen('create-room'); },
  };
  actions[action]?.();
});

sidebarContent.addEventListener('click', (event) => {
  if (event.target.closest('[data-sidebar-action="library"]')) openSkillLibrary();
  if (event.target.closest('[data-sidebar-action="ledger"]')) setScreen('loan-ledger');
});

eventAction.addEventListener('click', () => {
  if (state.screen === 'draft-error') announce('错误码 DRAFT_OFFER_TIMEOUT', '保留旧 offerId，允许玩家重试，不消耗刷新次数', 'danger');
  if (state.screen === 'skill-cooldown') announce('禁用原因', '技能本手已发动 1 次；冷却与可用次数均以服务端字段为准', 'neutral');
  if (state.screen === 'spectator-hidden') announce('隐私保护', 'HAND_NOT_SHARED 响应不包含 rank、suit 或可逆推的牌索引', 'danger');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (state.screen === 'target') { event.preventDefault(); setScreen('play'); }
    else if (state.screen === 'confirm') { event.preventDefault(); setScreen('play'); }
    else if (state.screen === 'ya-river-choice') { event.preventDefault(); setScreen('play'); announce('未发动逆流换河', '鸭毛未消耗，后续按自然牌序继续发牌', 'neutral'); }
    else if (state.screen === 'activity-log') { event.preventDefault(); setScreen(state.activityReturnScreen || 'play'); }
    else if (['loan-offer', 'loan-response', 'mao-challenge', 'qiwan-card-swap'].includes(state.screen)) { event.preventDefault(); setScreen('play'); }
    else if (['spectator-hidden', 'spectator-failed'].includes(state.screen)) { event.preventDefault(); state.spectatorId = state.lastSpectatorId; setScreen('spectator'); }
    else if (state.screen === 'skill-library') { event.preventDefault(); closeSkillLibrary(); }
    else if (state.screen === 'awaken' && state.characterDetailsOpen) { event.preventDefault(); state.characterDetailsOpen = false; renderControl(); restoreControlFocus('[data-action="view-character"]'); }
    return;
  }
  if (event.key === 'Enter' && ['draft', 'draft-error'].includes(state.screen) && document.activeElement?.closest?.('[data-skill-id]')) {
    event.preventDefault();
    state.skillConsumed = false;
    state.characterSkillConsumed = false;
    state.reactionWindowSkillId = null;
    setScreen('play');
    announce('技能已装备', `${getSkill(state.selectedSkillId).name}将在本手生效`, 'success');
    return;
  }
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  if (state.screen === 'create-room' && document.activeElement?.closest?.('[data-room-mode]')) {
    const modes = ['classic', 'hextech'];
    const index = modes.indexOf(state.roomMode);
    state.roomMode = modes[(index + direction + modes.length) % modes.length];
    event.preventDefault();
    renderControl();
    controlContent.querySelector(`[data-room-mode="${state.roomMode}"]`)?.focus();
  } else if (state.screen === 'character-select') {
    if (!document.activeElement?.closest?.('[data-character-id]')) return;
    const occupiedIds = occupiedCharacterIds();
    const selectableIds = characters.filter((character) => !occupiedIds.has(character.id)).map((character) => character.id);
    const index = selectableIds.indexOf(state.characterId);
    state.characterId = selectableIds[(index + direction + selectableIds.length) % selectableIds.length];
    event.preventDefault();
    renderHand(); renderControl(); renderSidebar();
    controlContent.querySelector(`[data-character-id="${state.characterId}"]`)?.focus();
  } else if (['draft', 'draft-error'].includes(state.screen)) {
    if (!document.activeElement?.closest?.('[data-skill-id]')) return;
    const index = state.draftOfferIds.indexOf(state.selectedSkillId);
    state.selectedSkillId = state.draftOfferIds[(index + direction + state.draftOfferIds.length) % state.draftOfferIds.length];
    event.preventDefault();
    renderControl();
    controlContent.querySelector(`[data-skill-id="${state.selectedSkillId}"]`)?.focus();
  }
});

document.addEventListener('error', (event) => {
  if (!(event.target instanceof HTMLImageElement)) return;
  event.target.classList.add('asset-missing');
  event.target.alt = event.target.alt || '素材生成中';
}, true);

window.HEXTECH_V1_DATA = { characters, skills, targetByPlayers };
setScreen('create-room', { fixture: true });
