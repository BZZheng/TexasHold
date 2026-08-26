import assert from "node:assert/strict";
import crypto from "node:crypto";
import { io } from "socket.io-client";

const baseUrl = String(process.env.ACCEPTANCE_URL || "").replace(/\/$/, "");
assert.match(baseUrl, /^https?:\/\//, "ACCEPTANCE_URL must be an HTTP(S) origin");

function socketAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result));
  });
}

async function register(username, password) {
  const response = await fetch(`${baseUrl}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  return response.headers.getSetCookie()[0].split(";", 1)[0];
}

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      timeout: 5000,
      extraHeaders: { Cookie: cookie, Origin: baseUrl },
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

const suffix = Date.now().toString(36).slice(-6);
const accountPassword = `Qa-${crypto.randomBytes(18).toString("base64url")}`;
const roomPassword = `房间-${crypto.randomBytes(4).toString("hex")}`;
let hostSocket;
let guestSocket;

try {
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.ok, true);
  assert.equal(health.ok, true);
  assert.equal(health.runtime.recoverable, true);
  assert.equal(health.runtime.persistenceHealthy, true);
  assert.equal(health.storage.mode, "local-hot-archive-ring");
  assert.equal(health.storage.acceptsNewRooms, true);
  assert.equal("hotDir" in health.storage, false);
  assert.equal("dataDir" in health.storage, false);
  assert.equal("path" in health.storage, false);
  assert.equal(health.logging.format, "jsonl");
  assert.equal(health.logging.fileHealthy, true);

  const hostCookie = await register(`验收房主${suffix}`, accountPassword);
  const guestCookie = await register(`验收房客${suffix}`, accountPassword);
  hostSocket = await connect(hostCookie);
  guestSocket = await connect(guestCookie);

  const created = await socketAck(hostSocket, "room:create", {
    name: "生产密码房验收",
    settings: {
      maxPlayers: 8,
      initialChips: 2000,
      smallBlind: 5,
      bigBlind: 10,
      password: `  ${roomPassword}  `,
    },
  });
  assert.equal(created.ok, true, created.error);

  const wrong = await socketAck(guestSocket, "room:join", { code: created.room.code, password: "wrong" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /房间密码不正确/);

  const joined = await socketAck(guestSocket, "room:join", {
    code: ` ${created.room.code.toLowerCase()} `,
    password: `  ${roomPassword}  `,
    mode: "player",
  });
  assert.equal(joined.ok, true, joined.error);
  assert.equal(joined.room.self.role, "spectator");
  assert.equal(joined.room.settings.maxPlayers, 8);
  assert.equal(joined.room.settings.smallBlind, 5);
  assert.equal(joined.room.settings.bigBlind, 10);
  assert.equal((await socketAck(guestSocket, "chat:send", { text: "密码房上线验收" })).ok, true);

  assert.equal((await socketAck(guestSocket, "room:leave")).ok, true);
  assert.equal((await socketAck(hostSocket, "room:leave")).ok, true);

  console.log(JSON.stringify({
    ok: true,
    publicUrl: baseUrl,
    websocket: true,
    passwordRoom: true,
    normalizedRoomCodeAndPassword: true,
    storageMode: health.storage.mode,
  }));
} finally {
  hostSocket?.disconnect();
  guestSocket?.disconnect();
}
