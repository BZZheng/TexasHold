import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, transformWithOxc } from "vite";
import { HEXTECH_CHARACTERS } from "../shared/hextech.js";
import { HEXTECH_CHARACTER_VOICE_LINES } from "../shared/hextech-character-voice-lines.js";

const componentPath = new URL("../src/hextech/HextechCharacterControl.jsx", import.meta.url);
const cssPath = new URL("../src/hextech/hextech.css", import.meta.url);
const source = fs.readFileSync(componentPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

function characterRow(character, userId, overrides = {}) {
  return {
    userId,
    characterId: character.id,
    resource: character.rules.resource.maximum ?? 0,
    resourceMaximum: character.rules.resource.maximum,
    awakened: false,
    progress: Object.fromEntries(character.rules.growth.counters.map(({ id }) => [id, 0])),
    activeUsed: false,
    window: null,
    availableStack: 2_000,
    netAssets: 2_000,
    ...overrides,
  };
}

function roomFor(characterId, selfOverrides = {}, hextechOverrides = {}) {
  const characters = HEXTECH_CHARACTERS.map((character, index) => (
    characterRow(character, character.id === characterId ? "self" : `player-${index}`)
  ));
  const selfIndex = characters.findIndex((entry) => entry.userId === "self");
  characters[selfIndex] = { ...characters[selfIndex], ...selfOverrides };
  const members = characters.map((entry, index) => ({
    userId: entry.userId,
    username: entry.userId === "self" ? "自己" : `玩家 ${index + 1}`,
    role: "player",
    characterId: entry.characterId,
  }));
  const stageByCharacter = {
    fenxiang: "flop",
    xu: "flop",
    jiansheng: "flop",
    ya: "turn",
    qiwan: "preflop",
    zige: "finished",
    mao: "flop",
    wengwengwen: "flop",
  };
  const stage = stageByCharacter[characterId];
  return {
    handNumber: 4,
    self: { userId: "self", role: "player", stack: 2_000, characterId },
    members,
    game: {
      handId: "hand-4",
      stage,
      community: stage === "turn" ? ["2c", "3d", "4h", "5s"] : stage === "flop" ? ["2c", "3d", "4h"] : [],
      actingSeat: selfIndex,
      currentBet: characterId === "wengwengwen" ? 120 : 40,
      players: characters.map((entry, index) => ({
        userId: entry.userId,
        seat: index,
        stack: 2_000,
        bet: entry.userId === "self" ? 40 : characterId === "wengwengwen" ? 120 : 40,
        allIn: entry.userId === "self" && ["ya", "qiwan"].includes(characterId),
        folded: false,
      })),
    },
    hextech: {
      phase: characterId === "zige" ? "hand-result" : "playing",
      serverNow: Date.now(),
      characters,
      selfCharacter: characters[selfIndex],
      loans: [],
      characterEvents: [],
      ...hextechOverrides,
    },
  };
}

async function loadControl() {
  const root = new URL("..", import.meta.url).pathname;
  const vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true },
    logLevel: "error",
  });
  const module = await vite.ssrLoadModule("/src/hextech/HextechCharacterControl.jsx");
  return { vite, HextechCharacterControl: module.HextechCharacterControl };
}

test("character control JSX parses independently of App integration", async () => {
  const transformed = await transformWithOxc(source, componentPath.pathname, { lang: "jsx" });
  assert.match(transformed.code, /HextechCharacterControl/);
});

test("all eight characters render resource, growth, awakening and their own voice line", async () => {
  const { vite, HextechCharacterControl } = await loadControl();
  try {
    for (const character of HEXTECH_CHARACTERS) {
      const room = roomFor(character.id);
      const html = renderToStaticMarkup(React.createElement(HextechCharacterControl, {
        room,
        onCommand() {},
      }));
      assert.match(html, new RegExp(character.name), `${character.id} name missing`);
      assert.match(html, new RegExp(character.rules.resource.label), `${character.id} resource missing`);
      assert.match(html, /成长与觉醒进度/);
      assert.match(html, /role="progressbar"/);
      assert.match(html, /data-control-rail="character"/);
      assert.match(html, new RegExp(HEXTECH_CHARACTER_VOICE_LINES[character.id].select));
    }
  } finally {
    await vite.close();
  }
});

test("Wengwengwen confirms a server-selected hunt and renders only an owner-private displayed card", async () => {
  const { vite, HextechCharacterControl } = await loadControl();
  try {
    const room = roomFor("wengwengwen", {
      latestAggressorUserId: "player-0",
      reveal: { targetUserId: "player-0", cardId: "7c", street: "flop" },
    });
    const html = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room, onCommand() {} }));
    assert.match(html, /月蚀追猎/);
    assert.match(html, /一张展示底牌/);
    assert.match(html, /只对你可见/);
    assert.match(html, /伪装技能可能改变展示牌/);
    assert.match(html, /aria-label="梅花 7"/);
    assert.doesNotMatch(html, /masked/);
  } finally {
    await vite.close();
  }
});

test("Ya and Qiwan never expose candidates while Mao keeps its authorized choice window", async () => {
  const { vite, HextechCharacterControl } = await loadControl();
  const expiresAt = new Date(Date.now() + 6_000).toISOString();
  try {
    const yaHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room: roomFor("ya"), onCommand() {} }));
    assert.match(yaHtml, /逆流换河/);
    assert.match(yaHtml, /服务端会弃置原定自然河牌/);
    assert.match(yaHtml, /看不到原牌或任何候选/);
    assert.doesNotMatch(yaHtml, /公开弃置|先发出自然河牌/);
    assert.match(yaHtml, /继续确认随机换河/);
    assert.doesNotMatch(yaHtml, /黑桃 A|方片 K|红桃 7/);

    const qiwanHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room: roomFor("qiwan"), onCommand() {} }));
    assert.match(qiwanHtml, /第 1 张底牌/);
    assert.match(qiwanHtml, /第 2 张底牌/);
    assert.match(qiwanHtml, /服务端弃置所选底牌/);
    assert.match(qiwanHtml, /不可预知的牌堆顶下一张/);
    assert.doesNotMatch(qiwanHtml, /选择换入牌|锁定候选牌|公开弃置/);

    for (const [id, type] of [["ya", "ya-river-choice"], ["qiwan", "qiwan-card-swap"]]) {
      const room = roomFor(id, {
        window: { windowId: `${id}-legacy`, type, state: "armed", candidateCardIds: ["As", "Kd", "7h"], expiresAt },
      });
      const html = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room, onCommand() {} }));
      assert.match(html, /旧版.*窗口正在安全迁移/);
      assert.match(html, /不会读取或展示旧候选牌/);
      assert.doesNotMatch(html, /黑桃 A|方片 K|红桃 7|role="radiogroup"/);
    }

    const maoRoom = roomFor("mao", {
      window: { windowId: "mao-1", type: "mao-suit-choice", state: "armed", candidateCardIds: ["Ah", "Kh"], suit: "hearts", expiresAt },
    });
    const maoHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room: maoRoom, onCommand() {} }));
    for (const expected of ["真蛊惑候选", "红桃候选", "确认发出此牌"]) assert.match(maoHtml, new RegExp(expected));
    assert.match(maoHtml, /role="radiogroup"/);
    assert.match(maoHtml, /aria-checked="false"/);
  } finally {
    await vite.close();
  }
});

test("Ya and Qiwan use explicit local confirmation before irreversible top-deck commands", () => {
  assert.match(source, /setIrreversibleConfirm\("ya"\)/);
  assert.match(source, /setIrreversibleConfirm\("qiwan"\)/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /!ownOpportunity && \["ya", "qiwan"\]\.includes\(irreversibleConfirm\)/);
  assert.match(source, /确认不可预知的河牌重发/);
  assert.match(source, /结果不可预知且不可撤销/);
  assert.match(source, /确认弃置第 \{\(holeCardIndex \?\? 0\) \+ 1\} 张底牌/);
  assert.match(source, /无法预知补到什么牌，提交后不可撤销/);
  assert.match(source, /issue\(CHARACTER_COMMANDS\.YA_ACTIVATE\)/);
  assert.match(source, /issue\(CHARACTER_COMMANDS\.QIWAN_ACTIVATE, \{ holeCardIndex \}\)/);
  assert.doesNotMatch(source, /YA_CHOOSE|QIWAN_ARM_CHOICE|QIWAN_COMMIT/);
  assert.doesNotMatch(source, /"ya:choose"|"qiwan:arm-choice"|"qiwan:commit"/);
});

test("new Ya growth and both awakenings are explained from the production contract", async () => {
  const { vite, HextechCharacterControl } = await loadControl();
  try {
    const yaRoom = roomFor("ya", { awakened: true });
    const yaHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room: yaRoom, onCommand() {} }));
    assert.match(yaHtml, /主动全押进入摊牌/);
    assert.match(yaHtml, /主动全押摊牌获胜/);
    assert.match(yaHtml, /觉醒减免 · 消耗 1 鸭毛/);

    const qiwanRoom = roomFor("qiwan", { awakened: true });
    const qiwanHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room: qiwanRoom, onCommand() {} }));
    assert.match(qiwanHtml, /灵感回响：换入牌进入最佳五张且赢池时返还 1 奇想/);
    assert.match(qiwanHtml, /消耗 2 奇想/);
  } finally {
    await vite.close();
  }
});

test("Xu explains the effective last-two-second growth and both barbecue clock profiles", async () => {
  const { vite, HextechCharacterControl } = await loadControl();
  try {
    const normalHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, {
      room: roomFor("xu"),
      onCommand() {},
    }));
    assert.match(normalHtml, /最后 2 秒手动跟注、下注、加注或全押/);
    assert.match(normalHtml, /实际投入至少 1BB/);
    assert.match(normalHtml, /有效压秒投入/);
    assert.match(normalHtml, /0\/12/);
    assert.match(normalHtml, /覆盖不同手牌/);
    assert.match(normalHtml, /0\/6/);
    assert.match(normalHtml, /所有仍在手对手 -15 秒（最低 30 秒），自己 \+10 秒/);
    assert.doesNotMatch(normalHtml, /额外向底池加入 80/);

    const awakenedHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, {
      room: roomFor("xu", { awakened: true }),
      onCommand() {},
    }));
    assert.match(awakenedHtml, /所有仍在手对手 -20 秒（最低 30 秒），自己 \+15 秒/);
    assert.match(awakenedHtml, /炉火纯青额外向底池加入 80 银行筹码/);
  } finally {
    await vite.close();
  }
});

test("Ya and Qiwan render the server-authoritative 60 second all-in opportunity", async () => {
  const { vite, HextechCharacterControl } = await loadControl();
  const serverNow = 1_800_000_000_000;
  try {
    for (const characterId of ["ya", "qiwan"]) {
      const room = roomFor(characterId, {}, {
        serverNow,
        characterOpportunity: {
          userId: "self",
          characterId,
          handId: "hand-4",
          expiresAt: serverNow + 60_000,
        },
      });
      const html = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room, onCommand() {} }));
      assert.match(html, /全押后人物技能机会已保留/);
      assert.match(html, /60 秒内决定/);
      assert.match(html, /超时将自动继续发牌/);
      assert.doesNotMatch(html, /candidateCardIds|候选编号|选择换入牌/);
    }
  } finally {
    await vite.close();
  }
});

test("Ya and Qiwan stay disabled without a current matching opportunity or after expiry", async () => {
  const { vite, HextechCharacterControl } = await loadControl();
  const serverNow = 1_800_000_000_000;
  const openingButtonForText = (html, text) => {
    const textIndex = html.indexOf(text);
    assert.ok(textIndex > -1, `${text} control is missing`);
    const buttonIndex = html.lastIndexOf("<button", textIndex);
    return html.slice(buttonIndex, html.indexOf(">", buttonIndex) + 1);
  };
  try {
    for (const [characterId, label] of [["ya", "继续确认随机换河"], ["qiwan", "继续确认随机换牌"]]) {
      const noOpportunityHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, {
        room: roomFor(characterId, {}, { serverNow, characterOpportunity: null }),
        onCommand() {},
      }));
      assert.match(noOpportunityHtml, /当前没有可用的全押人物技能机会/);
      assert.match(openingButtonForText(noOpportunityHtml, label), /disabled=""/);

      const expiredHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, {
        room: roomFor(characterId, {}, {
          serverNow,
          characterOpportunity: {
            userId: "self",
            characterId,
            handId: "hand-4",
            expiresAt: serverNow - 1,
          },
        }),
        onCommand() {},
      }));
      assert.match(expiredHtml, /全押后人物技能选择时间已经结束/);
      assert.match(openingButtonForText(expiredHtml, label), /disabled=""/);
      assert.doesNotMatch(expiredHtml, /全押后人物技能机会已保留/);

      for (const mismatch of [
        { userId: "someone-else", characterId, handId: "hand-4" },
        { userId: "self", characterId: characterId === "ya" ? "qiwan" : "ya", handId: "hand-4" },
        { userId: "self", characterId, handId: "another-hand" },
      ]) {
        const mismatchHtml = renderToStaticMarkup(React.createElement(HextechCharacterControl, {
          room: roomFor(characterId, {}, {
            serverNow,
            characterOpportunity: { ...mismatch, expiresAt: serverNow + 60_000 },
          }),
          onCommand() {},
        }));
        assert.match(mismatchHtml, /当前没有可用的全押人物技能机会/);
        assert.match(openingButtonForText(mismatchHtml, label), /disabled=""/);
        assert.doesNotMatch(mismatchHtml, /全押后人物技能机会已保留/);
      }
    }
  } finally {
    await vite.close();
  }
});

test("loan offer, borrower response, repayment and public ledger are real controls", async () => {
  const { vite, HextechCharacterControl } = await loadControl();
  try {
    const baseRoom = roomFor("zige");
    const borrowerId = baseRoom.hextech.characters.find((entry) => entry.userId !== "self").userId;
    const loans = [
      {
        loanId: "loan-offer",
        lenderUserId: borrowerId,
        borrowerUserId: "self",
        principal: 600,
        interestRate: .1,
        dueAfterHands: 3,
        expiresAt: new Date(Date.now() + 9_000).toISOString(),
        state: "offered",
        outstanding: 660,
      },
      {
        loanId: "loan-active",
        lenderUserId: borrowerId,
        borrowerUserId: "self",
        principal: 400,
        interestRate: .1,
        dueAfterHands: 3,
        expiresAt: null,
        state: "active",
        outstanding: 440,
      },
    ];
    const room = { ...baseRoom, hextech: { ...baseRoom.hextech, loans } };
    const html = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room, onCommand() {} }));
    assert.match(html, /贷款本金/);
    assert.match(html, /min="200" max="600" step="100"/);
    assert.match(html, /接受并到账/);
    assert.match(html, /到账 600，3 手后偿还 660/);
    assert.match(html, /role="alert" aria-live="assertive"/);
    assert.match(html, /role="timer" aria-live="off"/);
    assert.match(html, /主动还款/);
    assert.match(html, /公开贷款账本/);
  } finally {
    await vite.close();
  }
});

test("a new loan invitation scrolls into view without taking input focus", () => {
  const effectStart = source.indexOf("const incomingLoanKey");
  const effectEnd = source.indexOf("const relevantLoans", effectStart);
  assert.ok(effectStart > -1 && effectEnd > effectStart, "loan visibility effect is missing");
  const loanVisibilityEffect = source.slice(effectStart, effectEnd);
  assert.match(loanVisibilityEffect, /hasNewInvitation/);
  assert.match(loanVisibilityEffect, /scrollTo\?\.\(\{ top: 0,[^}]*behavior: "auto" \}\)/);
  assert.match(loanVisibilityEffect, /scrollIntoView\?\.\(\{ block: "nearest", inline: "nearest", behavior: "auto" \}\)/);
  assert.doesNotMatch(loanVisibilityEffect, /\.focus\(/, "loan invitation must not steal the active input focus");
});

test("folded players retain their character HUD while all in-hand commands are disabled", async () => {
  const { vite, HextechCharacterControl } = await loadControl();
  try {
    const room = roomFor("fenxiang");
    room.game.players.find((entry) => entry.userId === "self").folded = true;
    const mao = room.hextech.characters.find((entry) => entry.characterId === "mao");
    mao.window = {
      windowId: "mao-public-claim",
      type: "mao-claim",
      state: "armed",
      suit: "hearts",
      expiresAt: new Date(Date.now() + 8_000).toISOString(),
    };
    const html = renderToStaticMarkup(React.createElement(HextechCharacterControl, { room, onCommand() {} }));
    assert.match(html, /character-fenxiang[^"\n]*is-folded/);
    assert.match(html, /aria-disabled="true"/);
    assert.match(html, /粉香/);
    assert.match(html, /成长与觉醒进度/);
    assert.match(html, /已弃牌，本手不能发动人物技能/);
    assert.match(html, /发动以小搏大/);
    assert.match(html, /质疑花色/);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    assert.ok(buttons.length >= 2, "fixture must expose both own and reaction commands");
    assert.ok(buttons.every((button) => button.includes('disabled=""')), "every folded in-hand command must be disabled");
  } finally {
    await vite.close();
  }
});

test("character command contract uses only client-authorized fields", () => {
  for (const command of [
    "fenxiang:activate",
    "xu:barbecue",
    "jiansheng:pressure",
    "ya:activate",
    "qiwan:activate",
    "zige:offer-loan",
    "zige:respond-loan",
    "zige:repay-loan",
    "mao:claim",
    "mao:challenge",
    "mao:choose",
    "wengwengwen:activate-hunt",
  ]) {
    assert.match(source, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /commandId: commandId\(\)/);
  assert.doesNotMatch(source, /await onCommand\([^)]*\{[\s\S]{0,120}handNumber:/);
  assert.doesNotMatch(source, /issue\([^\n]+\{[^\n}]*(?:street|casterAllIn|riverDealt|flopDealt|casterStreetCommitted|lenderAvailableStack|borrowerAvailableStack|now)\s*:/);
  assert.doesNotMatch(source, /MAO_CLAIM[^\n]+street:/);
  assert.match(source, /adapter must add userId,[\s\S]*handNumber/);
});

test("character rail has keyboard, status, timer and non-color selection semantics", () => {
  for (const token of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
    assert.match(source, new RegExp(token));
  }
  assert.match(source, /role="meter"/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /aria-selected/);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /aria-checked/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-live="assertive"/);
  assert.match(source, /role="log"/);
  assert.match(source, /secondsLeft/);
});

test("candidate values are read only for Mao's authorized private choice window", () => {
  assert.doesNotMatch(source, /(?:holeCards|selfCards|privateCards|revealedCards)/);
  assert.match(source, /const ownCandidates = characterId === "mao" \? candidateIds\(ownWindow\) : \[\]/);
  assert.equal((source.match(/candidateIds\(/g) ?? []).length, 2, "helper must only be called once, with ownWindow");
  assert.doesNotMatch(source, /publicMaoWindow[^;]+candidateCardIds/s);
  const yaBranch = source.slice(source.indexOf('characterId === "ya"'), source.indexOf('characterId === "zige"'));
  assert.doesNotMatch(yaBranch, /CharacterCardChoices|cardId:|selectedCardId|ownCandidates/);
});

test("character rail remains in normal flow and bounds expansion at 320px", () => {
  assert.doesNotMatch(css, /\.hextech-character-control\s*\{[^}]*position:\s*(?:fixed|absolute)/s);
  assert.match(css, /\.hextech-character-control\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.hextech-character-control-workspace\s*\{[^}]*max-height:[^;]+;[\s\S]*?overflow:\s*auto/s);
  assert.match(css, /@media\s*\(max-width:\s*39\.99rem\)[\s\S]*\.hextech-character-control\s*\{[\s\S]*grid-template-columns:/);
  assert.match(css, /\.hextech-character-control-workspace\s*\{[\s\S]*max-height:\s*min\(42dvh,\s*250px\)/);
  assert.match(css, /\.hextech-character-control-targets > button,[\s\S]*min-height:\s*44px/);
  assert.match(css, /\.hextech-character-control-confirm-actions\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.hextech-character-control-awaken-stamp/);
  assert.match(css, /feTurbulence/);
});
