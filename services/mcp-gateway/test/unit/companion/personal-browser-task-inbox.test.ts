import { describe, expect, it } from "@jest/globals";
import { PersonalBrowserTaskInbox } from "../../../src/companion/personal-browser-task-inbox.js";

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id: `msg_${id}`, text: `nota ${id}`, sentAt: "2026-10-28T15:00:00.000Z", ...extra,
});

describe("PersonalBrowserTaskInbox", () => {
  it("drops malformed entries and keeps only personal tab ids", () => {
    const inbox = new PersonalBrowserTaskInbox();
    expect(inbox.accept({ messages: [
      message("aaaaaaaa", { taskId: "task-1", tabIds: ["personal:7", "managed:1", 5] }),
      message("bad"),
      { ...message("bbbbbbbb"), text: "" },
      "nope",
    ] })).toEqual({ added: 1, addedIds: ["msg_aaaaaaaa"], alreadyDelivered: [] });
    expect(inbox.size).toBe(1);
    expect(inbox.take({ tabId: "managed:1" })).toEqual([]);
    expect(inbox.take({ tabId: "personal:7" })).toHaveLength(1);
  });

  it("wakes a waiting reader when a message for its task arrives, and not for another task", async () => {
    const inbox = new PersonalBrowserTaskInbox();
    let woke = false;
    const waiting = inbox.waitFor({ taskId: "task-1" }, false, 5_000).then(() => { woke = true; });
    inbox.accept({ messages: [message("cccccccc", { taskId: "task-2" })] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(woke).toBe(false);
    inbox.accept({ messages: [message("dddddddd", { taskId: "task-1" })] });
    await waiting;
    expect(inbox.take({ taskId: "task-1" }).map((entry) => entry.id)).toEqual(["msg_dddddddd"]);
  });

  it("returns when the time is up or the call is cancelled", async () => {
    const inbox = new PersonalBrowserTaskInbox();
    const started = Date.now();
    await inbox.waitFor({}, true, 30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    const controller = new AbortController();
    const waiting = inbox.waitFor({}, true, 60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("keeps at most 50 messages, dropping the oldest", () => {
    const inbox = new PersonalBrowserTaskInbox();
    inbox.accept({ messages: Array.from({ length: 50 }, (_, index) => message(`a${String(index).padStart(8, "0")}`)) });
    inbox.accept({ messages: [message("zzzzzzzz")] });
    const taken = inbox.take({}, true);
    expect(taken).toHaveLength(50);
    expect(taken[0]?.id).toBe("msg_a00000001");
    expect(taken.at(-1)?.id).toBe("msg_zzzzzzzz");
  });
});
