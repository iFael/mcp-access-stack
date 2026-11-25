import { describe, expect, it, jest } from "@jest/globals";
import { BrowserUserControl } from "../../services/browser-user-control.js";
import { browserViewerControlSchema } from "@vs-code-gpt/shared";

const holder = { taskId: "task-one", tabId: "tab-one", controlId: "11111111-1111-4111-8111-111111111111" };
const other = { ...holder, controlId: "22222222-2222-4222-8222-222222222222" };
const owner = "user:owner";
const take = { ...holder, action: "take" } as const;
const release = { ...holder, action: "release" } as const;
const click = { ...holder, action: "input", event: { kind: "click", x: 0.2, y: 0.5 } } as const;

function fixture() {
  const control = new BrowserUserControl();
  const handle = { input: jest.fn(async (): Promise<void> => undefined), release: jest.fn(async () => undefined), renew: jest.fn() };
  const begin = jest.fn(async () => handle);
  return { control, handle, begin };
}

describe("BrowserUserControl", () => {
  it("keeps agent requests and native executions mutually exclusive with human control", async () => {
    const { control, begin, handle } = fixture();
    const finishRequest = control.acquireAgent();
    const finishExecution = control.acquireAgent();
    finishRequest();
    await expect(control.run(take, owner, begin)).rejects.toMatchObject({ code: "AGENT_BUSY" });
    expect(begin).not.toHaveBeenCalled();
    finishExecution();
    const before = control.frameGuard(undefined);
    await control.run(take, owner, begin);
    expect(before()).toBe(false);
    expect(() => control.acquireAgent()).toThrow();
    expect(() => control.frameGuard(undefined)).toThrow();
    expect(control.frameGuard({ ...holder, ownerScope: owner })()).toBe(true);
    await expect(control.run({ ...click, ...other }, owner, begin)).rejects.toMatchObject({ code: "TASK_SUSPENDED" });
    await expect(control.run(click, "user:other", begin)).rejects.toMatchObject({ code: "TASK_SUSPENDED" });
    await control.run(click, owner, begin);
    expect(handle.input).toHaveBeenCalledTimes(1);
    const during = control.frameGuard({ ...holder, ownerScope: owner });
    await control.run(release, owner, begin);
    expect(during()).toBe(false);
    control.acquireAgent()();
  });

  it("does not hand the tab back on expiry or a failed release; a new authenticated viewer can recover it", async () => {
    const clock = jest.spyOn(Date, "now");
    clock.mockReturnValue(1000);
    try {
      const { control, handle, begin } = fixture();
      await control.run(take, owner, begin);
      await expect(control.run({ ...take, ...other }, owner, begin)).rejects.toMatchObject({ code: "TASK_SUSPENDED" });
      clock.mockReturnValue(121001);
      await expect(control.run(click, owner, begin)).rejects.toMatchObject({ code: "TASK_SUSPENDED" });
      expect(() => control.acquireAgent()).toThrow();
      await expect(control.run({ ...take, ...other, tabId: "other-tab" }, owner, begin)).rejects.toMatchObject({ code: "TASK_SUSPENDED" });
      await control.run({ ...take, ...other }, owner, begin);
      expect(begin).toHaveBeenCalledTimes(1);
      expect(handle.renew).toHaveBeenCalledTimes(1);
      handle.release.mockRejectedValueOnce(new Error("login still present"));
      await expect(control.run({ ...release, ...other }, owner, begin)).rejects.toThrow("login still present");
      expect(() => control.acquireAgent()).toThrow();
      await control.run({ ...release, ...other }, owner, begin);
      control.acquireAgent()();
    } finally { clock.mockRestore(); }
  });

  it("rejects concurrent manual inputs and unbounded or non-input payloads", async () => {
    const { control, handle, begin } = fixture();
    await control.run(take, owner, begin);
    let resolve!: () => void;
    handle.input.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const pending = control.run(click, owner, begin);
    await expect(control.run(click, owner, begin)).rejects.toMatchObject({ code: "AGENT_BUSY" });
    await expect(control.run(release, owner, begin)).rejects.toMatchObject({ code: "AGENT_BUSY" });
    resolve();
    await pending;
    expect(handle.input).toHaveBeenCalledTimes(1);
    for (const event of [{ kind: "click", x: 1, y: 0 }, { kind: "text", text: "x".repeat(513) },
      { kind: "evaluate", script: "forbidden" }, { kind: "key", key: "Control+Shift+I" }]) {
      expect(browserViewerControlSchema.safeParse({ ...holder, action: "input", event }).success).toBe(false);
    }
    await control.run(release, owner, begin);
  });
});
