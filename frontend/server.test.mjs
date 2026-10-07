import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { createApp, BACKEND_STATUS_FLAG, BACKEND_STATUS_BEACON_PATH } from "./server.mjs";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

/**
 * The page exactly as it rendered before the backend-status feature landed.
 * The control variation must reproduce this byte for byte.
 */
const PRE_FEATURE_PAGE = `<!doctype html>
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

/** Records every track() call so tests can assert on event keys and values. */
function stubClient(variationValue) {
  const tracked = [];
  return {
    tracked,
    variation: async () => {
      if (variationValue instanceof Error) throw variationValue;
      return variationValue;
    },
    track: (key, _ctx, _data, value) => tracked.push({ key, value }),
  };
}

async function withServer(ldClient, fn) {
  const server = createApp({ ldClient }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const getPage = (ldClient) => withServer(ldClient, async (base) => (await fetch(`${base}/`)).text());

const postBeacon = (ldClient, body) =>
  withServer(ldClient, async (base) => {
    const res = await fetch(`${base}${BACKEND_STATUS_BEACON_PATH}`, { method: "POST", body });
    await sleep(10);
    return res;
  });

test("flag key is the one the release manifest and metrics are keyed on", () => {
  assert.equal(BACKEND_STATUS_FLAG, "enable-backend-status");
});

// --- control path (flag off / fail-safe) -------------------------------------

test("control renders the pre-feature page byte for byte", async () => {
  assert.equal(await getPage(stubClient("control")), PRE_FEATURE_PAGE);
});

test("control omits the backend-status element and its fetch", async () => {
  const html = await getPage(stubClient("control"));
  assert.ok(!html.includes('id="backend-status"'));
  assert.ok(!html.includes("/api/status"));
  assert.ok(!html.includes("sendBeacon"));
});

test("a missing LaunchDarkly client falls back to control", async () => {
  assert.equal(await getPage(null), PRE_FEATURE_PAGE);
});

test("a throwing flag evaluation falls back to control", async () => {
  assert.equal(await getPage(stubClient(new Error("LaunchDarkly unreachable"))), PRE_FEATURE_PAGE);
});

test("a non-string variation value falls back to control", async () => {
  assert.equal(await getPage(stubClient(42)), PRE_FEATURE_PAGE);
});

test("an unknown variation falls back to control rather than guessing", async () => {
  assert.equal(await getPage(stubClient("v2")), PRE_FEATURE_PAGE);
});

test("the flag is evaluated by key with a fail-safe default of control", async () => {
  const seen = {};
  const client = {
    // Mimics the SDK when the flag is absent: hands back the caller's default.
    variation: async (key, context, defaultValue) => {
      Object.assign(seen, { key, context, defaultValue });
      return defaultValue;
    },
    track: () => {},
  };
  const html = await getPage(client);
  assert.equal(seen.key, "enable-backend-status");
  assert.equal(seen.defaultValue, "control");
  assert.deepEqual(seen.context, { kind: "user", key: "demo-user" });
  assert.equal(html, PRE_FEATURE_PAGE);
});

test("a truthy non-v1 string does not take the treatment path", async () => {
  // Guards the boolean-helper trap: every non-empty string is truthy.
  assert.equal(await getPage(stubClient("control")), PRE_FEATURE_PAGE);
  assert.equal(await getPage(stubClient("enabled")), PRE_FEATURE_PAGE);
});

// --- v1 path (this PR's behavior) --------------------------------------------

test("v1 renders the backend-status element", async () => {
  const html = await getPage(stubClient("v1"));
  assert.ok(html.includes('<p id="backend-status">Checking backend status…</p>'));
});

test("v1 fetches the backend status endpoint and reports both outcomes", async () => {
  const html = await getPage(stubClient("v1"));
  assert.ok(html.includes(`fetch("${BACKEND_URL}/api/status")`));
  assert.ok(html.includes('"Backend online: " + d.service + " version " + d.version'));
  assert.ok(html.includes('"Backend offline"'));
});

test("v1 is the control page plus the treatment fragments only", async () => {
  const html = await getPage(stubClient("v1"));
  assert.ok(html.startsWith(PRE_FEATURE_PAGE.slice(0, PRE_FEATURE_PAGE.indexOf("<script>"))));
  assert.ok(html.endsWith("</body></html>"));
});

test("v1 beacons its outcome back for the guarded-release metrics", async () => {
  const html = await getPage(stubClient("v1"));
  assert.ok(html.includes(`navigator.sendBeacon("${BACKEND_STATUS_BEACON_PATH}"`));
  assert.ok(html.includes('{ outcome: "ok" }'));
  assert.ok(html.includes('{ outcome: "error" }'));
});

// --- metric events ------------------------------------------------------------

test("latency is emitted on BOTH variations so the comparison is two-armed", async () => {
  for (const variation of ["control", "v1"]) {
    const client = stubClient(variation);
    await withServer(client, async (base) => {
      await fetch(`${base}/`);
      await sleep(10);
    });
    const latency = client.tracked.filter((e) => e.key === "enable-backend-status-latency");
    assert.equal(latency.length, 1, `expected one latency event on ${variation}`);
    assert.equal(typeof latency[0].value, "number");
    assert.ok(Number.isFinite(latency[0].value) && latency[0].value >= 0);
  }
});

test("an ok beacon emits the success event", async () => {
  const client = stubClient("v1");
  const res = await postBeacon(client, JSON.stringify({ outcome: "ok" }));
  assert.equal(res.status, 204);
  assert.deepEqual(
    client.tracked.map((e) => e.key),
    ["enable-backend-status-success"],
  );
});

test("an error beacon emits the error event that backs the killswitch", async () => {
  const client = stubClient("v1");
  const res = await postBeacon(client, JSON.stringify({ outcome: "error" }));
  assert.equal(res.status, 204);
  assert.deepEqual(
    client.tracked.map((e) => e.key),
    ["enable-backend-status-error"],
  );
});

test("occurrence events carry no metric value", async () => {
  const client = stubClient("v1");
  await postBeacon(client, JSON.stringify({ outcome: "ok" }));
  assert.equal(client.tracked[0].value, undefined);
});

for (const [label, body] of [
  ["malformed JSON", "not json"],
  ["an unrecognized outcome", JSON.stringify({ outcome: "bogus" })],
  ["an empty body", ""],
  ["a JSON scalar", JSON.stringify("ok")],
  ["a missing outcome", JSON.stringify({ elapsedMs: 12 })],
]) {
  test(`${label} emits no event and still returns 204`, async () => {
    const client = stubClient("v1");
    const res = await postBeacon(client, body);
    assert.equal(res.status, 204);
    assert.deepEqual(client.tracked, []);
  });
}

test("a failing track() never fails the request", async () => {
  const client = {
    variation: async () => "v1",
    track: () => {
      throw new Error("event pipeline down");
    },
  };
  const html = await getPage(client);
  assert.ok(html.includes('id="backend-status"'));
  const res = await postBeacon(client, JSON.stringify({ outcome: "error" }));
  assert.equal(res.status, 204);
});

// --- untouched surface --------------------------------------------------------

test("the status contract endpoint is unaffected by the flag", async () => {
  for (const variation of ["control", "v1"]) {
    const body = await withServer(stubClient(variation), async (base) =>
      (await fetch(`${base}/api/status`)).json(),
    );
    assert.deepEqual(body, { service: "demo-frontend", version: SHA });
  }
});
