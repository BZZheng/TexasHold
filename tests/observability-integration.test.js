import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { io } from "socket.io-client";

async function waitForServer(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("observability integration server did not start");
}

function connect(url, cookie) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Cookie: cookie, Origin: url },
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function socketAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function jsonlRecords(root) {
  const records = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of readFileSync(target, "utf8").split("\n")) {
          if (line.trim()) records.push(JSON.parse(line));
        }
      }
    }
  }
  visit(root);
  return records;
}

test("HTTP, browser diagnostics, and socket operations share request IDs in persisted structured logs", { timeout: 15000 }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-observability-"));
  const port = 21000 + (process.pid % 2000);
  const url = `http://127.0.0.1:${port}`;
  const password = "never-log-this-password-2026";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: "production",
      COOKIE_SECURE: "false",
      APP_ORIGINS: url,
      LOG_STDOUT: "false",
      LOG_FLUSH_INTERVAL_MS: "20",
      LOG_ARCHIVE_MODE: "disabled",
      APP_RELEASE: "observability-test",
    },
    stdio: "ignore",
  });
  let socket;
  try {
    const health = await waitForServer(url);
    assert.equal(health.logging.format, "jsonl");
    assert.equal(health.logging.fileHealthy, true);

    const registered = await fetch(`${url}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "日志集成测试", password }),
    });
    assert.equal(registered.ok, true);
    assert.match(registered.headers.get("x-request-id") || "", /^[0-9a-f-]{36}$/);
    const cookie = (registered.headers.get("set-cookie") || "").split(";", 1)[0];
    assert.match(cookie, /^fh_session=/);

    const clientEvent = await fetch(`${url}/api/client-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        domain: "deploy",
        event: "ui_runtime_error",
        level: "error",
        context: { component: "window", phase: "visible", reasonCode: "TypeError", viewport: "1920x1080" },
      }),
    });
    assert.equal(clientEvent.status, 202);
    const unsafeClientEvent = await fetch(`${url}/api/client-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        domain: "deploy",
        event: "ui_runtime_error",
        level: "error",
        context: { component: "window", phase: "visible", reasonCode: password },
      }),
    });
    assert.equal(unsafeClientEvent.status, 400);

    socket = await connect(url, cookie);
    const lobby = await socketAck(socket, "lobby:list");
    assert.equal(lobby.ok, true);
    assert.match(lobby.requestId || "", /^[0-9a-f-]{36}$/);
    socket.disconnect();
    socket = null;

    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    socket?.disconnect();
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        timeout.unref();
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }

  try {
    const records = jsonlRecords(path.join(dataDir, "logs"));
    assert.ok(records.some((record) => record.domain === "deploy" && record.event === "server_started"));
    assert.ok(records.some((record) => record.domain === "auth" && record.event === "http_request_completed"));
    assert.ok(records.some((record) => record.domain === "lobby" && record.event === "socket_operation_succeeded"));
    assert.ok(records.some((record) => record.domain === "deploy" && record.event === "client:ui_runtime_error"));
    assert.ok(records.every((record) => typeof record.eventId === "string"));
    const persisted = JSON.stringify(records);
    assert.equal(persisted.includes(password), false);
    assert.equal(/fh_session=[A-Za-z0-9._~-]+/.test(persisted), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
