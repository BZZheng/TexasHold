import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, transformWithOxc } from "vite";

const componentPath = new URL("../src/hextech/HextechSkillControl.jsx", import.meta.url);
const cssPath = new URL("../src/hextech/hextech.css", import.meta.url);
const source = fs.readFileSync(componentPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

test("skill control JSX parses even before App integration", async () => {
  const transformed = await transformWithOxc(source, componentPath.pathname, { lang: "jsx" });
  assert.match(transformed.code, /HextechSkillControl/);
});

test("all eight skill-control states render from a server window", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true },
    logLevel: "error",
  });
  try {
    const { HextechSkillControl } = await vite.ssrLoadModule("/src/hextech/HextechSkillControl.jsx");
    const characters = [
      { userId: "self", username: "阿青", characterId: "fenxiang", chips: 1800, isSelf: true },
      { userId: "target", username: "小许", characterId: "xu", chips: 2300 },
    ];
    for (const state of ["idle", "armed", "targeting", "confirming", "reaction", "resolving", "consumed", "disabled"]) {
      const isReaction = state === "reaction";
      const room = {
        self: { userId: "self", equippedSkillId: isReaction ? "escape" : "xray" },
        members: characters,
        hextech: {
          equippedSkill: isReaction ? "escape" : "xray",
          characters,
          serverNow: Date.now(),
          selfSkillWindow: {
            token: `token-${state}`,
            version: 1,
            skillId: isReaction ? "escape" : "xray",
            state: isReaction ? "armed" : state,
            expiresAt: isReaction ? Date.now() + 4000 : null,
            validTargetUserIds: ["target"],
            pendingTargetUserId: state === "confirming" ? "target" : null,
            maximumChipRisk: isReaction ? 160 : 0,
            counterplayLabels: ["技能护盾"],
            disabledReason: state === "disabled" ? "当前街道不能发动" : null,
          },
        },
      };
      const html = renderToStaticMarkup(React.createElement(HextechSkillControl, { room, onCommand() {} }));
      assert.match(html, new RegExp(`state-${state}`));
    }
  } finally {
    await vite.close();
  }
});

test("skill control exposes every server-authoritative interaction state and command", () => {
  for (const state of [
    "idle",
    "armed",
    "targeting",
    "confirming",
    "reaction",
    "resolving",
    "consumed",
    "disabled",
  ]) {
    assert.match(source, new RegExp(`\\b${state}\\b`), `missing ${state} state`);
  }
  for (const command of ["arm", "target", "choice", "confirm", "react", "cancel"]) {
    assert.match(source, new RegExp(`command\\(\\"${command}\\"`), `missing ${command} command`);
  }
  assert.match(source, /windowId/);
  assert.match(source, /windowToken/);
  assert.match(source, /windowVersion/);
  assert.match(source, /commandId/);
  assert.match(source, /skillId/);
  assert.match(source, /targetUserId/);
  assert.match(source, /choices: localChoices/);
});

test("choice controls honor the shared rank, suit, category and card-index schema", () => {
  for (const stepId of ["holeCardIndex", "rank", "suit", "handCategory", "candidateCardIndex"]) {
    assert.match(source, new RegExp(`\\b${stepId}\\b`));
  }
  assert.match(source, /choiceSchema/);
  assert.match(source, /schema\.steps/);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /role="radio"/);
  assert.match(source, /aria-checked/);
});

test("skill rail includes keyboard, countdown and non-color status semantics", () => {
  assert.match(source, /event\.key !== "Escape"/);
  assert.match(source, /ArrowLeft/);
  assert.match(source, /ArrowRight/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /aria-selected/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /aria-busy/);
  assert.match(source, /disabledReason/);
  assert.match(source, /二次确认/);
  assert.match(source, /发动费用/);
  assert.match(source, /最大风险/);
  assert.match(source, /对手反制/);
  assert.match(source, /pendingReactionOption/);
  assert.match(source, /option: "escape"/);
  assert.match(source, /command\("react", \{ option: "decline" \}\)/);
});

test("skill rail stays in normal flow and constrains expansion at 320px", () => {
  assert.doesNotMatch(css, /\.hextech-skill-control\s*\{[^}]*position:\s*(?:fixed|absolute)/s);
  assert.match(css, /\.hextech-skill-control\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.hextech-skill-control\s*\{[^}]*--hextech-skill-rail-size:\s*214px;[^}]*height:\s*var\(--hextech-skill-rail-size\);[^}]*min-height:\s*var\(--hextech-skill-rail-size\);[^}]*max-height:\s*var\(--hextech-skill-rail-size\)/s);
  assert.match(css, /\.hextech-skill-workspace\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*max-height:\s*none;[^}]*overflow:\s*auto/s);
  assert.match(css, /@media\s*\(max-width:\s*39\.99rem\)[\s\S]*\.hextech-skill-control/);
  assert.match(css, /@media\s*\(max-width:\s*39\.99rem\)[\s\S]*--hextech-skill-rail-size:\s*342px;[\s\S]*grid-template-rows:\s*68px minmax\(0, 1fr\) 62px/);
  assert.match(css, /\.hextech-skill-actions\s*\{[^}]*grid-template-rows:\s*42px 42px 12px/s);
  assert.match(css, /\.hextech-skill-actions > \.hextech-skill-primary,[^{]*\{ grid-row:\s*1; \}/s);
  assert.match(css, /\.hextech-skill-actions > \.hextech-skill-secondary \{ grid-row:\s*2; \}/);
  assert.match(css, /@media\s*\(max-width:\s*39\.99rem\)[\s\S]*\.hextech-skill-actions > \.hextech-skill-primary \{ grid-column:\s*1; grid-row:\s*1; \}[\s\S]*\.hextech-skill-actions > \.hextech-skill-secondary \{ grid-column:\s*2; grid-row:\s*1; \}/);
  assert.match(css, /\.hextech-skill-actions button,[\s\S]*min-height:\s*44px/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(source, /data-control-rail="skill"/);
});

test("skill help uses real shared rules and works with hover, focus, and mobile tap", async () => {
  assert.match(source, /skill\.summary/);
  assert.match(source, /skill\.timing/);
  assert.match(source, /skill\.rules\?\.cost/);
  assert.match(source, /formatSkillTarget\(skill\)/);
  assert.match(source, /aria-expanded=\{helpOpen\}/);
  assert.match(source, /aria-describedby=\{helpId\}/);
  assert.match(source, /role="tooltip"/);
  assert.match(source, /className="hextech-skill-workspace-head"[\s\S]*className="hextech-skill-help-trigger"/);
  assert.match(css, /\.hextech-skill-help:hover \.hextech-skill-help-popover/);
  assert.match(css, /\.hextech-skill-help:focus-within \.hextech-skill-help-popover/);
  assert.match(css, /\.hextech-skill-help\.is-open \.hextech-skill-help-popover/);
  assert.match(css, /\.hextech-skill-help-popover\s*\{[^}]*position:\s*absolute;[^}]*visibility:\s*hidden/s);
  assert.match(css, /\.hextech-skill-help\s*\{[^}]*position:\s*static/s);
  assert.match(css, /@media\s*\(max-width:\s*39\.99rem\)[\s\S]*\.hextech-skill-help-trigger\s*\{[^}]*width:\s*44px;[^}]*min-width:\s*44px;[^}]*height:\s*44px;[^}]*min-height:\s*44px/s);
  assert.doesNotMatch(css, /\.hextech-skill-help-trigger\s*\{[^}]*(?:top|right|bottom|left):/s);

  const root = new URL("..", import.meta.url).pathname;
  const vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true },
    logLevel: "error",
  });
  try {
    const { HextechSkillControl } = await vite.ssrLoadModule("/src/hextech/HextechSkillControl.jsx");
    const room = {
      self: { userId: "self", equippedSkillId: "xray" },
      hextech: {
        equippedSkill: "xray",
        selfSkillWindow: { skillId: "xray", state: "idle", token: "help-xray", version: 1 },
      },
    };
    const html = renderToStaticMarkup(React.createElement(HextechSkillControl, { room, onCommand() {} }));
    assert.match(html, /主动 · 由你发动/);
    assert.match(html, /<dt>时机<\/dt><dd>行动前<\/dd>/);
    assert.match(html, /1 名符合当前条件的对手/);
    assert.match(html, /60% 成功查看其底牌至本街结束/);
    assert.match(html, /在「行动前」技能可用时/);
    assert.match(html, /aria-describedby="[^"]+"/);
  } finally {
    await vite.close();
  }
});

test("target display never reads private card fields from other players", () => {
  assert.doesNotMatch(source, /(?:holeCards|selfCards|privateCards|revealedCards)/);
  assert.match(source, /hextech\.characters \?\? room\?\.members/);
});

test("private skill outcomes render only from the server-filtered privateEffects contract", async () => {
  assert.match(source, /hextech\?\.privateEffects/);
  assert.match(source, /sourceSkillId === skillId/);
  assert.match(source, /技能生效状态/);
  assert.match(source, /PlayingCard/);
  assert.match(source, /其他玩家与观战者不会收到/);
  assert.doesNotMatch(source, /room\?\.game\?\.(?:players|holeCards)/);
});

test("armed settlement skills show their server status without a misleading cancel action", () => {
  assert.match(source, /hextech\.equipment\?\.status/);
  assert.match(source, /armedWaiting/);
  for (const effect of ["potBombs", "duelContracts", "bounties", "lastStands", "insurances", "fixedDeposits"]) {
    assert.match(source, new RegExp(`effects\\.${effect}`));
  }
  assert.match(source, /final-hand-category-prediction/);
});
