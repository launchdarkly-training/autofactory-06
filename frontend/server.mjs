/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The backend-status line on the page is gated by the string multivariate flag
 * "enable-backend-status": "control" renders the page exactly as it was before
 * the feature landed, "v1" adds the line and its fetch.
 */

import express from "express";
import { pathToFileURL } from "node:url";
import { init } from "@launchdarkly/node-server-sdk";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export const BACKEND_STATUS_FLAG = "enable-backend-status";
export const BACKEND_STATUS_BEACON_PATH = "/api/telemetry/backend-status";

/** Matches the backend's context convention (backend/app.py `_ld_context`). */
const LD_CONTEXT = { kind: "user", key: "demo-user" };

/** An implausible render duration is a bug or a clock skew, not a measurement. */
const MAX_PLAUSIBLE_RENDER_MS = 60_000;

/**
 * Resolve the flag to a variation value. Never throws: an unreachable or
 * absent LaunchDarkly degrades to "control", the existing-behavior path.
 */
async function backendStatusVariation(ldClient) {
  if (!ldClient) return "control";
  try {
    const value = await ldClient.variation(BACKEND_STATUS_FLAG, LD_CONTEXT, "control");
    return typeof value === "string" ? value : "control";
  } catch {
    return "control";
  }
}

/** Telemetry must never be able to fail a request. */
function emit(ldClient, eventKey, metricValue) {
  if (!ldClient) return;
  try {
    ldClient.track(eventKey, LD_CONTEXT, undefined, metricValue);
  } catch {
    /* swallowed on purpose */
  }
}

const BACKEND_STATUS_PARAGRAPH = `
  <p id="backend-status">Checking backend status…</p>`;

const BACKEND_STATUS_SCRIPT = `
    fetch("${BACKEND_URL}/api/status")
      .then(r => r.json())
      .then(d => { document.getElementById("backend-status").textContent =
        "Backend online: " + d.service + " version " + d.version;
        navigator.sendBeacon("${BACKEND_STATUS_BEACON_PATH}", JSON.stringify({ outcome: "ok" })); })
      .catch(() => { document.getElementById("backend-status").textContent = "Backend offline";
        navigator.sendBeacon("${BACKEND_STATUS_BEACON_PATH}", JSON.stringify({ outcome: "error" })); });`;

function renderPage({ showBackendStatus }) {
  const paragraph = showBackendStatus ? BACKEND_STATUS_PARAGRAPH : "";
  const script = showBackendStatus ? BACKEND_STATUS_SCRIPT : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>${paragraph}
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });${script}
  </script>
</body></html>`;
}

export function createApp({ ldClient = null } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", async (_req, res) => {
    const startedAt = Date.now();
    const variation = await backendStatusVariation(ldClient);
    res.type("html").send(renderPage({ showBackendStatus: variation === "v1" }));

    // Emitted on BOTH variations so the guarded release has a real comparison.
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 0 && elapsedMs <= MAX_PLAUSIBLE_RENDER_MS) {
      emit(ldClient, "enable-backend-status-latency", elapsedMs);
    }
  });

  // navigator.sendBeacon posts a Blob with an arbitrary content type, so take
  // the body as text and parse it here rather than letting express.json 400.
  app.post(
    BACKEND_STATUS_BEACON_PATH,
    express.text({ type: "*/*", limit: "1kb" }),
    (req, res) => {
      res.status(204).end();

      let body;
      try {
        body = JSON.parse(req.body);
      } catch {
        return;
      }
      if (!body || typeof body !== "object") return;

      if (body.outcome === "ok") {
        emit(ldClient, "enable-backend-status-success");
      } else if (body.outcome === "error") {
        emit(ldClient, "enable-backend-status-error");
      }
    },
  );

  return app;
}

/** Returns an initialized client, or null when LD is unconfigured/unreachable. */
export async function initLdClient() {
  const sdkKey = process.env.LD_SDK_KEY;
  if (!sdkKey) return null;
  const client = init(sdkKey);
  try {
    await client.waitForInitialization({ timeout: 5 });
    return client;
  } catch {
    await client.close();
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ldClient = await initLdClient();
  const port = process.env.PORT || 3000;
  createApp({ ldClient }).listen(port, () => console.log(`demo-frontend on :${port}`));
}
