import { setTimeout as delay } from "node:timers/promises";

// Retry only the read-only transfer, never integrity failures or publication.
export async function downloadGitleaks(url, { fetchImpl = fetch, sleep = delay } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { "user-agent": "mcp-v3-release-builder" },
        signal: AbortSignal.timeout(120000),
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      const error = new Error(`Gitleaks download failed with HTTP ${response.status}.`);
      error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
      await response.body?.cancel();
      throw error;
    } catch (error) {
      const transient = error.retryable === true || error.name === "TimeoutError" ||
        ["ERR_HTTP2_STREAM_ERROR", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN",
          "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
          "UND_ERR_SOCKET"].includes(error.cause?.code);
      if (!transient || attempt === 3) throw error;
      console.warn(`Gitleaks download attempt ${attempt} failed; retrying.`);
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}
