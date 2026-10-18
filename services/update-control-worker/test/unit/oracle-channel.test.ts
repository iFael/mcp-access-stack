import { describe, expect, it, jest } from "@jest/globals";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import {ORACLE_CONTROL_CONNECT_PATH,ORACLE_CONTROL_RPC_PATH,ORACLE_CONTROL_ORIGIN,ORACLE_CONTROL_SCOPE,
  ORACLE_SOURCE_CONNECT_PATH,ORACLE_SOURCE_RPC_PATH,ORACLE_SOURCE_ORIGIN,ORACLE_SOURCE_SCOPE,
  ORACLE_WORKFLOW_CONNECT_PATH,ORACLE_WORKFLOW_RPC_PATH,ORACLE_WORKFLOW_ORIGIN,ORACLE_WORKFLOW_SCOPE,
  ORACLE_CANDIDATE_CONNECT_PATH,ORACLE_CANDIDATE_RPC_PATH,
  ORACLE_CANDIDATE_ORIGIN,ORACLE_CANDIDATE_SCOPE,
  ORACLE_ACTIVE_CONNECT_PATH,ORACLE_ACTIVE_RPC_PATH,
  ORACLE_ACTIVE_ORIGIN,ORACLE_ACTIVE_SCOPE} from "@mcp-access-stack/update-control-contract";
import type {
  UpdateControlEvent,
  UpdateControlRunSnapshot,
  UpdateGetRunResult,
  UpdateListRunsResult,
  UpdateWaitEventsResult,
} from "@mcp-access-stack/update-control-contract";
import {
  ORACLE_CHANNEL_CONNECT_PATH,
  ORACLE_CHANNEL_ORIGIN,
  ORACLE_CHANNEL_SCOPE,
  UpdateControlOracleChannel,
  type OracleChannelDurableState,
  type OracleChannelEnvironment,
} from "../../src/oracle-channel.js";
import { UpdateControlOracleChannelReadClient } from "../../src/oracle-channel-client.js";
import { createUpdateControlReadOnlyTools } from "../../src/tools.js";

const TOKEN = "oracle-channel-test-token-".padEnd(48, "x");
const CONTROL_TOKEN="oracle-control-separated-token-".padEnd(48,"y");
const SOURCE_TOKEN="oracle-source-separated-token-".padEnd(48,"z");
const WORKFLOW_TOKEN="oracle-workflow-separated-token-".padEnd(48,"w");
const CANDIDATE_TOKEN="oracle-candidate-separated-token-".padEnd(48,"c");
const ACTIVE_TOKEN="oracle-active-separated-token-".padEnd(48,"a");
const principal: AuthenticatedEdgePrincipal = {
  subject: "owner:test",
  scopes: ["update:read"],
  ownerScope: "owner",
  userId: "usr_update_control_owner",
};
const runId = "6aa35d14-07fb-414c-9f91-f9b08c125303";
const run: UpdateControlRunSnapshot = {
  runId,
  blueprintId: "mcp-v3-public-release",
  blueprintVersion: 1,
  blueprintSha256: "a".repeat(64),
  targetRelease: "synthetic-beta80",
  sourceCommitSha: "b".repeat(40),
  status: "paused_outcome_unknown",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:01:00.000Z",
  lastSeq: 3,
  steps: [],
  gates: [],
};
const events: UpdateControlEvent[] = [
  {
    eventId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320000",
    runId,
    seq: 2,
    eventType: "step.started",
    payload: { stepId: "oracle-health" },
    occurredAt: "2026-10-01T00:00:30.000Z",
    redacted: true,
  },
  {
    eventId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320001",
    runId,
    seq: 3,
    eventType: "run.paused_outcome_unknown",
    payload: { stepId: "oracle-health" },
    occurredAt: "2026-10-01T00:01:00.000Z",
    redacted: true,
  },
];

type SocketMessage = string | ArrayBuffer;

class MemorySocket {
  readyState = 1;
  closeCode: number | undefined;
  receiver: ((message: SocketMessage) => void) | undefined;
  peer: MemorySocket | undefined;

  send(message: SocketMessage): void {
    if (this.readyState !== 1 || !this.peer || this.peer.readyState !== 1) {
      throw new Error("socket is not open");
    }
    this.peer.receiver?.(message);
  }

  close(code = 1000, _reason = ""): void {
    this.closeCode = code;
    this.readyState = 3;
    if (this.peer) this.peer.readyState = 3;
  }

  static pair(): { client: MemorySocket; server: MemorySocket } {
    const client = new MemorySocket();
    const server = new MemorySocket();
    client.peer = server;
    server.peer = client;
    return { client, server };
  }
}

class MemoryDurableState implements OracleChannelDurableState {
  readonly accepted: Array<{ socket: WebSocket; tags: string[] }> = [];
  readonly tasks: Promise<unknown>[] = [];
  readonly storage = {
    get: jest.fn(async () => { throw new Error("channel must not read durable storage"); }),
    put: jest.fn(async () => { throw new Error("channel must not write durable storage"); }),
    delete: jest.fn(async () => { throw new Error("channel must not delete durable storage"); }),
  };

  acceptWebSocket(socket: WebSocket, tags?: string[]): void {
    this.accepted.push({ socket, tags: [...(tags ?? [])] });
  }

  getWebSockets(tag?: string): WebSocket[] {
    return this.accepted
      .filter((entry) => tag === undefined || entry.tags.includes(tag))
      .map((entry) => entry.socket)
      .filter((socket) => socket.readyState === 1);
  }

  waitUntil(promise: Promise<unknown>): void {
    this.tasks.push(promise);
  }

  async flush(): Promise<void> {
    while (this.tasks.length > 0) await Promise.all(this.tasks.splice(0));
  }
}

function makeUpgradeResponse(client: WebSocket): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "webSocket", { value: client });
  return response;
}

function createHarness() {
  const state = new MemoryDurableState();
  const pairs: Array<{ client: MemorySocket; server: MemorySocket }> = [];
  let channel = new UpdateControlOracleChannel(
    state,
    { UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: TOKEN,
      UPDATE_CONTROL_ORACLE_CONTROL_TOKEN:CONTROL_TOKEN,
      UPDATE_CONTROL_ORACLE_SOURCE_PROVIDER_TOKEN:SOURCE_TOKEN,
      UPDATE_CONTROL_ORACLE_WORKFLOW_PROVIDER_TOKEN:WORKFLOW_TOKEN,
      UPDATE_CONTROL_ORACLE_CANDIDATE_PROVIDER_TOKEN:CANDIDATE_TOKEN,
      UPDATE_CONTROL_ORACLE_ACTIVE_PROVIDER_TOKEN:ACTIVE_TOKEN } satisfies OracleChannelEnvironment,
    {
      webSocketPairFactory: () => {
        const pair = MemorySocket.pair();
        pairs.push(pair);
        return pair as unknown as { client: WebSocket; server: WebSocket };
      },
      upgradeResponseFactory: makeUpgradeResponse,
    },
  );
  const namespace = {
    idFromName: jest.fn((name: string) => name),
    get: jest.fn((id: unknown) => ({
      fetch: (request: Request) => channel.fetch(request),
      id,
    })),
  };
  const client = new UpdateControlOracleChannelReadClient(namespace);

  async function connect(headers: Record<string, string> = {}) {
    const response = await channel.fetch(new Request(
      "https://mcp-v3-update-control.workers.dev" + ORACLE_CHANNEL_CONNECT_PATH,
      {
        method: "GET",
        headers: {
          upgrade: "websocket",
          origin: ORACLE_CHANNEL_ORIGIN,
          authorization: "Bearer " + TOKEN,
          ...headers,
        },
      },
    ));
    return { response, oracle: pairs.at(-1)?.client, server: pairs.at(-1)?.server };
  }

  function reactivate(): void {
    channel = new UpdateControlOracleChannel(
      state,
      { UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: TOKEN,
      UPDATE_CONTROL_ORACLE_CONTROL_TOKEN:CONTROL_TOKEN,
      UPDATE_CONTROL_ORACLE_SOURCE_PROVIDER_TOKEN:SOURCE_TOKEN,
      UPDATE_CONTROL_ORACLE_WORKFLOW_PROVIDER_TOKEN:WORKFLOW_TOKEN,
      UPDATE_CONTROL_ORACLE_CANDIDATE_PROVIDER_TOKEN:CANDIDATE_TOKEN,
      UPDATE_CONTROL_ORACLE_ACTIVE_PROVIDER_TOKEN:ACTIVE_TOKEN } satisfies OracleChannelEnvironment,
      {
        webSocketPairFactory: () => {
          const pair = MemorySocket.pair();
          pairs.push(pair);
          return pair as unknown as { client: WebSocket; server: WebSocket };
        },
        upgradeResponseFactory: makeUpgradeResponse,
      },
    );
  }

  return { state, pairs, channel: () => channel, client, namespace, connect, reactivate };
}

function rpcRequest(method: string, args: unknown): Request {
  return new Request("https://oracle-channel.internal/_internal/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, arguments: args }),
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) await Promise.resolve();
}

function attachOraclePeer(
  channel: UpdateControlOracleChannel,
  state: MemoryDurableState,
  oracle: MemorySocket,
  server: MemorySocket,
  respond: (request: Record<string, unknown>) => unknown,
): void {
  server.receiver = (message) => channel.webSocketMessage(server as unknown as WebSocket, message);
  oracle.receiver = (message) => {
    if (typeof message !== "string") return;
    const request = JSON.parse(message) as Record<string, unknown>;
    const result = respond(request);
    oracle.send(JSON.stringify({
      version: 1,
      type: "response",
      requestId: request.requestId,
      outcome: "success",
      result,
    }));
    void state.flush();
  };
}

describe("ACTIVE-only Oracle Durable Object isolation",()=>{
  it("requires its distinct bearer and origin, never borrowing candidate",async()=>{
    const h=createHarness();
    const connect=(token:string,origin=ORACLE_ACTIVE_ORIGIN)=>new Request(
      "https://worker.example"+ORACLE_ACTIVE_CONNECT_PATH,{
        method:"GET",headers:{upgrade:"websocket",origin,
          authorization:"Bearer "+token},
      });
    expect((await h.channel().fetch(connect(CANDIDATE_TOKEN))).status).toBe(401);
    expect((await h.channel().fetch(connect(ACTIVE_TOKEN,ORACLE_CANDIDATE_ORIGIN))).status)
      .toBe(403);
    expect((await h.channel().fetch(connect(ACTIVE_TOKEN))).status).toBe(200);
    expect(h.state.getWebSockets(ORACLE_ACTIVE_SCOPE)).toHaveLength(1);
    expect(h.state.getWebSockets(ORACLE_CANDIDATE_SCOPE)).toHaveLength(0);
  });
  it("accepts only correlated ACTIVE responses and refuses forged state",async()=>{
    const h=createHarness();
    await h.channel().fetch(new Request("https://worker.example"+ORACLE_ACTIVE_CONNECT_PATH,{
      method:"GET",headers:{upgrade:"websocket",origin:ORACLE_ACTIVE_ORIGIN,
        authorization:"Bearer "+ACTIVE_TOKEN},
    }));
    const peer=h.pairs.at(-1)!;
    const requestId="11111111-2222-4333-8444-555555555550";
    const args={tag:"v1.1.0-beta.90",commitSha:"a".repeat(40),requestId};
    let forged=false;
    attachOraclePeer(h.channel(),h.state,peer.client,peer.server,()=>({
      method:"inspect_active",requestId,
      manifest:{releaseTag:args.tag,sourceCommitSha:args.commitSha,
        manifestSha256:"b".repeat(64),verifiedArtifactCount:3,
        ...(forged?{filePath:"/etc/secrets"}:{})},
    }));
    const rpc=(command:unknown)=>h.channel().fetch(new Request(
      "https://worker.internal"+ORACLE_ACTIVE_RPC_PATH,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify(command),
      }));
    expect((await rpc({method:"get_state",arguments:{requestId,path:"/etc"}})).status)
      .toBe(400);
    const valid=await rpc({method:"inspect_active",arguments:args});
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      result:{method:"inspect_active",requestId,manifest:{
        manifestSha256:"b".repeat(64)}}});
    forged=true;
    expect((await rpc({method:"inspect_active",arguments:args})).status).toBe(502);
  });
});

describe("candidate provider isolation in the existing Oracle DO",()=>{
  it("accepts only its own token+origin, never source, workflow or control",async()=>{
    const h=createHarness();
    const connect=(token:string,origin=ORACLE_CANDIDATE_ORIGIN)=>new Request(
      "https://worker.example"+ORACLE_CANDIDATE_CONNECT_PATH,{
        method:"GET",headers:{upgrade:"websocket",origin,
          authorization:"Bearer "+token},
      });
    expect((await h.channel().fetch(connect(SOURCE_TOKEN))).status).toBe(401);
    expect((await h.channel().fetch(connect(WORKFLOW_TOKEN))).status).toBe(401);
    expect((await h.channel().fetch(connect(CANDIDATE_TOKEN,ORACLE_SOURCE_ORIGIN))).status)
      .toBe(403);
    expect((await h.channel().fetch(connect(CANDIDATE_TOKEN))).status).toBe(200);
    expect(h.state.getWebSockets(ORACLE_CANDIDATE_SCOPE)).toHaveLength(1);
    expect(h.state.getWebSockets(ORACLE_SOURCE_SCOPE)).toHaveLength(0);
    expect(h.state.getWebSockets(ORACLE_WORKFLOW_SCOPE)).toHaveLength(0);
  });
  it("forwards a run-bound read and rejects a forged candidate reply",async()=>{
    const h=createHarness();
    await h.channel().fetch(new Request("https://worker.example"+ORACLE_CANDIDATE_CONNECT_PATH,{
      method:"GET",headers:{upgrade:"websocket",origin:ORACLE_CANDIDATE_ORIGIN,
        authorization:"Bearer "+CANDIDATE_TOKEN},
    }));
    const peer=h.pairs.at(-1)!;
    const runId="11111111-2222-4333-8444-555555555555";
    const operationId="11111111-2222-4333-8444-555555555556";
    const args={tag:"v1.1.0-beta.90",commitSha:"a".repeat(40),runId,operationId};
    attachOraclePeer(h.channel(),h.state,peer.client,peer.server,()=>({
      releaseTag:args.tag,sourceCommitSha:args.commitSha,
      manifestSha256:"b".repeat(64),verifiedArtifactCount:5,runId,operationId,
    }));
    const rpc=(command:unknown)=>h.channel().fetch(new Request(
      "https://worker.internal"+ORACLE_CANDIDATE_RPC_PATH,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify(command),
      }));
    expect((await rpc({method:"shell",arguments:{}})).status).toBe(400);
    expect((await rpc({method:"read_candidate",arguments:{...args,path:"etc/passwd"}})).status)
      .toBe(400);
    const result=await rpc({method:"read_candidate",arguments:args});
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      result:{releaseTag:args.tag,manifestSha256:"b".repeat(64),runId,operationId},
    });
  });
  it("rejects a syntactically valid candidate receipt from the wrong operation",async()=>{
    const h=createHarness();
    await h.channel().fetch(new Request("https://worker.example"+ORACLE_CANDIDATE_CONNECT_PATH,{
      method:"GET",headers:{upgrade:"websocket",origin:ORACLE_CANDIDATE_ORIGIN,
        authorization:"Bearer "+CANDIDATE_TOKEN},
    }));
    const peer=h.pairs.at(-1)!;
    const runId="11111111-2222-4333-8444-555555555555";
    const operationId="11111111-2222-4333-8444-555555555556";
    attachOraclePeer(h.channel(),h.state,peer.client,peer.server,()=>({
      releaseTag:"v1.1.0-beta.90",sourceCommitSha:"a".repeat(40),
      manifestSha256:"b".repeat(64),verifiedArtifactCount:5,
      runId,operationId:"11111111-2222-4333-8444-555555555557",
    }));
    const result=await h.channel().fetch(new Request(
      "https://worker.internal"+ORACLE_CANDIDATE_RPC_PATH,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({method:"read_candidate",arguments:{
          tag:"v1.1.0-beta.90",commitSha:"a".repeat(40),runId,operationId,
        }}),
      }));
    expect(result.status).toBe(502);
  });
});

describe("isolated authenticated source provider DO",()=>{
  it("does not accept the read/control tokens or origins",async()=>{
    const h=createHarness();
    const connect=(token:string,origin=ORACLE_SOURCE_ORIGIN)=>new Request(
      "https://worker.example"+ORACLE_SOURCE_CONNECT_PATH,{
      method:"GET",headers:{upgrade:"websocket",origin,authorization:"Bearer "+token},
    });
    expect((await h.channel().fetch(connect(TOKEN))).status).toBe(401);
    expect((await h.channel().fetch(connect(CONTROL_TOKEN))).status).toBe(401);
    expect((await h.channel().fetch(connect(SOURCE_TOKEN,ORACLE_CHANNEL_ORIGIN))).status).toBe(403);
    expect((await h.channel().fetch(connect(SOURCE_TOKEN))).status).toBe(200);
    expect(h.state.getWebSockets(ORACLE_SOURCE_SCOPE)).toHaveLength(1);
    expect(h.state.getWebSockets(ORACLE_CHANNEL_SCOPE)).toHaveLength(0);
  });
  it("forwards only fixed GET methods and validates provider response",async()=>{
    const h=createHarness();
    await h.channel().fetch(new Request("https://worker.example"+ORACLE_SOURCE_CONNECT_PATH,{
      method:"GET",headers:{upgrade:"websocket",origin:ORACLE_SOURCE_ORIGIN,
        authorization:"Bearer "+SOURCE_TOKEN},
    }));
    const pair=h.pairs.at(-1)!;
    const received:unknown[]=[];
    attachOraclePeer(h.channel(),h.state,pair.client,pair.server,request=>{
      received.push(request);
      return "a".repeat(40);
    });
    const rpc=(command:unknown)=>h.channel().fetch(new Request(
      "https://worker.internal"+ORACLE_SOURCE_RPC_PATH,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(command),
      }));
    expect((await rpc({method:"shell",arguments:{}})).status).toBe(400);
    expect((await rpc({method:"read_main_head",arguments:{repository:"other"}})).status).toBe(400);
    const result=await rpc({method:"read_main_head",arguments:{}});
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({result:"a".repeat(40)});
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({method:"read_main_head",arguments:{}});
  });
});

describe("domain-isolated workflow RPC channel",()=>{
  it("refuses source/control bearer tokens and accepts only bounded typed workflow requests",async()=>{
    const h=createHarness();
    const connect=(token:string,origin=ORACLE_WORKFLOW_ORIGIN)=>h.channel().fetch(new Request(
      "https://worker.example"+ORACLE_WORKFLOW_CONNECT_PATH,{
        method:"GET",headers:{upgrade:"websocket",origin,authorization:"Bearer "+token},
      }));
    expect((await connect(SOURCE_TOKEN)).status).toBe(401);
    expect((await connect(CONTROL_TOKEN)).status).toBe(401);
    expect((await connect(WORKFLOW_TOKEN,ORACLE_SOURCE_ORIGIN)).status).toBe(403);
    expect((await connect(WORKFLOW_TOKEN)).status).toBe(200);
    expect(h.state.getWebSockets(ORACLE_WORKFLOW_SCOPE)).toHaveLength(1);
    expect(h.state.getWebSockets(ORACLE_SOURCE_SCOPE)).toHaveLength(0);
    const pair=h.pairs.at(-1)!;
    const operationId="11111111-2222-4333-8444-555555555555";
    const request={method:"workflow_operation",arguments:{
      workflow:"release-tag-bootstrap.yml",mode:"reconcile",tag:"v1.1.0-beta.90",
      expectedMainSha:"a".repeat(40),operationId,
    }};
    const requests:unknown[]=[];
    attachOraclePeer(h.channel(),h.state,pair.client,pair.server,frame=>{
      requests.push(frame);
      return {status:"observed",operationId,runId:4,state:"completed",conclusion:"success"};
    });
    const rpc=(value:unknown)=>h.channel().fetch(new Request(
      "https://oracle-workflow.internal"+ORACLE_WORKFLOW_RPC_PATH,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value),
      }));
    expect((await rpc({...request,arguments:{...request.arguments,owner:"attacker"}})).status).toBe(400);
    expect((await rpc({method:"shell",arguments:{}})).status).toBe(400);
    const response=await rpc(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({result:{
      status:"observed",operationId,runId:4,state:"completed",conclusion:"success",
    }});
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject(request);
  });
});

describe("isolated control mode on existing Oracle channel DO implementation",()=>{
  it("rejects the read token and read origin for the separate control socket",async()=>{
    const h=createHarness();
    const url="https://worker.example"+ORACLE_CONTROL_CONNECT_PATH;
    const mk=(token:string,origin=ORACLE_CONTROL_ORIGIN)=>new Request(url,{
      method:"GET",headers:{upgrade:"websocket",origin,authorization:"Bearer "+token},
    });
    expect((await h.channel().fetch(mk(TOKEN))).status).toBe(401);
    expect((await h.channel().fetch(mk(CONTROL_TOKEN,ORACLE_CHANNEL_ORIGIN))).status).toBe(403);
    const response=await h.channel().fetch(mk(CONTROL_TOKEN));
    expect(response.status).toBe(200);
    expect(h.state.getWebSockets(ORACLE_CONTROL_SCOPE)).toHaveLength(1);
    expect(h.state.getWebSockets(ORACLE_CHANNEL_SCOPE)).toHaveLength(0);
    expect((await h.channel().fetch(rpcRequest("advance_release",{}))).status).toBe(400);
  });
  it("delivers only the fixed typed operation on the dedicated RPC path",async()=>{
    const h=createHarness();
    await h.channel().fetch(new Request("https://worker.example"+ORACLE_CONTROL_CONNECT_PATH,{
      method:"GET",headers:{upgrade:"websocket",origin:ORACLE_CONTROL_ORIGIN,
        authorization:"Bearer "+CONTROL_TOKEN},
    }));
    const oracle=h.pairs.at(-1)!.client,server=h.pairs.at(-1)!.server;
    server.receiver=(message)=>h.channel().webSocketMessage(server as unknown as WebSocket,message);
    let request:Record<string,unknown>|undefined;
    oracle.receiver=(message)=>{
      if(typeof message!=="string")return;
      request=JSON.parse(message) as Record<string,unknown>;
      oracle.send(JSON.stringify({version:1,type:"response",requestId:request.requestId,
        outcome:"success",result:{runId, lastSeq:4,status:"paused_outcome_unknown",stop:"outcome_unknown"}}));
      void h.state.flush();
    };
    const body={method:"advance_release",
      arguments:{runId,expectedSourceSha:"a".repeat(40),expectedLastSeq:3,
        operationId:"11111111-2222-4333-8444-555555555555"},
      principal:{workspaceId:"mcp-access-stack",authenticatedActorId:"mcp:v3-release-control",
        ownerScope:"trusted:release-operator"}};
    const rpc=(value:unknown)=>h.channel().fetch(new Request("https://control.internal"+ORACLE_CONTROL_RPC_PATH,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value),
    }));
    expect((await rpc({...body,method:"shell"})).status).toBe(400);
    expect((await rpc({...body,principal:{...body.principal,ownerScope:"owner"}})).status).toBe(400);
    expect((await rpc(body)).status).toBe(200);
    expect(request).toMatchObject({method:"advance_release",arguments:body.arguments,
      principal:body.principal});
    expect((await h.channel().fetch(rpcRequest("advance_release",body.arguments))).status).toBe(400);
  });
});

describe("Update Control reverse WSS channel", () => {
  it("routes the three existing read-only tools end to end without changing arguments or results", async () => {
    const h = createHarness();
    const connected = await h.connect();
    expect(connected.response.status).toBe(200);
    const oracle = connected.oracle!;
    const server = connected.server!;
    const seen: Array<{ method: string; arguments: unknown }> = [];
    attachOraclePeer(h.channel(), h.state, oracle, server, (frame) => {
      seen.push({ method: String(frame.method), arguments: frame.arguments });
      if (frame.method === "list_runs") {
        return { runs: [run], nextCursor: "cursor_next", hasMore: true } satisfies UpdateListRunsResult;
      }
      if (frame.method === "get_run") {
        return {
          run,
          evidence: [],
          nextEvidenceCursor: null,
          hasMoreEvidence: false,
        } satisfies UpdateGetRunResult;
      }
      return {
        outcome: "events",
        runId,
        afterSeq: 1,
        currentSeq: 3,
        events: events.slice(0, 1),
        hasMore: true,
      } satisfies UpdateWaitEventsResult;
    });

    const tools = createUpdateControlReadOnlyTools(h.client);
    const list = await tools.handle({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "update_list_runs", arguments: { limit: 1, cursor: "cursor_prior" } },
    }, principal);
    const get = await tools.handle({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "update_get_run", arguments: { runId, evidenceLimit: 10 } },
    }, principal);
    const wait = await tools.handle({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "update_wait_events", arguments: { runId, afterSeq: 1, timeoutSeconds: 15, limit: 1 } },
    }, principal);

    expect(seen).toEqual([
      { method: "list_runs", arguments: { limit: 1, cursor: "cursor_prior" } },
      { method: "get_run", arguments: { runId, evidenceLimit: 10 } },
      { method: "wait_events", arguments: { runId, afterSeq: 1, timeoutSeconds: 15, limit: 1 } },
    ]);
    expect((await list!.json() as { result: { structuredContent: UpdateListRunsResult } })
      .result.structuredContent.runs[0]?.status).toBe("paused_outcome_unknown");
    expect((await get!.json() as { result: { structuredContent: UpdateGetRunResult } })
      .result.structuredContent.run.runId).toBe(runId);
    const waitResult = (await wait!.json() as {
      result: { structuredContent: UpdateWaitEventsResult };
    }).result.structuredContent;
    expect(waitResult.events.map((event) => event.seq)).toEqual([2]);
    expect(waitResult.hasMore).toBe(true);
    expect(h.state.storage.get).not.toHaveBeenCalled();
    expect(h.state.storage.put).not.toHaveBeenCalled();
    expect(h.state.storage.delete).not.toHaveBeenCalled();
  });

  it("preserves a legitimate wait timeout response separately from transport timeout", async () => {
    const h = createHarness();
    const connected = await h.connect();
    attachOraclePeer(h.channel(), h.state, connected.oracle!, connected.server!, (frame) => ({
      outcome: "timeout",
      runId,
      afterSeq: (frame.arguments as { afterSeq: number }).afterSeq,
      currentSeq: 3,
      events: [],
    } satisfies UpdateWaitEventsResult));

    await expect(h.client.waitEvents({ runId, afterSeq: 3, timeoutSeconds: 15, limit: 100 }))
      .resolves.toEqual({
        outcome: "timeout",
        runId,
        afterSeq: 3,
        currentSeq: 3,
        events: [],
      });
  });

  it("reports a disconnected Oracle as transport unavailable and supports a clean reconnect", async () => {
    const h = createHarness();
    const connected = await h.connect();
    connected.oracle!.close(1006, "test disconnect");
    h.channel().webSocketClose(
      connected.server as unknown as WebSocket, 1006, "test disconnect", false,
    );

    await expect(h.client.listRuns({ limit: 1 })).rejects.toMatchObject({
      code: "UPDATE_ORCHESTRATOR_UNAVAILABLE",
    });
    const next = await h.connect();
    attachOraclePeer(h.channel(), h.state, next.oracle!, next.server!, () => ({
      runs: [run],
      nextCursor: null,
      hasMore: false,
    } satisfies UpdateListRunsResult));
    await expect(h.client.listRuns({ limit: 1 })).resolves.toMatchObject({ runs: [run] });
  });

  it("recovers the active socket after DO reactivation without persistent business storage", async () => {
    const h = createHarness();
    const connected = await h.connect();
    h.reactivate();
    attachOraclePeer(h.channel(), h.state, connected.oracle!, connected.server!, () => ({
      runs: [run],
      nextCursor: null,
      hasMore: false,
    } satisfies UpdateListRunsResult));
    await expect(h.client.listRuns({ limit: 1 })).resolves.toMatchObject({ runs: [run] });
    expect(h.state.storage.get).not.toHaveBeenCalled();
    expect(h.state.storage.put).not.toHaveBeenCalled();
    expect(h.state.storage.delete).not.toHaveBeenCalled();
  });

  it("replaces an authenticated connection while retaining one live socket per scope", async () => {
    const h = createHarness();
    const first = await h.connect();
    const second = await h.connect();
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(first.oracle!.readyState).toBe(3);
    expect(h.state.getWebSockets(ORACLE_CHANNEL_SCOPE)).toHaveLength(1);
  });

  it("fails closed for invalid token, origin, path, method, and missing transport secret", async () => {
    const h = createHarness();
    expect((await h.connect({ authorization: "Bearer wrong" })).response.status).toBe(401);
    expect((await h.connect({ origin: "https://other.example" })).response.status).toBe(403);
    const badPath = await h.channel().fetch(new Request("https://worker.example/not-the-channel", {
      method: "GET",
      headers: { upgrade: "websocket", origin: ORACLE_CHANNEL_ORIGIN, authorization: "Bearer " + TOKEN },
    }));
    expect(badPath.status).toBe(404);
    const badMethod = await h.channel().fetch(new Request(
      "https://worker.example" + ORACLE_CHANNEL_CONNECT_PATH,
      { method: "POST", headers: { upgrade: "websocket", origin: ORACLE_CHANNEL_ORIGIN, authorization: "Bearer " + TOKEN } },
    ));
    expect(badMethod.status).toBe(405);
    const missing = new UpdateControlOracleChannel(h.state, {}, {
      webSocketPairFactory: () => MemorySocket.pair() as unknown as { client: WebSocket; server: WebSocket },
      upgradeResponseFactory: makeUpgradeResponse,
    });
    const response = await missing.fetch(new Request(
      "https://worker.example" + ORACLE_CHANNEL_CONNECT_PATH,
      { method: "GET", headers: { upgrade: "websocket", origin: ORACLE_CHANNEL_ORIGIN, authorization: "Bearer " + TOKEN } },
    ));
    expect(response.status).toBe(503);
    expect(h.pairs).toHaveLength(0);
  });

  it("rejects invalid internal methods, malformed frames, oversized and binary frames", async () => {
    const h = createHarness();
    expect((await h.channel().fetch(rpcRequest("promote", {}))).status).toBe(400);
    const connected = await h.connect();
    h.channel().webSocketMessage(connected.server as unknown as WebSocket, "not json");
    await h.state.flush();
    expect(connected.server!.closeCode).toBe(1008);

    const next = await h.connect();
    h.channel().webSocketMessage(
      next.server as unknown as WebSocket,
      "x".repeat(512 * 1024 + 1),
    );
    await h.state.flush();
    expect(next.server!.closeCode).toBe(1009);

    const last = await h.connect();
    h.channel().webSocketMessage(last.server as unknown as WebSocket, new ArrayBuffer(8));
    await h.state.flush();
    expect(last.server!.closeCode).toBe(1003);
  });

  it("rejects duplicate and late response correlation IDs", async () => {
    jest.useFakeTimers();
    try {
      const h = createHarness();
      let connected = await h.connect();
      let oracle = connected.oracle!;
      let server = connected.server!;
      server.receiver = (message) => h.channel().webSocketMessage(server as unknown as WebSocket, message);
      let captured: Record<string, unknown> | undefined;
      oracle.receiver = (message) => {
        if (typeof message === "string") captured = JSON.parse(message) as Record<string, unknown>;
      };
      const first = h.channel().fetch(rpcRequest("list_runs", {}));
      await flushMicrotasks();
      const firstFrame = captured!;
      oracle.send(JSON.stringify({
        version: 1,
        type: "response",
        requestId: firstFrame.requestId,
        outcome: "success",
        result: { runs: [run], nextCursor: null, hasMore: false },
      }));
      await h.state.flush();
      expect((await first).status).toBe(200);
      oracle.send(JSON.stringify({
        version: 1,
        type: "response",
        requestId: firstFrame.requestId,
        outcome: "success",
        result: { runs: [run], nextCursor: null, hasMore: false },
      }));
      await h.state.flush();
      expect(server.closeCode).toBe(1008);

      connected = await h.connect();
      oracle = connected.oracle!;
      server = connected.server!;
      server.receiver = (message) => h.channel().webSocketMessage(server as unknown as WebSocket, message);
      captured = undefined;
      oracle.receiver = (message) => {
        if (typeof message === "string") captured = JSON.parse(message) as Record<string, unknown>;
      };
      const request = h.channel().fetch(rpcRequest("wait_events", {
        runId, afterSeq: 3, timeoutSeconds: 15, limit: 100,
      }));
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(20_001);
      expect((await request).status).toBe(504);
      oracle.send(JSON.stringify({
        version: 1,
        type: "response",
        requestId: captured?.requestId,
        outcome: "success",
        result: { outcome: "timeout", runId, afterSeq: 3, currentSeq: 3, events: [] },
      }));
      await h.state.flush();
      expect(server.closeCode).toBe(1008);
    } finally {
      jest.useRealTimers();
    }
  });

  it("bounds in-flight RPCs and clears correlations when the socket closes", async () => {
    jest.useFakeTimers();
    try {
      const h = createHarness();
      const connected = await h.connect();
      const oracle = connected.oracle!;
      const server = connected.server!;
      server.receiver = (message) => h.channel().webSocketMessage(server as unknown as WebSocket, message);
      oracle.receiver = () => undefined;
      const requests = Array.from({ length: 33 }, () =>
        h.channel().fetch(rpcRequest("list_runs", {})));
      await flushMicrotasks();
      const overflow = await Promise.all(requests.slice(32));
      expect(overflow[0]?.status).toBe(503);
      oracle.close(1006, "test disconnect");
      h.channel().webSocketClose(server as unknown as WebSocket, 1006, "test disconnect", false);
      const settled = await Promise.all(requests.slice(0, 32));
      expect(settled.every((response) => response.status === 503)).toBe(true);
      expect(h.state.getWebSockets(ORACLE_CHANNEL_SCOPE)).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps read result sequence ordering and outcome_unknown intact", async () => {
    const h = createHarness();
    const connected = await h.connect();
    attachOraclePeer(h.channel(), h.state, connected.oracle!, connected.server!, (frame) => {
      if (frame.method === "list_runs") {
        return { runs: [run], nextCursor: null, hasMore: false } satisfies UpdateListRunsResult;
      }
      return {
        outcome: "events",
        runId,
        afterSeq: 1,
        currentSeq: 3,
        events,
        hasMore: false,
      } satisfies UpdateWaitEventsResult;
    });

    const result = await h.client.waitEvents({ runId, afterSeq: 1, timeoutSeconds: 0, limit: 10 });
    expect(result.events.map((event) => event.seq)).toEqual([2, 3]);
    const listed = await h.client.listRuns({ limit: 1 });
    expect(listed.runs[0]?.status).toBe("paused_outcome_unknown");
  });
});
