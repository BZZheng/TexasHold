# 海克斯大乱德 v1 交付索引

## 直接查看

- 可点击 UI 稿：`prototype-v1.html`
- 样式：`prototype-v1.css`
- 状态机与演示数据：`prototype-v1.js`
- UI / 交互开发规格：`UI-SPEC-v1.md`
- 玩法与数值基线：`GAME-RULES-v1.md`
- 人物与技能素材清单：`assets/v1/asset-manifest.json`

v0 的 `prototype.html`、`prototype.css`、`prototype.js` 和 `UI-SPEC.md` 均保留，没有被 v1 覆盖。

## 本地预览

在项目根目录运行：

```bash
python3 -m http.server 4174 --bind 127.0.0.1
```

打开：

```text
http://127.0.0.1:4174/design/hextech-chaos/prototype-v1.html
```

原型顶部可切换 29 个场景与 1440 / 768 / 414 / 375 / 320 五档画布。“显示安全区”会标出三个互不覆盖的开发轨道。

## V1 验收快照

- 29 场景 × 5 档画布共 145 个组合：公共牌、自己/授权观战手牌和操作轨道无交叠，页面无横向溢出。
- 真实 320 px 视口需覆盖 8 人观战、13 点赌圣选择、三技能同屏和贷款账本五字段。
- 自动测试与 `npm run build` 纳入交付验收；素材清单为 16 张人物图与 30 张技能图，无缺失引用。

## 开发接入顺序

1. 把 `GAME-RULES-v1.md` 中的目标、盲注、人物和 30 个技能转为共享配置与服务端判定测试。
2. 在现有牌桌主列建立 `table-zone`、`hand-rail`、`control-rail` 三个固定职责轨道。
3. 接入房间创建、人物锁定与每手 `EquipmentDraft`。
4. 接入目标选择、反应窗口、贷款、质疑、审计和人物觉醒。
5. 接入授权观战、补筹、单手结算及两种整场终局。
6. 按 `UI-SPEC-v1.md` 的验收清单跑 320–1440 px 与权限测试。

## 素材约束

- 8 名人物各有普通 / 觉醒 2 张，共 16 张 RGBA PNG，最长边约 900 px。
- 30 个技能均为 512×512 RGBA PNG，四角透明，适合 48–96 px 展示。
- 业务数据只保存 `characterId` / `skillId`；展示路径从 manifest 或构建时资源映射获取。
- 技能插画使用可爱贴纸风，现有牌桌继续使用深绿私人俱乐部风格。
