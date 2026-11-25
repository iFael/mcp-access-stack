import assert from "node:assert/strict";
import test from "node:test";
import { downloadGitleaks } from "./download-gitleaks.mjs";

const url = "https://github.com/gitleaks/gitleaks/releases/download/test/fixture.tar.gz";
const refused = () => new TypeError("fetch failed", { cause: Object.assign(new Error("NGHTTP2_REFUSED_STREAM"), { code: "ERR_HTTP2_STREAM_ERROR" }) });

test("recovers a refused HTTP/2 stream with the same pinned URL", async () => {
  const waits = [];
  let calls = 0;
  const bytes = await downloadGitleaks(url, {
    fetchImpl: async (actual, options) => {
      assert.equal(actual, url);
      assert.ok(options.signal instanceof AbortSignal);
      if (++calls === 1) throw refused();
      return new Response("archive");
    },
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(bytes.toString(), "archive");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
});

test("bounds transient failures to three attempts", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(downloadGitleaks(url, {
    fetchImpl: async () => { calls++; throw refused(); },
    sleep: async (ms) => { waits.push(ms); },
  }), /fetch failed/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("does not retry permanent HTTP failures", async () => {
  let calls = 0;
  await assert.rejects(downloadGitleaks(url, {
    fetchImpl: async () => { calls++; return new Response("missing", { status: 404 }); },
    sleep: async () => assert.fail("unexpected retry"),
  }), /HTTP 404/);
  assert.equal(calls, 1);
});

test("retries a temporary HTTP response and interrupted response body", async () => {
  let calls = 0;
  const bytes = await downloadGitleaks(url, {
    fetchImpl: async () => {
      switch (++calls) {
        case 1: return new Response("unavailable", { status: 503 });
        case 2: return { ok: true, arrayBuffer: async () => { throw refused(); } };
        default: return new Response("archive");
      }
    },
    sleep: async () => {},
  });
  assert.equal(bytes.toString(), "archive");
  assert.equal(calls, 3);
});

test("does not retry an unclassified or certificate failure", async () => {
  let calls = 0;
  await assert.rejects(downloadGitleaks(url, {
    fetchImpl: async () => { calls++; throw new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } }); },
    sleep: async () => assert.fail("unexpected retry"),
  }), /fetch failed/);
  assert.equal(calls, 1);
});
