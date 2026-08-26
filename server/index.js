import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { Store, SESSION_TTL_MS } from "./store.js";
import { RoomManager } from "./rooms.js";
import {
  LOG_DOMAINS,
  createLoggerFromEnvironment,
  socketLogDomain,
} from "./logger.js";
import {
  SESSION_COOKIE,
  FixedWindowRateLimiter,
  auditSecurity,
  booleanEnvironment,
  clientAddress,
  configureSecurityAuditSink,
  createOriginChecker,
  isPlainRecord,
  parseCookies,
  securityHeaders,
} from "./security.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, "..");
const dataDir = process.env.DATA_DIR || path.join(rootDir, "data");
const port = Number(process.env.PORT || 7790);
const environment = process.env.NODE_ENV || "development";
const production = environment === "production";
const secureCookies = booleanEnvironment(process.env.COOKIE_SECURE, production);
const allowNoOrigin = booleanEnvironment(process.env.ALLOW_NO_ORIGIN, false);
const trustProxy = String(process.env.TRUST_PROXY || "loopback")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const configuredOrigins = String(process.env.APP_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const originAllowed = createOriginChecker({
  environment,
  configuredOrigins: configuredOrigins.join(","),
  allowNoOrigin,
});
const handshakeLimiter = new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000 });
const apiLimiter = new FixedWindowRateLimiter({ limit: 240, windowMs: 60_000 });
const loginLimiter = new FixedWindowRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
const loginIpLimiter = new FixedWindowRateLimiter({ limit: 40, windowMs: 15 * 60_000 });
const registerLimiter = new FixedWindowRateLimiter({ limit: 12, windowMs: 60 * 60_000 });
const clientEventLimiter = new FixedWindowRateLimiter({ limit: 60, windowMs: 60_000 });
const replicationStateFile = path.join(dataDir, "replication-state.json");
const logger = createLoggerFromEnvironment({ dataDir, replicationStateFile, environment });
configureSecurityAuditSink((event, details) => {
  const domain = typeof details.event === "string"
    ? socketLogDomain(details.event)
    : event.startsWith("runtime_")
      ? "deploy"
      : "auth";
  logger.warn(domain, event, details);
});
const store = new Store(dataDir, { logger });
const app = express();
const server = http.createServer(app);
const ioOptions = {
  maxHttpBufferSize: 16 * 1024,
  perMessageDeflate: false,
  allowRequest: (request, callback) => {
    const ip = clientAddress(request);
    if (!originAllowed(request)) {
      auditSecurity("socket_origin_rejected", { ip, origin: request.headers.origin });
      callback(null, false);
      return;
    }
    const limit = handshakeLimiter.consume(ip);
    if (!limit.allowed) {
      auditSecurity("socket_handshake_rate_limited", { ip });
      callback(null, false);
      return;
    }
    callback(null, true);
  },
};
if (!production || configuredOrigins.length) {
  ioOptions.cors = {
    origin: configuredOrigins.length
      ? configuredOrigins
      : ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:7790", "http://localhost:7790"],
    credentials: true,
  };
}
const io = new Server(server, ioOptions);
const rooms = new RoomManager(io, store, { audit: auditSecurity, logger });
const activeSocketsByUser = new Map();

app.disable("x-powered-by");
app.set("trust proxy", trustProxy);
app.use(securityHeaders({ production: production && secureCookies }));
app.use((request, response, next) => {
  if (!request.path.startsWith("/api/")) return next();
  const startedAt = Date.now();
  request.requestId = crypto.randomUUID();
  response.setHeader("X-Request-Id", request.requestId);
  response.once("finish", () => {
    const domain = request.path === "/api/health"
      ? "deploy"
      : ["/api/register", "/api/login", "/api/logout", "/api/me"].includes(request.path)
        ? "auth"
        : "lobby";
    const level = request.path === "/api/health"
      ? "debug"
      : response.statusCode >= 500
        ? "error"
        : response.statusCode >= 400
          ? "warn"
          : "info";
    logger.log(level, domain, "http_request_completed", {
      requestId: request.requestId,
      userId: request.user?.id,
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  });
  next();
});
app.use(express.json({ limit: "16kb", strict: true }));
app.use("/api", (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  const limit = apiLimiter.consume(clientAddress(request));
  if (limit.allowed) return next();
  response.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
  auditSecurity("api_rate_limited", { ip: clientAddress(request), path: request.path });
  return response.status(429).json({ error: "请求过于频繁，请稍后重试" });
});

function bearerToken(request) {
  const value = request.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}

function cookieToken(request) {
  return parseCookies(request.get("cookie"))[SESSION_COOKIE] || null;
}

function requestToken(request) {
  const cookie = cookieToken(request);
  return cookie ? { token: cookie, source: "cookie" } : { token: bearerToken(request), source: "bearer" };
}

function sessionCookie(token, remember = true) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secureCookies) parts.push("Secure");
  if (remember) parts.push(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  return parts.join("; ");
}

function clearSessionCookie() {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secureCookies) parts.push("Secure");
  return parts.join("; ");
}

function rateLimit(limiter, keyForRequest, event) {
  return (request, response, next) => {
    const key = keyForRequest(request);
    const limit = limiter.consume(key);
    if (limit.allowed) return next();
    response.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
    auditSecurity(event, { ip: clientAddress(request) });
    return response.status(429).json({ error: "尝试次数过多，请稍后再试" });
  };
}

function requireUser(request, response, next) {
  const { token, source } = requestToken(request);
  const user = store.userForToken(token);
  if (!user) return response.status(401).json({ error: "请先登录" });
  request.user = user;
  request.token = token;
  request.tokenSource = source;
  next();
}

function authResult(request, response, operation, domain = "auth") {
  try {
    response.json(operation());
  } catch (error) {
    logger.warn(domain, "http_operation_rejected", {
      requestId: request.requestId,
      userId: request.user?.id,
      method: request.method,
      path: request.path,
      error,
    });
    response.status(error.status || 400).json({ error: error.message || "操作失败" });
  }
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "friends-holdem",
    seamlessRestart: true,
    runtime: rooms.deploymentStatus(),
    storage: store.storageStatus(),
    logging: logger.status(),
  });
});

app.post("/api/register", rateLimit(registerLimiter, (request) => clientAddress(request), "register_rate_limited"), (request, response) => {
  authResult(request, response, () => {
    const user = store.register(request.body?.username, request.body?.password);
    const session = store.createSession(user.id);
    request.user = session.user;
    response.setHeader("Set-Cookie", sessionCookie(session.token, request.body?.remember !== false));
    return { user: session.user };
  });
});

app.post(
  "/api/login",
  rateLimit(loginIpLimiter, (request) => clientAddress(request), "login_ip_rate_limited"),
  rateLimit(
    loginLimiter,
    (request) => `${clientAddress(request)}:${String(request.body?.username ?? "").trim().toLowerCase().slice(0, 32)}`,
    "login_rate_limited",
  ),
  (request, response) => {
    authResult(request, response, () => {
      const session = store.login(request.body?.username, request.body?.password);
      request.user = session.user;
      response.setHeader("Set-Cookie", sessionCookie(session.token, request.body?.remember !== false));
      return { user: session.user };
    });
  },
);

app.post("/api/logout", requireUser, (request, response) => {
  store.logout(request.token);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.sessionToken === request.token) socket.disconnect(true);
  }
  response.setHeader("Set-Cookie", clearSessionCookie());
  response.json({ ok: true });
});

app.get("/api/me", requireUser, (request, response) => {
  if (request.tokenSource === "bearer" && !cookieToken(request)) {
    response.setHeader("Set-Cookie", sessionCookie(request.token, true));
  }
  response.json({ user: request.user });
});

app.get("/api/history", requireUser, (request, response) => {
  response.json({ history: store.historyFor(request.user.id) });
});

app.get("/api/profile", requireUser, (request, response) => {
  response.json({ profile: store.profileFor(request.user.id) });
});

app.patch("/api/profile", requireUser, (request, response) => {
  authResult(request, response, () => {
    const user = store.updateProfile(request.user.id, request.body);
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.user?.id === user.id) socket.data.user = user;
    }
    rooms.refreshUserProfile(user);
    return { user, profile: store.profileFor(user.id) };
  }, "lobby");
});

app.get("/api/leaderboards/history", requireUser, (_request, response) => {
  response.json({ leaderboard: store.historyLeaderboard() });
});

app.post(
  "/api/client-events",
  requireUser,
  rateLimit(clientEventLimiter, (request) => request.user.id, "client_event_rate_limited"),
  (request, response) => {
    const payload = request.body;
    if (!isPlainRecord(payload)
      || Object.keys(payload).some((key) => ![
        "domain",
        "event",
        "level",
        "requestId",
        "roomCode",
        "handId",
        "context",
      ].includes(key))) {
      return response.status(400).json({ error: "客户端事件格式不正确" });
    }
    const domain = String(payload.domain || "deploy").toLowerCase();
    const event = String(payload.event || "");
    const level = String(payload.level || "info").toLowerCase();
    const context = payload.context == null ? {} : payload.context;
    const allowedContextKeys = new Set([
      "component",
      "phase",
      "reasonCode",
      "viewport",
    ]);
    const allowedDiagnosticEvents = new Set(["ui_runtime_error", "ui_unhandled_rejection"]);
    const allowedReasonCodes = new Set([
      "Error",
      "TypeError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "URIError",
      "EvalError",
      "AggregateError",
      "javascript_error",
      "promise_rejection",
    ]);
    if (!LOG_DOMAINS.includes(domain)
      || domain !== "deploy"
      || !allowedDiagnosticEvents.has(event)
      || level !== "error"
      || !isPlainRecord(context)
      || Object.keys(context).some((key) => !allowedContextKeys.has(key))
      || context.component !== "window"
      || !["visible", "hidden", "prerender"].includes(context.phase)
      || !allowedReasonCodes.has(context.reasonCode)
      || (context.viewport != null && !/^\d{2,5}x\d{2,5}$/.test(context.viewport))
      || (payload.requestId != null && !/^[0-9a-f-]{36}$/i.test(payload.requestId))
      || (payload.roomCode != null && !/^[A-Z2-9]{4}$/.test(payload.roomCode))
      || (payload.handId != null && !/^[0-9a-f-]{36}$/i.test(payload.handId))) {
      return response.status(400).json({ error: "客户端事件格式不正确" });
    }
    logger.log(level, domain, `client:${event}`, {
      requestId: payload.requestId || request.requestId,
      userId: request.user.id,
      roomCode: payload.roomCode || null,
      handId: payload.handId || null,
      source: "browser",
      ...context,
    });
    return response.status(202).json({ ok: true });
  },
);

io.use((socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]
    || socket.handshake.auth?.token;
  const user = store.userForToken(token);
  if (!user) {
    logger.warn("auth", "socket_auth_rejected", { reason: "invalid_session" });
    return next(new Error("请先登录"));
  }
  const activeSockets = activeSocketsByUser.get(user.id);
  if (activeSockets?.size >= 5) {
    auditSecurity("socket_connection_limit", { userId: user.id, ip: socket.handshake.address });
    return next(new Error("当前账号连接数量过多"));
  }
  socket.data.user = user;
  socket.data.sessionToken = token;
  next();
});

io.on("connection", (socket) => {
  const userId = socket.data.user.id;
  logger.info("auth", "socket_connected", { requestId: socket.id, userId });
  const sockets = activeSocketsByUser.get(userId) || new Set();
  sockets.add(socket.id);
  activeSocketsByUser.set(userId, sockets);
  rooms.register(socket);
  socket.on("disconnect", (reason) => {
    sockets.delete(socket.id);
    if (!sockets.size) activeSocketsByUser.delete(userId);
    logger.info("auth", "socket_disconnected", {
      requestId: socket.id,
      userId,
      reason: String(reason || "unknown").slice(0, 80),
    });
  });
});

const distDir = path.join(rootDir, "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, {
    index: false,
    setHeaders(response, filePath) {
      const relativePath = path.relative(distDir, filePath).split(path.sep).join("/");
      if (/^hextech-chaos\/(?:characters|skills)\/.+-\d+\.webp$/.test(relativePath)) {
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
    response.sendFile(path.join(distDir, "index.html"));
  });
}

app.use("/api", (_request, response) => response.status(404).json({ error: "接口不存在" }));

app.use((error, request, response, _next) => {
  if (error?.type === "entity.too.large") {
    return response.status(413).json({ error: "请求内容过大" });
  }
  if (error instanceof SyntaxError && "body" in error) {
    return response.status(400).json({ error: "请求格式不正确" });
  }
  logger.error("deploy", "http_request_failed", error, {
    requestId: request.requestId,
    userId: request.user?.id,
    method: request.method,
    path: request.path,
  });
  return response.status(500).json({ error: "服务器暂时无法处理请求" });
});

server.listen(port, "0.0.0.0", () => {
  logger.info("deploy", "server_started", { port, seamlessRestart: true });
  queueMicrotask(() => void logger.syncArchive());
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("deploy", "shutdown_started", { signal });
  try {
    rooms.shutdown();
  } catch (error) {
    logger.fatal("deploy", "runtime_checkpoint_failed_during_shutdown", error, { signal });
    await logger.close();
    process.exit(1);
    return;
  }
  const forceExit = setTimeout(() => process.exit(1), 8_000);
  forceExit.unref();
  io.close(async () => {
    clearTimeout(forceExit);
    logger.info("deploy", "shutdown_completed", { signal });
    await logger.close();
    process.exit(0);
  });
}

process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("uncaughtExceptionMonitor", (error, origin) => {
  logger.fatal("deploy", "uncaught_exception", error, { origin });
});
