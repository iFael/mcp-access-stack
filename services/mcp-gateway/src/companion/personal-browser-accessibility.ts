import type { BrowserAccessibilitySummary } from "@vs-code-gpt/shared";

/**
 * CDP Accessibility.getFullAXTree is observational only. Never expose CDP
 * nodeId, backendDOMNodeId, value, properties or childIds in tool output:
 * those are not scoped, validated MCP action references.
 *
 * Intentionally self-contained: the Chrome extension embeds this exact pure
 * function, so sanitization happens before the bridge receives any AX data.
 */
export function summarizeCdpAccessibility(
  tree: unknown,
  frames: unknown,
): BrowserAccessibilitySummary {
  const input = tree as { nodes?: unknown };
  if (!input || !Array.isArray(input.nodes) || input.nodes.length === 0) {
    throw new Error("The native Chrome accessibility tree is unavailable.");
  }
  type Node = {
    nodeId?: string;
    childIds?: string[];
    ignored?: boolean;
    role?: { value?: unknown };
    name?: { value?: unknown };
  };
  const indexed = new Map<string, Node>();
  const nodes = input.nodes as Node[];
  // The complete raw CDP response is kept only in the extension worker.
  for (const item of nodes.slice(0, 20000)) {
    if (item && typeof item.nodeId === "string") indexed.set(item.nodeId, item);
  }
  const root = nodes[0];
  if (!root || typeof root.nodeId !== "string") {
    throw new Error("The native Chrome accessibility tree has no root.");
  }
  const result: Array<{ role: string; name: string; depth: number }> = [];
  const pending: Array<{ id: string; depth: number }> = [{ id: root.nodeId, depth: 0 }];
  const seen = new Set<string>();
  let truncated = nodes.length > 20000;
  for (let i = 0; i < pending.length && i < 10000; i += 1) {
    const current = pending[i]!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    const node = indexed.get(current.id);
    if (!node) continue;
    const role = typeof node.role?.value === "string"
      ? node.role.value.slice(0, 100) : "unknown";
    const name = typeof node.name?.value === "string"
      ? node.name.value.replace(/\s+/gu, " ").trim().slice(0, 500) : "";
    if (result.length >= 1000) { truncated = true; break; }
    if (current.depth > 40) { truncated = true; continue; }
    // Ignore CDP values and passwords: only role and accessible name are useful.
    if (!node.ignored) result.push({ role, name, depth: current.depth });
    if (current.depth >= 40) {
      if (node.childIds?.length) truncated = true;
      continue;
    }
    for (const child of (Array.isArray(node.childIds) ? node.childIds : []).slice(0, 1000)) {
      if (typeof child === "string" && pending.length < 12000) {
        pending.push({ id: child, depth: current.depth + 1 });
      } else truncated = true;
    }
  }
  const info = frames as { frameTree?: unknown };
  const frameStack: unknown[] = info?.frameTree ? [info.frameTree] : [];
  let frameCount = 0;
  while (frameStack.length && frameCount < 200) {
    const next = frameStack.pop() as { childFrames?: unknown } | undefined;
    if (!next) continue;
    frameCount += 1;
    if (Array.isArray(next.childFrames)) {
      for (const child of next.childFrames.slice(0, 200)) frameStack.push(child);
    }
  }
  return {
    source: "cdp",
    coverage: "main-frame-only",
    frameCount,
    nodes: result,
    truncated: truncated || frameStack.length > 0,
  };
}
