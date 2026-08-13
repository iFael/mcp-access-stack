import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { AppError } from "./errors.js";

const BROKER_MAGIC = Buffer.from("MCPCRD01", "ascii");
const BROKER_PROTOCOL_VERSION = 1;
const MAX_BROKER_PAYLOAD_BYTES = 140_000;

export interface CredentialBrokerReadRequest {
  siteId: string;
  accountId: string;
  signal?: AbortSignal;
}

export type CredentialBrokerReadResult =
  | { status: "success"; secret: CredentialSecret }
  | {
      status:
        | "unavailable"
        | "access-denied"
        | "protocol-mismatch"
        | "broker-unavailable";
    };

export interface BrowserCredentialBroker {
  read(request: CredentialBrokerReadRequest): Promise<CredentialBrokerReadResult>;
}

export class CredentialSecret {
  readonly username: Buffer;
  readonly password: Buffer;
  private disposed = false;

  constructor(username: Buffer, password: Buffer) {
    this.username = username;
    this.password = password;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.username.fill(0);
    this.password.fill(0);
  }
}

export interface WindowsCredentialBrokerClientOptions {
  executablePath?: string;
  privateDirectory: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  connectPipe?: (pipePath: string) => Promise<Socket>;
}

export class WindowsCredentialBrokerClient implements BrowserCredentialBroker {
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: typeof spawn;

  constructor(private readonly options: WindowsCredentialBrokerClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async read(
    request: CredentialBrokerReadRequest,
  ): Promise<CredentialBrokerReadResult> {
    const executablePath = this.options.executablePath;
    if (
      this.platform !== "win32" ||
      !executablePath ||
      !path.isAbsolute(executablePath) ||
      !existsSync(executablePath)
    ) {
      return { status: "broker-unavailable" };
    }

    const pipeName = `mcp-credential-broker-${process.pid}-${randomBytes(16).toString("hex")}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const nonce = randomBytes(32).toString("base64url");
    const target = credentialTargetName(
      this.options.privateDirectory,
      request.siteId,
      request.accountId,
    );
    let launchError: Error | undefined;
    const child = this.spawnProcess(
      executablePath,
      [
        "--mode",
        "read",
        "--pipe",
        pipeName,
        "--nonce",
        nonce,
        "--target",
        target,
        "--protocol",
        String(BROKER_PROTOCOL_VERSION),
        "--client-pid",
        String(process.pid),
        "--timeout-ms",
        String(this.timeoutMs),
      ],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
    child.once("error", (error) => {
      launchError = error;
    });

    try {
      const payload = await this.readPayload(
        child,
        pipePath,
        request.signal,
        () => launchError,
      );
      return parseBrokerPayload(payload, nonce, child.pid);
    } finally {
      terminateChild(child);
    }
  }

  private async readPayload(
    child: ChildProcess,
    pipePath: string,
    signal: AbortSignal | undefined,
    launchError: () => Error | undefined,
  ): Promise<Buffer> {
    const deadline = Date.now() + this.timeoutMs;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let socket: Socket | undefined;
    const ignoreLateSocketError = (): void => undefined;
    try {
      socket = this.options.connectPipe
        ? await this.options.connectPipe(pipePath)
        : await connectNamedPipe(
            pipePath,
            deadline,
            child,
            signal,
            launchError,
          );
      return await new Promise<Buffer>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          socket?.on("error", ignoreLateSocketError);
          if (error) reject(error);
          else resolve(Buffer.concat(chunks, totalBytes));
        };
        const abort = (): void =>
          finish(new AppError("OPERATION_CANCELLED", "Credential broker request was cancelled."));
        const timer = setTimeout(() => {
          finish(new AppError(
            "CREDENTIAL_BROKER_UNAVAILABLE",
            "Credential broker response timed out.",
          ));
        }, Math.max(1, deadline - Date.now()));
        timer.unref?.();
        signal?.addEventListener("abort", abort, { once: true });
        socket?.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_BROKER_PAYLOAD_BYTES) {
            finish(new AppError(
              "CREDENTIAL_BROKER_PROTOCOL_MISMATCH",
              "Credential broker payload exceeded its protocol limit.",
            ));
            socket?.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        socket?.once("end", () => finish());
        socket?.once("close", () => finish());
        socket?.once("error", (error) => finish(new AppError(
          "CREDENTIAL_BROKER_UNAVAILABLE",
          "Credential broker pipe failed.",
          { cause: error },
        )));
      });
    } finally {
      if (socket && socket.listenerCount("error") === 0) {
        socket.on("error", ignoreLateSocketError);
      }
      socket?.destroy();
    }
  }
}

export function credentialTargetName(
  privateDirectory: string,
  siteId: string,
  accountId: string,
): string {
  const installationHash = createHash("sha256")
    .update(path.resolve(privateDirectory).toLocaleLowerCase("en-US"), "utf8")
    .digest("hex")
    .slice(0, 24);
  const site = safeTargetSegment(siteId);
  const account = safeTargetSegment(accountId);
  return `McpAccessStack/${installationHash}/${site}/${account}`;
}

async function connectNamedPipe(
  pipePath: string,
  deadline: number,
  child: ChildProcess,
  signal: AbortSignal | undefined,
  launchError: () => Error | undefined,
): Promise<Socket> {
  while (Date.now() < deadline) {
    const processError = launchError();
    if (processError) {
      throw new AppError(
        "CREDENTIAL_BROKER_UNAVAILABLE",
        "Credential broker process could not be started.",
        { cause: processError },
      );
    }
    if (signal?.aborted) {
      throw new AppError(
        "OPERATION_CANCELLED",
        "Credential broker request was cancelled.",
      );
    }
    if (child.exitCode !== null) {
      throw new AppError(
        "CREDENTIAL_BROKER_UNAVAILABLE",
        "Credential broker exited before opening its pipe.",
      );
    }
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection(pipePath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOENT", "ECONNREFUSED", "EPIPE"].includes(code ?? "")) {
        throw new AppError(
          "CREDENTIAL_BROKER_UNAVAILABLE",
          "Credential broker pipe could not be opened.",
          { cause: error },
        );
      }
      await delay(20);
    }
  }
  throw new AppError(
    "CREDENTIAL_BROKER_UNAVAILABLE",
    "Credential broker pipe was not available before the deadline.",
  );
}

function parseBrokerPayload(
  payload: Buffer,
  expectedNonce: string,
  expectedProcessId: number | undefined,
): CredentialBrokerReadResult {
  try {
    let offset = 0;
    requireBytes(payload, offset, BROKER_MAGIC.length);
    const magic = payload.subarray(offset, offset + BROKER_MAGIC.length);
    offset += BROKER_MAGIC.length;
    if (!timingSafeEqual(magic, BROKER_MAGIC)) {
      return { status: "protocol-mismatch" };
    }
    const version = readInt32(payload, offset);
    offset += 4;
    const status = readInt32(payload, offset);
    offset += 4;
    const processId = readInt32(payload, offset);
    offset += 4;
    const nonce = readBuffer(payload, offset, 4_096);
    offset = nonce.nextOffset;
    const username = readBuffer(payload, offset, 65_536);
    offset = username.nextOffset;
    const password = readBuffer(payload, offset, 65_536);
    offset = password.nextOffset;
    if (offset !== payload.length || version !== BROKER_PROTOCOL_VERSION) {
      return { status: "protocol-mismatch" };
    }
    if (expectedProcessId !== undefined && processId !== expectedProcessId) {
      return { status: "protocol-mismatch" };
    }
    const expectedNonceBytes = Buffer.from(expectedNonce, "utf8");
    const nonceMatches = nonce.value.length === expectedNonceBytes.length &&
      timingSafeEqual(nonce.value, expectedNonceBytes);
    expectedNonceBytes.fill(0);
    nonce.value.fill(0);
    if (!nonceMatches) return { status: "protocol-mismatch" };

    if (status === 0) {
      if (username.value.length === 0 || password.value.length === 0) {
        username.value.fill(0);
        password.value.fill(0);
        return { status: "protocol-mismatch" };
      }
      return {
        status: "success",
        secret: new CredentialSecret(username.value, password.value),
      };
    }
    username.value.fill(0);
    password.value.fill(0);
    if (status === 1) return { status: "unavailable" };
    if (status === 2) return { status: "access-denied" };
    if (status === 3) return { status: "protocol-mismatch" };
    return { status: "broker-unavailable" };
  } finally {
    payload.fill(0);
  }
}

function readInt32(payload: Buffer, offset: number): number {
  requireBytes(payload, offset, 4);
  return payload.readInt32LE(offset);
}

function readBuffer(
  payload: Buffer,
  offset: number,
  maximum: number,
): { value: Buffer; nextOffset: number } {
  const length = readInt32(payload, offset);
  offset += 4;
  if (length < 0 || length > maximum) {
    throw new AppError(
      "CREDENTIAL_BROKER_PROTOCOL_MISMATCH",
      "Credential broker returned an invalid field length.",
    );
  }
  requireBytes(payload, offset, length);
  return {
    value: Buffer.from(payload.subarray(offset, offset + length)),
    nextOffset: offset + length,
  };
}

function requireBytes(payload: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > payload.length) {
    throw new AppError(
      "CREDENTIAL_BROKER_PROTOCOL_MISMATCH",
      "Credential broker returned a truncated payload.",
    );
  }
}

function safeTargetSegment(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!/^[a-z0-9._-]{1,128}$/.test(normalized)) {
    throw new AppError(
      "POLICY_INVALID",
      "Credential target contains an invalid site or account identifier.",
    );
  }
  return normalized;
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  try {
    child.kill();
  } catch {
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
