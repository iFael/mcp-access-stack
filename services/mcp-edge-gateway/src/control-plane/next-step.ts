// Every published tool carries, in its _meta, the call that comes after it.
// The Edge adds it to each successful result, wherever the call was answered,
// so the agent is told the next call when it needs it. Every published tool's
// result, but the card tools', also reminds it to end the answer with the plan
// card, which ChatGPT draws only where browser_progress is called.

export const NEXT_STEP_META_KEY = "io.github.ifael/next-step";

export const PLAN_CARD_REMINDER =
  "Card: end this answer, after your text, with browser_progress and the conversation's planId (open one with browser_progress if it has none).";
const CARD_TOOLS = /^browser_(progress|user_|plan$)/;

export function nextStepsOf(manifest: readonly unknown[]): Map<string, string> {
  const steps = new Map<string, string>();
  for (const tool of manifest) {
    if (!isRecord(tool) || typeof tool.name !== "string") continue;
    const next = isRecord(tool._meta) ? tool._meta[NEXT_STEP_META_KEY] : undefined;
    steps.set(tool.name, typeof next === "string" ? next : "");
  }
  return steps;
}

export async function attachNextStep(body: unknown, response: Response, steps: ReadonlyMap<string, string>): Promise<Response> {
  if (!isRecord(body) || !isRecord(body.params) || typeof body.params.name !== "string") return response;
  const name = body.params.name;
  const lines = [steps.get(name) ? `Next: ${steps.get(name)}` : "", !steps.has(name) || CARD_TOOLS.test(name) ? "" : PLAN_CARD_REMINDER]
    .filter(Boolean);
  if (lines.length === 0 || !(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  let result: unknown;
  try { result = await response.clone().json(); } catch { return response; }
  if (!isRecord(result) || !isRecord(result.result) || result.result.isError === true ||
      !Array.isArray(result.result.content)) return response;
  result.result.content = [...result.result.content, ...lines.map((text) => ({ type: "text", text }))];
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(result), { status: response.status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
