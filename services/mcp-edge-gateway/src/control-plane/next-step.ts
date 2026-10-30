// Every published tool carries, in its _meta, the call that comes after it.
// The Edge adds it to each successful result, wherever the call was answered,
// so the agent is told the next call when it needs it.

export const NEXT_STEP_META_KEY = "io.github.ifael/next-step";

export function nextStepsOf(manifest: readonly unknown[]): Map<string, string> {
  const steps = new Map<string, string>();
  for (const tool of manifest) {
    if (!isRecord(tool) || typeof tool.name !== "string" || !isRecord(tool._meta)) continue;
    const next = tool._meta[NEXT_STEP_META_KEY];
    if (typeof next === "string" && next) steps.set(tool.name, next);
  }
  return steps;
}

export async function attachNextStep(body: unknown, response: Response, steps: ReadonlyMap<string, string>): Promise<Response> {
  if (!isRecord(body) || !isRecord(body.params) || typeof body.params.name !== "string") return response;
  const next = steps.get(body.params.name);
  if (!next || !(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  let result: unknown;
  try { result = await response.clone().json(); } catch { return response; }
  if (!isRecord(result) || !isRecord(result.result) || result.result.isError === true ||
      !Array.isArray(result.result.content)) return response;
  result.result.content = [...result.result.content, { type: "text", text: `Next: ${next}` }];
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(result), { status: response.status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
