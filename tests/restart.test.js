import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { io } from "socket.io-client";

function socketAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // The replacement process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("restart test server did not start");
}

async function register(url, username) {
  const response = await fetch(`${url}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "local-test-password" }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  const setCookie = response.headers.getSetCookie()[0];
  return {
    ...body,
    token: decodeURIComponent(setCookie.match(/fh_session=([^;]+)/)[1]),
  };
}

function startServer({ dataDir, port, url }) {
  return spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: "production",
      COOKIE_SECURE: "false",
      APP_ORIGINS: url,
    },
    stdio: "ignore",
  });
}

function connect(url, token, onRoomState = null) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token },
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Origin: url },
    });
    if (onRoomState) socket.on("room:state", onRoomState);
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

function stopServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server did not stop gracefully")), 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.kill("SIGTERM");
  });
}

test("an in-progress room survives a graceful server replacement", { timeout: 25_000 }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-restart-"));
  const port = 20000 + (process.pid % 1000);
  const url = `http://127.0.0.1:${port}`;
  let server = startServer({ dataDir, port, url });
  let socket;

  try {
    const initialHealth = await waitForServer(url);
    assert.equal(initialHealth.seamlessRestart, true);
    assert.equal(initialHealth.runtime.recoverable, true);
    const host = await register(url, "重启恢复测试玩家");
    let latestState = null;
    socket = await connect(url, host.token, (state) => { latestState = state; });

    const created = await socketAck(socket, "room:create", {
      name: "无感升级测试",
      settings: { maxPlayers: 2, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
    });
    assert.equal(created.ok, true, created.error);
    assert.equal((await socketAck(socket, "room:add-bot")).ok, true);
    assert.equal((await socketAck(socket, "room:ready", { ready: true })).ok, true);
    assert.equal((await socketAck(socket, "room:start")).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const before = latestState;
    assert.ok(before?.game?.handId);
    assert.equal(before.game.stage, "preflop");
    assert.equal(before.game.players.find((player) => player.userId === host.user.id).cards.length, 2);
    const oldToken = before.game.actionToken;
    const oldDeadline = before.game.turnDeadline;

    const activeHealth = await (await fetch(`${url}/api/health`)).json();
    assert.equal(activeHealth.runtime.activeHands, 1);
    assert.equal(activeHealth.runtime.persistenceHealthy, true);
    const stopped = await stopServer(server);
    assert.equal(stopped.code, 0);
    socket.disconnect();

    server = startServer({ dataDir, port, url });
    await waitForServer(url);
    let resolveRestored;
    const restoredState = new Promise((resolve) => { resolveRestored = resolve; });
    socket = await connect(url, host.token, (state) => {
      latestState = state;
      if (state.game?.handId === before.game.handId) resolveRestored(state);
    });
    const after = await Promise.race([
      restoredState,
      new Promise((_, reject) => setTimeout(() => reject(new Error("restored room state was not emitted")), 5000)),
    ]);

    assert.equal(after.code, before.code);
    assert.equal(after.game.handId, before.game.handId);
    assert.equal(after.game.pot, before.game.pot);
    assert.deepEqual(after.game.community, before.game.community);
    assert.deepEqual(
      after.game.players.find((player) => player.userId === host.user.id).cards,
      before.game.players.find((player) => player.userId === host.user.id).cards,
    );
    assert.notEqual(after.game.actionToken, oldToken);
    assert.ok(after.game.turnDeadline > oldDeadline);

    const staleAction = await socketAck(socket, "game:action", {
      action: "call",
      handId: after.game.handId,
      actionToken: oldToken,
    });
    assert.equal(staleAction.ok, false);
    assert.match(staleAction.error, /操作已过期/);

    const resumedAction = await socketAck(socket, "game:action", {
      action: "call",
      handId: after.game.handId,
      actionToken: after.game.actionToken,
    });
    assert.equal(resumedAction.ok, true, resumedAction.error);
  } finally {
    socket?.disconnect();
    if (server && server.exitCode == null && server.signalCode == null) {
      try { await stopServer(server); } catch { server.kill("SIGKILL"); }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
