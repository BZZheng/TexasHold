import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  actionLogEntryKey,
  actionVoiceAnnouncement,
  browserSpeechAvailable,
  speakVoiceAnnouncement,
} from "../src/voice-announcements.js";

test("classic poker action lines become concise Mandarin announcements with stable log keys", () => {
  const entry = { actor: "阿文", text: "加注至 120", at: "2026-09-04T12:00:00.000Z" };
  assert.equal(actionVoiceAnnouncement(entry), "阿文，加注至 120");
  assert.equal(actionLogEntryKey(entry), "2026-09-04T12:00:00.000Z|阿文|加注至 120");
  for (const [text, expected] of [
    ["小盲 5", "阿文，小盲 5"],
    ["大盲 10", "阿文，大盲 10"],
    ["过牌", "阿文，过牌"],
    ["跟注 20", "阿文，跟注 20"],
    ["跟注 80，全押", "阿文，跟注 80，全押"],
    ["下注 40", "阿文，下注 40"],
    ["加注至 120，全押", "阿文，加注至 120，全押"],
    ["全押至 300", "阿文，全押至 300"],
    ["弃牌", "阿文，弃牌"],
  ]) assert.equal(actionVoiceAnnouncement({ actor: "阿文", text }), expected);
});

test("system, settlement, utility and Hextech records stay out of the classic action route", () => {
  for (const entry of [
    { actor: "系统", text: "河牌已发出" },
    { actor: "系统", text: "阿文 赢得 240" },
    { actor: "阿文", text: "购买加时 +60 秒，花费 500 筹码" },
    { actor: "阿文", text: "选择亮出手牌" },
    { actor: "海克斯", text: "技能已经发动" },
    { actor: "阿文", text: "  " },
  ]) assert.equal(actionVoiceAnnouncement(entry), "");
});

test("browser speaker prefers Mandarin, keeps poker speech measured, and can interrupt stale speech", () => {
  const spoken = [];
  let cancelled = 0;
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const mandarinVoice = { name: "Mandarin", lang: "zh-CN" };
  const scope = {
    SpeechSynthesisUtterance: FakeUtterance,
    speechSynthesis: {
      cancel() { cancelled += 1; },
      getVoices() { return [{ name: "English", lang: "en-US" }, mandarinVoice]; },
      speak(utterance) { spoken.push(utterance); },
    },
  };

  assert.equal(browserSpeechAvailable(scope), true);
  assert.equal(speakVoiceAnnouncement("  轮到你   行动  ", { scope, interrupt: true }), true);
  assert.equal(cancelled, 1);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "轮到你 行动");
  assert.equal(spoken[0].lang, "zh-CN");
  assert.equal(spoken[0].voice, mandarinVoice);
  assert.equal(spoken[0].rate, 0.96);
  assert.equal(spoken[0].volume, 0.9);
  assert.equal(speakVoiceAnnouncement("", { scope }), false);
  assert.equal(speakVoiceAnnouncement("继续牌局", {
    scope: {
      SpeechSynthesisUtterance: FakeUtterance,
      speechSynthesis: { getVoices: () => [], speak: () => { throw new Error("voice unavailable"); } },
    },
  }), false);
});

test("room UI exposes persisted classic-route settings, quick mute, and a non-replaying coordinator", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /voiceAnnouncements:\s*true/);
  assert.match(source, /role="switch"/);
  assert.match(source, /播报普通牌局行动线/);
  assert.match(source, /room\.mode !== ROOM_MODES\.HEXTECH_CHAOS/);
  assert.match(source, /function VoiceAnnouncementsButton/);
  assert.match(source, /function useRoomVoiceAnnouncements/);
  assert.match(source, /previous\.initialized/);
  assert.match(source, /previousIndex > 0/);
  assert.doesNotMatch(source, /characterSelectionVoiceAnnouncement|characterVoiceAnnouncement/);
  assert.match(styles, /\.voice-preference-toggle\[aria-checked="true"\]/);
  assert.match(styles, /\.voice-announcements-button\.is-off/);
});
