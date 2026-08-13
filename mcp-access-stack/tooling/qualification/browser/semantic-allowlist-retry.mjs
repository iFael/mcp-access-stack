export const TRANSIENT_SEMANTIC_QUALIFICATION_CODES = Object.freeze([
  "FRAME_NOT_FOUND",
  "FRAME_NOT_READY",
  "LOCATOR_NOT_FOUND",
  "LOCATOR_LOW_CONFIDENCE",
  "NAVIGATION_TIMEOUT",
  "STATE_NOT_REACHED",
]);

export function isTransientSemanticQualificationCode(code) {
  return typeof code === "string" &&
    TRANSIENT_SEMANTIC_QUALIFICATION_CODES.includes(code);
}

export async function retryTransientSemanticOperation({
  operation,
  getErrorCode,
  maxAttempts = 3,
  delayMs = 400,
  retryCodes = TRANSIENT_SEMANTIC_QUALIFICATION_CODES,
  sleep = defaultSleep,
  onRetry,
}) {
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function.");
  }
  if (typeof getErrorCode !== "function") {
    throw new TypeError("getErrorCode must be a function.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new RangeError("maxAttempts must be an integer between 1 and 5.");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw new RangeError("delayMs must be between 0 and 5000 milliseconds.");
  }
  if (!Array.isArray(retryCodes) || retryCodes.length === 0) {
    throw new TypeError("retryCodes must be a non-empty array.");
  }
  if (retryCodes.some((code) => !isTransientSemanticQualificationCode(code))) {
    throw new RangeError("retryCodes may contain only approved transient codes.");
  }
  if (typeof sleep !== "function") {
    throw new TypeError("sleep must be a function.");
  }
  const allowedCodes = new Set(retryCodes);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await operation(attempt);
      return { attempts: attempt };
    } catch (error) {
      const code = getErrorCode(error);
      if (
        attempt === maxAttempts ||
        !allowedCodes.has(code)
      ) {
        throw error;
      }
      onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        code,
      });
      await sleep(delayMs * attempt);
    }
  }

  throw new Error("Retry loop completed without a terminal result.");
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
