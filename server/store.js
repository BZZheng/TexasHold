import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { constantTimeEqual, tokenDigest } from "./security.js";
import {
  ACHIEVEMENT_CATALOG,
  AVATAR_TONES,
  DEFAULT_PLAYER_TITLE,
  achievementsForPublicDisplay,
  achievementsForStats,
} from "../shared/achievements.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 8;
const DEFAULT_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;
const PLAYER_STATS_VERSION = 2;
const LEGACY_PROVIDER_SEGMENT = String.fromCharCode(78, 97, 115);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function atomicJsonWrite(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function cleanUsername(value) {
  return String(value ?? "").trim().normalize("NFKC");
}

function normalizedDisplayedAchievementIds(ids, title) {
  return achievementsForPublicDisplay(ids, [title]).map((achievement) => achievement.id);
}

function emptyPlayerStats() {
  return {
    hands: 0,
    wins: 0,
    netPoints: 0,
    largestWin: 0,
    largestLoss: 0,
    currentWinStreak: 0,
    maxWinStreak: 0,
    currentLossStreak: 0,
    maxLossStreak: 0,
  };
}

function applyHistoryToStats(stats, entry) {
  const change = Number(entry?.chipChange) || 0;
  stats.hands += 1;
  stats.netPoints += change;
  stats.largestWin = Math.max(stats.largestWin, change);
  stats.largestLoss = Math.max(stats.largestLoss, Math.abs(Math.min(0, change)));
  if (entry?.result === "获胜") stats.wins += 1;
  if (change > 0) {
    stats.currentWinStreak += 1;
    stats.maxWinStreak = Math.max(stats.maxWinStreak, stats.currentWinStreak);
    stats.currentLossStreak = 0;
  } else if (change < 0) {
    stats.currentLossStreak += 1;
    stats.maxLossStreak = Math.max(stats.maxLossStreak, stats.currentLossStreak);
    stats.currentWinStreak = 0;
  } else {
    stats.currentWinStreak = 0;
    stats.currentLossStreak = 0;
  }
  return stats;
}

function statsFromHistory(history) {
  return [...history]
    .reverse()
    .filter((entry) => entry?.leaderboardEligible !== false)
    .reduce((stats, entry) => applyHistoryToStats(stats, entry), emptyPlayerStats());
}

export class Store {
  constructor(dataDir, {
    archiveMaxBytes = positiveInteger(process.env.ARCHIVE_RING_MAX_BYTES, DEFAULT_ARCHIVE_MAX_BYTES),
    minFreeBytes = positiveInteger(process.env.STORAGE_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES),
    logger = null,
  } = {}) {
    this.dataDir = dataDir;
    this.hotDir = path.join(dataDir, "hot");
    this.file = path.join(this.hotDir, "texashold.json");
    this.runtimeFile = path.join(this.hotDir, "runtime-rooms.json");
    this.archiveDir = path.join(dataDir, "archive-ring");
    this.archiveFile = path.join(this.archiveDir, "history-events.json");
    this.replicationFile = path.join(dataDir, "replication-state.json");
    this.archiveMaxBytes = archiveMaxBytes;
    this.minFreeBytes = minFreeBytes;
    this.logger = logger;
    this.archiveDroppedEvents = 0;
    fs.mkdirSync(this.hotDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
    this.#migrateLegacyFile(path.join(dataDir, "texashold.json"), this.file);
    this.#migrateLegacyFile(path.join(dataDir, "runtime-rooms.json"), this.runtimeFile);
    this.data = this.#read();
    this.archive = this.#readArchive();
    const historyMigration = this.#migrateHistoryEligibility();
    const hadPlaintextTokens = this.data.sessions.some((session) => session.token && !session.tokenHash);
    let needsSave = historyMigration.dataChanged;
    if (hadPlaintextTokens) {
      this.data.sessions = this.data.sessions.map((session) => ({
        userId: session.userId,
        tokenHash: session.tokenHash || tokenDigest(session.token),
        createdAt: session.createdAt || new Date().toISOString(),
        expiresAt: session.expiresAt,
      }));
      needsSave = true;
    }
    if (this.data.statsVersion !== PLAYER_STATS_VERSION) {
      this.#rebuildPlayerStats();
      this.data.statsVersion = PLAYER_STATS_VERSION;
      needsSave = true;
    }
    if (this.#ensureUserProfiles()) needsSave = true;
    if (needsSave) this.#save();
    if (historyMigration.archiveChanged) this.#saveArchive();
  }

  #migrateHistoryEligibility() {
    const pendingGroups = new Map();
    for (const entry of this.data.histories) {
      if (typeof entry?.leaderboardEligible === "boolean") continue;
      const hasHandIdentity = typeof entry?.roomCode === "string"
        && Number.isSafeInteger(entry?.handNumber);
      const key = hasHandIdentity ? `${entry.roomCode}:${entry.handNumber}` : `event:${entry.id}`;
      const group = pendingGroups.get(key) || [];
      group.push(entry);
      pendingGroups.set(key, group);
    }

    let dataChanged = false;
    for (const group of pendingGroups.values()) {
      // A completed Hold'em hand needs at least two seated players. Legacy
      // settlements containing only one human record therefore came from a
      // human-versus-test-player practice hand. This inference repairs the
      // practice hands written before the eligibility flag existed.
      const inferredPracticeHand = group.length === 1
        && typeof group[0]?.roomCode === "string"
        && Number.isSafeInteger(group[0]?.handNumber);
      for (const entry of group) {
        entry.leaderboardEligible = !inferredPracticeHand;
        entry.matchType = inferredPracticeHand ? "practice" : "friends";
        dataChanged = true;
      }
    }

    const hotHistoryById = new Map(this.data.histories.map((entry) => [entry.id, entry]));
    let archiveChanged = false;
    for (const entry of this.archive.events) {
      const hotEntry = hotHistoryById.get(entry.id);
      const leaderboardEligible = hotEntry?.leaderboardEligible
        ?? (entry.leaderboardEligible !== false);
      const matchType = leaderboardEligible ? "friends" : "practice";
      if (entry.leaderboardEligible !== leaderboardEligible || entry.matchType !== matchType) {
        entry.leaderboardEligible = leaderboardEligible;
        entry.matchType = matchType;
        archiveChanged = true;
      }
    }
    return { dataChanged, archiveChanged };
  }

  #rebuildPlayerStats() {
    for (const user of this.data.users) {
      user.stats = statsFromHistory(
        this.data.histories.filter((entry) => entry.userId === user.id),
      );
    }
  }

  #ensureUserProfiles() {
    let changed = false;
    for (const user of this.data.users) {
      if (typeof user.displayName !== "string" || !user.displayName.trim()) {
        user.displayName = user.username;
        changed = true;
      }
      if (!AVATAR_TONES.some((tone) => tone.id === user.avatarTone)) {
        user.avatarTone = "gold";
        changed = true;
      }
      if (typeof user.title !== "string" || !user.title) {
        user.title = DEFAULT_PLAYER_TITLE;
        changed = true;
      }
      if (!Array.isArray(user.displayedAchievements)) {
        user.displayedAchievements = [];
        changed = true;
      }
      if (!user.stats || !Number.isSafeInteger(user.stats.hands)) {
        user.stats = statsFromHistory(this.data.histories.filter((entry) => entry.userId === user.id));
        changed = true;
      } else {
        user.stats = { ...emptyPlayerStats(), ...user.stats };
      }

      const unlockedAchievements = achievementsForStats(user.stats)
        .filter((achievement) => achievement.unlocked);
      const unlockedIds = new Set(unlockedAchievements.map((achievement) => achievement.id));
      const unlockedTitles = new Set(unlockedAchievements.map((achievement) => achievement.title));
      const displayedAchievements = normalizedDisplayedAchievementIds(
        user.displayedAchievements.filter((id) => unlockedIds.has(id)),
        user.title,
      );
      if (displayedAchievements.length !== user.displayedAchievements.length
        || displayedAchievements.some((id, index) => id !== user.displayedAchievements[index])) {
        user.displayedAchievements = displayedAchievements;
        changed = true;
      }
      if (user.title !== DEFAULT_PLAYER_TITLE && !unlockedTitles.has(user.title)) {
        user.title = DEFAULT_PLAYER_TITLE;
        changed = true;
      }
    }
    return changed;
  }

  #migrateLegacyFile(legacyFile, targetFile) {
    if (fs.existsSync(targetFile) || !fs.existsSync(legacyFile)) return;
    const temp = `${targetFile}.${process.pid}.migration`;
    fs.copyFileSync(legacyFile, temp);
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, targetFile);
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        statsVersion: Number.isSafeInteger(parsed.statsVersion) ? parsed.statsVersion : 0,
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        histories: Array.isArray(parsed.histories) ? parsed.histories : [],
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { statsVersion: PLAYER_STATS_VERSION, users: [], sessions: [], histories: [] };
    }
  }

  #save() {
    atomicJsonWrite(this.file, this.data);
  }

  #readArchive() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.archiveFile, "utf8"));
      return {
        version: 1,
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { version: 1, events: [] };
    }
  }

  #saveArchive() {
    let payload = { version: 1, events: this.archive.events };
    let encoded = JSON.stringify(payload, null, 2);
    while (Buffer.byteLength(encoded) > this.archiveMaxBytes && this.archive.events.length > 1) {
      this.archive.events.shift();
      this.archiveDroppedEvents += 1;
      payload = { version: 1, events: this.archive.events };
      encoded = JSON.stringify(payload, null, 2);
    }
    const temp = `${this.archiveFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, encoded, { mode: 0o600 });
    fs.renameSync(temp, this.archiveFile);
  }

  storageStatus() {
    let freeBytes = null;
    try {
      const stats = fs.statfsSync(this.dataDir);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // Older Node/filesystem combinations may not expose statfs information.
    }
    let archiveBytes = 0;
    try {
      archiveBytes = fs.statSync(this.archiveFile).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let lastArchivePullAt = null;
    try {
      const replication = JSON.parse(fs.readFileSync(this.replicationFile, "utf8"));
      const legacyField = `last${LEGACY_PROVIDER_SEGMENT}PullAt`;
      const pulledAt = replication.lastArchivePullAt ?? replication[legacyField];
      if (typeof pulledAt === "string") lastArchivePullAt = pulledAt;
    } catch (error) {
      // Replication metadata is written by the restricted archive exporter. A
      // permission mismatch must not take the gameplay health endpoint down.
      if (!["ENOENT", "EACCES", "EPERM"].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
    return {
      mode: "local-hot-archive-ring",
      archiveEvents: this.archive.events.length,
      archiveBytes,
      archiveMaxBytes: this.archiveMaxBytes,
      archiveDroppedEvents: this.archiveDroppedEvents,
      lastArchivePullAt,
      freeBytes,
      acceptsNewRooms: freeBytes == null || freeBytes >= this.minFreeBytes,
    };
  }

  assertCanCreateRoom() {
    if (!this.storageStatus().acceptsNewRooms) {
      const error = new Error("服务器存储空间不足，暂时不能创建新房间；进行中的牌局不受影响");
      error.status = 503;
      throw error;
    }
  }

  publicUser(user) {
    return user ? {
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      avatarTone: user.avatarTone || "gold",
      title: user.title || DEFAULT_PLAYER_TITLE,
      displayedAchievements: normalizedDisplayedAchievementIds(
        user.displayedAchievements || [],
        user.title || DEFAULT_PLAYER_TITLE,
      ),
      createdAt: user.createdAt,
    } : null;
  }

  register(usernameValue, password) {
    const username = cleanUsername(usernameValue);
    const passwordValue = String(password ?? "");
    if (username.length < 2 || username.length > 16) {
      throw new Error("用户名需要 2–16 个字符");
    }
    if (!/^[\p{L}\p{N}_-]+$/u.test(username)) {
      throw new Error("用户名只能包含文字、数字、下划线或短横线");
    }
    if (passwordValue.length < 6 || passwordValue.length > 128) {
      throw new Error("密码需要 6–128 位");
    }
    if (this.data.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      throw new Error("该用户名已被使用");
    }

    const user = {
      id: crypto.randomUUID(),
      username,
      displayName: username,
      avatarTone: "gold",
      title: DEFAULT_PLAYER_TITLE,
      displayedAchievements: [],
      stats: emptyPlayerStats(),
      passwordHash: bcrypt.hashSync(passwordValue, 10),
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    this.#save();
    return this.publicUser(user);
  }

  login(usernameValue, password) {
    const username = cleanUsername(usernameValue);
    const passwordValue = String(password ?? "");
    const user = this.data.users.find(
      (candidate) => candidate.username.toLowerCase() === username.toLowerCase(),
    );
    if (passwordValue.length > 128 || !user || !bcrypt.compareSync(passwordValue, user.passwordHash)) {
      throw new Error("用户名或密码不正确");
    }
    return this.createSession(user.id);
  }

  createSession(userId) {
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter((session) => session.expiresAt > now);
    const token = crypto.randomBytes(32).toString("base64url");
    const retainedUserSessions = this.data.sessions
      .filter((session) => session.userId === userId)
      .sort((left, right) => right.expiresAt - left.expiresAt)
      .slice(0, MAX_SESSIONS_PER_USER - 1);
    this.data.sessions = [
      ...this.data.sessions.filter((session) => session.userId !== userId),
      ...retainedUserSessions,
      {
        tokenHash: tokenDigest(token),
        userId,
        createdAt: new Date(now).toISOString(),
        expiresAt: now + SESSION_TTL_MS,
      },
    ];
    this.#save();
    return { token, user: this.publicUser(this.data.users.find((user) => user.id === userId)) };
  }

  userForToken(token) {
    if (!token) return null;
    const digest = tokenDigest(token);
    const session = this.data.sessions.find(
      (candidate) => candidate.expiresAt > Date.now() && constantTimeEqual(candidate.tokenHash, digest),
    );
    if (!session) return null;
    return this.publicUser(this.data.users.find((user) => user.id === session.userId));
  }

  logout(token) {
    const digest = tokenDigest(token);
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((session) => !constantTimeEqual(session.tokenHash, digest));
    if (this.data.sessions.length !== before) this.#save();
  }

  addHistory(entry) {
    const leaderboardEligible = entry?.leaderboardEligible !== false;
    const event = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...entry,
      leaderboardEligible,
      matchType: leaderboardEligible ? "friends" : "practice",
    };
    const user = this.data.users.find((candidate) => candidate.id === event.userId);
    if (user && leaderboardEligible) {
      user.stats = applyHistoryToStats({ ...emptyPlayerStats(), ...user.stats }, event);
    }
    this.data.histories.unshift(event);
    this.data.histories = this.data.histories.slice(0, 500);
    this.#save();
    this.archive.events.push(event);
    this.#saveArchive();
    this.logger?.info?.("settlement", "history_recorded", {
      userId: event.userId,
      roomCode: event.roomCode,
      handNumber: event.handNumber,
      roomMode: event.roomMode,
      leaderboardEligible,
    });
  }

  historyFor(userId) {
    return this.data.histories.filter((entry) => entry.userId === userId).slice(0, 20);
  }

  profileFor(userId) {
    const user = this.data.users.find((candidate) => candidate.id === userId);
    if (!user) return null;
    const achievements = achievementsForStats(user.stats);
    const unlockedIds = new Set(achievements.filter((achievement) => achievement.unlocked).map((achievement) => achievement.id));
    return {
      user: this.publicUser(user),
      stats: { ...emptyPlayerStats(), ...user.stats },
      achievements,
      unlockedCount: unlockedIds.size,
    };
  }

  updateProfile(userId, payload = {}) {
    const user = this.data.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error("没有找到玩家资料");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("资料格式不正确");

    if (Object.hasOwn(payload, "displayName")) {
      const displayName = cleanUsername(payload.displayName);
      if (displayName.length < 2 || displayName.length > 16 || /[\u0000-\u001F\u007F]/u.test(displayName)) {
        throw new Error("昵称需要 2–16 个可见字符");
      }
      user.displayName = displayName;
    }
    if (Object.hasOwn(payload, "avatarTone")) {
      if (!AVATAR_TONES.some((tone) => tone.id === payload.avatarTone)) throw new Error("头像样式不正确");
      user.avatarTone = payload.avatarTone;
    }

    const achievements = achievementsForStats(user.stats);
    const unlocked = new Map(achievements.filter((achievement) => achievement.unlocked).map((achievement) => [achievement.id, achievement]));
    if (Object.hasOwn(payload, "title")) {
      const title = String(payload.title ?? "");
      const titleUnlocked = [...unlocked.values()].some((achievement) => achievement.title === title);
      if (title !== DEFAULT_PLAYER_TITLE && !titleUnlocked) throw new Error("只能使用已经解锁的称号");
      user.title = title;
    }
    if (Object.hasOwn(payload, "displayedAchievements")) {
      if (!Array.isArray(payload.displayedAchievements)) throw new Error("展示成就格式不正确");
      const ids = [...new Set(payload.displayedAchievements.map((value) => String(value)))];
      if (ids.length > ACHIEVEMENT_CATALOG.length || ids.some((id) => !unlocked.has(id))) throw new Error("只能展示已经解锁的成就");
      user.displayedAchievements = ids;
    }
    user.displayedAchievements = normalizedDisplayedAchievementIds(user.displayedAchievements, user.title);

    this.#save();
    return this.publicUser(user);
  }

  historyLeaderboard() {
    return this.data.users
      .filter((user) => (user.stats?.hands || 0) > 0)
      .map((user) => ({
        userId: user.id,
        username: user.displayName || user.username,
        accountName: user.username,
        avatarTone: user.avatarTone || "gold",
        title: user.title || DEFAULT_PLAYER_TITLE,
        displayedAchievements: normalizedDisplayedAchievementIds(user.displayedAchievements || [], user.title),
        score: Number(user.stats?.netPoints) || 0,
        hands: Number(user.stats?.hands) || 0,
        wins: Number(user.stats?.wins) || 0,
        status: "历史累计",
      }))
      .sort((left, right) => right.score - left.score || right.wins - left.wins || left.username.localeCompare(right.username, "zh-CN"))
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
  }
}
