import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileCredentialBroker } from "../../services/file-credential-broker.js";

describe("FileCredentialBroker", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mcp-browser-credentials-"));
    filePath = path.join(directory, "credentials.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        credentials: [
          {
            siteId: "finance",
            accountId: "default",
            username: "user",
            password: "secret",
          },
        ],
      }),
      "utf8",
    );
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns credentials through the existing disposable secret contract", async () => {
    const broker = new FileCredentialBroker(filePath);
    const result = await broker.read({ siteId: "finance", accountId: "default" });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");

    expect(result.secret.username.toString("utf8")).toBe("user");
    expect(result.secret.password.toString("utf8")).toBe("secret");
    result.secret.dispose();
    expect([...result.secret.password]).toEqual([...Buffer.alloc(6)]);
  });

  it("returns unavailable without exposing file contents when an account is absent", async () => {
    const broker = new FileCredentialBroker(filePath);
    await expect(
      broker.read({ siteId: "finance", accountId: "missing" }),
    ).resolves.toEqual({ status: "unavailable" });
  });
});
