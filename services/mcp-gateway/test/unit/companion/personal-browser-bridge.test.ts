import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "@jest/globals";
import WebSocket from "ws";
import { PersonalBrowserBridge } from "../../../src/companion/personal-browser-bridge.js";
import {
  PERSONAL_BROWSER_CAPABILITIES,
  PERSONAL_BROWSER_EXTENSION_VERSION,
  PERSONAL_BROWSER_PROTOCOL_VERSION,
} from "../../../src/companion/personal-browser-extension-assets.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("PersonalBrowserBridge", () => {
  it("routes read-only frame sequences atomically and blocks mixed mutations before dispatch", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const requests: Array<{ operation?: string; input?: unknown }> = [];
    const respond = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      requests.push({
        ...(request.operation ? { operation: request.operation } : {}),
        input: request.input,
      });
      if (request.operation !== "frameSequence") return;
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: {
          tabId: "personal:7", completed: true,
          steps: [{ index: 0, action: "index", completed: true,
            value: { items: [], truncated: false, totalCount: 0 } },
          { index: 1, action: "assert", completed: true }],
          telemetry: { totalMs: 12, strategy: "chrome-frame-readonly", retries: 0 },
        },
      }));
    };
    extension.on("message", respond);
    try {
      const input = {
        tabId: "personal:7", steps: [
          { action: "index" as const, framePath: ["menu"], limit: 25 },
          { action: "assert" as const, framePath: ["menu"], condition: "frameReady" as const },
        ],
      };
      await expect(bridge.frameSequence(input)).resolves.toMatchObject({
        tabId: input.tabId, completed: true,
        steps: [{ action: "index" }, { action: "assert" }],
      });
      expect(requests).toEqual([{ operation: "frameSequence", input }]);
      // Mutations need a fresh page guard before anything is dispatched.
      await expect(bridge.frameSequence({ tabId: input.tabId, steps: [
        { action: "index", framePath: ["menu"] },
        { action: "click", framePath: ["menu"], locator: { selector: "#delete" } },
      ] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(requests).toHaveLength(1);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("preflights legacy frame mutations and binds every dangerous target before consuming a confirmation", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const tabId = "personal:7";
    const requests: Array<Record<string, unknown>> = [];
    let targets = [
      { index: 1, label: "Excluir pedido", role: "button", submitLike: false },
      { index: 2, label: "keyboard:Enter", role: "keyboard", submitLike: true },
    ];
    const respond = (data: WebSocket.RawData) => {
      const req = JSON.parse(data.toString()) as WireMessage;
      if (req.type !== "request") return;
      const input = req.input as Record<string, unknown>;
      let result: unknown = { tabId, url: "https://legacy.example/", content: "Legacy", refs: [] };
      if (req.operation === "frameSequence") {
        requests.push(input);
        result = input.phase === "preflight"
          ? { tabId, completed: true, steps: targets.map(({ index, ...value }) => ({
            index, action: index === 1 ? "click" : "press", completed: true, value,
            strategy: "chrome-frame-preflight" })),
          telemetry: { totalMs: 1, strategy: "chrome-frame-preflight", retries: 0 } }
          : { tabId, completed: true, steps: [0, 1, 2].map((index) => ({
            index, action: ["fill", "click", "press"][index], completed: true })),
          telemetry: { totalMs: 3, strategy: "chrome-frame-native-input", retries: 0 } };
      }
      extension.send(JSON.stringify({ type: "response", id: req.id, ok: true, result }));
    };
    extension.on("message", respond);
    const confirmationOf = async (promise: Promise<unknown>): Promise<string> => {
      try {
        await promise;
      } catch (error) {
        const typed = error as { code: string; message: string };
        expect(typed.code).toBe("ACTION_REQUIRES_CONFIRMATION");
        return JSON.parse(typed.message.slice(typed.message.indexOf("{"))).confirmationId as string;
      }
      throw new Error("Expected a confirmation request.");
    };
    try {
      await bridge.snapshot({ tabId });
      const fill = { action: "fill" as const, framePath: ["main"], locator: { name: "pedido" }, value: "42" };
      const click = { action: "click" as const, framePath: ["main"], locator: { selector: "#excluir" } };
      const press = { action: "press" as const, framePath: ["main"], key: "Enter" };
      const steps = [fill, click, press];
      const first = await confirmationOf(bridge.frameSequence({ tabId, steps }));
      expect(requests.map((request) => request.phase)).toEqual(["preflight"]);
      expect(requests[0]).toMatchObject({ guard: { url: "https://legacy.example/" } });
      // A later missing confirmation must not consume the earlier one.
      const second = await confirmationOf(bridge.frameSequence({ tabId, steps: [
        fill, { ...click, confirmationId: first }, press,
      ] }));
      expect(second).not.toBe(first);
      const confirmed = [fill, { ...click, confirmationId: first }, { ...press, confirmationId: second }];
      await expect(bridge.frameSequence({ tabId, steps: confirmed })).resolves.toMatchObject({
        completed: true, steps: [{ action: "fill" }, { action: "click" }, { action: "press" }],
      });
      expect(requests.map((request) => request.phase))
        .toEqual(["preflight", "preflight", "preflight", "execute"]);
      expect(requests[3]).toMatchObject({ phase: "execute", expectedTargets: targets });
      // Confirmations are single use.
      await expect(bridge.frameSequence({ tabId, steps: confirmed }))
        .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
      // A preflight that omits a click step cannot be used to skip confirmation.
      targets = [targets[1]!];
      await expect(bridge.frameSequence({ tabId, steps }))
        .rejects.toMatchObject({ code: "RELAY_PROTOCOL_ERROR" });
      expect(requests.filter((request) => request.phase === "execute")).toHaveLength(1);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("refuses legacy frame mutations when the extension lacks the mutation capability", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-personal-browser-"));
    temporaryRoots.push(root);
    const port = await reservePort();
    const bridge = await PersonalBrowserBridge.start({ stateRoot: root, port });
    const workerSource = await readFile(
      path.join(root, "browser", "personal-extension", "service-worker.js"), "utf8");
    const token = /const BRIDGE_TOKEN = "([^"]+)";/u.exec(workerSource)?.[1] ?? "";
    const extension = await connectExtension(port, token,
      PERSONAL_BROWSER_CAPABILITIES.filter((capability) => capability !== "frameSequenceMutationsV1"));
    const operations: string[] = [];
    extension.on("message", (data: WebSocket.RawData) => {
      const req = JSON.parse(data.toString()) as WireMessage;
      if (req.type === "request" && req.operation) operations.push(req.operation);
    });
    try {
      await expect(bridge.frameSequence({ tabId: "personal:7", steps: [
        { action: "click", locator: { selector: "#go" } },
      ] })).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_UNSUPPORTED" });
      expect(operations).toEqual([]);
    } finally {
      extension.close();
      await bridge.close();
    }
  });

  it("binds physical canvas drags to fresh screenshot evidence and a one-use confirmation", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const tabId = "personal:7";
    const sent: Array<Record<string, unknown>> = [];
    const respond = (data: WebSocket.RawData) => {
      const req = JSON.parse(data.toString()) as WireMessage;
      if (req.type !== "request") return;
      const result = req.operation === "snapshot"
        ? { tabId, url: "https://example.com/", content: "Map canvas", refs: [] }
        : req.operation === "screenshot"
          ? { tabId, path: "/private/s.png", mimeType: "image/png",
            contentBase64: "aGVsbG8=", sizeBytes: 5 }
          : { tabId, completed: true };
      if (req.operation === "drag") sent.push(req.input as Record<string, unknown>);
      extension.send(JSON.stringify({ type: "response", id: req.id, ok: true, result }));
    };
    extension.on("message", respond);
    try {
      const input = { tabId, from: { x: 110, y: 120 },
        to: { x: 240, y: 260 }, steps: 8 };
      await expect(bridge.drag(input))
        .rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });
      await bridge.screenshot({ tabId });
      let confirmationId = "";
      try { await bridge.drag(input); }
      catch (error) {
        const typed = error as { code: string; message: string };
        expect(typed.code).toBe("ACTION_REQUIRES_CONFIRMATION");
        confirmationId = JSON.parse(typed.message.slice(typed.message.indexOf("{"))).confirmationId;
      }
      expect(confirmationId).toBeTruthy();
      expect(sent).toHaveLength(0);
      await expect(bridge.drag({ ...input, confirmationId }))
        .resolves.toMatchObject({ completed: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ from: input.from, to: input.to,
        fromGuard: { url: "https://example.com/", pixel: true, x: 110, y: 120 },
        toGuard: { url: "https://example.com/", pixel: true, x: 240, y: 260 } });
      await expect(bridge.drag({ ...input, confirmationId }))
        .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
      expect(sent).toHaveLength(1);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("requires fresh screenshot and single-use confirmation before a pixel-only canvas click", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const tabId = "personal:7";
    const dispatched: Array<Record<string, unknown>> = [];
    const handler = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (message.type !== "request") return;
      const result = message.operation === "snapshot"
        ? { tabId, url: "https://example.com/", content: "Canvas drawing",
            refs: [], pointTarget: undefined }
        : message.operation === "screenshot"
          ? { tabId, path: "/private/screen.png", sizeBytes: 5,
              mimeType: "image/png", contentBase64: "aGVsbG8=" }
          : { tabId, completed: true };
      if (message.operation === "click") dispatched.push(message.input as Record<string, unknown>);
      extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
    };
    extension.on("message", handler);
    try {
      await expect(bridge.click({ tabId, x: 190, y: 120 }))
        .rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });
      await bridge.screenshot({ tabId });
      let confirmationId = "";
      try {
        await bridge.click({ tabId, x: 190, y: 120, button: "right" });
      } catch (error) {
        const typed = error as { code: string; message: string };
        expect(typed.code).toBe("ACTION_REQUIRES_CONFIRMATION");
        confirmationId = JSON.parse(typed.message.slice(typed.message.indexOf("{"))).confirmationId;
      }
      expect(confirmationId).toBeTruthy();
      expect(dispatched).toHaveLength(0);
      await expect(bridge.click({ tabId, x: 190, y: 120,
        button: "right", confirmationId })).resolves.toMatchObject({ completed: true });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({ tabId, x: 190, y: 120,
        button: "right", guard: { url: "https://example.com/", pixel: true, x: 190, y: 120 } });
      await expect(bridge.click({ tabId, x: 190, y: 120,
        button: "right", confirmationId })).rejects.toMatchObject({
          code: "BROWSER_CONFIRMATION_INVALID",
        });
      expect(dispatched).toHaveLength(1);
    } finally {
      extension.off("message", handler);
      await close();
    }
  });

  it("routes legacy page profiles and frame DOM indices only through the authenticated owned-tab Chrome bridge", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const received: Array<{ operation?: string; input?: unknown }> = [];
    const reply = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (message.type !== "request") return;
      received.push({ ...(message.operation ? { operation: message.operation } : {}),
        input: message.input });
      const result = message.operation === "profilePage"
        ? { tabId: "personal:7", profile: "legacy-frames", signals: {
          frames: 1, nestedFrames: 0, layoutTables: 0, inlineHandlers: 0,
          hashLinks: 0, targetedNavigation: 0, postForms: 0,
        }, pageSignature: "12345678", frameGraphSignature: "87654321",
        frames: [{ path: ["menu"], name: "menu", index: 0, status: "ready",
          signature: "11223344", children: [] }], telemetry: { totalMs: 1 } }
        : { tabId: "personal:7", framePath: ["menu"], pageSignature: "12345678",
            frameGraphSignature: "87654321", offset: 0, truncated: false,
            totalCount: 1, items: [{ ref: "lref_12345678", tag: "button", id: "save",
              text: "Save", visible: true, enabled: true, selector: "#save",
              framePath: ["menu"], ancestors: [] }], telemetry: { totalMs: 1 } };
      extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
    };
    extension.on("message", reply);
    try {
      const profile = await bridge.profilePage({ tabId: "personal:7", maxDepth: 4 });
      expect(profile).toMatchObject({ profile: "legacy-frames",
        frames: [{ path: ["menu"] }] });
      const index = await bridge.domIndex({ tabId: "personal:7",
        framePath: ["menu"], visibleOnly: true });
      expect(index).toMatchObject({ items: [{ ref: "lref_12345678" }] });
      expect(received).toEqual([
        { operation: "profilePage", input: { tabId: "personal:7", maxDepth: 4 } },
        { operation: "domIndex", input: {
          tabId: "personal:7", framePath: ["menu"], visibleOnly: true,
        } },
      ]);
    } finally {
      extension.off("message", reply);
      await close();
    }
  });

  it("routes named-frame extraction only through the authenticated personal Chrome extension", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const captured: Array<{ operation?: string; input: unknown }> = [];
    const respond = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      captured.push({ ...(request.operation ? { operation: request.operation } : {}), input: request.input });
      extension.send(JSON.stringify({ type: "response", id: request.id, ok: true,
        result: { tabId: "personal:7", frame: "Corpo do conteúdo", format: "text",
          value: "Scoped content" } }));
    };
    extension.on("message", respond);
    try {
      await expect(bridge.frameExtract({ tabId: "personal:7", frame: "Corpo do conteúdo" }))
        .resolves.toMatchObject({ tabId: "personal:7", frame: "Corpo do conteúdo", value: "Scoped content" });
      expect(captured).toEqual([{ operation: "frameExtract",
        input: { tabId: "personal:7", frame: "Corpo do conteúdo" } }]);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("guards direct-frame click/fill with the previously observed owned parent URL", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const tabId = "personal:7";
    const forwarded: Array<{ operation: string; input: Record<string, unknown> }> = [];
    try {
      await primeReference(bridge, extension, tabId);
      const respond = (data: WebSocket.RawData) => {
        const request = JSON.parse(data.toString()) as WireMessage;
        if (request.type !== "request" || !request.operation ||
            !["frameClick", "frameFill"].includes(request.operation)) return;
        forwarded.push({ operation: request.operation, input: request.input as Record<string, unknown> });
        extension.send(JSON.stringify({ type: "response", id: request.id, ok: true,
          result: { tabId, completed: true } }));
      };
      extension.on("message", respond);
      try {
        await expect(bridge.frameClick({ tabId, frame: "details", selector: "#save" }))
          .resolves.toEqual({ tabId, completed: true });
        await expect(bridge.frameFill({ tabId, frame: "details", selector: "#title", value: "Draft" }))
          .resolves.toEqual({ tabId, completed: true });
        expect(forwarded).toEqual([
          { operation: "frameClick", input: { tabId, frame: "details", selector: "#save",
            guard: { url: "https://example.com/" } } },
          { operation: "frameFill", input: { tabId, frame: "details", selector: "#title",
            value: "Draft", guard: { url: "https://example.com/" } } },
        ]);
      } finally {
        extension.off("message", respond);
      }
    } finally {
      await close();
    }
  });

  it("routes the owned-tab viewport preset and reset without altering unrelated Chrome tabs", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const requests: Array<{ operation?: string; input: unknown }> = [];
    const respond = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      requests.push({ ...(request.operation ? { operation: request.operation } : {}), input: request.input });
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: { tabId: "personal:7", width: 375, height: 812, deviceScaleFactor: 3,
          mobile: true, touch: true, colorScheme: "dark", emulated: true,
          userAgent: "Mozilla/5.0 Chrome/155.0.0.0 Mobile Safari/537.36" },
      }));
    };
    extension.on("message", respond);
    try {
      await expect(bridge.viewport({ tabId: "personal:7", preset: "mobile", colorScheme: "dark" }))
        .resolves.toMatchObject({ tabId: "personal:7", width: 375, mobile: true, emulated: true });
      expect(requests).toEqual([{
        operation: "viewport", input: { tabId: "personal:7", preset: "mobile", colorScheme: "dark" },
      }]);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("reads a dialog and dismisses only the exact observed message", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const actions: string[] = [];
    const respond = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      actions.push((request.input as { action?: string }).action ?? "");
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: { tabId: "personal:7", state: (request.input as { action?: string } | undefined)?.action === "inspect" ? "open" : "idle",
          ...((request.input as { action?: string } | undefined)?.action === "inspect" ? {
            dialogType: "confirm", message: "Continue?",
            expiresAt: "2026-10-20T12:00:30.000Z",
          } : {}) },
      }));
    };
    extension.on("message", respond);
    try {
      await expect(bridge.dialog({ tabId: "personal:7", action: "respond",
        response: "dismiss", expectedMessage: "Continue?" }))
        .resolves.toMatchObject({ state: "idle" });
      expect(actions).toEqual(["inspect", "respond"]);
      await expect(bridge.dialog({ tabId: "personal:7", action: "respond",
        response: "dismiss", expectedMessage: "Changed?" }))
        .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
      expect(actions).toEqual(["inspect", "respond", "inspect"]);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("moves one owned Chrome download into private storage and rejects paths outside its one-time staging scope", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const tabId = "personal:7";
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-download-staging-"));
    temporaryRoots.push(stagingRoot);
    let stagedPath = "";
    let unsafe = false;
    try {
      await primeReference(bridge, extension, tabId);
      const responder = async (data: WebSocket.RawData) => {
        const request = JSON.parse(data.toString()) as WireMessage;
        if (request.type !== "request" || request.operation !== "download") return;
        const input = request.input as { runId: string; guard: { url: string } };
        expect(input.guard.url).toBe("https://example.com/");
        const directory = path.join(stagingRoot, "MCP-V3-Staging", input.runId);
        await mkdir(directory, { recursive: true });
        stagedPath = unsafe ? path.join(stagingRoot, "unsafe.txt") : path.join(directory, "report.txt");
        await writeFile(stagedPath, "hello");
        extension.send(JSON.stringify({
          type: "response", id: request.id, ok: true,
          result: { tabId, path: stagedPath, suggestedFilename: "report.txt", sizeBytes: 5 },
        }));
      };
      extension.on("message", responder);
      try {
        const result = await bridge.download({ tabId, url: "https://example.com/report.txt" });
        expect(result.path).toContain("personal-artifacts");
        expect(result.path).toContain("downloads");
        expect(result.sizeBytes).toBe(5);
        expect((await readFile(result.path)).toString()).toBe("hello");
        await expect(readFile(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
        unsafe = true;
        await expect(bridge.download({ tabId, url: "https://example.com/other.txt" }))
          .rejects.toMatchObject({ code: "RELAY_PROTOCOL_ERROR" });
      } finally {
        extension.off("message", responder);
      }
    } finally {
      await close();
    }
  });

  it("stages authorized Chrome uploads privately and removes temporary bytes after native selection", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const tabId = "personal:7";
    let stagePath = "";
    try {
      await primeReference(bridge, extension, tabId);
      const input = { tabId, selector: "input[type=file]",
        files: [{ name: "receipt.pdf", contentBase64: "aGVsbG8=" }] };
      let confirmationId = "";
      try {
        await bridge.upload(input);
      } catch (error) {
        const typed = error as { code: string; message: string };
        expect(typed.code).toBe("ACTION_REQUIRES_CONFIRMATION");
        confirmationId = JSON.parse(typed.message.slice(typed.message.indexOf("{"))).confirmationId;
        expect(typed.message).not.toContain("aGVsbG8");
      }
      expect(confirmationId).toBeTruthy();
      const reply = async (data: WebSocket.RawData) => {
        const request = JSON.parse(data.toString()) as WireMessage;
        if (request.type !== "request" || request.operation !== "upload") return;
        const info = request.input as { files: Array<{ name: string; path: string }>;
          guard: { url: string }; totalBytes: number };
        stagePath = info.files[0]!.path;
        expect(info.guard.url).toBe("https://example.com/");
        expect(stagePath).toContain("personal-artifacts");
        expect(stagePath).toContain("uploads");
        expect((await readFile(stagePath)).toString()).toBe("hello");
        extension.send(JSON.stringify({
          type: "response", id: request.id, ok: true,
          result: { tabId, completed: true, fileCount: 1, totalBytes: info.totalBytes },
        }));
      };
      extension.on("message", reply);
      try {
        await expect(bridge.upload({ ...input, confirmationId })).resolves.toEqual({
          tabId, completed: true, fileCount: 1, totalBytes: 5,
        });
        await expect(readFile(stagePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        extension.off("message", reply);
      }
    } finally {
      await close();
    }
  });

  it("materializes a final screenshot after a sequence and keeps transport base64 out of the result", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const seen: string[] = [];
    const respond = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      if (request.operation) seen.push(request.operation);
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: request.operation === "sequence"
          ? { tabId: "personal:7", completed: true,
              steps: [{ index: 0, action: "wait", completed: true, durationMs: 5 }],
              actionSummary: [{ index: 0, action: "wait", durationMs: 5 }] }
          : { tabId: "personal:7", path: "/runtime/staged.png", sizeBytes: 5,
              mimeType: "image/png", contentBase64: "aGVsbG8=" },
      }));
    };
    extension.on("message", respond);
    try {
      const result = await bridge.sequence({ tabId: "personal:7",
        steps: [{ action: "wait", timeoutMs: 5 }], finalScreenshot: true });
      expect(seen).toEqual(["sequence", "screenshot"]);
      expect(result).toMatchObject({ completed: true, screenshot: { sizeBytes: 5,
        path: expect.stringContaining("personal-artifacts") } });
      expect(JSON.stringify(result)).not.toContain("aGVsbG8");
      expect(result.actionSummary).toHaveLength(1);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("routes select_tab to the owned Chrome extension without touching other tabs", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const requests: Array<{ operation?: string; input: unknown }> = [];
    const handle = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      requests.push({ ...(request.operation ? { operation: request.operation } : {}), input: request.input });
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: { tab: {
          tabId: "personal:7", url: "https://example.test/",
          ownership: "mcp", lifecycle: "task-scoped", taskId: "task-1",
          purpose: "test", reusable: false, protected: false, sticky: false,
          createdAt: "2026-10-20T10:00:00.000Z", lastUsedAt: "2026-10-20T10:00:00.000Z",
        } },
      }));
    };
    extension.on("message", handle);
    try {
      await expect(bridge.selectTab({ tabId: "personal:7" }))
        .resolves.toMatchObject({ tab: { tabId: "personal:7" } });
      expect(requests).toEqual([{ operation: "selectTab", input: { tabId: "personal:7" } }]);
    } finally {
      extension.off("message", handle);
      await close();
    }
  });

  it("materializes a private PDF artifact and rejects corrupt Chrome payloads", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    let invalid = false;
    const handle = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: { tabId: "personal:7", kind: "pdf",
          contentBase64: invalid ? "YmFk" : "JVBERi0xLjQKZW5k",
          sizeBytes: invalid ? 3 : 12,
          createdAt: "2026-10-20T11:00:00.000Z" },
      }));
    };
    extension.on("message", handle);
    try {
      const pdf = await bridge.pdf({ tabId: "personal:7", filename: "report.pdf" });
      expect(pdf).toMatchObject({ kind: "pdf", tabId: "personal:7", sizeBytes: 12 });
      expect(pdf.path).toContain("personal-artifacts");
      expect(pdf.path).toContain("pdfs");
      expect(pdf.path).toContain("report.pdf");
      expect((await readFile(pdf.path)).toString("ascii").startsWith("%PDF-")).toBe(true);
      invalid = true;
      await expect(bridge.pdf({ tabId: "personal:7" })).rejects.toMatchObject({ code: "RELAY_PROTOCOL_ERROR" });
    } finally {
      extension.off("message", handle);
      await close();
    }
  });

  it("collects personal Chrome diagnostics serially without competing CDP debugger attachments", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const seen: string[] = [];
    const respond = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      if (request.operation) seen.push(request.operation);
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: { tabId: "personal:7", text: request.operation === "console" ? "[error] Failed" : "1. GET https://api.test/ 500",
          truncated: false, collectedAt: "2026-10-20T11:00:00.000Z" },
      }));
    };
    extension.on("message", respond);
    try {
      await expect(bridge.diagnostics({
        tabId: "personal:7", consoleLevel: "error", requestFilter: "api[.]test",
      })).resolves.toMatchObject({
        console: { text: "[error] Failed" },
        network: { text: "1. GET https://api.test/ 500" },
        traceActive: false, videoActive: false,
      });
      expect(seen).toEqual(["console", "networkList"]);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("routes network list and request inspection without exposing tab data through another tab", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const requests: Array<{ operation?: string; input?: unknown }> = [];
    const respond = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      requests.push({ ...(request.operation ? { operation: request.operation } : {}), input: request.input });
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: { tabId: "personal:7", text: "1. GET https://example.test/api 200",
          truncated: false, collectedAt: "2026-10-20T10:00:00.000Z" },
      }));
    };
    extension.on("message", respond);
    try {
      await expect(bridge.networkList({ tabId: "personal:7", filter: "example" }))
        .resolves.toMatchObject({ tabId: "personal:7", truncated: false });
      await expect(bridge.networkInspect({ tabId: "personal:7", index: 1, detail: "request" }))
        .resolves.toMatchObject({ tabId: "personal:7" });
      expect(requests).toEqual([
        { operation: "networkList", input: { tabId: "personal:7", filter: "example" } },
        { operation: "networkInspect", input: { tabId: "personal:7", index: 1, detail: "request" } },
      ]);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("routes sanitized Chrome personal console reads through the authorized extension", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const requests: Array<{ operation?: string; input?: unknown }> = [];
    const respond = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request") return;
      requests.push({ ...(request.operation ? { operation: request.operation } : {}), input: request.input });
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: { tabId: "personal:7", text: "[error] TypeError: failed", truncated: false, collectedAt: "2026-10-20T10:00:00.000Z" },
      }));
    };
    extension.on("message", respond);
    try {
      await expect(bridge.console({ tabId: "personal:7", pattern: "TypeError", onlyErrors: true, limit: 10 }))
        .resolves.toMatchObject({ text: "[error] TypeError: failed" });
      expect(requests).toEqual([{ operation: "console", input: { tabId: "personal:7", pattern: "TypeError", onlyErrors: true, limit: 10 } }]);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });


  it("resolves viewport coordinates to authenticated structured refs before clicking or hovering", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const requests: Array<{ operation?: string; input: Record<string, unknown> }> = [];
    const respond = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (message.type !== "request") return;
      requests.push({ ...(message.operation ? { operation: message.operation } : {}), input: message.input as Record<string, unknown> });
      const result = message.operation === "snapshot"
        ? {
          tabId: "personal:7", url: "https://example.com/",
          content: '- link "Help" [ref=p-7]',
          refs: [{ ref: "p-7", role: "link", name: "Help" }],
          pointTarget: { ref: "p-7", role: "link", name: "Help" },
        }
        : { tabId: "personal:7", completed: true };
      extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
    };
    extension.on("message", respond);
    try {
      await expect(bridge.click({ tabId: "personal:7", x: 31, y: 44 }))
        .resolves.toMatchObject({ tabId: "personal:7", completed: true });
      expect(requests.map((request) => request.operation)).toEqual(["snapshot", "click"]);
      expect(requests[0]?.input).toMatchObject({ tabId: "personal:7", point: { x: 31, y: 44 } });
      expect(requests[1]?.input).toMatchObject({
        tabId: "personal:7", ref: "p-7", x: 31, y: 44,
        guard: { ref: "p-7", role: "link", name: "Help" },
      });
      requests.length = 0;
      await expect(bridge.hover({ tabId: "personal:7", x: 31, y: 44 }))
        .resolves.toMatchObject({ completed: true });
      expect(requests.map((request) => request.operation)).toEqual(["snapshot", "hover"]);
      expect(requests[1]?.input).toMatchObject({ ref: "p-7", x: 31, y: 44 });
    } finally {
      extension.off("message", respond);
      await close();
    }
  });
  it("projects personal snapshots while preserving full authenticated refs and revision history", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const requests: Array<Record<string, unknown>> = [];
    let pageText = "Login page";
    const respond = (data: WebSocket.RawData) => {
      const request = JSON.parse(data.toString()) as WireMessage;
      if (request.type !== "request" || request.operation !== "snapshot") return;
      requests.push(request.input as Record<string, unknown>);
      extension.send(JSON.stringify({
        type: "response", id: request.id, ok: true, result: {
          tabId: "personal:7", url: "https://example.com/",
          pageInstanceId: "document-7",
          content: pageText + '\nInteractive elements:\n- button "Continue" [ref=p-7]\n- link "Help" [ref=p-8]',
          refs: [
            { ref: "p-7", role: "button", name: "Continue" },
            { ref: "p-8", role: "link", name: "Help" },
          ],
        },
      }));
    };
    extension.on("message", respond);
    try {
      const first = await bridge.snapshot({ tabId: "personal:7" });
      expect(first.state).toMatchObject({ kind: "full", documentId: "document-7", revision: 1 });
      const second = await bridge.snapshot({ tabId: "personal:7", knownRevision: 1 });
      expect(second.state?.kind).toBe("unchanged");
      expect(second.content).toBe("");
      pageText = "Updated";
      const projected = await bridge.snapshot({
        tabId: "personal:7", knownRevision: 1, filter: "interactive", maxChars: 110,
      });
      expect(projected.content).not.toContain("Updated");
      expect(projected.content).toContain('button "Continue"');
      expect(projected.state?.kind).toBe("full");
      expect(projected.state?.snapshot).toBe(projected.content);
      expect(projected.refs).toHaveLength(2);
      expect(requests[2]).toMatchObject({ tabId: "personal:7", forceFull: true });
      await expect(bridge.find({ tabId: "personal:7", query: "Continue", role: "button" }))
        .resolves.toMatchObject({ matches: [{ ref: "p-7" }] });
    } finally {
      extension.off("message", respond);
      await close();
    }
  });
  it("finds fresh refs through the authenticated Chrome snapshot without a new extension operation", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    const operations: string[] = [];
    const respond = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (message.type !== "request") return;
      operations.push(message.operation ?? "");
      if (message.operation !== "snapshot") return;
      extension.send(JSON.stringify({
        type: "response", id: message.id, ok: true,
        result: {
          tabId: "personal:7", url: "https://example.com/",
          content: '- button "Enviar" [ref=valid-1]',
          refs: [
            { ref: "valid-1", role: "button", name: "Enviar" },
            { ref: "valid-2", role: "link", name: "Enviar relatório" },
          ],
        },
      }));
    };
    extension.on("message", respond);
    try {
      await expect(bridge.find({ tabId: "personal:7", query: "enviar", role: "button" }))
        .resolves.toMatchObject({
          matches: [{ ref: "valid-1", role: "button", name: "Enviar", score: 100 }],
        });
      expect(operations).toEqual(["snapshot"]);
    } finally {
      extension.off("message", respond);
      await close();
    }
  });

  it("logs a safe peer error code with a terminal but never its private message", async () => {
    const events: Record<string, unknown>[]=[];
    const { bridge,extension,close }=await startAuthenticatedBridge(e => events.push(e));
    await primeReference(bridge, extension, "personal:1");
    events.length = 0;
    extension.on("message", data => { const m=JSON.parse(data.toString()) as WireMessage; if(m.type==="request") extension.send(JSON.stringify({ type:"response",id:m.id,ok:false,error:{code:"LOCATOR_NOT_FOUND",message:"secret-user-message"} })); });
    try {
      await expect(bridge.fill({tabId:"personal:1",ref:"ref",value:"secret-fill"})).rejects.toMatchObject({code:"LOCATOR_NOT_FOUND"});
      expect(events.filter(e=>e.event==="browser_latency")).toEqual([expect.objectContaining({outcome:"error",errorCode:"LOCATOR_NOT_FOUND"})]);
      expect(JSON.stringify(events)).not.toContain("secret-");
    } finally {await close();}
  });
  it("correlates concurrent tabs and fresh sequential calls without logging input or trusting peer metrics", async () => {
    const events: Record<string, unknown>[] = [];
    const { bridge, extension, close } = await startAuthenticatedBridge(e => events.push(e));
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const requests: WireMessage[] = [];
    await primeReference(bridge, extension, "personal:1");
    await primeReference(bridge, extension, "personal:2");
    events.length = 0;
    extension.on("message", data => {
      const m = JSON.parse(data.toString()) as WireMessage;
      if (m.type !== "request") return;
      requests.push(m);
      extension.send(JSON.stringify({ type: "response", id: m.id, ok: true,
        result: { tabId: (m.input as { tabId: string }).tabId, completed: true },
        timing: { receivedAt: Date.now(), totalMs: 2, queueMs: 0, actionMs: 1, snapshotMs: 1, serializationMs: 0,
          value: "secret-peer-value", contentBase64: "secret-image" } }));
    });
    try {
      await Promise.all(ids.map((requestId, i) => bridge.fill({ tabId: "personal:" + (i+1), ref: "ref", value: "secret-fill-value" },
        { latency: { requestId, gatewayRequestId: requestId }, invocationId: requestId } as never)));
      await bridge.fill({ tabId: "personal:1", ref: "ref", value: "secret-sequential-value" },
        { latency: { requestId: ids[0], gatewayRequestId: ids[0] }, invocationId: ids[0] } as never);
      const terminal = events.filter(e => e.event === "browser_latency" && e.layer === "bridge");
      expect(terminal).toHaveLength(3);
      expect(terminal.map(e => e.requestId)).toEqual([ids[0], ids[1], ids[0]]);
      expect(new Set(terminal.map(e => e.bridgeRequestId)).size).toBe(3);
      for (const e of terminal) {
        expect(e.outcome).toBe("success");
        expect(e.durationMs).toEqual(expect.any(Number));
        expect(e.durationMs as number).toBeGreaterThanOrEqual(0);
        expect(e.requestBytes as number).toBeGreaterThan(0);
        expect(e.responseBytes as number).toBeGreaterThan(0);
        expect(e.extensionTotalMs).toBe(2);
        expect(JSON.stringify(e).length).toBeLessThan(2048);
      }
      expect(requests.every(m => m.measureTiming === true)).toBe(true);
      expect(JSON.stringify(terminal)).not.toMatch(/secret-|token|ownerScope/);
    } finally { await close(); }
  });

  it("emits exactly one terminal event after mutation cancellation and ignores late replies", async () => {
    const events: Record<string, unknown>[] = [];
    const { bridge, extension, close } = await startAuthenticatedBridge(e => events.push(e));
    const controller = new AbortController();
    try {
      await primeReference(bridge, extension, "personal:7");
      events.length = 0;
      const dispatched = nextWireMessage(extension, m => m.type === "request");
      const result = bridge.fill({ tabId: "personal:7", ref: "ref", value: "secret" }, { signal: controller.signal });
      const rejection = expect(result).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
      const request = await dispatched;
      controller.abort();
      await rejection;
      extension.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { tabId: "personal:7", completed: true } }));
      const terminal = events.filter(e => e.event === "browser_latency");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ outcome: "cancelled", errorCode: "EXECUTION_OUTCOME_UNKNOWN" });
    } finally { await close(); }
  });

  it("materializes the extension, rejects an invalid token and accepts authenticated RPC", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-personal-browser-"));
    temporaryRoots.push(root);
    const port = await reservePort();
    const bridge = await PersonalBrowserBridge.start({
      stateRoot: root,
      port,
    });

    const manifestPath = path.join(
      root,
      "browser",
      "personal-extension",
      "manifest.json",
    );
    const workerPath = path.join(
      root,
      "browser",
      "personal-extension",
      "service-worker.js",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      manifest_version: number;
      permissions: string[];
    };
    const workerSource = await readFile(workerPath, "utf8");
    const token = /const BRIDGE_TOKEN = "([^"]+)";/u.exec(workerSource)?.[1];

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining([
      "tabs",
      "scripting",
      "storage",
      "debugger",
    ]));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(() => new Script(workerSource)).not.toThrow();
    const popupHtml = await readFile(path.join(root, "browser", "personal-extension", "secret-provision.html"), "utf8");
    const popupJs = await readFile(path.join(root, "browser", "personal-extension", "secret-provision.js"), "utf8");
    expect(popupHtml).toContain("MCP_CONTRACT_PREPARE_TOKEN");
    expect(popupHtml).toContain("secret-provision.js");
    expect(() => new Script(popupJs)).not.toThrow();
    expect(workerSource).toContain("chrome.storage.session");

    const rejected = new WebSocket(
      `ws://127.0.0.1:${port}/?token=invalid`,
    );
    const rejectedCode = await new Promise<number>((resolve, reject) => {
      rejected.once("close", (code) => resolve(code));
      rejected.once("error", reject);
    });
    expect(rejectedCode).toBe(1008);
    expect(bridge.isConnected()).toBe(false);

    const extension = await connectExtension(port, token!);
    expect(bridge.isConnected()).toBe(true);
    expect(bridge.connectionInfo()).toMatchObject({
      connected: true,
      browser: "chrome",
      profile: "personal",
      protocolVersion: PERSONAL_BROWSER_PROTOCOL_VERSION,
      extensionVersion: PERSONAL_BROWSER_EXTENSION_VERSION,
      capabilities: [...PERSONAL_BROWSER_CAPABILITIES],
    });

    extension.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        id?: string;
        operation?: string;
      };
      if (message.type !== "request" || !message.id) return;
      if (message.operation !== "tabs") return;
      extension.send(JSON.stringify({
        type: "response",
        id: message.id,
        ok: true,
        result: { tabs: [] },
      }));
    });

    await expect(bridge.tabs({})).resolves.toEqual({ tabs: [] });

    extension.close();
    await new Promise<void>((resolve) => extension.once("close", () => resolve()));
    await bridge.close();
  });

  it("materializes configured private-site origins into the personal denylist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-personal-browser-"));
    temporaryRoots.push(root);
    const privateDirectory = path.join(root, "browser", "private");
    await mkdir(privateDirectory, { recursive: true });
    await writeFile(
      path.join(privateDirectory, "site-policies.json"),
      JSON.stringify([{
        siteId: "private-test",
        entryUrl: "https://private.example.test/app",
        allowedOrigins: [
          "https://private.example.test",
          "https://api.private.example.test",
        ],
      }]),
      "utf8",
    );
    const port = await reservePort();
    const bridge = await PersonalBrowserBridge.start({ stateRoot: root, port });
    const workerSource = await readFile(
      path.join(root, "browser", "personal-extension", "service-worker.js"),
      "utf8",
    );

    expect(workerSource).toContain(
      'const BLOCKED_PRIVATE_ORIGINS = new Set(["https://api.private.example.test","https://private.example.test"]);',
    );
    await bridge.close();
  });

  it("persists personal screenshot bytes returned by the extension", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    try {
      extension.on("message", (data) => {
        const message = JSON.parse(data.toString()) as WireMessage;
        if (message.type !== "request" || message.operation !== "screenshot" || !message.id) return;
        extension.send(JSON.stringify({
          type: "response",
          id: message.id,
          ok: true,
          result: {
            tabId: "personal:7",
            path: "personal://screenshot/test.jpg",
            sizeBytes: 3,
            mimeType: "image/jpeg",
            contentBase64: "YWJj",
          },
        }));
      });

      const result = await bridge.screenshot({ tabId: "personal:7" });
      expect(result.path).toMatch(/personal-artifacts[\\/]screenshots/u);
      expect(result.sizeBytes).toBe(3);
      await expect(readFile(result.path)).resolves.toEqual(Buffer.from("abc"));
      expect(result).toMatchObject({
        mimeType: "image/jpeg",
        contentBase64: "YWJj",
      });
    } finally {
      await close();
    }
  });

  it("accepts extensions with additional or missing optional capabilities", async () => {
    const { bridge, extension: original, token, port, close } = await startAuthenticatedBridge();
    let newer: WebSocket | undefined;
    let older: WebSocket | undefined;
    try {
      newer = await connectExtension(port, token, [...PERSONAL_BROWSER_CAPABILITIES, "futureBrowserAction"], "0.4.0");
      expect(bridge.connectionInfo()).toMatchObject({
        extensionVersion: "0.4.0",
        capabilities: expect.arrayContaining(["futureBrowserAction"]),
      });
      older = await connectExtension(port, token, ["tabs", "open", "navigate", "snapshot", "click", "fill", "press", "closeTab", "finishTask"], "0.2.0");
      expect(bridge.connectionInfo().extensionVersion).toBe("0.2.0");
      await expect(bridge.snapshot({ tabId: "personal:7", includeAccessibility: true })).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_UNSUPPORTED" });
      await expect(bridge.wait({ tabId: "personal:7", timeoutMs: 100 })).rejects.toMatchObject({
        code: "BROWSER_CAPABILITY_UNSUPPORTED",
        message: expect.stringContaining("0.2.0"),
      });
      expect(bridge.isConnected()).toBe(true);
    } finally {
      newer?.close();
      older?.close();
      original.close();
      await close();
    }
  });

  it("rejects extensions missing a mandatory browser capability", async () => {
    const { bridge, token, port, close } = await startAuthenticatedBridge();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      socket.send(JSON.stringify({
        type: "hello",
        protocolVersion: PERSONAL_BROWSER_PROTOCOL_VERSION,
        extensionVersion: "0.1.0",
        browser: "chrome",
        profile: "personal",
        capabilities: ["tabs", "open"],
      }));
      await expect(closed).resolves.toBe(1008);
      expect(bridge.isConnected()).toBe(true);
    } finally {
      socket.close();
      await close();
    }
  });

  it("requires a compatible hello before activating an authenticated socket", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-personal-browser-"));
    temporaryRoots.push(root);
    const port = await reservePort();
    const bridge = await PersonalBrowserBridge.start({ stateRoot: root, port });
    const workerSource = await readFile(
      path.join(root, "browser", "personal-extension", "service-worker.js"),
      "utf8",
    );
    const token = /const BRIDGE_TOKEN = "([^"]+)";/u.exec(workerSource)?.[1];
    if (!token) throw new Error("Personal browser token was not materialized.");

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    expect(bridge.isConnected()).toBe(false);

    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(JSON.stringify({
      type: "hello",
      protocolVersion: 999,
      extensionVersion: PERSONAL_BROWSER_EXTENSION_VERSION,
      browser: "chrome",
      profile: "personal",
      capabilities: [...PERSONAL_BROWSER_CAPABILITIES],
    }));

    await expect(closed).resolves.toBe(1008);
    expect(bridge.isConnected()).toBe(false);
    await bridge.close();
  });

  it("sends cooperative cancel and distinguishes read cancellation from unknown mutation outcome", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    try {
      const readController = new AbortController();
      const readRequestPromise = nextWireMessage(
        extension,
        (message) => message.type === "request" && message.operation === "wait",
      );
      const read = bridge.wait(
        { tabId: "personal:1", timeoutMs: 30_000 },
        { signal: readController.signal },
      );
      const readRequest = await readRequestPromise;
      const readCancelPromise = nextWireMessage(
        extension,
        (message) => message.type === "cancel" && message.id === readRequest.id,
      );
      readController.abort();

      await expect(read).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
      await expect(readCancelPromise).resolves.toMatchObject({
        type: "cancel",
        id: readRequest.id,
      });

      extension.on("message", (data) => {
        const message = JSON.parse(data.toString()) as WireMessage;
        if (message.type !== "request" || message.operation !== "snapshot") return;
        extension.send(JSON.stringify({
          type: "response", id: message.id, ok: true,
          result: {
            tabId: "personal:1", url: "https://example.com/",
            content: '- button "Read help" [ref=p-generation-1]',
            refs: [{ ref: "p-generation-1", role: "button", name: "Read help" }],
          },
        }));
      });
      await bridge.snapshot({ tabId: "personal:1" });
      const mutationController = new AbortController();
      const mutationRequestPromise = nextWireMessage(
        extension,
        (message) => message.type === "request" && message.operation === "click",
      );
      const mutation = bridge.click(
        { tabId: "personal:1", ref: "p-generation-1" },
        { signal: mutationController.signal },
      );
      const mutationRequest = await mutationRequestPromise;
      const mutationCancelPromise = nextWireMessage(
        extension,
        (message) => message.type === "cancel" && message.id === mutationRequest.id,
      );
      mutationController.abort();

      await expect(mutation).rejects.toMatchObject({
        code: "EXECUTION_OUTCOME_UNKNOWN",
      });
      await expect(mutationCancelPromise).resolves.toMatchObject({
        type: "cancel",
        id: mutationRequest.id,
      });
    } finally {
      await close();
    }
  });

  it("bounds calls by the upstream deadline and propagates the effective deadline", async () => {
    const events: Record<string, unknown>[] = [];
    const { bridge, extension, close } = await startAuthenticatedBridge(e => events.push(e));
    try {
      const deadlineAt = new Date(Date.now() + 500).toISOString();
      const requestPromise = nextWireMessage(
        extension,
        (message) => message.type === "request" && message.operation === "tabs",
      );
      const call = bridge.tabs(
        {},
        {
          deadline: {
            requestedTimeoutMs: 500,
            effectiveTimeoutMs: 500,
            deadlineAt,
          },
        },
      );
      const request = await requestPromise;

      expect(typeof request.deadlineAt).toBe("string");
      expect(Date.parse(String(request.deadlineAt))).toBeLessThanOrEqual(
        Date.parse(deadlineAt),
      );
      await expect(call).rejects.toMatchObject({ code: "BROWSER_WORKER_TIMEOUT" });
      expect(events.filter(e => e.event === "browser_latency")).toEqual([expect.objectContaining({ outcome:"timeout",errorCode:"BROWSER_WORKER_TIMEOUT" })]);
    } finally {
      await close();
    }
  });

  it("isolates pending calls by connection generation", async () => {
    const { bridge, extension: first, token, port, close } =
      await startAuthenticatedBridge();
    let second: WebSocket | undefined;
    try {
      const oldRequestPromise = nextWireMessage(
        first,
        (message) => message.type === "request" && message.operation === "tabs",
      );
      const oldCall = bridge.tabs({});
      await oldRequestPromise;

      second = await connectExtension(port, token);
      await expect(oldCall).rejects.toMatchObject({ code: "BROWSER_DISCONNECTED" });

      second.on("message", (data) => {
        const message = JSON.parse(data.toString()) as WireMessage;
        if (message.type !== "request" || message.operation !== "tabs" || !message.id) return;
        second?.send(JSON.stringify({
          type: "response",
          id: message.id,
          ok: true,
          result: { tabs: [] },
        }));
      });

      await expect(bridge.tabs({})).resolves.toEqual({ tabs: [] });
    } finally {
      second?.close();
      await close();
    }
  });
});

async function primeReference(
  bridge: PersonalBrowserBridge,
  extension: WebSocket,
  tabId: string,
  ref = "ref",
): Promise<void> {
  const respond = (data: WebSocket.RawData) => {
    const message = JSON.parse(data.toString()) as WireMessage;
    if (message.type !== "request" || message.operation !== "snapshot") return;
    extension.send(JSON.stringify({
      type: "response", id: message.id, ok: true,
      result: {
        tabId, url: "https://example.com/",
        content: '- textbox "Test" [ref=' + ref + ']',
        refs: [{ ref, role: "textbox", name: "Test" }],
      },
    }));
  };
  extension.on("message", respond);
  try { await bridge.snapshot({ tabId }); }
  finally { extension.off("message", respond); }
}

interface WireMessage {
  type?: string;
  id?: string;
  operation?: string;
  deadlineAt?: string;
  [key: string]: unknown;
}

async function startAuthenticatedBridge(log?: (entry: Record<string, unknown>) => void): Promise<{
  bridge: PersonalBrowserBridge;
  extension: WebSocket;
  token: string;
  port: number;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-personal-browser-"));
  temporaryRoots.push(root);
  const port = await reservePort();
  const bridge = await PersonalBrowserBridge.start({ stateRoot: root, port, ...(log ? { log } : {}) });
  const workerSource = await readFile(
    path.join(root, "browser", "personal-extension", "service-worker.js"),
    "utf8",
  );
  const token = /const BRIDGE_TOKEN = "([^"]+)";/u.exec(workerSource)?.[1];
  if (!token) throw new Error("Personal browser token was not materialized.");
  const extension = await connectExtension(port, token);
  return {
    bridge,
    extension,
    token,
    port,
    async close() {
      if (extension.readyState < WebSocket.CLOSING) extension.close();
      await bridge.close();
    },
  };
}

async function connectExtension(
  port: number,
  token: string,
  capabilities: readonly string[] = PERSONAL_BROWSER_CAPABILITIES,
  extensionVersion = PERSONAL_BROWSER_EXTENSION_VERSION,
): Promise<WebSocket> {
  const extension = new WebSocket(
    `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
  );
  await new Promise<void>((resolve, reject) => {
    extension.once("open", () => resolve());
    extension.once("error", reject);
  });
  const acknowledged = nextWireMessage(
    extension,
    (message) => message.type === "hello-ack",
  );
  extension.send(JSON.stringify({
    type: "hello",
    protocolVersion: PERSONAL_BROWSER_PROTOCOL_VERSION,
    extensionVersion,
    browser: "chrome",
    profile: "personal",
    capabilities: [...capabilities],
  }));
  await acknowledged;
  return extension;
}

function nextWireMessage(
  socket: WebSocket,
  predicate: (message: WireMessage) => boolean,
): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString()) as WireMessage;
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before the expected message."));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a loopback port.");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
