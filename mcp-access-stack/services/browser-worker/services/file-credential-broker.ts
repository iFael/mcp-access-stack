import { readFile, stat } from "node:fs/promises";
import { AppError, CredentialSecret, type BrowserCredentialBroker, type CredentialBrokerReadRequest, type CredentialBrokerReadResult } from "@vs-code-gpt/shared";
import { z } from "zod";

const credentialFileSchema = z
  .object({
    version: z.literal(1),
    credentials: z
      .array(
        z
          .object({
            siteId: z.string().min(1).max(128),
            accountId: z.string().min(1).max(128),
            username: z.string().min(1).max(4_096),
            password: z.string().min(1).max(16_384),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export class FileCredentialBroker implements BrowserCredentialBroker {
  constructor(private readonly filePath: string) {}

  async read(request: CredentialBrokerReadRequest): Promise<CredentialBrokerReadResult> {
    if (request.signal?.aborted) {
      throw new AppError("OPERATION_CANCELLED", "Credential request was cancelled.");
    }

    let fileMode: number;
    let raw: string;
    try {
      const fileStat = await stat(this.filePath);
      if (!fileStat.isFile()) return { status: "broker-unavailable" };
      fileMode = fileStat.mode;
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return { status: "broker-unavailable" };
    }

    if (process.platform !== "win32" && (fileMode & 0o077) !== 0) {
      return { status: "access-denied" };
    }

    let parsed: z.infer<typeof credentialFileSchema>;
    try {
      parsed = credentialFileSchema.parse(JSON.parse(raw));
    } catch {
      return { status: "protocol-mismatch" };
    }

    const credential = parsed.credentials.find(
      (entry) => entry.siteId === request.siteId && entry.accountId === request.accountId,
    );
    if (!credential) return { status: "unavailable" };

    return {
      status: "success",
      secret: new CredentialSecret(
        Buffer.from(credential.username, "utf8"),
        Buffer.from(credential.password, "utf8"),
      ),
    };
  }
}
