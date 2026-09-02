import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  markMutationReceiptCompleted,
  markMutationReceiptExecuting,
  markMutationReceiptReconciliationRequired,
  parseMutationReceipt,
  reserveMutationReceipt,
  type MutationReceipt,
  type MutationReceiptIdentity,
  type MutationReceiptReservation,
  type MutationReceiptStore,
} from "@vs-code-gpt/shared";

export interface MutationReceiptFileOperations {
  ensureDirectory(directory: string): Promise<void>;
  readText(filePath: string): Promise<string | undefined>;
  writeText(filePath: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

export interface FileMutationReceiptStoreOptions {
  fileOperations?: MutationReceiptFileOperations;
}

const nodeFileOperations: MutationReceiptFileOperations = {
  ensureDirectory: async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  },
  readText: async (filePath) => {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  writeText: async (filePath, content) => {
    await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  remove: async (filePath) => {
    await rm(filePath, { force: true });
  },
};

export class FileMutationReceiptStore implements MutationReceiptStore {
  private readonly receiptDirectory: string;
  private readonly fileOperations: MutationReceiptFileOperations;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    workspaceRoot: string,
    options: FileMutationReceiptStoreOptions = {},
  ) {
    this.receiptDirectory = path.join(
      path.resolve(workspaceRoot),
      ".runtime-private",
      "source-control-receipts",
    );
    this.fileOperations = options.fileOperations ?? nodeFileOperations;
  }

  async reserve(
    identity: MutationReceiptIdentity,
  ): Promise<MutationReceiptReservation> {
    return this.serialize(identity.idempotencyKey, async () => {
      const existing = await this.readReceipt(identity.idempotencyKey);
      const reservation = reserveMutationReceipt(existing, identity);
      if (reservation.disposition === "execute") {
        await this.writeReceipt(reservation.receipt);
      }
      return reservation;
    });
  }

  async markExecuting(identity: MutationReceiptIdentity): Promise<MutationReceipt> {
    return this.serialize(identity.idempotencyKey, async () => {
      const receipt = markMutationReceiptExecuting(
        await this.readReceipt(identity.idempotencyKey),
        identity,
      );
      await this.writeReceipt(receipt);
      return receipt;
    });
  }

  async markReconciliationRequired(
    identity: MutationReceiptIdentity,
  ): Promise<MutationReceipt> {
    return this.serialize(identity.idempotencyKey, async () => {
      const receipt = markMutationReceiptReconciliationRequired(
        await this.readReceipt(identity.idempotencyKey),
        identity,
      );
      await this.writeReceipt(receipt);
      return receipt;
    });
  }

  async markCompleted(
    identity: MutationReceiptIdentity,
    result: unknown,
  ): Promise<MutationReceipt> {
    return this.serialize(identity.idempotencyKey, async () => {
      const receipt = markMutationReceiptCompleted(
        await this.readReceipt(identity.idempotencyKey),
        identity,
        result,
      );
      await this.writeReceipt(receipt);
      return receipt;
    });
  }

  async get(idempotencyKey: string): Promise<MutationReceipt | undefined> {
    return this.serialize(idempotencyKey, () => this.readReceipt(idempotencyKey));
  }

  private async readReceipt(
    idempotencyKey: string,
  ): Promise<MutationReceipt | undefined> {
    const serialized = await this.fileOperations.readText(
      this.receiptPath(idempotencyKey),
    );
    if (serialized === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch (error) {
      throw new Error("Persisted source-control mutation receipt is invalid JSON.", {
        cause: error,
      });
    }
    return parseMutationReceipt(parsed);
  }

  private async writeReceipt(receipt: MutationReceipt): Promise<void> {
    const targetPath = this.receiptPath(receipt.identity.idempotencyKey);
    await this.fileOperations.ensureDirectory(this.receiptDirectory);
    const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    const content = `${JSON.stringify(parseMutationReceipt(receipt))}\n`;
    try {
      await this.fileOperations.writeText(temporaryPath, content);
      await this.fileOperations.rename(temporaryPath, targetPath);
    } catch (error) {
      try {
        await this.fileOperations.remove(temporaryPath);
      } catch {}
      throw error;
    }
  }

  private receiptPath(idempotencyKey: string): string {
    const digest = createHash("sha256").update(idempotencyKey).digest("hex");
    return path.join(this.receiptDirectory, `${digest}.json`);
  }

  private serialize<T>(idempotencyKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(idempotencyKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(idempotencyKey, current);
    return current.finally(() => {
      if (this.queues.get(idempotencyKey) === current) {
        this.queues.delete(idempotencyKey);
      }
    });
  }
}
