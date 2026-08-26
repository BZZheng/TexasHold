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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("integration server did not start");
}

async function register(url, username) {
  const response = await fetch(`${url}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "local-test-password" }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  assert.equal(body.token, undefined);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const setCookie = response.headers.getSetCookie()[0];
  assert.match(setCookie, /fh_session=.*HttpOnly.*SameSite=Strict/i);
  const token = decodeURIComponent(setCookie.match(/fh_session=([^;]+)/)[1]);
  return { ...body, token };
}

function connect(url, token, origin = url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token },
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Origin: origin },
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

test("a spectator sees one authorized live hand, never the mystery hand, and can queue for the next hand", { timeout: 15000 }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "friends-holdem-test-"));
  const port = 18000 + (process.pid % 1000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.js"], {
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
  let hostSocket;
  let spectatorSocket;
  let leaverSocket;

  try {
    await waitForServer(url);
    const host = await register(url, "集成测试房主");
    const spectator = await register(url, "集成测试观战者");
    const leaver = await register(url, "集成测试临时观战者");
    await assert.rejects(connect(url, host.token, "https://evil.example"));
    hostSocket = await connect(url, host.token);
    let latestHostState = null;
    hostSocket.on("room:state", (state) => { latestHostState = state; });
    spectatorSocket = await connect(url, spectator.token);
    leaverSocket = await connect(url, leaver.token);

    const created = await socketAck(hostSocket, "room:create", {
      name: "观战规则测试",
      settings: { maxPlayers: 3, initialChips: 2000, smallBlind: 5, bigBlind: 10 },
    });
    assert.equal(created.ok, true);
    const botAdded = await socketAck(hostSocket, "room:add-bot");
    assert.equal(botAdded.ok, true, botAdded.error);
    const hostReady = await socketAck(hostSocket, "room:ready", { ready: true });
    assert.equal(hostReady.ok, true, hostReady.error);
    const started = await socketAck(hostSocket, "room:start");
    assert.equal(started.ok, true, started.error);
    assert.equal(latestHostState.game.timeExtension.cost, 500);
    assert.equal(latestHostState.game.timeExtension.seconds, 60);
    const deadlineBeforeExtension = latestHostState.game.turnDeadline;
    const stackBeforeExtension = latestHostState.game.players
      .find((player) => player.userId === host.user.id).stack;

    const forgedExtension = await socketAck(hostSocket, "game:time-extension", {
      handId: latestHostState.game.handId,
      actionToken: latestHostState.game.actionToken,
      cost: 0,
    });
    assert.equal(forgedExtension.ok, false);
    assert.match(forgedExtension.error, /客户端无权提交或修改加时状态/);

    const boughtExtension = await socketAck(hostSocket, "game:time-extension", {
      handId: latestHostState.game.handId,
      actionToken: latestHostState.game.actionToken,
    });
    assert.equal(boughtExtension.ok, true, boughtExtension.error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(latestHostState.game.turnDeadline, deadlineBeforeExtension + 60_000);
    assert.equal(latestHostState.game.timeExtension.used, true);
    assert.equal(
      latestHostState.game.players.find((player) => player.userId === host.user.id).stack,
      stackBeforeExtension - 500,
    );

    const replayedExtension = await socketAck(hostSocket, "game:time-extension", {
      handId: latestHostState.game.handId,
      actionToken: latestHostState.game.actionToken,
    });
    assert.equal(replayedExtension.ok, false);
    assert.match(replayedExtension.error, /本回合已经使用过加时卡/);

    const lobby = await socketAck(spectatorSocket, "lobby:list");
    assert.ok(lobby.rooms.some((room) => room.code === created.room.code));
    assert.equal(lobby.leaderboard.length, 3);
    assert.equal(lobby.leaderboard.some((entry) => entry.username.startsWith("测试玩家")), false);
    assert.equal(
      lobby.leaderboard.find((entry) => entry.userId === host.user.id).score,
      latestHostState.game.players.find((player) => player.userId === host.user.id).stack,
    );
    assert.equal(lobby.leaderboard.find((entry) => entry.userId === spectator.user.id).status, "大厅");

    const joined = await socketAck(spectatorSocket, "room:join", {
      code: created.room.code,
      mode: "spectator",
    });
    assert.equal(joined.ok, true);
    assert.equal(joined.room.self.role, "spectator");
    const initiallyWatched = joined.room.game.players.filter((player) => player.cards.length === 2);
    assert.equal(initiallyWatched.length, 1);
    assert.equal(initiallyWatched[0].userId, joined.room.game.spectatorView.focusUserId);
    assert.notEqual(initiallyWatched[0].userId, joined.room.game.spectatorView.mysteryUserId);
    assert.equal(
      joined.room.game.players.find((player) => player.userId === joined.room.game.spectatorView.mysteryUserId).cards.length,
      0,
    );

    const spectatorExtension = await socketAck(spectatorSocket, "game:time-extension", {
      handId: latestHostState.game.handId,
      actionToken: latestHostState.game.actionToken,
    });
    assert.equal(spectatorExtension.ok, false);
    assert.match(spectatorExtension.error, /观战者不能购买加时/);

    const leavingSpectator = await socketAck(leaverSocket, "room:join", {
      code: created.room.code,
      mode: "spectator",
    });
    assert.equal(leavingSpectator.ok, true);
    assert.equal((await socketAck(leaverSocket, "room:leave")).ok, true);

    assert.equal((await socketAck(spectatorSocket, "room:request-seat", { seat: 2 })).ok, true);
    const duringHandApproval = await socketAck(hostSocket, "room:approve-seat", {
      userId: spectator.user.id,
    });
    assert.equal(duringHandApproval.ok, false);

    const folded = await socketAck(hostSocket, "game:action", {
      action: "fold",
      handId: latestHostState.game.handId,
      actionToken: latestHostState.game.actionToken,
    });
    assert.equal(folded.ok, true, folded.error);
    const nextStatePromise = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      spectatorSocket.on("room:state", (state) => {
        if (state.self.role === "player") {
          clearTimeout(timeout);
          resolve(state);
        }
      });
    });
    assert.equal((await socketAck(hostSocket, "room:approve-seat", { userId: spectator.user.id })).ok, true);
    const nextState = await nextStatePromise;
    assert.equal(nextState?.self.role, "player");
    assert.equal(nextState?.self.seat, 2);

    const reminderPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 2000);
      spectatorSocket.once("room:ready-reminder", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });
    const blockedStart = await socketAck(hostSocket, "room:start");
    assert.equal(blockedStart.ok, false);
    assert.match(blockedStart.error, /集成测试观战者.*尚未准备/);
    const reminder = await reminderPromise;
    assert.match(reminder?.message ?? "", /等待你准备/);

    assert.equal((await socketAck(spectatorSocket, "room:ready", { ready: true })).ok, true);
    const nextHand = await socketAck(hostSocket, "room:start");
    assert.equal(nextHand.ok, true, nextHand.error);
  } finally {
    hostSocket?.disconnect();
    spectatorSocket?.disconnect();
    leaverSocket?.disconnect();
    if (child.exitCode == null && child.signalCode == null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
