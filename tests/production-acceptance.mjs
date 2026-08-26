import assert from "node:assert/strict";
import crypto from "node:crypto";
import { io } from "socket.io-client";

const baseUrl = String(process.env.ACCEPTANCE_URL || "").replace(/\/$/, "");
assert.match(baseUrl, /^https?:\/\//, "ACCEPTANCE_URL must be an HTTP(S) origin");
const expectsSecureCookie = baseUrl.startsWith("https://");

function socketAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function waitUntil(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function register(username, password) {
  const response = await fetch(`${baseUrl}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  assert.equal(body.token, undefined, "raw tokens must not appear in JSON");
  const setCookie = response.headers.getSetCookie()[0];
  assert.match(setCookie, /^fh_session=/i);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  if (expectsSecureCookie) assert.match(setCookie, /Secure/i);
  else assert.doesNotMatch(setCookie, /Secure/i);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  return { user: body.user, cookie: setCookie.split(";", 1)[0] };
}

function connect(cookie, origin = baseUrl) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      timeout: 5000,
      extraHeaders: { Cookie: cookie, Origin: origin },
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

const suffix = Date.now().toString(36).slice(-6);
const password = `Qa-${crypto.randomBytes(18).toString("base64url")}`;
let hostSocket;
let spectatorSocket;

try {
  const health = await fetch(`${baseUrl}/api/health`);
  const healthBody = await health.json();
  assert.equal(health.ok, true);
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.service, "friends-holdem");
  assert.equal(healthBody.logging?.format, "jsonl");
  assert.equal(healthBody.logging?.fileHealthy, true);

  const host = await register(`验收房主${suffix}`, password);
  const spectator = await register(`验收观众${suffix}`, password);

  const me = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: host.cookie } });
  assert.equal(me.ok, true);
  assert.equal((await me.json()).user.id, host.user.id);

  await assert.rejects(connect(host.cookie, "https://evil.example"));
  hostSocket = await connect(host.cookie);
  spectatorSocket = await connect(spectator.cookie);

  let latestHostState = null;
  hostSocket.on("room:state", (state) => { latestHostState = state; });

  const created = await socketAck(hostSocket, "room:create", {
    name: "生产上线验收",
    settings: {
      maxPlayers: 8,
      initialChips: 2000,
      smallBlind: 5,
      bigBlind: 10,
      allowRebuy: true,
      rebuyAmount: 2000,
      maxRebuys: 3,
    },
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.room.settings.maxPlayers, 8);
  assert.equal(created.room.settings.smallBlind, 5);
  assert.equal(created.room.settings.bigBlind, 10);

  for (let index = 0; index < 7; index += 1) {
    const added = await socketAck(hostSocket, "room:add-bot");
    assert.equal(added.ok, true, added.error);
  }
  assert.equal((await socketAck(hostSocket, "room:ready", { ready: true })).ok, true);
  const started = await socketAck(hostSocket, "room:start");
  assert.equal(started.ok, true, started.error);

  const dealt = await waitUntil(
    () => latestHostState?.game?.players?.length === 8 && latestHostState,
    "eight-player hand was not dealt",
  );
  const hostPlayer = dealt.game.players.find((player) => player.userId === host.user.id);
  assert.equal(hostPlayer.cards.length, 2, "host must receive exactly two private cards");
  assert.ok(
    dealt.game.players.filter((player) => player.userId !== host.user.id).every((player) => player.cards.length === 0),
    "a player must not receive opponents' cards",
  );

  const joined = await socketAck(spectatorSocket, "room:join", {
    code: created.room.code,
    mode: "player",
  });
  assert.equal(joined.ok, true, joined.error);
  assert.equal(joined.room.self.role, "spectator", "forged player mode must remain spectator");
  assert.equal(joined.room.game.players.length, 8);
  const initiallyWatched = joined.room.game.players.filter((player) => player.cards.length === 2);
  assert.equal(initiallyWatched.length, 1, "a spectator receives exactly one authorized watched hand");
  assert.equal(initiallyWatched[0].userId, joined.room.game.spectatorView.focusUserId);
  assert.notEqual(initiallyWatched[0].userId, joined.room.game.spectatorView.mysteryUserId);
  assert.equal(
    joined.room.game.players.find((player) => player.userId === joined.room.game.spectatorView.mysteryUserId).cards.length,
    0,
    "the mystery hand must stay hidden",
  );
  assert.equal(joined.room.game.actionToken, null);

  const forged = await socketAck(hostSocket, "game:action", {
    action: "fold",
    handId: dealt.game.handId,
    actionToken: dealt.game.actionToken || "forged",
    cards: ["As", "Ah"],
    stack: 999999,
  });
  assert.equal(forged.ok, false);
  assert.match(forged.error, /无权提交|修改牌局状态/);

  const spectatorAction = await socketAck(spectatorSocket, "game:action", {
    action: "fold",
    handId: joined.room.game.handId,
    actionToken: "forged",
  });
  assert.equal(spectatorAction.ok, false);
  assert.match(spectatorAction.error, /观战者不能操作/);

  const lobby = await socketAck(spectatorSocket, "lobby:list");
  const publicRoom = lobby.rooms.find((room) => room.code === created.room.code);
  assert.equal(publicRoom.playerCount, 8);
  assert.equal(publicRoom.spectatorCount, 1);

  assert.equal((await socketAck(spectatorSocket, "chat:send", { text: "上线验收" })).ok, true);

  console.log(JSON.stringify({
    ok: true,
    https: expectsSecureCookie,
    secureCookie: expectsSecureCookie,
    websocket: true,
    originGuard: true,
    playerCount: 8,
    spectatorCardsVisible: 0,
    blinds: "5/10",
    initialChips: 2000,
    forgedStateRejected: true,
  }));
} finally {
  hostSocket?.disconnect();
  spectatorSocket?.disconnect();
}
