const ASSET_ROOT = "/hextech-chaos";
const ASSET_REVISION = "2";

function versioned(pathname) {
  return `${pathname}?v=${ASSET_REVISION}`;
}

export function characterImage(characterId, awakened = false, width = 192) {
  const state = awakened ? "awaken" : "normal";
  return versioned(`${ASSET_ROOT}/characters/${characterId}-${state}-${width}.webp`);
}

export function characterImageSrcSet(characterId, awakened = false) {
  return [192, 384]
    .map((width) => `${characterImage(characterId, awakened, width)} ${width}w`)
    .join(", ");
}

export function skillImage(skillId, width = 128) {
  return versioned(`${ASSET_ROOT}/skills/${skillId}-${width}.webp`);
}

export function skillImageSrcSet(skillId) {
  return [128, 256]
    .map((width) => `${skillImage(skillId, width)} ${width}w`)
    .join(", ");
}
