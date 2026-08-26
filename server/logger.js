import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

const LOG_LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 });
export const LOG_DOMAINS = Object.freeze([
  "auth",
  "lobby",
  "room",
  "game",
  "action",
  "spectator",
  "hextech",
  "rebuy",
  "settlement",
  "deploy",
]);

const LOG_DOMAIN_SET = new Set(LOG_DOMAINS);
const DEFAULT_FILE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_ROTATE_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_ARCHIVE_STALE_AFTER_MS = 5 * 60 * 1000;
const LEGACY_PROVIDER_SEGMENT = String.fromCharCode(78, 97, 115);
const MAX_FIELD_DEPTH = 4;
const MAX_ARRAY_LENGTH = 24;
const MAX_FIELD_LENGTH = 800;
const MAX_LINE_BYTES = 64 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function environmentBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function normalizedLevel(value, fallback = "info") {
  const candidate = String(value || "").toLowerCase();
  return Object.hasOwn(LOG_LEVELS, candidate) ? candidate : fallback;
}

function normalizedDomain(value) {
  const candidate = String(value || "").toLowerCase();
  return LOG_DOMAIN_SET.has(candidate) ? candidate : "deploy";
}

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[-_]/g, "").toLowerCase();
  if (["handid", "handnumber", "skillid", "characterid"].includes(normalized)) return false;
  return normalized.includes("password")
    || normalized.includes("passwd")
    || normalized.includes("passphrase")
    || normalized.includes("authorization")
    || normalized.includes("cookie")
    || normalized.includes("token")
    || normalized.includes("secret")
    || [
      "card",
      "cards",
      "deck",
      "hand",
      "holecard",
      "holecards",
      "skillresult",
      "privateresult",
      "offer",
      "offers",
    ].includes(normalized);
}

export function redactLogString(value, maxLength = MAX_FIELD_LENGTH) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bfh_session\s*=\s*[^;\s]+/gi, "fh_session=[REDACTED]")
    .replace(/([?&](?:token|password|secret|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\/Users\/[^/\s)]+/g, "/Users/<user>")
    .slice(0, maxLength);
}

function sanitizeValue(value, key = "", depth = 0, seen = new WeakSet()) {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactLogString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeLogError(value);
  if (typeof value !== "object") return redactLogString(value);
  if (depth >= MAX_FIELD_DEPTH) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, key, depth + 1, seen));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 80)
      .map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey, depth + 1, seen)]),
  );
}

export function sanitizeLogError(error) {
  if (!(error instanceof Error)) return { message: redactLogString(error) };
  const safe = {
    name: redactLogString(error.name, 80),
    message: redactLogString(error.message),
  };
  if (typeof error.code === "string") safe.code = redactLogString(error.code, 120);
  if (typeof error.status === "number") safe.status = error.status;
  if (typeof error.stack === "string") {
    safe.stack = error.stack
      .split("\n")
      .slice(0, 12)
      .map((line) => redactLogString(line, 500))
      .join("\n");
  }
  return safe;
}

function safeEventName(value) {
  const event = String(value || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_")
    .slice(0, 96);
  return event || "unknown";
}

function isoFileTimestamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[-:.TZ]/g, "");
}

function safeInstanceId(value) {
  const id = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return id || `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

function errorText(error) {
  return redactLogString(error instanceof Error ? error.message : error, 300);
}

export function socketLogDomain(event) {
  if (event === "lobby:list") return "lobby";
  if (event === "room:start") return "game";
  if (event === "room:final-settlement") return "settlement";
  if (event === "game:rebuy") return "rebuy";
  if (event === "game:watch-player" || event === "game:spectator-visibility") return "spectator";
  if (event.startsWith("hextech:")) return "hextech";
  if (event === "game:action" || event === "game:fold-reveal" || event === "game:time-extension") return "action";
  if (event.startsWith("game:")) return "game";
  return "room";
}

export class StructuredLogger {
  constructor({
    enabled = true,
    level = "info",
    service = "friends-holdem",
    environment = process.env.NODE_ENV || "development",
    release = process.env.APP_RELEASE || "dev",
    instanceId = process.env.INSTANCE_ID,
    hotDir,
    archiveDir,
    fileMaxBytes = DEFAULT_FILE_MAX_BYTES,
    archiveMaxBytes = DEFAULT_ARCHIVE_MAX_BYTES,
    archiveMaxFiles = 12,
    rotateIntervalMs = DEFAULT_ROTATE_INTERVAL_MS,
    queueMaxEntries = 5000,
    flushIntervalMs = 250,
    stdout = true,
    archiveMode = "disabled",
    externalArchiveDir = null,
    archiveReadyFile = null,
    archiveSyncIntervalMs = 30_000,
    archiveStaleAfterMs = DEFAULT_ARCHIVE_STALE_AFTER_MS,
    replicationStateFile = null,
    now = () => Date.now(),
  } = {}) {
    if (!hotDir || !archiveDir) throw new Error("StructuredLogger requires hotDir and archiveDir");
    this.enabled = Boolean(enabled);
    this.minimumLevel = normalizedLevel(level);
    this.service = redactLogString(service, 80);
    this.environment = redactLogString(environment, 40);
    this.release = redactLogString(release, 80);
    this.instanceId = safeInstanceId(instanceId);
    this.hotDir = path.resolve(hotDir);
    this.archiveDir = path.resolve(archiveDir);
    this.activeFile = path.join(this.hotDir, "application.jsonl");
    this.fileMaxBytes = positiveInteger(fileMaxBytes, DEFAULT_FILE_MAX_BYTES);
    this.archiveMaxBytes = positiveInteger(archiveMaxBytes, DEFAULT_ARCHIVE_MAX_BYTES);
    this.archiveMaxFiles = positiveInteger(archiveMaxFiles, 12);
    this.rotateIntervalMs = positiveInteger(rotateIntervalMs, DEFAULT_ROTATE_INTERVAL_MS);
    this.queueMaxEntries = positiveInteger(queueMaxEntries, 5000);
    this.flushIntervalMs = positiveInteger(flushIntervalMs, 250);
    this.stdout = Boolean(stdout);
    this.archiveMode = ["disabled", "push", "pull"].includes(archiveMode) ? archiveMode : "disabled";
    this.externalArchiveDir = externalArchiveDir ? path.resolve(externalArchiveDir) : null;
    this.archiveReadyFile = archiveReadyFile ? path.resolve(archiveReadyFile) : null;
    this.archiveSyncIntervalMs = positiveInteger(archiveSyncIntervalMs, 30_000);
    this.archiveStaleAfterMs = positiveInteger(archiveStaleAfterMs, DEFAULT_ARCHIVE_STALE_AFTER_MS);
    this.replicationStateFile = replicationStateFile ? path.resolve(replicationStateFile) : null;
    this.now = now;
    this.queue = [];
    this.flushPromise = null;
    this.archivePromise = null;
    this.closed = false;
    this.rotateSequence = 0;
    this.currentBytes = 0;
    this.activeOpenedAt = this.now();
    this.health = {
      fileHealthy: true,
      lastWriteAt: null,
      lastWriteError: null,
      droppedEntries: 0,
      failedWrites: 0,
      archivedFiles: 0,
      archiveBytes: 0,
      archiveDroppedFiles: 0,
      archive: {
        mode: this.archiveMode,
        state: this.archiveMode === "disabled" ? "disabled" : "waiting",
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null,
        pendingFiles: 0,
      },
    };
    this.readyPromise = this.enabled ? this.#initialize() : Promise.resolve();
    this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.flushTimer.unref();
    this.archiveTimer = this.archiveMode === "disabled"
      ? null
      : setInterval(() => void this.syncArchive(), this.archiveSyncIntervalMs);
    this.archiveTimer?.unref();
  }

  async #initialize() {
    try {
      await Promise.all([
        fsp.mkdir(this.hotDir, { recursive: true, mode: 0o700 }),
        fsp.mkdir(this.archiveDir, { recursive: true, mode: 0o700 }),
      ]);
      try {
        const stat = await fsp.stat(this.activeFile);
        this.currentBytes = stat.size;
        this.activeOpenedAt = stat.birthtimeMs || stat.mtimeMs || this.now();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await this.#refreshArchiveStatus();
    } catch (error) {
      this.health.fileHealthy = false;
      this.health.lastWriteError = errorText(error);
      this.#fallbackDiagnostic("logger_initialization_failed", error);
    }
  }

  #fallbackDiagnostic(event, error) {
    try {
      process.stderr.write(`${JSON.stringify({
        ts: new Date(this.now()).toISOString(),
        level: "error",
        domain: "deploy",
        event,
        error: errorText(error),
      })}\n`);
    } catch {
      // Logging must never interrupt gameplay, including when stderr is closed.
    }
  }

  #shouldLog(level) {
    return this.enabled && LOG_LEVELS[normalizedLevel(level)] >= LOG_LEVELS[this.minimumLevel];
  }

  log(level, domain, event, fields = {}) {
    const safeLevel = normalizedLevel(level);
    if (!this.#shouldLog(safeLevel) || this.closed) return null;
    const timestamp = new Date(this.now()).toISOString();
    const eventId = crypto.randomUUID();
    const safeFields = sanitizeValue(fields, "fields");
    const entry = {
      ts: timestamp,
      level: safeLevel,
      domain: normalizedDomain(domain),
      event: safeEventName(event),
      eventId,
      service: this.service,
      environment: this.environment,
      release: this.release,
      instanceId: this.instanceId,
      ...safeFields,
    };
    if (this.queue.length >= this.queueMaxEntries) {
      this.queue.shift();
      this.health.droppedEntries += 1;
    }
    this.queue.push(entry);
    if (LOG_LEVELS[safeLevel] >= LOG_LEVELS.error) queueMicrotask(() => void this.flush());
    return eventId;
  }

  trace(domain, event, fields) { return this.log("trace", domain, event, fields); }
  debug(domain, event, fields) { return this.log("debug", domain, event, fields); }
  info(domain, event, fields) { return this.log("info", domain, event, fields); }
  warn(domain, event, fields) { return this.log("warn", domain, event, fields); }
  error(domain, event, error, fields = {}) { return this.log("error", domain, event, { ...fields, error }); }
  fatal(domain, event, error, fields = {}) { return this.log("fatal", domain, event, { ...fields, error }); }

  async flush() {
    if (!this.enabled) return;
    if (this.flushPromise) {
      await this.flushPromise;
      if (this.queue.length) return this.flush();
      return;
    }
    if (!this.queue.length) {
      if (this.currentBytes > 0 && this.now() - this.activeOpenedAt >= this.rotateIntervalMs) {
        this.flushPromise = this.readyPromise
          .then(() => this.#rotate())
          .catch((error) => {
            this.health.fileHealthy = false;
            this.health.lastWriteError = errorText(error);
            this.#fallbackDiagnostic("logger_rotation_failed", error);
          })
          .finally(() => { this.flushPromise = null; });
        await this.flushPromise;
      }
      return;
    }
    const entries = this.queue.splice(0, this.queue.length);
    this.flushPromise = this.#writeEntries(entries)
      .catch((error) => {
        this.health.fileHealthy = false;
        this.health.failedWrites += entries.length;
        this.health.lastWriteError = errorText(error);
        const room = Math.max(0, this.queueMaxEntries - this.queue.length);
        this.queue.unshift(...entries.slice(-room));
        this.#fallbackDiagnostic("logger_write_failed", error);
      })
      .finally(() => { this.flushPromise = null; });
    await this.flushPromise;
  }

  #encodedLine(entry) {
    let line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
    line = `${JSON.stringify({
      ts: entry.ts,
      level: entry.level,
      domain: entry.domain,
      event: entry.event,
      eventId: entry.eventId,
      service: entry.service,
      environment: entry.environment,
      release: entry.release,
      instanceId: entry.instanceId,
      truncated: true,
    })}\n`;
    return line;
  }

  async #writeEntries(entries) {
    await this.readyPromise;
    const lines = entries.map((entry) => this.#encodedLine(entry));
    for (const line of lines) {
      const bytes = Buffer.byteLength(line);
      const timedOut = this.currentBytes > 0 && this.now() - this.activeOpenedAt >= this.rotateIntervalMs;
      if (this.currentBytes > 0 && (this.currentBytes + bytes > this.fileMaxBytes || timedOut)) {
        await this.#rotate();
      }
      if (this.stdout) {
        try { process.stdout.write(line); } catch { /* Docker stdout is best-effort. */ }
      }
      await fsp.appendFile(this.activeFile, line, { encoding: "utf8", mode: 0o600 });
      this.currentBytes += bytes;
    }
    this.health.fileHealthy = true;
    this.health.lastWriteAt = new Date(this.now()).toISOString();
    this.health.lastWriteError = null;
  }

  async #rotate() {
    const archiveName = `application-${this.instanceId}-${isoFileTimestamp(this.now())}-${this.rotateSequence += 1}.jsonl`;
    const destination = path.join(this.archiveDir, archiveName);
    try {
      await fsp.rename(this.activeFile, destination);
      await fsp.chmod(destination, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.currentBytes = 0;
    this.activeOpenedAt = this.now();
    await this.#pruneArchive();
    if (this.archiveMode === "push") queueMicrotask(() => void this.syncArchive());
  }

  async #archiveFiles() {
    let names = [];
    try {
      names = await fsp.readdir(this.archiveDir);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const files = [];
    for (const name of names) {
      if (!/^application-[a-zA-Z0-9_-]+-\d+-\d+\.jsonl$/.test(name)) continue;
      const file = path.join(this.archiveDir, name);
      try {
        const stat = await fsp.stat(file);
        if (stat.isFile()) files.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  }

  async #refreshArchiveStatus() {
    const files = await this.#archiveFiles();
    this.health.archivedFiles = files.length;
    this.health.archiveBytes = files.reduce((total, file) => total + file.size, 0);
    return files;
  }

  async #pruneArchive() {
    const files = await this.#refreshArchiveStatus();
    let totalBytes = this.health.archiveBytes;
    while (files.length > this.archiveMaxFiles || totalBytes > this.archiveMaxBytes) {
      const oldest = files.shift();
      if (!oldest) break;
      try {
        await fsp.unlink(oldest.file);
        totalBytes -= oldest.size;
        this.health.archiveDroppedFiles += 1;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    this.health.archivedFiles = files.length;
    this.health.archiveBytes = Math.max(0, totalBytes);
  }

  async #archiveReady() {
    if (!this.externalArchiveDir) throw new Error("LOG_ARCHIVE_DIR is not configured");
    if (this.archiveReadyFile) {
      const ready = await fsp.stat(this.archiveReadyFile);
      if (!ready.isFile()) throw new Error("Archive ready marker is not a file");
    }
    const target = await fsp.stat(this.externalArchiveDir);
    if (!target.isDirectory()) throw new Error("Log archive path is not a directory");
  }

  async #copyToArchive(source, name) {
    const target = path.join(this.externalArchiveDir, name);
    const temporary = path.join(this.externalArchiveDir, `.${name}.${process.pid}.tmp`);
    try {
      await fsp.access(target, fs.constants.F_OK);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fsp.copyFile(source, temporary);
    await fsp.chmod(temporary, 0o600);
    await fsp.rename(temporary, target);
  }

  async #syncPushArchive() {
    await this.#archiveReady();
    const archived = await this.#refreshArchiveStatus();
    this.health.archive.pendingFiles = archived.length;
    for (const file of archived) await this.#copyToArchive(file.file, file.name);
    try {
      const activeStat = await fsp.stat(this.activeFile);
      if (activeStat.size > 0) {
        const activeName = `application-${this.instanceId}-current.jsonl`;
        const temporary = path.join(this.externalArchiveDir, `.${activeName}.${process.pid}.tmp`);
        await fsp.copyFile(this.activeFile, temporary);
        await fsp.chmod(temporary, 0o600);
        await fsp.rename(temporary, path.join(this.externalArchiveDir, activeName));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.health.archive.pendingFiles = 0;
  }

  async #syncPullStatus() {
    if (!this.replicationStateFile) throw new Error("replication state file is not configured");
    const state = JSON.parse(await fsp.readFile(this.replicationStateFile, "utf8"));
    const legacyField = `last${LEGACY_PROVIDER_SEGMENT}LogPullAt`;
    const timestamp = state.lastArchiveLogPullAt ?? state[legacyField];
    const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isFinite(parsed)) throw new Error("Archive pull has not reported a successful log archive yet");
    this.health.archive.lastSuccessAt = new Date(parsed).toISOString();
    if (this.now() - parsed > this.archiveStaleAfterMs) {
      this.health.archive.state = "stale";
      this.health.archive.lastError = "Archive log pull is stale";
      return;
    }
    this.health.archive.state = "healthy";
    this.health.archive.lastError = null;
  }

  async syncArchive() {
    if (!this.enabled || this.archiveMode === "disabled") return;
    if (this.archivePromise) return this.archivePromise;
    this.health.archive.lastAttemptAt = new Date(this.now()).toISOString();
    this.archivePromise = (this.archiveMode === "push" ? this.#syncPushArchive() : this.#syncPullStatus())
      .then(() => {
        if (this.archiveMode === "push") {
          this.health.archive.state = "healthy";
          this.health.archive.lastSuccessAt = new Date(this.now()).toISOString();
          this.health.archive.lastError = null;
        }
      })
      .catch((error) => {
        this.health.archive.state = this.health.archive.lastSuccessAt ? "degraded" : "unavailable";
        this.health.archive.lastError = errorText(error);
      })
      .finally(() => { this.archivePromise = null; });
    return this.archivePromise;
  }

  status() {
    const archiveHealth = { ...this.health.archive };
    archiveHealth.lastError = archiveHealth.lastError ? "archive_sync_failed" : null;
    return {
      enabled: this.enabled,
      level: this.minimumLevel,
      format: "jsonl",
      fileHealthy: this.health.fileHealthy,
      lastWriteAt: this.health.lastWriteAt,
      lastWriteError: this.health.lastWriteError ? "log_write_failed" : null,
      queuedEntries: this.queue.length,
      droppedEntries: this.health.droppedEntries,
      failedWrites: this.health.failedWrites,
      activeBytes: this.currentBytes,
      fileMaxBytes: this.fileMaxBytes,
      archivedFiles: this.health.archivedFiles,
      archiveBytes: this.health.archiveBytes,
      archiveMaxBytes: this.archiveMaxBytes,
      archiveDroppedFiles: this.health.archiveDroppedFiles,
      archive: archiveHealth,
    };
  }

  async close() {
    if (this.closed) return;
    clearInterval(this.flushTimer);
    if (this.archiveTimer) clearInterval(this.archiveTimer);
    await this.flush();
    if (this.archiveMode === "pull" && this.currentBytes > 0) await this.#rotate();
    await this.syncArchive();
    this.closed = true;
  }
}

export function createLoggerFromEnvironment({ dataDir, replicationStateFile, environment } = {}) {
  const logRoot = path.resolve(process.env.LOG_DIR || path.join(dataDir, "logs"));
  const archiveMode = String(process.env.LOG_ARCHIVE_MODE || "disabled").toLowerCase();
  return new StructuredLogger({
    enabled: environmentBoolean(process.env.LOG_ENABLED, true),
    level: process.env.LOG_LEVEL || (environment === "production" ? "info" : "debug"),
    environment,
    release: process.env.APP_RELEASE || "dev",
    instanceId: process.env.INSTANCE_ID,
    hotDir: path.join(logRoot, "hot"),
    archiveDir: path.join(logRoot, "archive-ring"),
    fileMaxBytes: positiveInteger(process.env.LOG_FILE_MAX_BYTES, DEFAULT_FILE_MAX_BYTES),
    archiveMaxBytes: positiveInteger(process.env.LOG_ARCHIVE_MAX_BYTES, DEFAULT_ARCHIVE_MAX_BYTES),
    archiveMaxFiles: positiveInteger(process.env.LOG_ARCHIVE_MAX_FILES, 12),
    rotateIntervalMs: positiveInteger(process.env.LOG_ROTATE_INTERVAL_MS, DEFAULT_ROTATE_INTERVAL_MS),
    queueMaxEntries: positiveInteger(process.env.LOG_QUEUE_MAX_ENTRIES, 5000),
    flushIntervalMs: positiveInteger(process.env.LOG_FLUSH_INTERVAL_MS, 250),
    stdout: environmentBoolean(process.env.LOG_STDOUT, true),
    archiveMode,
    externalArchiveDir: process.env.LOG_ARCHIVE_DIR || null,
    archiveReadyFile: process.env.LOG_ARCHIVE_READY_FILE || null,
    archiveSyncIntervalMs: positiveInteger(process.env.LOG_ARCHIVE_SYNC_INTERVAL_MS, 30_000),
    archiveStaleAfterMs: positiveInteger(process.env.LOG_ARCHIVE_STALE_AFTER_MS, DEFAULT_ARCHIVE_STALE_AFTER_MS),
    replicationStateFile,
  });
}
