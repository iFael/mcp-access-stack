import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSIENT_SEMANTIC_QUALIFICATION_CODES,
  isTransientSemanticQualificationCode,
  retryTransientSemanticOperation,
} from "./semantic-allowlist-retry.mjs";

const getErrorCode = (error) => error?.code;
const noDelay = async () => undefined;

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

test("declares only the approved transient qualification codes", () => {
  assert.deepEqual(TRANSIENT_SEMANTIC_QUALIFICATION_CODES, [
    "FRAME_NOT_FOUND",
    "FRAME_NOT_READY",
    "LOCATOR_NOT_FOUND",
    "LOCATOR_LOW_CONFIDENCE",
    "NAVIGATION_TIMEOUT",
    "STATE_NOT_REACHED",
  ]);
  assert.equal(isTransientSemanticQualificationCode("LOCATOR_NOT_FOUND"), true);
  assert.equal(isTransientSemanticQualificationCode("POLICY_DENIED"), false);
  assert.equal(isTransientSemanticQualificationCode("LOGIN_INTERACTION_REQUIRED"), false);
});

test("returns immediately when the semantic operation succeeds", async () => {
  let calls = 0;
  const result = await retryTransientSemanticOperation({
    operation: async () => { calls += 1; },
    getErrorCode,
    sleep: noDelay,
  });

  assert.deepEqual(result, { attempts: 1 });
  assert.equal(calls, 1);
});

test("retries the same operation for enumerated transient failures", async () => {
  const failures = [
    codedError("LOCATOR_LOW_CONFIDENCE"),
    codedError("LOCATOR_NOT_FOUND"),
  ];
  const retries = [];
  let calls = 0;

  const result = await retryTransientSemanticOperation({
    operation: async () => {
      calls += 1;
      const failure = failures.shift();
      if (failure) throw failure;
    },
    getErrorCode,
    maxAttempts: 3,
    delayMs: 0,
    sleep: noDelay,
    onRetry: (event) => retries.push(event),
  });

  assert.deepEqual(result, { attempts: 3 });
  assert.equal(calls, 3);
  assert.deepEqual(retries, [
    { attempt: 1, nextAttempt: 2, code: "LOCATOR_LOW_CONFIDENCE" },
    { attempt: 2, nextAttempt: 3, code: "LOCATOR_NOT_FOUND" },
  ]);
});

test("honors a narrower approved retry-code subset", async () => {
  const failure = codedError("STATE_NOT_REACHED");
  let calls = 0;

  await assert.rejects(
    retryTransientSemanticOperation({
      operation: async () => {
        calls += 1;
        throw failure;
      },
      getErrorCode,
      retryCodes: ["LOCATOR_NOT_FOUND"],
      sleep: noDelay,
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("does not retry policy, authentication, or unknown failures", async () => {
  const failure = codedError("POLICY_DENIED");
  let calls = 0;

  await assert.rejects(
    retryTransientSemanticOperation({
      operation: async () => {
        calls += 1;
        throw failure;
      },
      getErrorCode,
      sleep: noDelay,
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("stops after the configured maximum attempts", async () => {
  const failure = codedError("FRAME_NOT_READY");
  let calls = 0;

  await assert.rejects(
    retryTransientSemanticOperation({
      operation: async () => {
        calls += 1;
        throw failure;
      },
      getErrorCode,
      maxAttempts: 3,
      delayMs: 0,
      sleep: noDelay,
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 3);
});
