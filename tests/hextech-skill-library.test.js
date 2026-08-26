import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, transformWithOxc } from "vite";
import { HEXTECH_SKILLS } from "../shared/hextech.js";

const componentPath = new URL("../src/hextech/HextechSkillLibrary.jsx", import.meta.url);
const cssPath = new URL("../src/hextech/skill-library.css", import.meta.url);
const appPath = new URL("../src/App.jsx", import.meta.url);
const source = fs.readFileSync(componentPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");
const appSource = fs.readFileSync(appPath, "utf8");

test("public skill library JSX parses and reads the single shared catalog", async () => {
  const transformed = await transformWithOxc(source, componentPath.pathname, { lang: "jsx" });
  assert.match(transformed.code, /HextechSkillLibrary/);
  assert.match(source, /import \{ HEXTECH_SKILLS \} from "\.\.\/\.\.\/shared\/hextech\.js"/);
  assert.match(source, /HEXTECH_SKILLS\.filter/);
  assert.match(source, /filteredSkills\.map/);
  assert.doesNotMatch(source, /const\s+SKILLS\s*=/);
});

test("open library renders all thirty shared skills and authoritative rule detail", async () => {
  assert.equal(new Set(HEXTECH_SKILLS.map(({ id }) => id)).size, 30);
  assert.equal(HEXTECH_SKILLS.filter((skill) => skill.cheat || skill.rules.audit?.cheat).length, 5);
  const root = new URL("..", import.meta.url).pathname;
  const vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true },
    logLevel: "error",
  });
  try {
    const { HextechSkillLibrary } = await vite.ssrLoadModule("/src/hextech/HextechSkillLibrary.jsx");
    const html = renderToStaticMarkup(React.createElement(HextechSkillLibrary, { open: true, onClose() {} }));
    assert.equal((html.match(/class="hextech-library-card /g) ?? []).length, HEXTECH_SKILLS.length);
    for (const skill of HEXTECH_SKILLS) {
      assert.match(html, new RegExp(`>${skill.name}<`));
      assert.match(html, new RegExp(`/hextech-chaos/skills/${skill.id}-128\\.webp\\?v=2`));
    }
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /公共技能图鉴/);
    assert.match(html, /搜索名称、类别、时机或效果/);
    assert.match(html, /最大风险/);
    assert.match(html, /具体使用步骤/);
    assert.match(html, /作弊/);
    assert.match(html, /合法/);
  } finally {
    await vite.close();
  }
});

test("rule formatters expose target, cost, risk inputs and generated steps", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true },
    logLevel: "error",
  });
  try {
    const { activationKind, buildSkillSteps, formatSkillCost, formatSkillTarget } = await vite.ssrLoadModule("/src/hextech/HextechSkillLibrary.jsx");
    const xray = HEXTECH_SKILLS.find(({ id }) => id === "xray");
    const escape = HEXTECH_SKILLS.find(({ id }) => id === "escape");
    const fixedDeposit = HEXTECH_SKILLS.find(({ id }) => id === "fixed-deposit");
    assert.equal(activationKind(xray), "active");
    assert.equal(activationKind(escape), "reaction");
    assert.match(formatSkillTarget(xray.rules.target), /1 名 符合条件的对手/);
    assert.match(formatSkillCost(escape.rules.cost), /10%/);
    assert.match(formatSkillCost(escape.rules.cost), /最低 80、最高 160/);
    assert.match(formatSkillCost(fixedDeposit.rules.cost), /锁定 200 筹码至托管区/);
    assert.match(buildSkillSteps(xray).join(" "), /行动前/);
    assert.match(buildSkillSteps(xray).join(" "), /服务器校验/);
  } finally {
    await vite.close();
  }
});

test("library is accessible, mobile-safe, and never inserted into the live table", () => {
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /document\.activeElement/);
  assert.match(source, /opener instanceof HTMLElement/);
  assert.match(source, /loading="lazy"/);
  assert.match(css, /\.hextech-library-backdrop\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.hextech-library-dialog\s*\{[^}]*height:\s*min\(920px,\s*92dvh\)/s);
  assert.match(css, /min-width:\s*44px;[\s\S]*?min-height:\s*44px/);
  assert.match(css, /@media\s*\(max-width:\s*39\.99rem\)[\s\S]*?height:\s*100dvh/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.equal((appSource.match(/<HextechSkillLibrary /g) ?? []).length, 1);
  assert.match(appSource, /export default function App\(\)[\s\S]*?<HextechSkillLibrary /);
});

test("lobby, create-room flow, and hextech waiting room have explicit entries", () => {
  assert.match(appSource, /海克斯公共技能图鉴 · 30/);
  assert.match(appSource, /打开技能图鉴/);
  assert.match(appSource, /aria-label="查看公共技能图鉴"/);
  assert.match(appSource, /CreateRoomModal[\s\S]*?onOpenSkillLibrary/);
  assert.match(appSource, /<HextechSkillLibrary open=\{skillLibraryAllowed && skillLibraryOpen\}/);
  assert.match(appSource, /<RoomHeader[\s\S]{0,600}onOpenSkillLibrary=/);
  assert.match(appSource, /30 个公共技能均已接入权威效果层/);
  assert.doesNotMatch(appSource, /30 个技能的实际效果会由后续服务端效果层逐批开放/);
});

test("library search label stays visually hidden and keyboard focus remains visible", () => {
  assert.match(source, /className="hextech-library-sr-only"/);
  assert.match(css, /\.hextech-library-sr-only\s*\{[^}]*position:\s*absolute[^}]*clip-path:\s*inset\(50%\)/s);
  assert.match(css, /\.hextech-library-search:focus-within,[\s\S]*?\.hextech-library-rarity:focus-within\s*\{[^}]*box-shadow:/s);
  assert.match(source, /<dt>发动时机<\/dt><dd>\{skill\.timing\}<\/dd>/);
});
