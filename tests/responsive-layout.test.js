import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const hextechStyles = readFileSync(new URL("../src/hextech/hextech.css", import.meta.url), "utf8");

test("mobile waiting room pins the host start control to the viewport instead of requiring scroll", () => {
  assert.match(appSource, /className="button primary waiting-start-button"/);
  assert.match(appSource, />开始发牌<\/button>/);
  assert.match(styles, /\.game-layout\s*>\s*\.table-column\s*\{[^}]*height:\s*100%[^}]*max-height:\s*100%/s);
  assert.match(styles, /\.waiting-layout\s+\.waiting-actions,[^{]*\{[^}]*position:\s*fixed[^}]*width:\s*min\(calc\(100vw - 16px\), 42rem\)[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(styles, /\.waiting-layout\s+\.table-wrap,[^{]*\{[^}]*height:\s*clamp\(24rem,[^}]*min-height:\s*24rem/s);
  assert.match(styles, /\.waiting-actions\s+\.waiting-start-button,[^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
});

test("game controls render inside a fixed-size stage instead of changing page flow", () => {
  assert.match(appSource, /className=\{`game-controls-stage stage-\$\{game\.stage\}`\}/);
  assert.match(appSource, /className="own-cards-slot"/);
  assert.match(appSource, /className="game-console-slot"/);
  assert.match(styles, /\.game-controls-stage\s*\{[^}]*min-height:\s*5\.75rem[^}]*flex:\s*0\s+0\s+5\.75rem/s);
  assert.match(styles, /height:\s*9\.25rem;[^}]*grid-template-rows:\s*1\.375rem\s+7\.875rem/s);
});

test("compact hextech tables place poker actions before character and skill rails without overlays", () => {
  const compactStyles = hextechStyles.slice(hextechStyles.indexOf("@media (max-width: 39.99rem)"));
  assert.match(appSource, /className="own-cards-slot"[\s\S]*className="game-console-slot"/);
  assert.match(hextechStyles, /\.hextech-game-column \.game-console-slot > \.action-area,[\s\S]*?> \.result-card \{[\s\S]*?position:\s*static;/);
  assert.match(compactStyles, /\.hextech-game-column \.game-console-slot > \.action-area,[\s\S]*?> \.result-card \{ order:\s*-2; \}/);
  assert.match(compactStyles, /> \.hextech-character-control \{ order:\s*0; \}/);
  assert.match(compactStyles, /> \.hextech-skill-control \{ order:\s*1; \}/);
  assert.match(compactStyles, /\.hextech-skill-control\s*\{[^}]*--hextech-skill-rail-size:\s*342px;[^}]*grid-template-rows:\s*68px minmax\(0, 1fr\) 62px/s);
  assert.match(compactStyles, /\.hextech-skill-help-popover\s*\{[^}]*inset:\s*80px 6px 74px/s);
  assert.match(compactStyles, /\.hextech-skill-help-trigger\s*\{[^}]*width:\s*44px;[^}]*min-width:\s*44px;[^}]*height:\s*44px;[^}]*min-height:\s*44px/s);
  assert.doesNotMatch(compactStyles, /\.hextech-skill-actions > :only-child/);
  assert.match(compactStyles, /\.hextech-skill-actions > \.hextech-skill-primary \{ grid-column:\s*1; grid-row:\s*1; \}/);
  assert.match(compactStyles, /\.hextech-skill-actions > \.hextech-skill-secondary \{ grid-column:\s*2; grid-row:\s*1; \}/);
  assert.doesNotMatch(compactStyles, /\.hextech-game-column \.game-console-slot > \.(?:action-area|result-card)[^{]*\{[^}]*(?:position:\s*(?:fixed|absolute)|transform:\s*translate)/s);
});

test("light theme leaderboard overrides the approved dark card treatment", () => {
  assert.match(styles, /:root\[data-theme="light"\]\s+\.leaderboard-row\s*\{[^}]*background:\s*color-mix/s);
  assert.match(styles, /:root\[data-theme="light"\]\s+\.leaderboard-row\.rank-1\s*\{[^}]*--color-gold|:root\[data-theme="light"\]\s+\.leaderboard-row\.rank-1\s*\{[^}]*var\(--color-gold\)/s);
  assert.match(styles, /:root\[data-theme="light"\]\s+\.identity-badges em\s*\{[^}]*background:\s*#d4dfcf/s);
});

test("finished hands use a compact result strip without an inner scrollbar", () => {
  assert.match(appSource, /result-card compact-result-card/);
  assert.match(appSource, /className="result-summary-copy"/);
  assert.match(appSource, /className="result-footer/);
  assert.match(styles, /\.game-console-slot\s*>\s*\.result-card\.compact-result-card\s*\{[^}]*grid-template-rows:[^}]*overflow:\s*hidden/s);
});

test("raise controls open in a viewport-centered overlay outside the clipped action stage", () => {
  assert.match(appSource, /className="raise-backdrop"/);
  assert.match(styles, /\.raise-backdrop\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*z-index:\s*var\(--z-modal\)[^}]*place-items:\s*center/s);
  assert.match(styles, /\.raise-panel\s*\{[^}]*position:\s*relative[^}]*inset:\s*auto/s);
});

test("achievement rarity selector preserves its horizontal label and wraps as a whole", () => {
  assert.match(appSource, /className="achievement-rarity-filter"[\s\S]*?<span>稀有度<\/span>/);
  assert.match(styles, /\.achievement-filter-row\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(styles, /\.achievement-rarity-filter\s*\{[^}]*min-width:\s*max-content;[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.achievement-rarity-filter\s*>\s*span\s*\{[^}]*white-space:\s*nowrap;[^}]*writing-mode:\s*horizontal-tb;/s);
  assert.match(styles, /\.achievement-rarity-filter select\s*\{[^}]*min-width:\s*72px;[^}]*flex:\s*0 0 auto;/s);
});

test("the public pot uses a deterministic scattered chip layout instead of a straight row", () => {
  assert.match(appSource, /<div className="pot-chip-scatter">[\s\S]*?\{stacks\.map\(/);
  assert.doesNotMatch(appSource, /stacks\.slice\(0,\s*6\)/);
  assert.match(appSource, /function potChipLayout\(seed, amount, index\)/);
  assert.match(appSource, /potChipLayout\(seed, amount, index\)/);
  assert.match(appSource, /seed=\{game\.handId\}/);
  assert.match(appSource, /stack-depth-\$\{Math\.min\(4, count\)\}/);
  assert.match(styles, /\.real-chip\s*\{[^}]*--chip-x:\s*0px;[^}]*--chip-y:\s*0px;[^}]*inset-inline-start:\s*calc\(50% \+ var\(--chip-x\)\)[^}]*inset-block-start:\s*calc\(50% \+ var\(--chip-y\)\)/s);
  assert.doesNotMatch(styles, /\.pot-chip-scatter \.real-chip:nth-child/);
  assert.match(styles, /\.real-chip\.stack-depth-4\s*\{[^}]*0 7px 0/s);
  assert.match(styles, /@keyframes pot-chip-impact\s*\{[\s\S]*?100%\s*\{[^}]*rotate\(var\(--chip-rotate\)\)/s);
});

test("community cards stay above animated pot chips on wide desktop tables", () => {
  assert.match(styles, /\.pot-chips\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;[^}]*margin-block-end:\s*4px;/s);
  assert.match(styles, /\.community-cards\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*20;[^}]*isolation:\s*isolate;/s);
  assert.match(styles, /\.community-cards \.playing-card\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s);
});

test("timed all-in runouts explain that the board is being dealt street by street", () => {
  assert.match(appSource, /game\.runout\?\.active[\s\S]*?全押摊牌 · 公共牌逐街发出/);
});

test("spectator controls expose a compact player switcher and a dedicated watched hand", () => {
  assert.match(appSource, /className="spectator-view-switcher"[^>]*role="listbox"/);
  assert.match(appSource, /act\("game:watch-player", \{ userId \}\)/);
  assert.match(appSource, /aria-label=\{canWatch \? `观看 \$\{member\.username\} 的手牌`/);
  assert.match(appSource, /const canSwitchWatchPerspective = room\.self\.role === "spectator" \|\| foldedSpectatorView/);
  assert.match(appSource, /onWatchPlayer=\{canSwitchWatchPerspective/);
  assert.match(appSource, /className="folded-spectator-watch"/);
  assert.match(appSource, /canWatch && !spectatorFocused/);
  assert.match(appSource, /className="watch-seat-hint"/);
  assert.doesNotMatch(styles, /\.watch-seat-hint\.active/);
  assert.match(styles, /\.watchable-player,\s*\.watchable-player \* \{\s*cursor: pointer !important;/);
  assert.match(styles, /\.watchable-player::before \{[\s\S]*inset: -16px -22px;/);
  assert.match(appSource, /function SpectatorHand\(\{ game \}\)/);
  assert.match(appSource, /spectatorMystery=\{Boolean\(game\?\.spectatorView\?\.mysteryUserId\)/);
  assert.match(appSource, /神秘玩家 · 手牌隐藏/);
  assert.match(appSource, /game:spectator-visibility/);
  assert.match(appSource, /player\.spectatorHidden && !player\.spectatorAccessGranted/);
  assert.match(appSource, /本手已看过 · 权限保留/);
  assert.match(appSource, /self\.spectatorHidden \? "阻止新观战" : "观战可见"/);
  assert.match(appSource, /已经看过的人仍可继续查看/);
  assert.match(appSource, /选择座位并申请入座/);
  assert.match(appSource, /queuedFirstSeat && !activeGame/);
  assert.match(appSource, /waitingSpectatorView === "seat-select"/);
  assert.match(appSource, /socket\.on\("room:expired"/);
  assert.match(styles, /\.player-seat\.spectator-private \.seat-card/);
  assert.match(styles, /\.spectator-view-switcher\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /\.player-seat\.spectator-focused \.seat-card\s*\{[^}]*border-color:\s*var\(--color-gold-strong\)/s);
  assert.match(styles, /\.game-column \.turn-timer-cluster\s*\{[^}]*z-index:\s*20;/s);
  assert.match(styles, /@media \(max-width:\s*47\.99rem\)\s*\{[\s\S]*?\.spectator-bar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});

test("host moderation exposes a confirmed kick flow and a kicked-room listener", () => {
  assert.match(appSource, /act\("room:kick", \{ userId: kickTarget\.userId \}\)/);
  assert.match(appSource, /className="kick-confirm-dialog"/);
  assert.match(appSource, /socket\.on\("room:kicked"/);
  assert.match(styles, /\.member-kick-button\s*\{/);
  assert.match(styles, /\.kick-confirm-backdrop,\s*\.host-transfer-backdrop\s*\{[^}]*position:\s*fixed;/s);
});

test("end-of-hand controls expose timed fold reveal, low-stack top-up, and host transfer", () => {
  assert.match(appSource, /function FoldRevealChoice\(\{ game, act \}\)/);
  assert.match(appSource, /act\("game:fold-reveal", \{ reveal: true, handId: game\.handId \}\)/);
  assert.match(appSource, /room\.self\.stack < LOW_STACK_REBUY_THRESHOLD/);
  assert.match(appSource, /act\("room:transfer-host", \{ userId: transferTarget\.userId \}\)/);
  assert.match(appSource, /将房主转让给 \{transferTarget\.username\}/);
  assert.match(styles, /\.fold-reveal-choice\s*\{[^}]*display:\s*grid;/s);
  assert.match(styles, /\.member-transfer-button\s*\{/);
});

test("the bottom hand has a stable runway and folded players retain their original cards", () => {
  assert.match(appSource, /const reservesBottomHand = Boolean\(game && game\.stage !== "finished"\)/);
  assert.match(appSource, /reservesBottomHand \? "hand-runway" : ""/);
  assert.match(styles, /\.game-column \.table-wrap\.hand-runway \.player-seat\.seat-4\s*\{[^}]*inset-block-start:\s*79%;/s);
  assert.match(appSource, /function OwnCards\(\{ room, game, act, folded = false \}\)/);
  assert.match(appSource, /setPeeked\(folded\)/);
  assert.match(appSource, /<OwnCards room=\{room\} game=\{game\} act=\{act\} folded=\{foldedSpectatorView\} \/>/);
  assert.match(appSource, /folded \? "已弃牌 · 隐藏原手牌" : "隐藏手牌"/);
  assert.match(appSource, /const foldedCards = selfResultPlayer\?\.folded \? selfResultPlayer\.cards : \[\]/);
  assert.match(appSource, /className="result-folded-hand"/);
  assert.match(styles, /\.result-folded-hand \.playing-card\s*\{[^}]*width:\s*24px;[^}]*height:\s*34px;/s);
});
