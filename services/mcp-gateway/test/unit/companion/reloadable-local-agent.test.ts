import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { PolicyFile } from "@vs-code-gpt/shared";
import { LocalAgent } from "@vs-code-gpt/local-agent";
import { ReloadableLocalAgent } from "../../../src/companion/reloadable-local-agent.js";

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ReloadableLocalAgent confirmation state", () => {
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
