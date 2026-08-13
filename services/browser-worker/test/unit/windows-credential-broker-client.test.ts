import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { describe, expect, it, jest } from "@jest/globals";
import {
  credentialTargetName,
  WindowsCredentialBrokerClient,
} from "../../services/windows-credential-broker-client.js";

const MAGIC = Buffer.from("MCPCRD01", "ascii");

describe("WindowsCredentialBrokerClient", () => {
  it("validates the one-shot binary protocol and returns zeroizable buffers", async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild(4242);
    const client = new WindowsCredentialBrokerClient({
      executablePath: process.execPath,
      privateDirectory: "C:/private/browser",
      platform: "win32",
      spawnProcess: ((_file: string, args: readonly string[]) => {
        capturedArgs = [...args];
        return child;
      }) as never,
      connectPipe: async () =>
        payloadSocket(() => brokerPayload({
          nonce: argument(capturedArgs, "--nonce"),
          processId: 4242,
          status: 0,
          username: "reader",
          password: "secret-value",
        })),
    });

    const result = await client.read({ siteId: "private-site", accountId: "default" });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("Expected credential.");
    expect(result.secret.username.toString("utf8")).toBe("reader");
    expect(result.secret.password.toString("utf8")).toBe("secret-value");
    expect(capturedArgs).not.toContain("reader");
    expect(capturedArgs).not.toContain("secret-value");

    result.secret.dispose();
    expect([...result.secret.username]).toEqual(new Array(6).fill(0));
    expect([...result.secret.password]).toEqual(new Array(12).fill(0));
  });

  it("rejects a response whose nonce or process identity does not match", async () => {
    let capturedArgs: string[] = [];
    const client = new WindowsCredentialBrokerClient({
      executablePath: process.execPath,
      privateDirectory: "C:/private/browser",
      platform: "win32",
      spawnProcess: ((_file: string, args: readonly string[]) => {
        capturedArgs = [...args];
        return fakeChild(7331);
      }) as never,
      connectPipe: async () =>
        payloadSocket(() => brokerPayload({
          nonce: argument(capturedArgs, "--nonce") + "-replayed",
          processId: 7332,
          status: 0,
          username: "reader",
          password: "secret",
        })),
    });

    await expect(client.read({
      siteId: "private-site",
      accountId: "default",
    })).resolves.toEqual({ status: "protocol-mismatch" });
  });

  it("maps a process launch error without emitting an unhandled event", async () => {
    const child = fakeChild(0);
    const client = new WindowsCredentialBrokerClient({
      executablePath: process.execPath,
      privateDirectory: "C:/private/browser",
      platform: "win32",
      timeoutMs: 500,
      spawnProcess: (() => {
        queueMicrotask(() => child.emit("error", new Error("launch denied")));
        return child;
      }) as never,
    });

    await expect(client.read({
      siteId: "private-site",
      accountId: "default",
    })).rejects.toMatchObject({
      code: "CREDENTIAL_BROKER_UNAVAILABLE",
    });
  });

  it("survives a late pipe reset while tearing down the broker socket", async () => {
    let capturedArgs: string[] = [];
    const client = new WindowsCredentialBrokerClient({
      executablePath: process.execPath,
      privateDirectory: "C:/private/browser",
      platform: "win32",
      spawnProcess: ((_file: string, args: readonly string[]) => {
        capturedArgs = [...args];
        return fakeChild(5150);
      }) as never,
      connectPipe: async () =>
        payloadSocketWithResetOnDestroy(() => brokerPayload({
          nonce: argument(capturedArgs, "--nonce"),
          processId: 5150,
          status: 0,
          username: "reader",
          password: "secret",
        })),
    });

    const result = await client.read({
      siteId: "private-site",
      accountId: "default",
    });
    expect(result.status).toBe("success");
    if (result.status === "success") result.secret.dispose();
  });
  it("does not launch a broker outside Windows or without an executable", async () => {
    const spawnProcess = jest.fn();
    const client = new WindowsCredentialBrokerClient({
      privateDirectory: "/private/browser",
      platform: "linux",
      spawnProcess: spawnProcess as never,
    });

    await expect(client.read({
      siteId: "private-site",
      accountId: "default",
    })).resolves.toEqual({ status: "broker-unavailable" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("derives a stable opaque installation-scoped target", () => {
    const first = credentialTargetName(
      "C:/private/browser",
      "private-site",
      "default",
    );
    const second = credentialTargetName(
      "C:/private/browser",
      "private-site",
      "default",
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^McpAccessStack\/[a-f0-9]{24}\/private-site\/default$/);
    expect(first).not.toContain("C:/private/browser");
  });
});

function fakeChild(processId: number): ChildProcess & EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    pid: processId,
    exitCode: null,
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  });
  return child as unknown as ChildProcess & EventEmitter;
}

function payloadSocket(factory: () => Buffer): Promise<Socket> {
  const stream = new PassThrough();
  queueMicrotask(() => stream.end(factory()));
  return Promise.resolve(stream as unknown as Socket);
}

function payloadSocketWithResetOnDestroy(factory: () => Buffer): Promise<Socket> {
  const stream = new PassThrough();
  const destroy = stream.destroy.bind(stream);
  stream.destroy = ((error?: Error) => {
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    stream.emit("error", reset);
    return destroy(error);
  }) as typeof stream.destroy;
  queueMicrotask(() => stream.end(factory()));
  return Promise.resolve(stream as unknown as Socket);
}
function brokerPayload(input: {
  nonce: string;
  processId: number;
  status: number;
  username: string;
  password: string;
}): Buffer {
  const nonce = Buffer.from(input.nonce, "utf8");
  const username = Buffer.from(input.username, "utf8");
  const password = Buffer.from(input.password, "utf8");
  const chunks = [
    MAGIC,
    int32(1),
    int32(input.status),
    int32(input.processId),
    field(nonce),
    field(username),
    field(password),
  ];
  return Buffer.concat(chunks);
}

function field(value: Buffer): Buffer {
  return Buffer.concat([int32(value.length), value]);
}

function int32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeInt32LE(value);
  return result;
}

function argument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    throw new Error(`Missing argument ${name}.`);
  }
  return args[index + 1]!;
}
