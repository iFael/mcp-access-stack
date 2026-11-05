import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { AppError, type PolicyFile } from "@vs-code-gpt/shared";
import { LocalAgent } from "@vs-code-gpt/local-agent";
import { ReloadableLocalAgent } from "../../../src/companion/reloadable-local-agent.js";

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ReloadableLocalAgent confirmation state", () => {
  it("blocks repository mutation without a validated workspace policy", async () => {
    const reloadable = new ReloadableLocalAgent();
    const port = {
      calls: 0,
      read() { this.calls += 1; return this.calls; },
      async bind() { this.calls += 1; return this.calls; },
    };
    const guarded = reloadable.protectRepositoryOperations(port);
    expect(() => guarded.read()).toThrow();
    expect(() => guarded.bind()).toThrow();
    expect(port.calls).toBe(0);

    jest.spyOn(LocalAgent, "createFromPolicy").mockResolvedValue({} as LocalAgent);
    await reloadable.reload({} as PolicyFile);
    expect(guarded.read()).toBe(1);
    await expect(guarded.bind()).resolves.toBe(2);
    await reloadable.reload(null);
    expect(() => guarded.read()).toThrow();
    expect(port.calls).toBe(2);
  });


  it("fails closed and invalidates a previously ready agent if audit initialization fails", async () => {
    const agent = {} as LocalAgent;
    const create = jest.spyOn(LocalAgent, "createFromPolicy")
      .mockResolvedValueOnce(agent)
      .mockRejectedValueOnce(new AppError("AUDIT_FAILED", "Audit log is unavailable."));
    const reloadable = new ReloadableLocalAgent();
    const policy = {} as PolicyFile;
    await reloadable.reload(policy);
    expect(reloadable.ready).toBe(true);
    const oldGeneration = reloadable.currentGeneration;
    await expect(reloadable.reload(policy)).rejects.toMatchObject({ code: "AUDIT_FAILED" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(reloadable.ready).toBe(false);
    expect(reloadable.currentGeneration).toBeGreaterThan(oldGeneration);
    expect(() => reloadable.localAgent()).toThrow();
    await expect(reloadable.workspaceExecutor.listWorkspaces()).resolves.toEqual([]);
    expect(() => reloadable.workspaceExecutor.readFile({workspaceId:"project",path:"a.txt"}))
      .toThrow();
  });


  it("reuses confirmation registries across policy reloads", async () => {
    const createFromPolicy = jest
      .spyOn(LocalAgent, "createFromPolicy")
      .mockResolvedValue({} as LocalAgent);
    const reloadable = new ReloadableLocalAgent();
    const policy = {} as PolicyFile;

    await reloadable.reload(policy);
    await reloadable.reload(policy);

    expect(createFromPolicy).toHaveBeenCalledTimes(2);
    const firstOptions = createFromPolicy.mock.calls[0]?.[1];
    const secondOptions = createFromPolicy.mock.calls[1]?.[1];

    expect(firstOptions?.commandConfirmationRegistry).toBeDefined();
    expect(firstOptions?.typedConfirmationRegistry).toBeDefined();
    expect(secondOptions?.commandConfirmationRegistry).toBe(
      firstOptions?.commandConfirmationRegistry,
    );
    expect(secondOptions?.typedConfirmationRegistry).toBe(
      firstOptions?.typedConfirmationRegistry,
    );
  });
});
