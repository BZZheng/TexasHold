# 好友德州扑克设计系统

这是本应用的统一视觉基线。登录、游戏大厅、创建房间、等待入座、牌局、观战、补充筹码和结算必须共用同一套设计语言。

## 类型与结构

- **Genre**：atmospheric，私人俱乐部式深色游戏终端。
- **App macrostructure**：Workbench；主要状态和操作直接围绕牌桌展开，不使用营销页式巨型标题。
- **导航**：桌面端使用边缘对齐的紧凑顶栏，牌局右侧固定玩家 / 聊天 / 规则面板；移动端顶栏仅保留返回、房间信息与侧栏入口。
- **显示与声音偏好**：深色使用苔绿与黄铜金，浅色使用沙岩与鼠尾草；桌面端从右侧打开设置抽屉，移动端从底部打开，提供 12 / 14 / 16px 三档字号和普通牌局行动线语音播报开关，偏好只保存在当前设备。经典房间顶部另有一键静音；播报仅包含盲注、过牌、跟注、加注 / 全押金额和弃牌，重连时不会补播历史行动。
- **牌桌**：始终是横向椭圆，最多显示 8 个座位；移动端也不得改成长条竖向牌桌。
- **操作区**：桌面端位于牌桌下方，移动端固定在安全区上方；弃牌、过牌、跟注、加注保持单行且不换行。

## 主题

- 应用底色：石墨黑 `oklch(14% 0.012 205)`。
- 面板：深蓝灰 `oklch(20% 0.014 220)`，抬升层只增加亮度。
- 牌毡：深翡翠 `oklch(42% 0.095 167)`。
- 主文字：暖象牙 `oklch(94% 0.018 82)`。
- 主强调：哑金 `oklch(76% 0.118 79)`；仅用于当前行动、主操作、筹码数字和位置徽标。
- 危险操作：珊瑚红 `oklch(63% 0.185 30)`；必须同时配合文字，不以颜色作为唯一信号。

## 排版

- **Display / numerals**：Epilogue 700；用于品牌、房间码、筹码和行动计时。
- **Body / Chinese UI**：PingFang SC / Microsoft YaHei 400–600；Epilogue 为拉丁回退。
- 所有筹码、盲注、底池和倒计时使用等宽数字。
- 产品界面不使用装饰性斜体、渐变文字或全屏营销式标题。

## 间距、形状与层级

- 4 px 基准的命名间距令牌，页面 CSS 不直接写颜色或字体值。
- 面板圆角 14 px；控件 10 px；牌桌为完整横向椭圆。
- 移动端触摸目标不小于 44 × 44 px。
- 深色界面的层级主要由表面亮度和细边框表达，不使用彩色发光阴影。

## 动效与状态

- 只使用按压反馈、模态框淡入和牌局状态动效三种运动原语。
- 当前行动者使用金色外环；倒计时圆环持续表达剩余时间。
- 发牌仅动画 `transform` 与 `opacity`；减少动态偏好下缩短为不超过 150 ms 的淡入。
- 牌局进行中，非本局观战者只能查看主动允许观战的玩家手牌；本手一旦实际看过，玩家随后隐藏也不撤销这位观战者的既有权限。参加本局但已经弃牌的玩家不受主动隐藏限制，仍可切换查看其他非神秘玩家。神秘玩家始终隐藏，摊牌后由服务端公开其余未弃牌手牌。
- 筹码归零后明确提供“补充筹码”与“转为观战”，补充在下一局生效。

## 响应式约束

- 必须验收 320、375、414、768 px 以及桌面宽度。
- 根元素使用 `overflow-x: clip`；页面不得出现横向滚动。
- 移动端保持完整 8 人座位布局、横向牌桌、公共牌和固定底部操作条。
- 桌面侧栏在 960 px 以下改为抽屉，不挤压牌桌。

所有界面文案描述真实产品状态；本地自动玩家明确标记为“测试玩家”，不会伪装成真实用户。

## 三份交互稿：上线状态契约

三份交互稿不是视觉参考，而是产品上线时必须实现的页面和状态。新增功能不得绕过或合并下列关键步骤。

### 交互稿 1/3：入口与房间

1. 登录支持“记住我”、忘记密码说明与注册入口；注册成功后自动进入大厅。
2. 大厅同时提供创建房间、输入四位房间码加入、房间列表观战三个入口。
3. 创建房间是独立页面状态；默认初始筹码 2,000、小盲 5、大盲 10、2–8 人，补筹金额与次数可配置。
4. 房主创建后进入八座位等待牌桌；所有座位始终可见，人数不足时不可开始。
5. 房间内所有玩家都准备后才能开局；房主提前点击开始时，服务端阻止开局、列出未准备玩家，并向这些玩家发送准备提醒。
6. 以玩家身份加入时先成为观战者，再选择空位并提交申请；服务端必须保存所选座位。
7. 申请后进入“下一局入座申请已提交”确认页，由房主在两局之间批准。
8. 以观战身份加入时进入观战席，可继续观战、申请下一局入座或返回大厅。
9. 观战者在等待页或进行中的牌局申请入座时，都必须先进入八座位选择页；提交后若牌局仍在进行，应立即回到牌桌继续观战。
10. 房间连续两小时只有一位真人玩家时自动解散并从大厅移除，测试机器人不计入人数；已经终局结算的房间不再出现在大厅列表。

### 交互稿 2/3：一手牌完整操作

1. 开始发牌后牌桌保持原位，只更新庄位、盲注、筹码、底池和底牌；不插入新页面或覆盖牌桌的大面板。
2. 其他玩家的两张底牌只显示牌背；本人可点击看牌、隐藏手牌并查看起手牌类型。
3. 每次行动默认 30 秒，当前玩家有金色行动标记，已行动玩家有绿色完成标记；当前行动回合可花费 500 筹码购买一次额外 60 秒。
4. 底部操作栏固定为弃牌、过牌、跟注、加注四项；可用状态由服务端规则实时控制。
5. 加注打开金额面板，包含最小值、滑杆、手动整数输入、快捷金额、全押和确认加注；提交后回到等待状态。
6. 翻牌、转牌、河牌在同一牌桌原位发出；街道切换只使用轻量文字与牌面动效。
7. 玩家、观战者均可查看行动记录；全押、弃牌、盲注、过牌、跟注和加注都必须记录。

### 交互稿 3/3：观战、补筹与摊牌

1. 筹码归零后，当前屏幕底部操作区原位切换为“补充筹码 / 转为观战”，不得把开始下一局放到屏幕外的新卡片中。
2. 转为观战必须二次确认；确认后释放座位，并允许观战者在牌局结束后再次申请。
3. 观战界面显示玩家数、公共牌、下注、底池、进度、聊天和行动记录，并提供观战规则弹层。
4. 实时牌局仅允许查看主动开放的玩家手牌；本手已经看过的授权不会因玩家随后隐藏而撤销。神秘玩家始终隐藏，摊牌后公开其余未弃牌玩家手牌。
5. 玩家弃牌后只切换为“本局观战视角”，不能改变服务端玩家角色、座位或筹码；用牌桌上方的状态带替换手牌和操作区，本局结束后自动恢复。
5. 补筹需要金额与剩余次数确认；成功后显示“下一局生效”，并进入下一局入座队列。
6. 补筹玩家必须再次确认“加入牌桌 / 继续观战”；加入后进入干净的下一局等待牌桌，不残留上一局公共牌、ALL IN 或赢家状态。
7. 下一局开始时牌桌保持在原位置，只清理上一局状态并重新发牌；准备和开始操作始终在当前视口可见。

## Exports

### 1. CSS custom properties

[`tokens.css`](tokens.css) 是唯一设计令牌来源，`src/styles.css` 必须在首行导入并只通过 `var(...)` 使用颜色、字体、间距、圆角、阴影和动效值。

### 2. Tailwind CSS v4 `@theme`

```css
@theme {
  --color-paper: oklch(14% 0.012 205);
  --color-paper-deep: oklch(10% 0.010 215);
  --color-surface: oklch(20% 0.014 220);
  --color-felt: oklch(42% 0.095 167);
  --color-ink: oklch(94% 0.018 82);
  --color-muted: oklch(72% 0.012 210);
  --color-accent: oklch(76% 0.118 79);
  --color-primary: oklch(48% 0.090 164);
  --color-destructive: oklch(63% 0.185 30);
  --color-focus: oklch(86% 0.150 83);
  --font-display: "Epilogue", "PingFang SC", sans-serif;
  --font-body: "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-numeric: "Epilogue", "PingFang SC", sans-serif;
  --spacing-3xs: 0.125rem;
  --spacing-2xs: 0.25rem;
  --spacing-xs: 0.5rem;
  --spacing-sm: 0.75rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --spacing-xl: 2.5rem;
  --radius-control: 0.625rem;
  --radius-panel: 0.875rem;
  --radius-pill: 999px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
}
```

### 3. DTCG `tokens.json`

```json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "paper": { "$value": "oklch(14% 0.012 205)", "$type": "color" },
    "paper-deep": { "$value": "oklch(10% 0.010 215)", "$type": "color" },
    "surface": { "$value": "oklch(20% 0.014 220)", "$type": "color" },
    "felt": { "$value": "oklch(42% 0.095 167)", "$type": "color" },
    "ink": { "$value": "oklch(94% 0.018 82)", "$type": "color" },
    "muted": { "$value": "oklch(72% 0.012 210)", "$type": "color" },
    "gold": { "$value": "oklch(76% 0.118 79)", "$type": "color" },
    "action": { "$value": "oklch(48% 0.090 164)", "$type": "color" },
    "danger": { "$value": "oklch(63% 0.185 30)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Epilogue, PingFang SC, sans-serif", "$type": "fontFamily" },
    "body": { "$value": "PingFang SC, Microsoft YaHei, sans-serif", "$type": "fontFamily" },
    "numeric": { "$value": "Epilogue, PingFang SC, sans-serif", "$type": "fontFamily" }
  },
  "space": {
    "3xs": { "$value": "0.125rem", "$type": "dimension" },
    "2xs": { "$value": "0.25rem", "$type": "dimension" },
    "xs": { "$value": "0.5rem", "$type": "dimension" },
    "sm": { "$value": "0.75rem", "$type": "dimension" },
    "md": { "$value": "1rem", "$type": "dimension" },
    "lg": { "$value": "1.5rem", "$type": "dimension" },
    "xl": { "$value": "2.5rem", "$type": "dimension" }
  },
  "duration": {
    "micro": { "$value": "120ms", "$type": "duration" },
    "short": { "$value": "220ms", "$type": "duration" },
    "long": { "$value": "420ms", "$type": "duration" }
  }
}
```

### 4. shadcn/ui variables

```css
:root {
  --background: 14% 0.012 205;
  --foreground: 94% 0.018 82;
  --card: 20% 0.014 220;
  --card-foreground: 94% 0.018 82;
  --popover: 24% 0.015 220;
  --popover-foreground: 94% 0.018 82;
  --primary: 48% 0.090 164;
  --primary-foreground: 96% 0.018 82;
  --secondary: 17% 0.012 210;
  --secondary-foreground: 94% 0.018 82;
  --muted: 33% 0.016 210;
  --muted-foreground: 72% 0.012 210;
  --accent: 76% 0.118 79;
  --accent-foreground: 18% 0.028 75;
  --destructive: 63% 0.185 30;
  --destructive-foreground: 97% 0.014 75;
  --border: 33% 0.016 210;
  --input: 33% 0.016 210;
  --ring: 86% 0.150 83;
  --radius: 0.875rem;
}
```
