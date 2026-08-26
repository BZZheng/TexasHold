# 海克斯大乱德 UI / 交互开发规格 v1

配套可点击稿：`prototype-v1.html`。配套玩法基线：`GAME-RULES-v1.md`。三者共同作为开发输入，不是气氛参考。

## 1. v1 范围

- 创建海克斯房与动态目标预览。
- 8 名人物的预览、占用、锁定、准备、资源、成长、台词与觉醒。
- 30 个公共技能图鉴、每手三选一、免费刷新、加载、失败、超时自动选择、冷却与禁用。
- 普通目标选择与不可逆技能二次确认。
- 资哥贷款邀请、接受/拒绝语义和公开账本。
- 毛哥花色宣称与质疑窗口。
- 抓老千成功/失败的服务端审计结果。
- 自己手牌、授权观战手牌、无权限与切换失败。
- 单手结算、补筹和整场终局。
- 桌面、768、414、375、320 五档可点击验证。

## 2. 不遮牌的强制布局合同

牌局主列必须用 CSS Grid 或等价正常文档流建立三个兄弟轨道，顺序和职责不可交换：

```text
table-column
├── table-zone    公共牌、底池、座位
├── hand-rail     自己或当前授权观战玩家的底牌
└── control-rail  下注、人物、公共技能和所有过程/结果面板
```

- 普通牌局过程中禁止在 `table-zone` 或 `hand-rail` 上方创建技能模态框。
- 目标选择只给合法座位加金框；确认文本仍位于 `control-rail`。
- 觉醒、贷款、质疑、抓老千、单手结算、补筹和终局全部替换 `control-rail` 内容。
- `event-lane` 只能展示一行状态，不承载需要点击多步完成的操作。
- 公共牌五张的几何安全区任何状态都必须完整可见。
- 手牌轨道不得下移到操作轨道内部；操作轨道也不得使用 `position: fixed` 覆盖它。
- 原型的“显示安全区”按钮是开发验收工具，正式版可通过 debug flag 开启。

## 3. 响应式尺寸

| 范围 | 牌桌轨道 | 手牌轨道 | 操作轨道 | 侧栏 |
| --- | ---: | ---: | ---: | --- |
| ≥960 | 自适应，最小 350 | 110 | 228 | 300 固定 |
| 768–959 | 自适应，最小 330 | 106 | 232 | 移入抽屉 |
| 375–767 | 剩余空间，最小 276 | 100 | 244 | 移入底部抽屉 |
| 320–374 | 剩余空间，最小 265 | 96 | 238 | 移入底部抽屉 |

移动端要求：

- 3 张技能卡必须同屏，不依赖横向滚动才能看到第三张。
- 8 张人物卡允许在人物选择轨道横向滑动，因为它不是限时的单次选择。
- 人物卡首屏可压缩描述，但必须提供“完整技能 / 成长”入口，在 `control-rail` 内查看被动、主动、成长和觉醒全文。
- 底牌按钮可视尺寸约 44 px；正式实现扩大透明触摸热区到至少 44×44 px。奇玩只在人物操作轨内选择“第 1 / 第 2 张底牌”，不得在真实手牌上增加覆盖层或点击热区。
- 桌面侧栏在 768 与手机档改为操作轨道内的“玩家 / 记录 / 技能”入口；查看时替换 `control-rail`，不得覆盖下注按钮、公共牌或手牌。
- 使用 `env(safe-area-inset-bottom)` 给正式底部操作条留安全距离。

## 4. 页面与状态清单

原型工具栏中的 29 个场景均须能通过路由或 Storybook story 独立复现。

街道数据必须随 story 同步：技能选择与奇玩随机换牌为翻牌前 0 张；普通操作与鸭哥随机换河机会为翻牌 3 张；毛哥质疑为已发转牌 4 张；单手结算、补筹与终局为完整 5 张。`streetCopy`、底池、牌型摘要和终局资产必须使用同一 fixture，不能只替换文案。

| 场景 | 主状态 | 必要反馈 |
| --- | --- | --- |
| 创建海克斯房 | `create_room` | 人数步进器即时更新目标；创建时才提交。 |
| 选择人物 | `character_select` | 单击预览、主按钮锁定、已占用不可选。 |
| 人物已锁定 | `character_locked` | 显示全员准备；取消准备后才能更换。 |
| 技能三选一 | `skill_select` | 3 张同屏；预选与装备提交分离。 |
| 刷新加载 | `draft_refreshing` | 旧选项冻结，不扣次数直到服务端确认。 |
| 刷新失败 | `draft_refresh_error` | 可重试或用旧选项；倒计时重新同步。 |
| 超时自动装备 | `draft_auto_selected` | 显示 `autoSelected=true`，明确是哪张技能。 |
| 30 技能图鉴 | `skill_library` | 类别筛选；长描述可滚动阅读；返回键与 Esc 回到进入前场景，并保留 lobby / play 的牌面上下文。 |
| 正常操作 | `betting_action` | 人物 HUD、4 个扑克动作、1 个装备位。 |
| 选择技能目标 | `skill_targeting` | 有效目标来自服务端；Esc / 取消返回。 |
| 不可逆确认 | `skill_confirming` | 显示目标、最大筹码风险、反制方式。 |
| 技能冷却/禁用 | `skill_unavailable` | 禁用原因必须是文字，不只靠灰色。 |
| 资哥发起贷款 | `loan_composing` | 借款人、200–600 本金、到期额与到期手。 |
| 借款人响应 | `loan_responding` | 接受、拒绝和过期均明确“接受前不扣款”。 |
| 贷款账本 | `loan_ledger` | 本金、应还、到期、状态全桌公开。 |
| 质疑毛哥 | `mao_claim_window` | 毛哥先选择并确认 ♠/♥/♣/♦，再打开 4 秒首位质疑窗口并显示双方风险。 |
| 鸭哥随机换河 | `ya_river_replace` | 二次确认明确“无候选、不可预知、不可撤销”；确认后只展示预约状态，服务端弃置原定自然河牌并由牌堆顶下一张替换，不展示原牌。 |
| 奇玩盲盒换牌 | `qiwan_card_swap` | 在人物操作轨选择第 1 / 第 2 张底牌；二次确认后立即弃置并由牌堆顶下一张补入，不展示候选牌。 |
| 抓老千成功 | `cheat_audit_success` | 审计技能、向全桌支付与目标退出本手。 |
| 抓老千误抓 | `cheat_audit_miss` | 无作弊结果、误抓者支付 100、双方继续。 |
| 人物觉醒 | `character_awakened` | 完整说明在操作轨道内只读展开；不得复用可编辑的人物选择流程，行动中只用顶部紧凑提示。 |
| 授权观战 | `spectator_shared_hand` | 手牌只在 hand rail 更新；切换器覆盖全部 2–8 名在座玩家并可安全滚动。 |
| 无权限 | `spectator_hand_denied` | 真实牌值不下发，只显示牌背与恢复入口。 |
| 切换网络失败 | `spectator_switch_failed` | hand rail 保留上一个合法授权视角。 |
| 移动端牌局记录 | `activity_log` | 记录位于操作轨道，不依赖桌面隐藏侧栏。 |
| 单手结算 | `hand_settlement` | 主底池、技能/人物奖惩、贷款划转分项。 |
| 补筹确认 | `rebuy_window` | 固定 2,000、剩余次数、下一手到账。 |
| 达标终局 | `match_target_settlement` | 达标手数、动态目标、排名、同配置再开。 |
| 15 手兜底终局 | `match_cap_settlement` | 明确无人达标，按第 15 手结算净资产排名。 |

## 5. 关键组件合同

### 5.1 `RoomModeCard`

```ts
type RoomModeCardProps = {
  mode: "classic" | "hextech-chaos";
  selected: boolean;
  disabledReason?: string;
  onPreview(mode): void;
}
```

预览不产生远端写入；“创建房间”提交完整配置。

### 5.2 `CharacterCard`

```ts
type CharacterCardProps = {
  characterId: string;
  state: "selectable" | "previewed" | "occupied" | "locked";
  occupiedBy?: { userId: string; displayName: string };
  resourceLabel: string;
  growthProgress: { current: number; target: number };
  awakened: boolean;
}
```

`occupied` 使用 `disabled` 语义并显示占用者，不能只降低透明度。普通与觉醒素材文件不同，但 `characterId` 不变。
`occupiedCharacterIds` 是独立的服务端房间状态，人物预览不得重排或改写它；只有锁定、解锁或成员离开事件可以更新占用集合。

许哥的生产人物合同：

- “有效压秒投入”只由服务端根据操作前后已投入筹码差、服务端大盲值、剩余时间和自动操作标记判定。仅最后 2 秒内手动完成的跟注、下注、加注或全押，且实际投入至少 1BB 才有效；客户端不得预先增加炭火或成长进度。
- 同一条下注街最多获得 1 炭火并累计 1 次成长；成长展示为 `effectiveLateInvestments / 12` 和 `distinctHandsWithEffectiveLateInvestment / 6`，两项都满足后才显示觉醒。
- 普通烧烤下一街对所有仍在手非施法者应用 `opponentSecondsDelta: -15`，最低 30 秒；许哥应用 `selfSecondsDelta: 10`。觉醒后分别为 `-20` 与 `+15`，并在底池明细显示 80 银行筹码。
- 客户端文案不得使用“后手玩家”或暗示座位范围；效果与相对行动顺序无关。觉醒后判定窗口仍是最后 2 秒，不显示 3 秒提示。

鸭哥与奇玩的生产人物合同：

- 鸭哥只有在翻牌前或翻牌阶段由自己主动全押、且本手实际进入摊牌时获得 1 鸭毛。对手全部弃牌或只是全押跟注均不计进度；累计 3 次此类摊牌且至少赢 1 次才觉醒。
- 鸭哥主动消耗 2 鸭毛、每手最多一次。确认后服务器预约“弃置原定自然河牌，再以牌堆顶下一张替换”；客户端不得接收、展示原牌或候选牌。觉醒“轻舟逆流”只把费用降为 1，不增加候选或选择步骤。
- 奇玩主动消耗 2 奇想，只在翻牌前全押机会中使用、每手最多一次。客户端只提交 `holeCardIndex: 0 | 1`；服务器立即弃置该底牌并以牌堆顶下一张补入，不能提交换入牌或候选编号。
- 奇玩觉醒“灵感回响”不改变换牌步骤；仅当换入牌进入最终 best five 且赢池时，由服务端返还 1 奇想。
- 两个主动均属于不可预知、不可撤销的牌堆变更。首按钮进入人物操作轨内的二次确认，确认文案必须复述真实结果；返回或 Escape 只取消本地确认，不消耗资源。

嗡嗡文的生产人物合同：

- 翻牌圈或转牌圈中，只有面对其他玩家手动投入至少 2BB 的下注/加注，且嗡嗡文本次手动跟注、加注或全押实际投入至少 2BB，才获得 1 月痕；每手最多一次，自动操作不计。
- 「月蚀追猎」只在嗡嗡文自己的行动前可用。目标由服务端锁定为本街最后一名符合条件的主动进攻者；客户端只提交人物命令和幂等 ID，不提交目标、牌号或伪装结果。
- 服务端先通过统一看牌出口应用假弱/假强伪装，再随机选择一张展示牌。展示牌仅存在于嗡嗡文本人的人物操作轨，其他玩家与观战者收到 `reveal: null`，并且本人视图也不包含 `masked` 等命中标记。
- 私密展示固定占用人物操作轨中的结果槽位，写明目标、保留到本街结束和“伪装可能生效”；不得以浮层覆盖公共牌、自己底牌或观战牌。
- 觉醒「满月双刃」只判定发动后的下一次真实操作；至少 2BB 的完整加注或全押加注返还 1 月痕，跟注、弃牌、短额全押与自动操作均不返还。
- 8 名人物的选择、主动、成长、觉醒台词使用同一个固定高度文案槽；台词切换不能改变控制轨外部几何或移动按钮位置。

### 5.3 `EquipmentDraft`

```ts
type EquipmentDraft = {
  offerId: string;
  expiresAt: string;
  offers: SkillOffer[];
  selectedId?: string;
  rerollsRemaining: number;
  state: "choosing" | "refreshing" | "submitting" | "locked" | "expired" | "error";
  autoSelected: boolean;
}
```

- `selectedId` 是本地预选，`lockedSkillId` 才是服务端确认。
- 刷新必须带当前 `offerId`；服务端返回新 `offerId` 后旧卡永久失效。
- 客户端不自行随机选卡或推导金色概率。

### 5.3a `SkillLibrary`

公共技能图鉴必须在第一次发牌前可访问，至少从大厅、海克斯创建页和海克斯等待房提供入口。它负责完整学习规则，60 秒三选一只负责当手取舍。

- 数据源必须直接使用共享的 30 项技能规则，禁止复制第二份技能数值或解析摘要文案作为逻辑。
- 总览支持名称搜索、主动 / 被动 / 反应类型筛选和稀有度筛选，并始终显示当前命中数。
- 技能卡首层展示图标、名称、稀有度、类型、时机、摘要与“作弊 / 合法”文字标签。
- 展开详情展示目标、代价、最大风险、反制方式与实际操作步骤；不同类型明确说明“由你发动”“自动触发”或“等待反应窗口”。
- 桌面使用居中图鉴层，移动端使用全高抽屉；内容独立滚动，所有关闭、筛选与展开按钮触控区至少 44×44 px。
- Escape、关闭按钮和点击遮罩均回到来源页面；从创建页打开时不得重置房名、人数、模式或密码。
- 图鉴不进入牌局的 `table-zone` 与 `hand-rail`。牌局内的快速说明只显示当前装备，不替代牌局外完整图鉴。

### 5.4 `SkillControl`

```ts
type SkillWindow = {
  skillId: string;
  state: "idle" | "armed" | "targeting" | "confirming" | "resolving" | "consumed";
  validTargetUserIds: string[];
  maximumChipRisk: number;
  counterplayLabels: string[];
  expiresAt?: string;
  disabledReason?: string;
}
```

合法目标完全由服务端提供。涉及筹码、换牌、强制跟注、缴械、抓老千或不可撤销牌堆变化时必须二次确认。

### 5.5 `HandRail`

```ts
type HandRailState =
  | { kind: "self"; cards: Card[] }
  | { kind: "spectator_shared"; owner: PublicUser; cards: Card[] }
  | { kind: "spectator_denied"; owner: PublicUser; reason: string }
  | { kind: "spectator_table" }
  | { kind: "not_dealt" };
```

`spectator_denied` 响应禁止包含牌值、花色、牌堆索引或可逆推字段。不能把真实牌放进 DOM 后用模糊或 `display:none` 隐藏。
`spectator_table` 没有手牌拥有者，只显示牌背/未选择提示。未知或未授权 `ownerId` 必须失败关闭，禁止回退到任意示例手牌；网络切换失败继续使用 `lastAuthorizedOwnerId`，而不是本次尝试的目标。

### 5.6 `LoanComposer` / `LoanLedger`

```ts
type LoanOffer = {
  loanId: string;
  lenderUserId: string;
  borrowerUserId: string;
  principal: 200 | 300 | 400 | 500 | 600;
  interestRate: 0.10;
  dueAfterHands: 3;
  expiresAt: string;
  state: "offered" | "accepted" | "rejected" | "active" | "repaid" | "overdue";
}
```

借款人接受/拒绝是独立响应窗口。接受前不得预扣资哥筹码。账本对全桌公开，但不暴露账户或现实身份信息。
贷款接受后，可用筹码立即扣除本金；净资产统一计算为 `可用筹码 + 应收本金 + 已计提利息 - 自身贷款负债`。进行中贷款达到 1/1 时不得创建第二笔。
接受贷款只消耗出借人资哥的本手人物主动，不消耗借款人的人物技能；进行中贷款须从桌面侧栏和移动端“玩家 / 技能”抽屉重新进入公开账本。

### 5.7 选择型与反应型技能

- `confirm-choice` 必须由服务端 schema 提供选项：预言家为四种花色，牌型预报为九类最终牌型；未选择时不能提交。
- “我是赌圣”的目标点数覆盖完整 `A、K、Q、J、10…2` 十三档，移动端可横向滚动但不能裁掉选项语义。
- `reaction` 默认显示“等待合法反应窗口”且不可点击。只有服务端下发匹配的 `SkillWindow.state="armed"` 与 `expiresAt` 后才开放；金蝉脱壳不选择玩家，后手猎人只消费当前触发事件中的目标。
- 公共技能反应与鸭哥 / 奇玩的全押后人物机会重叠时，操作轨先显示公共反应；反应确认、放弃或超时后，人物机会重新获得完整 60 秒窗口，两个窗口不能互相阻塞。
- 公共技能与人物主动分别记录本手消耗状态；进入新一手时同时重置，但跨手债务、觉醒和成长进度不重置。
- 毛哥人物主动使用独立 `confirm-choice`：选择花色只更新本地预选，点击“宣称”并收到服务端确认后才消耗本手人物主动并打开质疑窗口。
- 奇玩不再存在候选选择或 `swapArmed`。第 1 / 第 2 张底牌的本地预选与最终提交必须分离；改变底牌预选、返回或按 Escape 都应撤销本地二次确认，只有确认按钮提交 `holeCardIndex`。
- 从结算等场景进入活动日志时保存 `returnScreen`；返回按钮与 Escape 必须回到来源场景，不能绕过下一手边界。觉醒状态跨手保留，仅在新整场或离房时清空。

## 6. 推荐服务端事件

```text
room.hextech.created
room.character.previewed          // 本地即可，不必广播
room.character.lock_requested
room.character.locked
room.member.ready_changed
hand.equipment.offer
hand.equipment.refresh_requested
hand.equipment.refreshed
hand.equipment.lock_requested
hand.equipment.locked
hand.equipment.auto_selected
hand.skill.target_window
hand.skill.confirmed
hand.skill.resolved
hand.character.progressed
hand.character.awakened
hand.mao.claimed_suit
hand.mao.challenge_opened
hand.mao.challenge_resolved
hand.cheat_audit.resolved
room.loan.offered
room.loan.responded
room.loan.settled
hand.settled
room.rebuy.responded
match.settled
```

所有结果事件包含 `eventSeq`、`roomVersion` 和服务端时间。随机结果额外包含可审计的结果标识，但不向无权限客户端下发秘密牌。

## 7. 加载、空、错、超时

- 首次加载人物/技能素材：保留卡片尺寸，用骨架块，不让轨道高度跳变。
- 技能刷新加载：旧卡可见但禁用；请求失败恢复旧卡可提交状态。
- 选择超时：先等待服务端 `auto_selected`，不能由前端自行选第 1 张。
- 目标过期：保留公共牌和手牌，将操作轨道恢复到下注；顶部说明“窗口已结束”。
- 扑克行动到达服务端时已过 `turnDeadline`：按“本回合行动时间已经结束”处理，立即停用旧操作按钮并等待服务端超时动作；客户端不得乐观移动筹码或预增人物资源、成长进度。
- 贷款邀请过期：双方账本保持不变，显示“未接受”而不是“失败扣款”。
- 服务重启恢复限时窗口时，以快照保存时的剩余时间重建，并追加重连宽限；不能在用户重新连入前自动强制跟注、自动选牌或判定无人质疑。
- 观战切换失败：保留当前合法手牌；若当前玩家权限被撤销，立即替换为牌背且清空内存中的牌值。
- 图片加载失败：卡片仍显示名称和类别；不使用布局坍塌的破图图标。

## 8. 交互与动效

- 卡牌预选：180 ms，最多位移 4 px。
- 三张技能进入：220 ms，可错开 40 ms；减少动态模式下同时出现。
- 锁定盖章：220 ms，不影响布局尺寸。
- 目标金框稳定显示，不循环闪烁。
- 觉醒头像变化：最多 420 ms；轮到下注时只更新头像框和顶部事件，不替换下注按钮。
- 所有概率结果先显示“服务端判定中”，再播放结果；不得先在客户端做乐观随机。

## 9. 可访问性

- 人物与技能选择使用按钮，容器使用 listbox/option 或 radio group 语义。
- `aria-selected`、`disabledReason`、作弊标签和冷却原因均需要文本表达。
- 倒计时只在 5、3、1 秒低频播报，避免每秒打断读屏。
- 键盘：方向键移动卡片预选，Enter 装备，Escape 取消目标/确认。
- 焦点不能跳到牌桌中央不可见元素；面板替换后焦点落到面板标题或首个动作。
- 卡通卡片正文和背景满足 WCAG AA；颜色不是稀有度与合法性的唯一提示。

## 10. 开发验收清单

- [ ] 320 / 375 / 414 / 768 / 1440 五档无横向滚动。
- [ ] 29 个场景中，`table-zone.bottom <= hand-rail.top` 且 `hand-rail.bottom <= control-rail.top`。
- [ ] 公共牌在所有牌局场景完整位于 `table-zone` 内。
- [ ] 自己或授权观战的两张手牌完整位于 `hand-rail` 内。
- [ ] 320 px 技能三选一的第三张不被裁切。
- [ ] 大厅、创建页与海克斯等待房均可在发牌前打开完整 30 技能图鉴；关闭后来源状态保持不变。
- [ ] 图鉴搜索、类型 / 稀有度筛选、展开详情和 44×44 px 触控在 320 / 375 / 768 / 桌面均可完成。
- [ ] 320 / 375 / 414 人物卡和技能卡底部文字、标签及选中描边不被裁切。
- [ ] 目标选择没有牌桌中央弹层。
- [ ] 觉醒、贷款、质疑、抓老千、结算与补筹均不遮牌。
- [ ] `HAND_NOT_SHARED` 不包含真实牌值，DOM 与全局状态也没有残留。
- [ ] 全桌观战没有默认手牌回退；观战网络失败保持上一个授权身份与牌值的原子绑定。
- [ ] 移动端能在操作轨道访问玩家、记录、技能、人物成长与贷款到期字段。
- [ ] 刷新失败不扣次数；超时选择来自服务端。
- [ ] 人物占用、按钮禁用、冷却和错误都包含文字原因。
- [ ] `prefers-reduced-motion` 下禁用非必要动效。
- [ ] 15 手终局与达标终局都能独立复现。

## 11. 原型与正式开发的边界

- 原型为纯前端状态演示，数值与概率不在浏览器实际随机。
- 正式开发应复用项目现有牌桌与发牌组件，新增人物/技能卡通层和三个轨道布局。
- 所有图片路径和 ID 见 `assets/v1/asset-manifest.json`；业务状态只存 ID，不存展示文案。
- 正式实现前先把 `GAME-RULES-v1.md` 转成共享配置与服务端测试，避免 UI 文案、客户端和服务端出现三套数值。
