/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The "Refresh greeting" button is gated by the LaunchDarkly flag
 * `shift2-enable-greeting-refresh`: `control` renders the original page,
 * `v1` renders the page with the refresh control.
 */

import express from "express";
import { init } from "@launchdarkly/node-server-sdk";
import { pathToFileURL } from "node:url";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export const FLAG_KEY = "shift2-enable-greeting-refresh";
export const CONTROL = "control";
export const TELEMETRY_PATH = "/internal/greeting-refresh-telemetry";

/** The evaluation context, matching the backend's `demo-user` convention. */
export function ldContext() {
  return { kind: "user", key: "demo-user" };
}

/**
 * Resolve the flag's string variation. Fails safe to `control` whenever the
 * client is absent, the SDK throws, or the value is not one of our strings.
 */
export async function resolveVariation(ldClient) {
  if (!ldClient) return CONTROL;
  try {
    const value = await ldClient.variation(FLAG_KEY, ldContext(), CONTROL);
    return typeof value === "string" ? value : CONTROL;
  } catch {
    return CONTROL;
  }
}

/** Guarded-release telemetry must never be able to fail a request. */
function track(ldClient, eventKey, metricValue) {
  if (!ldClient) return;
  try {
    ldClient.track(eventKey, ldContext(), undefined, metricValue);
  } catch {
    /* telemetry is best-effort */
  }
}

function controlPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });
  </script>
</body></html>`;
}

function refreshPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>
  <button id="refresh" type="button">Refresh greeting</button>
  <script>
    function report(outcome) {
      try {
        navigator.sendBeacon("${TELEMETRY_PATH}", JSON.stringify({ outcome: outcome }));
      } catch (e) {}
    }
    function loadGreeting() {
      document.getElementById("greeting").textContent = "Loading greeting from backend…";
      fetch("${BACKEND_URL}/api/greeting")
        .then(r => r.json())
        .then(d => { document.getElementById("greeting").textContent =
          d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; report("success"); })
        .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; report("error"); });
    }
    loadGreeting();
    document.getElementById("refresh").addEventListener("click", loadGreeting);
  </script>
</body></html>`;
}

export function renderPage(variation) {
  return variation === "v1" ? refreshPage() : controlPage();
}

export function createApp({ ldClient = null } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", async (_req, res) => {
    const startedAt = Date.now();
    const variation = await resolveVariation(ldClient);
    res.type("html").send(renderPage(variation));
    // Emitted on BOTH variations so the guarded release has a real comparison.
    track(ldClient, "shift2-enable-greeting-refresh-latency", Date.now() - startedAt);
  });

  // sendBeacon posts a Blob, so parse the body as text and never 400 on junk.
  app.post(
    TELEMETRY_PATH,
    express.text({ type: "*/*", limit: "1kb" }),
    (req, res) => {
      res.status(204).end();
      let outcome;
      try {
        outcome = JSON.parse(req.body)?.outcome;
      } catch {
        return;
      }
      if (outcome === "success") {
        track(ldClient, "shift2-enable-greeting-refresh-success");
      } else if (outcome === "error") {
        track(ldClient, "shift2-enable-greeting-refresh-error");
      }
    },
  );

  return app;
}

/** Initialize the LaunchDarkly client, or return null when it is unavailable. */
export async function initLdClient(sdkKey = process.env.LD_SDK_KEY) {
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
  createApp({ ldClient }).listen(port, () =>
    console.log(`demo-frontend on :${port}`),
  );
}
