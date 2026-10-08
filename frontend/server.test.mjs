import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import {
  CONTROL,
  FLAG_KEY,
  TELEMETRY_PATH,
  createApp,
  ldContext,
  renderPage,
  resolveVariation,
} from "./server.mjs";

const LATENCY_EVENT = "shift2-enable-greeting-refresh-latency";
const SUCCESS_EVENT = "shift2-enable-greeting-refresh-success";
const ERROR_EVENT = "shift2-enable-greeting-refresh-error";

/**
 * A stub shaped like the real Node SDK: when `value` is omitted it returns the
 * caller's `defaultValue`, which is how the SDK behaves for an absent flag.
 * That is what makes the fail-safe default observable to the tests.
 */
function stubClient({ value, throwOnVariation = false, throwOnTrack = false } = {}) {
  const calls = { variation: [], track: [] };
  return {
    calls,
    async variation(key, context, defaultValue) {
      calls.variation.push({ key, context, defaultValue });
      if (throwOnVariation) throw new Error("LD unavailable");
      return value === undefined ? defaultValue : value;
    },
    track(key, context, data, metricValue) {
      calls.track.push({ key, context, data, metricValue });
      if (throwOnTrack) throw new Error("event processor down");
    },
  };
}

async function withServer(ldClient, fn) {
  const server = createApp({ ldClient }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

const getPage = (ldClient) =>
  withServer(ldClient, async (base) => {
    const res = await fetch(base);
    const body = await res.text();
    await sleep(20); // the latency event is emitted after the response is sent
    return { res, body };
  });

const postBeacon = (ldClient, body) =>
  withServer(ldClient, async (base) => {
    const res = await fetch(`${base}${TELEMETRY_PATH}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    await sleep(20);
    return res;
  });

const eventKeys = (client) => client.calls.track.map((c) => c.key);

test("control: renders the existing page with no refresh button", async () => {
  const client = stubClient({ value: CONTROL });
  const { body } = await getPage(client);
  assert.ok(!body.includes("Refresh greeting"));
  assert.ok(!body.includes('id="refresh"'));
  assert.ok(!body.includes("loadGreeting"));
  assert.ok(body.includes('<p id="greeting">Loading greeting from backend…</p>'));
  assert.ok(body.includes("/api/greeting"));
});

test("v1: renders the refresh button wired to a re-fetch", async () => {
  const client = stubClient({ value: "v1" });
  const { body } = await getPage(client);
  assert.ok(body.includes('<button id="refresh" type="button">Refresh greeting</button>'));
  assert.ok(body.includes("function loadGreeting()"));
  assert.ok(body.includes('document.getElementById("refresh").addEventListener("click", loadGreeting)'));
});

test("control: emits no client telemetry beacon", async () => {
  const { body } = await getPage(stubClient({ value: CONTROL }));
  assert.ok(!body.includes(TELEMETRY_PATH));
  assert.ok(!body.includes("sendBeacon"));
});

test("v1: reports refresh outcomes through the telemetry beacon", async () => {
  const { body } = await getPage(stubClient({ value: "v1" }));
  assert.ok(body.includes(`navigator.sendBeacon("${TELEMETRY_PATH}"`));
  assert.ok(body.includes('report("success")'));
  assert.ok(body.includes('report("error")'));
});

test("an unknown variation falls back to the control page", async () => {
  const { body } = await getPage(stubClient({ value: "v2" }));
  assert.ok(!body.includes("Refresh greeting"));
});

test("a non-string variation value falls back to the control page", async () => {
  const { body } = await getPage(stubClient({ value: true }));
  assert.ok(!body.includes("Refresh greeting"));
  assert.equal(await resolveVariation(stubClient({ value: true })), CONTROL);
});

test("a missing LaunchDarkly client serves the control page", async () => {
  const { body } = await getPage(null);
  assert.ok(!body.includes("Refresh greeting"));
  assert.equal(await resolveVariation(null), CONTROL);
});

test("a throwing LaunchDarkly client serves the control page", async () => {
  const client = stubClient({ value: "v1", throwOnVariation: true });
  const { res, body } = await getPage(client);
  assert.equal(res.status, 200);
  assert.ok(!body.includes("Refresh greeting"));
});

test("the evaluation passes 'control' as the fail-safe default, so an absent flag serves control", async () => {
  const client = stubClient(); // returns whatever default the caller passed
  const { body } = await getPage(client);
  assert.equal(client.calls.variation.length, 1);
  assert.equal(client.calls.variation[0].key, FLAG_KEY);
  assert.equal(client.calls.variation[0].defaultValue, CONTROL);
  assert.ok(!body.includes("Refresh greeting"));
});

test("the flag is evaluated for the demo-user context", async () => {
  const client = stubClient({ value: "v1" });
  await getPage(client);
  assert.deepEqual(client.calls.variation[0].context, { kind: "user", key: "demo-user" });
  assert.deepEqual(ldContext(), { kind: "user", key: "demo-user" });
});

test("renderPage is a pure control/v1 switch", () => {
  assert.equal(renderPage("v1"), renderPage("v1"));
  assert.equal(renderPage(CONTROL), renderPage("v2"));
  assert.equal(renderPage(CONTROL), renderPage(undefined));
  assert.notEqual(renderPage("v1"), renderPage(CONTROL));
});

test("latency is two-armed: control page loads emit the latency event", async () => {
  const client = stubClient({ value: CONTROL });
  await getPage(client);
  assert.deepEqual(eventKeys(client), [LATENCY_EVENT]);
  const [event] = client.calls.track;
  assert.equal(typeof event.metricValue, "number");
  assert.ok(event.metricValue >= 0);
  assert.deepEqual(event.context, { kind: "user", key: "demo-user" });
});

test("latency is two-armed: v1 page loads emit the latency event", async () => {
  const client = stubClient({ value: "v1" });
  await getPage(client);
  assert.deepEqual(eventKeys(client), [LATENCY_EVENT]);
  assert.equal(typeof client.calls.track[0].metricValue, "number");
});

test("a successful refresh beacon emits only the success event", async () => {
  const client = stubClient({ value: "v1" });
  const res = await postBeacon(client, JSON.stringify({ outcome: "success" }));
  assert.equal(res.status, 204);
  assert.deepEqual(eventKeys(client), [SUCCESS_EVENT]);
  assert.equal(client.calls.track[0].metricValue, undefined);
});

test("a failed refresh beacon emits only the error event", async () => {
  const client = stubClient({ value: "v1" });
  const res = await postBeacon(client, JSON.stringify({ outcome: "error" }));
  assert.equal(res.status, 204);
  assert.deepEqual(eventKeys(client), [ERROR_EVENT]);
});

test("the beacon route ignores malformed and unknown payloads", async () => {
  for (const body of ["not json", "", "[]", JSON.stringify({ outcome: "bogus" })]) {
    const client = stubClient({ value: "v1" });
    const res = await postBeacon(client, body);
    assert.equal(res.status, 204, `status for ${JSON.stringify(body)}`);
    assert.deepEqual(eventKeys(client), [], `events for ${JSON.stringify(body)}`);
  }
});

test("the beacon never records a client-supplied metric value", async () => {
  const client = stubClient({ value: "v1" });
  await postBeacon(client, JSON.stringify({ outcome: "success", elapsedMs: 9999 }));
  assert.deepEqual(eventKeys(client), [SUCCESS_EVENT]);
  assert.equal(client.calls.track[0].metricValue, undefined);
});

test("a telemetry failure never fails a request", async () => {
  const throwing = stubClient({ value: "v1", throwOnTrack: true });
  const { res, body } = await getPage(throwing);
  assert.equal(res.status, 200);
  assert.ok(body.includes("Refresh greeting"));
  assert.equal(
    (await postBeacon(stubClient({ value: "v1", throwOnTrack: true }), JSON.stringify({ outcome: "error" }))).status,
    204,
  );
});

test("the flag key and event keys are literals that match the release manifest", async () => {
  assert.equal(FLAG_KEY, "shift2-enable-greeting-refresh");

  const manifest = JSON.parse(
    await readFile(new URL("../.release-flags/shift-2-refresh-greeting.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.flagKey, FLAG_KEY);
  assert.equal(manifest.targetVariation, "v1");
  assert.deepEqual([...manifest.releasePlan.metricKeys].sort(), [
    `${FLAG_KEY}-error-rate`,
    `${FLAG_KEY}-latency`,
    `${FLAG_KEY}-success-rate`,
  ]);

  // Guarded-release event keys must stay greppable literals in the source.
  const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  for (const eventKey of [LATENCY_EVENT, SUCCESS_EVENT, ERROR_EVENT]) {
    assert.ok(source.includes(`"${eventKey}"`), `${eventKey} is not a literal in server.mjs`);
  }
});

test("the status contract is unchanged on both variations", async () => {
  for (const value of [CONTROL, "v1"]) {
    const payload = await withServer(stubClient({ value }), async (base) =>
      (await fetch(`${base}/api/status`)).json(),
    );
    assert.deepEqual(payload, { service: "demo-frontend", version: process.env.RAILWAY_GIT_COMMIT_SHA || "dev" });
  }
});
