const CLIENT_EVENT_PATH = "/api/client-events";
const ALLOWED_CONTEXT_KEYS = new Set([
  "component",
  "phase",
  "reasonCode",
  "viewport",
]);
const ALLOWED_REASON_CODES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
]);
const recentEvents = new Map();

function safeContext(context = {}) {
  return Object.fromEntries(
    Object.entries(context)
      .filter(([key, value]) => ALLOWED_CONTEXT_KEYS.has(key)
        && ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 160) : value]),
  );
}

function recentlySent(key) {
  const now = Date.now();
  const previous = recentEvents.get(key) || 0;
  recentEvents.set(key, now);
  for (const [candidate, timestamp] of recentEvents) {
    if (now - timestamp > 60_000) recentEvents.delete(candidate);
  }
  return now - previous < 5_000;
}

export function trackClientEvent(event, {
  domain = "deploy",
  level = "info",
  requestId = null,
  roomCode = null,
  handId = null,
  context = {},
} = {}) {
  const safeEvent = String(event || "").toLowerCase();
  if (!/^[a-z0-9:_-]{1,64}$/.test(safeEvent)) return;
  const sanitizedContext = safeContext(context);
  const dedupeKey = `${domain}:${safeEvent}:${sanitizedContext.component || "app"}:${sanitizedContext.reasonCode || "none"}`;
  if (recentlySent(dedupeKey)) return;
  void fetch(CLIENT_EVENT_PATH, {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      domain,
      event: safeEvent,
      level,
      requestId,
      roomCode,
      handId,
      context: {
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        ...sanitizedContext,
      },
    }),
  }).catch(() => {
    // Browser diagnostics are best-effort and must never affect game input.
  });
}

export function installClientDiagnostics() {
  window.addEventListener("error", (event) => {
    trackClientEvent("ui_runtime_error", {
      level: "error",
      context: {
        component: "window",
        phase: document.visibilityState,
        reasonCode: ALLOWED_REASON_CODES.has(event.error?.name) ? event.error.name : "javascript_error",
      },
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    trackClientEvent("ui_unhandled_rejection", {
      level: "error",
      context: {
        component: "window",
        phase: document.visibilityState,
        reasonCode: ALLOWED_REASON_CODES.has(event.reason?.name) ? event.reason.name : "promise_rejection",
      },
    });
  });
}
