import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HEXTECH_CHARACTERS, HEXTECH_SKILLS } from "../shared/hextech.js";
import {
  characterImage,
  characterImageSrcSet,
  skillImage,
  skillImageSrcSet,
} from "../src/hextech/hextech-assets.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");

function publicFile(assetUrl) {
  return path.join(publicDir, assetUrl.split("?")[0].replace(/^\//, ""));
}

test("every character ships bounded responsive WebP art, including 翁翁翁", () => {
  assert.ok(HEXTECH_CHARACTERS.some(({ id }) => id === "wengwengwen"));
  for (const character of HEXTECH_CHARACTERS) {
    for (const awakened of [false, true]) {
      const small = characterImage(character.id, awakened);
      const large = characterImage(character.id, awakened, 384);
      assert.match(small, /-192\.webp\?v=2$/);
      assert.match(characterImageSrcSet(character.id, awakened), /192w, .*384w$/);
      assert.ok(fs.statSync(publicFile(small)).size <= 40_000, `${small} exceeds the 40 KB first-paint budget`);
      assert.ok(fs.statSync(publicFile(large)).size <= 100_000, `${large} exceeds the 100 KB high-density budget`);
    }
  }
});

test("every skill ships bounded responsive WebP art", () => {
  for (const skill of HEXTECH_SKILLS) {
    const small = skillImage(skill.id);
    const large = skillImage(skill.id, 256);
    assert.match(small, /-128\.webp\?v=2$/);
    assert.match(skillImageSrcSet(skill.id), /128w, .*256w$/);
    assert.ok(fs.statSync(publicFile(small)).size <= 15_000, `${small} exceeds the 15 KB first-paint budget`);
    assert.ok(fs.statSync(publicFile(large)).size <= 35_000, `${large} exceeds the 35 KB high-density budget`);
  }
});

test("production static server marks revisioned Hextech WebP assets immutable", () => {
  const serverSource = fs.readFileSync(path.join(rootDir, "server/index.js"), "utf8");
  assert.match(serverSource, /hextech-chaos\\\/\(\?:characters\|skills\)/);
  assert.match(serverSource, /Cache-Control", "public, max-age=31536000, immutable"/);
});
