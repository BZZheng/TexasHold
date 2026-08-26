import assert from "node:assert/strict";
import test from "node:test";
import {
  HEXTECH_BLIND_LEVELS,
  HEXTECH_CHARACTERS,
  HEXTECH_MODE,
  HEXTECH_SKILLS,
  ROOM_MODES,
  hextechBlindForHand,
  hextechTargetForPlayers,
  isHextechCharacterId,
  isHextechSkillId,
  normalizeRoomMode,
} from "../shared/hextech.js";

test("hextech mode keeps the approved 2–8 player targets", () => {
  assert.deepEqual(
    [2, 3, 4, 5, 6, 7, 8].map((count) => hextechTargetForPlayers(count)),
    [4000, 5400, 6800, 8200, 9600, 11000, 12400],
  );
  assert.throws(() => hextechTargetForPlayers(9), /2–8/);
});

test("hextech blind schedule covers exactly fifteen hands", () => {
  assert.equal(HEXTECH_BLIND_LEVELS.length, 5);
  assert.deepEqual(hextechBlindForHand(1), {
    fromHand: 1, toHand: 3, smallBlind: 20, bigBlind: 40, actionSeconds: 60,
  });
  assert.equal(HEXTECH_MODE.draftSeconds, 60);
  assert.ok(HEXTECH_BLIND_LEVELS.every(({ actionSeconds }) => actionSeconds >= 60));
  assert.equal(hextechBlindForHand(6).bigBlind, 60);
  assert.equal(hextechBlindForHand(9).bigBlind, 100);
  assert.equal(hextechBlindForHand(12).bigBlind, 160);
  assert.equal(hextechBlindForHand(15).bigBlind, 240);
  assert.throws(() => hextechBlindForHand(16), /1–15/);
});

test("hextech catalogs retain eight unique characters and thirty unique skills", () => {
  assert.equal(HEXTECH_CHARACTERS.length, 8);
  assert.equal(new Set(HEXTECH_CHARACTERS.map(({ id }) => id)).size, 8);
  assert.equal(HEXTECH_SKILLS.length, 30);
  assert.equal(new Set(HEXTECH_SKILLS.map(({ id }) => id)).size, 30);
  assert.equal(isHextechCharacterId("fenxiang"), true);
  assert.equal(isHextechCharacterId("wengwengwen"), true);
  assert.equal(isHextechSkillId("catch-cheater"), true);
  assert.equal(isHextechCharacterId("unknown"), false);
});

test("room mode normalization remains backward-compatible with classic rooms", () => {
  assert.equal(normalizeRoomMode(), ROOM_MODES.CLASSIC);
  assert.equal(normalizeRoomMode(HEXTECH_MODE.id), HEXTECH_MODE.id);
  assert.throws(() => normalizeRoomMode("custom"), /房间模式/);
});
