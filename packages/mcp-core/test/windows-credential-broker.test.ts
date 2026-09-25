import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { describe, expect, it } from "@jest/globals";
import { WindowsCredentialBrokerClient } from "../src/windows-credential-broker.js";

const READ_MAGIC = Buffer.from("MCPCRD01", "ascii");
const WRITE_MAGIC = Buffer.from("MCPCRW01", "ascii");

describe("WindowsCredentialBrokerClient write/delete", () => {
  it("writes credentials through the pipe without exposing secrets in process arguments", async () => {
    let capturedArgs: string[] = [];
    let writtenPayload = Buffer.alloc(0);
    const child = fakeChild(4242);
    const client = new WindowsCredentialBrokerClient({
      executablePath: process.execPath,
      privateDirectory: "C:/private/mcp-v3",
      platform: "win32",
      spawnProcess: ((_file: string, args: readonly string[]) => {
        capturedArgs = [...args];
        return child;
      }) as never,
      connectPipe: async () => writeSocket(
        (payload) => {
          writtenPayload = Buffer.from(payload);
          return statusPayload({
            nonce: argument(capturedArgs, "--nonce"),
            processId: 4242,
            status: 0,
          });
        },
      ),
    });

    const username = Buffer.from('{"clientId":"client-1","scope":"workspaces:read"}', "utf8");
    const password = Buffer.from("refresh-token-secret-value", "utf8");
    const result = await client.write({
      siteId: "mcp-v3",
      accountId: "oauth-fixture",
      username,
      password,
    });

    expect(result).toEqual({ status: "success" });
    expect(capturedArgs).toContain("write");
    expect(capturedArgs.join(" ")).not.toContain("client-1");
    expect(capturedArgs.join(" ")).not.toContain("refresh-token-secret-value");

    const parsed = parseWritePayload(writtenPayload);
    expect(parsed.nonce).toBe(argument(capturedArgs, "--nonce"));
    expect(parsed.username).toBe(username.toString("utf8"));
    expect(parsed.password).toBe(password.toString("utf8"));
  });

  it("rejects a write acknowledgement with the wrong process identity", async () => {
    let capturedArgs: string[] = [];
    const client = new WindowsCredentialBrokerClient({
      executablePath: process.execPath,
      privateDirectory: "C:/private/mcp-v3",
      platform: "win32",
      spawnProcess: ((_file: string, args: readonly string[]) => {
        capturedArgs = [...args];
        return fakeChild(5150);
      }) as never,
      connectPipe: async () => writeSocket(() => statusPayload({
        nonce: argument(capturedArgs, "--nonce"),
        processId: 5151,
        status: 0,
      })),
    });

    await expect(client.write({
      siteId: "mcp-v3",
      accountId: "oauth-fixture",
      username: Buffer.from("descriptor", "utf8"),
      password: Buffer.from("refresh-token-secret-value", "utf8"),
    })).resolves.toEqual({ status: "protocol-mismatch" });
  });

  it("deletes by opaque target without passing credential contents", async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild(6161);
    const client = new WindowsCredentialBrokerClient({
      executablePath: process.execPath,
      privateDirectory: "C:/private/mcp-v3",
      platform: "win32",
      spawnProcess: ((_file: string, args: readonly string[]) => {
        capturedArgs = [...args];
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      }) as never,
    });

    await client.delete("mcp-v3", "oauth-fixture");

    expect(capturedArgs).toContain("delete");
    expect(capturedArgs).toContain("--target");
    expect(capturedArgs.join(" ")).not.toContain("refresh-token");
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

function writeSocket(
  responseFor: (payload: Buffer) => Buffer,
): Promise<Socket> {
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      const response = responseFor(Buffer.from(chunk));
      queueMicrotask(() => {
        stream.push(response);
        stream.push(null);
      });
      callback();
    },
  });
  return Promise.resolve(stream as unknown as Socket);
}

function statusPayload(input: {
  nonce: string;
  processId: number;
  status: number;
}): Buffer {
  return Buffer.concat([
    READ_MAGIC,
    int32(1),
    int32(input.status),
    int32(input.processId),
    field(Buffer.from(input.nonce, "utf8")),
    field(Buffer.alloc(0)),
    field(Buffer.alloc(0)),
  ]);
}

function parseWritePayload(payload: Buffer): {
  nonce: string;
  username: string;
  password: string;
} {
  let offset = 0;
  expect(payload.subarray(offset, offset + WRITE_MAGIC.length)).toEqual(WRITE_MAGIC);
  offset += WRITE_MAGIC.length;
  expect(payload.readInt32LE(offset)).toBe(1);
  offset += 4;
  const nonce = readField(payload, offset);
  offset = nonce.next;
  const username = readField(payload, offset);
  offset = username.next;
  const password = readField(payload, offset);
  offset = password.next;
  expect(offset).toBe(payload.length);
  return {
    nonce: nonce.value.toString("utf8"),
    username: username.value.toString("utf8"),
    password: password.value.toString("utf8"),
  };
}

function readField(payload: Buffer, offset: number): {
  value: Buffer;
  next: number;
} {
  const length = payload.readInt32LE(offset);
  offset += 4;
  return {
    value: payload.subarray(offset, offset + length),
    next: offset + length,
  };
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
