import assert from "node:assert/strict";
import test from "node:test";
import {
  ACHIEVEMENT_CATALOG,
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_RARITIES,
  achievementsForPublicDisplay,
} from "../shared/achievements.js";

test("achievement catalog contains 120 unique achievements with long-term rarity tiers", () => {
  assert.equal(ACHIEVEMENT_CATALOG.length, 120);
  assert.equal(new Set(ACHIEVEMENT_CATALOG.map(({ id }) => id)).size, 120);
  assert.equal(new Set(ACHIEVEMENT_CATALOG.map(({ title }) => title)).size, 120);

  for (const category of ACHIEVEMENT_CATEGORIES.filter((item) => item !== "全部")) {
    assert.equal(ACHIEVEMENT_CATALOG.filter((achievement) => achievement.category === category).length, 24);
  }
  assert.ok(ACHIEVEMENT_CATALOG.filter(({ rarity }) => rarity === "legendary").length >= 12);
  assert.ok(ACHIEVEMENT_CATALOG.every(({ rarity }) => Object.hasOwn(ACHIEVEMENT_RARITIES, rarity)));
  assert.ok(ACHIEVEMENT_CATALOG.some(({ target }) => target >= 10000));
});

test("public identity badges exclude the current title and duplicate achievement ids", () => {
  const badges = achievementsForPublicDisplay(
    ["legendary-hand", "unlucky", "legendary-hand"],
    ["一手封神"],
  );

  assert.deepEqual(badges.map(({ id }) => id), ["unlucky"]);
});

test("public identity badges preserve distinct unlocked achievement labels", () => {
  const badges = achievementsForPublicDisplay(["first-hand", "first-profit"], ["牌桌新秀"]);

  assert.deepEqual(badges.map(({ title }) => title), ["初登牌桌", "第一桶金"]);
});
