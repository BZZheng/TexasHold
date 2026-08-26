import { io } from "socket.io-client";

const TOKEN_KEY = "friends-holdem-token";

export function getLegacyToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
}

export function clearLegacyToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function api(path, options = {}) {
  const legacyToken = getLegacyToken();
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(legacyToken ? { Authorization: `Bearer ${legacyToken}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "请求失败");
    error.requestId = response.headers.get("x-request-id") || null;
    throw error;
  }
  return body;
}

export function connectSocket() {
  return io({ transports: ["websocket", "polling"] });
}

export async function emit(socket, event, payload = {}) {
  if (!socket) throw new Error("服务器连接尚未建立");
  if (!socket.connected) {
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        socket.off("connect", onConnect);
        reject(new Error("无法连接到服务器"));
      }, 8000);
      function onConnect() {
        window.clearTimeout(timeout);
        resolve();
      }
      socket.once("connect", onConnect);
    });
  }
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (error, result) => {
      if (error) reject(new Error("服务器响应超时"));
      else if (!result?.ok) {
        const operationError = new Error(result?.error || "操作失败");
        operationError.requestId = result?.requestId || null;
        reject(operationError);
      }
      else resolve(result);
    });
  });
}
