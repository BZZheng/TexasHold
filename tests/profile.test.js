import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../server/store.js";

test("player profile persists nickname, avatar, title and public achievements", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-profile-"));
  try {
    const store = new Store(dataDir);
    const user = store.register("资料测试玩家", "local-test-password");
    store.addHistory({
      userId: user.id,
      roomCode: "TST1",
      roomName: "资料测试房",
      handNumber: 1,
      chipChange: 600,
      result: "获胜",
      detail: "两对",
    });

    const before = store.profileFor(user.id);
    assert.equal(before.stats.hands, 1);
    assert.equal(before.stats.netPoints, 600);
    assert.equal(before.achievements.find((entry) => entry.id === "first-hand").unlocked, true);
    assert.equal(before.achievements.find((entry) => entry.id === "first-profit").unlocked, true);

    const updated = store.updateProfile(user.id, {
      displayName: "河畔牌手",
      avatarTone: "sage",
      title: "第一桶金",
      displayedAchievements: ["first-hand", "first-profit"],
    });
    assert.equal(updated.displayName, "河畔牌手");
    assert.equal(updated.avatarTone, "sage");
    assert.equal(updated.title, "第一桶金");
    assert.deepEqual(updated.displayedAchievements, ["first-hand"]);

    const restored = new Store(dataDir).profileFor(user.id);
    assert.equal(restored.user.displayName, "河畔牌手");
    assert.deepEqual(restored.user.displayedAchievements, ["first-hand"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("historical leaderboard uses authoritative lifetime settlement stats", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-ranking-"));
  try {
    const store = new Store(dataDir);
    const first = store.register("历史甲", "local-test-password");
    const second = store.register("历史乙", "local-test-password");
    store.addHistory({ userId: first.id, chipChange: 350, result: "获胜" });
    store.addHistory({ userId: second.id, chipChange: -100, result: "结束" });
    store.addHistory({ userId: second.id, chipChange: 200, result: "获胜" });

    const ranking = store.historyLeaderboard();
    assert.deepEqual(ranking.map((entry) => entry.userId), [first.id, second.id]);
    assert.equal(ranking[0].score, 350);
    assert.equal(ranking[1].score, 100);
    assert.equal(ranking[1].hands, 2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("practice hands with test players stay in history but never affect ranking or achievements", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-practice-ranking-"));
  try {
    const store = new Store(dataDir);
    const user = store.register("练习局玩家", "local-test-password");
    store.addHistory({
      userId: user.id,
      roomCode: "BOT1",
      roomName: "测试玩家练习房",
      handNumber: 1,
      chipChange: 1800,
      result: "获胜",
      detail: "同花",
      leaderboardEligible: false,
    });

    const history = store.historyFor(user.id);
    const profile = store.profileFor(user.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].matchType, "practice");
    assert.equal(history[0].leaderboardEligible, false);
    assert.equal(profile.stats.hands, 0);
    assert.equal(profile.stats.wins, 0);
    assert.equal(profile.stats.netPoints, 0);
    assert.equal(profile.unlockedCount, 0);
    assert.deepEqual(store.historyLeaderboard(), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("legacy single-human settlements are migrated out of lifetime ranking", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-practice-migration-"));
  try {
    const hotDir = path.join(dataDir, "hot");
    const archiveDir = path.join(dataDir, "archive-ring");
    mkdirSync(hotDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    const first = { id: "first", username: "历史真人甲", displayName: "历史真人甲", stats: { hands: 2, wins: 2, netPoints: 900 } };
    const second = { id: "second", username: "历史真人乙", displayName: "历史真人乙", stats: { hands: 1, wins: 0, netPoints: -300 } };
    const officialWin = { id: "official-win", userId: first.id, roomCode: "REAL", handNumber: 1, chipChange: 300, result: "获胜", createdAt: "2026-01-01T00:00:01.000Z" };
    const officialLoss = { id: "official-loss", userId: second.id, roomCode: "REAL", handNumber: 1, chipChange: -300, result: "结束", createdAt: "2026-01-01T00:00:00.000Z" };
    const practiceWin = { id: "practice-win", userId: first.id, roomCode: "BOTS", handNumber: 1, chipChange: 600, result: "获胜", createdAt: "2026-01-02T00:00:00.000Z" };
    writeFileSync(path.join(hotDir, "texashold.json"), JSON.stringify({
      users: [first, second],
      sessions: [],
      histories: [practiceWin, officialWin, officialLoss],
    }));
    writeFileSync(path.join(archiveDir, "history-events.json"), JSON.stringify({ version: 1, events: [practiceWin] }));

    const store = new Store(dataDir);
    const firstProfile = store.profileFor(first.id);
    assert.equal(firstProfile.stats.hands, 1);
    assert.equal(firstProfile.stats.wins, 1);
    assert.equal(firstProfile.stats.netPoints, 300);
    assert.equal(store.historyFor(first.id).find((entry) => entry.id === "practice-win").leaderboardEligible, false);
    assert.equal(store.archive.events[0].leaderboardEligible, false);
    assert.equal(store.historyLeaderboard()[0].score, 300);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("locked achievements cannot be forged into a public profile", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-profile-guard-"));
  try {
    const store = new Store(dataDir);
    const user = store.register("称号防伪", "local-test-password");
    assert.throws(
      () => store.updateProfile(user.id, { title: "皇家同花梦" }),
      /只能使用已经解锁的称号/,
    );
    assert.throws(
      () => store.updateProfile(user.id, { displayedAchievements: ["royal-dream"] }),
      /只能展示已经解锁的成就/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
