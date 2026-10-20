import { AppError } from "./errors.js";
import type { BrowserSnapshotInput, BrowserSnapshotResult } from "./browser-contracts.js";

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox", "listbox",
  "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch",
  "slider", "spinbutton", "searchbox", "treeitem",
]);

/**
 * Read-only view of an already captured snapshot. Always keep the full
 * authoritative ref array and capture it BEFORE filtering, so a smaller
 * response never weakens safety checks or loses actionable references.
 */
export function projectBrowserSnapshot(
  snapshot: BrowserSnapshotResult,
  options: Pick<BrowserSnapshotInput, "filter" | "depth" | "refId" | "maxChars">,
): BrowserSnapshotResult {
  const { filter, depth, refId, maxChars } = options;
  if (!filter && depth === undefined && !refId && maxChars === undefined) return snapshot;
  if (refId && !snapshot.refs.some((reference) => reference.ref === refId)) {
    throw new AppError("INVALID_ARGUMENT", "Unknown or expired snapshot ref. Capture a fresh browser_snapshot.");
  }
  const original = snapshot.content;
  if (!original) return snapshot;
  const lines = original.split("\n");
  const semantic = /^([ \t]*)-\s+(?:<changed>\s+)?([A-Za-z][\w-]*)\b.*?\[ref=([^\]]+)\]/u;
  const anchor = refId
    ? lines.findIndex((line) => semantic.exec(line)?.[3] === refId)
    : -1;
  if (refId && anchor < 0) {
    throw new AppError("INVALID_ARGUMENT", "The selected ref is not present in the full snapshot.");
  }
  const anchorIndent = anchor >= 0 ? (semantic.exec(lines[anchor]!)?.[1]?.length ?? 0) : 0;
  const allowedRefs = new Set(snapshot.refs.map((ref) => ref.ref));
  let selected: string[];
  if (anchor >= 0) {
    selected = [];
    for (let index = anchor; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = /^([ \t]*)-\s+/u.exec(line);
      const indent = match?.[1]?.length ?? 0;
      if (index > anchor && match && indent <= anchorIndent) break;
      if (depth !== undefined && index > anchor && Math.floor((indent - anchorIndent) / 2) >= depth) continue;
      if (filter === "interactive") {
        const parsed = semantic.exec(line);
        if (!parsed || !allowedRefs.has(parsed[3]!) || !INTERACTIVE_ROLES.has(parsed[2]!.toLowerCase())) continue;
      }
      selected.push(line);
    }
  } else if (filter === "interactive") {
    selected = lines.filter((line) => {
      const parsed = semantic.exec(line);
      return parsed && allowedRefs.has(parsed[3]!) &&
        INTERACTIVE_ROLES.has(parsed[2]!.toLowerCase()) &&
        (depth === undefined || Math.floor((parsed[1]?.length ?? 0) / 2) < depth);
    });
  } else if (depth !== undefined) {
    selected = lines.filter((line) => {
      const match = /^([ \t]*)-\s+/u.exec(line);
      return !match || Math.floor((match[1]?.length ?? 0) / 2) < depth;
    });
  } else {
    selected = lines;
  }
  let content = selected.join("\n");
  let truncated = false;
  if (maxChars !== undefined && content.length > maxChars) {
    const out: string[] = [];
    let used = 0;
    for (const line of selected) {
      const cost = line.length + (out.length ? 1 : 0);
      if (used + cost > maxChars) break;
      out.push(line);
      used += cost;
    }
    content = out.length ? out.join("\n") : selected[0]!.slice(0, maxChars);
    truncated = true;
  }
  // Filtered snapshots are complete views rather than tracked deltas.
  // Caller must request a full capture when projection is active.
  return {
    ...snapshot,
    content,
    ...(truncated ? { truncated: true } : {}),
    ...(snapshot.state?.kind === "full"
      ? { state: { ...snapshot.state, snapshot: content } }
      : {}),
  };
}
