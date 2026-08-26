import crypto from "node:crypto";

export const SESSION_COOKIE = "fh_session";

export class SecurityError extends Error {
  constructor(message, code = "invalid_request", status = 400) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
    this.status = status;
  }
}

export class FixedWindowRateLimiter {
  constructor({ limit, windowMs, maxKeys = 5000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.entries = new Map();
  }

  consume(key, now = Date.now()) {
    let entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }

    if (entry.count >= this.limit) {
      return { allowed: false, retryAfterMs: Math.max(1, entry.resetAt - now) };
    }

    entry.count += 1;
    if (this.entries.size > this.maxKeys) this.#prune(now);
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterMs: Math.max(1, entry.resetAt - now),
    };
  }

  #prune(now) {
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }
    while (this.entries.size > this.maxKeys) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }
}

export function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function authorizePayload(value, allowedKeys, message = "请求包含未授权字段") {
  const payload = value == null ? {} : value;
  if (!isPlainRecord(payload)) throw new SecurityError("请求格式不正确", "invalid_payload");
  const allowed = new Set(allowedKeys);
  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    throw new SecurityError(message, "forbidden_payload_field");
  }
  return payload;
}

export function tokenDigest(token) {
  return crypto.createHash("sha256").update(String(token ?? ""), "utf8").digest("base64url");
}

export function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
}

export function booleanEnvironment(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function normalizedOrigin(value) {
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createOriginChecker({ environment, configuredOrigins = "", allowNoOrigin = false }) {
  const explicitOrigins = String(configuredOrigins)
    .split(",")
    .map((value) => normalizedOrigin(value.trim()))
    .filter(Boolean);
  const developmentOrigins = new Set([
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:7790",
    "http://localhost:7790",
  ]);

  return (request) => {
    const origin = normalizedOrigin(request.headers.origin);
    if (!request.headers.origin) return environment === "test" || allowNoOrigin;
    if (!origin) return false;
    if (explicitOrigins.length) return explicitOrigins.includes(origin);
    if (environment !== "production" && developmentOrigins.has(origin)) return true;

    const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
    const requestHost = forwardedHost || String(request.headers.host ?? "").trim();
    return Boolean(requestHost) && new URL(origin).host === requestHost;
  };
}

export function clientAddress(request) {
  if (request.ip) return request.ip;
  const remote = request.socket?.remoteAddress || "unknown";
  const forwarded = String(request.headers?.["x-forwarded-for"] ?? "").split(",")[0].trim();
  const trustedLocalProxy = remote === "127.0.0.1"
    || remote === "::1"
    || remote === "::ffff:127.0.0.1"
    || remote.startsWith("172.")
    || remote.startsWith("10.")
    || remote.startsWith("192.168.");
  return trustedLocalProxy && forwarded ? forwarded : remote;
}

let securityAuditSink = null;

export function configureSecurityAuditSink(sink) {
  securityAuditSink = typeof sink === "function" ? sink : null;
}

export function auditSecurity(event, details = {}) {
  const safeDetails = Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value).slice(0, 160)]),
  );
  if (securityAuditSink) {
    try {
      securityAuditSink(event, safeDetails);
      return;
    } catch {
      // The security control must continue even if its observability sink is unavailable.
    }
  }
  console.warn(JSON.stringify({ level: "warn", type: "security", event, at: new Date().toISOString(), ...safeDetails }));
}

export function securityHeaders({ production = false } = {}) {
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join("; ");

  return (_request, response, next) => {
    response.setHeader("Content-Security-Policy", policy);
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    if (production) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}
