import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, transformWithOxc } from "vite";
import {
  WENGWENGWEN_CHARACTER,
  WENGWENGWEN_COMMANDS,
  WENGWENGWEN_RULES,
  assertValidWengwengwenRules,
  validateWengwengwenRules,
} from "../shared/hextech-wengwengwen.js";
import {
  HEXTECH_CHARACTER_VOICE_LINES,
  assertValidHextechCharacterVoiceLines,
} from "../shared/hextech-character-voice-lines.js";
import {
  createWengwengwenEngine,
  restoreWengwengwenEngine,
} from "../server/hextech-wengwengwen.js";

const componentPath = new URL("../src/hextech/HextechWengwengwenControl.jsx", import.meta.url);
const cssPath = new URL("../src/hextech/wengwengwen.css", import.meta.url);
const source = fs.readFileSync(componentPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

async function loadControl() {
  const vite = await createServer({
    root: new URL("..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true },
    logLevel: "error",
  });
  const module = await vite.ssrLoadModule("/src/hextech/HextechWengwengwenControl.jsx");
  return { vite, HextechWengwengwenControl: module.HextechWengwengwenControl };
}

function begin(engine, handNumber) {
  return engine.beginHand({
    eventId: `begin-${handNumber}`,
    handId: `hand-${handNumber}`,
    handNumber,
  });
}

function targetRaises(engine, handNumber, street = "flop") {
  return engine.afterPokerAction({
    eventId: `target-${handNumber}`,
    handId: `hand-${handNumber}`,
    actorUserId: "target",
    action: "raise",
    street,
    bigBlind: 40,
    investment: 120,
    isAggressive: true,
  });
}

function selfCalls(engine, handNumber, street = "flop") {
  return engine.afterPokerAction({
    eventId: `self-${handNumber}`,
    handId: `hand-${handNumber}`,
    actorUserId: "self",
    action: "call",
    street,
    bigBlind: 40,
    investment: 120,
    facingAggressorUserId: "target",
  });
}

test("Wengwengwen publishes a bounded server-authoritative rule contract", () => {
  assert.equal(assertValidWengwengwenRules(), true);
  assert.deepEqual(validateWengwengwenRules(), []);
  assert.equal(WENGWENGWEN_CHARACTER.id, "wengwengwen");
  assert.equal(WENGWENGWEN_RULES.resource.maximum, 3);
  assert.equal(WENGWENGWEN_RULES.active.cost, 2);
  assert.equal(WENGWENGWEN_RULES.active.reveal.cardCount, 1);
  assert.equal(WENGWENGWEN_RULES.active.reveal.selection, "server-random");
  assert.deepEqual(WENGWENGWEN_RULES.active.legalStreets, ["flop", "turn"]);
  assert.equal(WENGWENGWEN_CHARACTER.voiceLines, HEXTECH_CHARACTER_VOICE_LINES.wengwengwen);
});

test("all eight Hextech characters publish the same four voice-line events", () => {
  const ids = ["fenxiang", "xu", "jiansheng", "ya", "qiwan", "zige", "mao", "wengwengwen"];
  assert.equal(assertValidHextechCharacterVoiceLines(ids), true);
  assert.deepEqual(Object.keys(HEXTECH_CHARACTER_VOICE_LINES), ids);
  for (const characterId of ids) {
    assert.deepEqual(Object.keys(HEXTECH_CHARACTER_VOICE_LINES[characterId]), [
      "select",
      "activate",
      "progress",
      "awaken",
    ]);
  }
});

test("manual postflop pursuit gains at most one moon mark per hand", () => {
  const engine = createWengwengwenEngine({ userId: "self" });
  begin(engine, 1);
  targetRaises(engine, 1);
  selfCalls(engine, 1);
  engine.afterPokerAction({
    eventId: "self-second-1",
    handId: "hand-1",
    actorUserId: "self",
    action: "raise",
    street: "flop",
    bigBlind: 40,
    investment: 160,
    facingAggressorUserId: "target",
    isFullRaise: true,
  });
  assert.equal(engine.viewFor("self").resource, 1);
  assert.equal(engine.viewFor("self").progress.distinctHuntHands, 1);

  begin(engine, 2);
  targetRaises(engine, 2);
  engine.afterPokerAction({
    eventId: "automatic-self-2",
    handId: "hand-2",
    actorUserId: "self",
    action: "call",
    street: "flop",
    bigBlind: 40,
    investment: 120,
    facingAggressorUserId: "target",
    automatic: true,
  });
  assert.equal(engine.viewFor("self").resource, 1);
});

test("eclipse hunt reveals one displayed card only to its owner and replays no mutation", () => {
  const engine = createWengwengwenEngine({ userId: "self", rng: () => 0 });
  for (const handNumber of [1, 2]) {
    begin(engine, handNumber);
    targetRaises(engine, handNumber);
    selfCalls(engine, handNumber);
  }
  begin(engine, 3);
  targetRaises(engine, 3);
  const command = {
    type: WENGWENGWEN_COMMANDS.ACTIVATE_HUNT,
    commandId: "hunt-3",
    handId: "hand-3",
    street: "flop",
    isOwnAction: true,
    toCall: 120,
    targetUserId: "target",
    displayedCards: ["7c", "2d"],
    masked: true,
  };
  assert.equal(engine.command(command).replayed, false);
  assert.equal(engine.command(command).replayed, true);

  const owner = engine.viewFor("self");
  const other = engine.viewFor("observer");
  assert.deepEqual(owner.reveal, { targetUserId: "target", cardId: "7c", street: "flop" });
  assert.equal("masked" in owner.reveal, false);
  assert.equal(other.reveal, null);
  assert.equal(owner.resource, 0);
  assert.equal(engine.exportState().hand.reveal.masked, true);
});

test("growth requires five distinct hunts, a turn hunt and a showdown win before full-moon refund", () => {
  const engine = createWengwengwenEngine({ userId: "self", rng: () => 0.8 });
  for (let handNumber = 1; handNumber <= 5; handNumber += 1) {
    const street = handNumber === 4 ? "turn" : "flop";
    begin(engine, handNumber);
    targetRaises(engine, handNumber, street);
    selfCalls(engine, handNumber, street);
    engine.settleHand({
      eventId: `settle-${handNumber}`,
      handId: `hand-${handNumber}`,
      result: {
        reachedShowdown: handNumber === 5,
        wonPotAmount: handNumber === 5 ? 400 : 0,
        opponentsBeaten: handNumber === 5 ? ["target"] : [],
      },
    });
  }
  assert.equal(engine.viewFor("self").awakened, true);

  begin(engine, 6);
  targetRaises(engine, 6);
  engine.command({
    type: WENGWENGWEN_COMMANDS.ACTIVATE_HUNT,
    commandId: "hunt-6",
    handId: "hand-6",
    street: "flop",
    isOwnAction: true,
    toCall: 120,
    targetUserId: "target",
    displayedCards: ["As", "Kd"],
  });
  assert.equal(engine.viewFor("self").resource, 1);
  engine.afterPokerAction({
    eventId: "full-moon-raise-6",
    handId: "hand-6",
    actorUserId: "self",
    action: "raise",
    street: "flop",
    bigBlind: 40,
    investment: 120,
    facingAggressorUserId: "target",
    isFullRaise: true,
  });
  assert.equal(engine.viewFor("self").resource, 3);

  const restored = restoreWengwengwenEngine(engine.exportState(), { rng: () => 0 });
  assert.equal(restored.viewFor("self").awakened, true);
  assert.equal(restored.viewFor("observer").reveal, null);
});

test("the isolated control renders real rules, fixed slots and an owner-safe active state", async () => {
  const transformed = await transformWithOxc(source, componentPath.pathname, { lang: "jsx" });
  assert.match(transformed.code, /HextechWengwengwenControl/);
  const { vite, HextechWengwengwenControl } = await loadControl();
  try {
    const html = renderToStaticMarkup(React.createElement(HextechWengwengwenControl, {
      state: {
        userId: "self",
        resource: 3,
        resourceMaximum: 3,
        awakened: false,
        progress: { distinctHuntHands: 2, turnHunts: 0, showdownWinsAgainstAggressor: 0 },
        activeUsed: false,
        latestAggressorUserId: "target",
        reveal: null,
      },
      game: {
        handId: "hand-1",
        stage: "flop",
        actingSeat: 0,
        currentBet: 120,
        players: [{ userId: "self", seat: 0, bet: 40 }],
      },
      members: [{ userId: "target", username: "进攻玩家" }],
      onCommand() {},
    }));
    assert.match(html, /嗡嗡文/);
    assert.match(html, /目标：进攻玩家/);
    assert.match(html, /发动月蚀追猎/);
    assert.match(html, /月痕 3\/3/);
    assert.match(html, /data-control-rail="character"/);
  } finally {
    await vite.close();
  }
  assert.match(css, /\.wengwengwen-control\s*\{[^}]*height:\s*214px;/s);
  assert.match(css, /\.wengwengwen-control\s*\{[^}]*box-sizing:\s*border-box;/s);
  assert.match(css, /grid-template-rows:\s*68px 74px 44px/);
  assert.match(css, /@media \(max-width:\s*39\.99rem\)[\s\S]*?\.wengwengwen-control\s*\{[^}]*height:\s*342px;/s);
  assert.match(css, /grid-template-rows:\s*64px 44px 112px 48px 38px/);
  assert.match(css, /\.wengwengwen-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s);
});
