import {
  parseWindowsReadResult,
  type WindowsReadCommand,
  type WindowsReadProof,
  type WindowsReadState,
} from "@mcp-access-stack/update-control-contract";
import type {WindowsReadProviderPort} from "./windows-read-provider.js";

/** A trusted Windows-only owner supplies this observer: it MUST invoke only
 * the pinned, read-only Get-McpWindowsExecutionNodeReadEvidence.ps1 installed
 * outside the mutable release tree, without interpreting caller strings as
 * commands or filesystem paths. This contract does not itself execute code. */
export interface WindowsNativeReadInvoker {
  observe(input:Readonly<{
    mode:"State"|"Candidate"|"Active";
    expectedTag?:string;
    expectedCommit?:string;
    expectedRunId?:string;
    expectedPrepareOperationId?:string;
  }>):Promise<unknown>;
}
export interface WindowsNativeReadPolicy{
  readonly ownerScope:string;
  authorize(ownerScope:string,operation:"state"|"candidate"|"active"):Promise<boolean>;
}
export interface WindowsNativeReadPortOptions{
  readonly invoker:WindowsNativeReadInvoker;
  readonly policy:WindowsNativeReadPolicy;
  readonly platform?:NodeJS.Platform;
}
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
function record(value:unknown):value is Record<string,unknown>{
  return value!==null && typeof value==="object" && !Array.isArray(value);
}
function exact(value:Record<string,unknown>,keys:readonly string[]):boolean{
  return Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
}
function identity(tag:string,commit:string):void{
  if(!TAG.test(tag) || tag.includes("..") || !SHA.test(commit))
    throw new Error("WINDOWS_NATIVE_EXPECTED_IDENTITY_INVALID");
}
function native(value:unknown,kind:"state"|"candidate"|"active",witness:boolean)
  :Record<string,unknown>{
  // Even trusted invokers may be outdated, compromised or return PowerShell
  // diagnostics. No extra keys and never accept a forged remote receipt.
  if(typeof value==="string"){
    if(Buffer.byteLength(value,"utf8")>2048)
      throw new Error("WINDOWS_NATIVE_EVIDENCE_OVERSIZE");
    try{value=JSON.parse(value) as unknown;}catch{
      throw new Error("WINDOWS_NATIVE_JSON_INVALID");
    }
  }
  if(!record(value) || value.platform!=="windows" ||
    value.kind!==kind || value.scope!=="local_hash_integrity_only" ||
    !exact(value,kind==="state"
      ?["platform","kind","scope","state"]
      :["platform","kind","scope","state","releaseTag","sourceCommitSha",
        "manifestSha256","verifiedArtifactCount",
        ...(witness?["localPrepareWitness"]:[])]))
    throw new Error("WINDOWS_NATIVE_EVIDENCE_INVALID");
  if(Buffer.byteLength(JSON.stringify(value),"utf8")>2048)
    throw new Error("WINDOWS_NATIVE_EVIDENCE_OVERSIZE");
  return value;
}
function proof(value:Record<string,unknown>,withWitness:boolean):Record<string,unknown>{
  const result={
    scope:value.scope,
    releaseTag:value.releaseTag,
    sourceCommitSha:value.sourceCommitSha,
    manifestSha256:value.manifestSha256,
    verifiedArtifactCount:value.verifiedArtifactCount,
    state:value.state,
    ...(withWitness?{localPrepareWitness:value.localPrepareWitness}:{}),
  };
  return result;
}

/** No implicit enrollment; callers must provide an independent trusted owner
 * policy and fixed-script invoker. These operations yield only local hashes. */
export class WindowsNativeReadPort implements WindowsReadProviderPort{
  constructor(private readonly options:WindowsNativeReadPortOptions){
    if((options.platform??process.platform)!=="win32" ||
      !options.invoker || typeof options.invoker.observe!=="function" ||
      !options.policy || typeof options.policy.authorize!=="function" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(options.policy.ownerScope))
      throw new Error("WINDOWS_NATIVE_READ_NOT_ENROLLED");
  }
  private async withAuth<T>(operation:"state"|"candidate"|"active",
    action:()=>Promise<T>):Promise<T>{
    const {policy}=this.options;
    if(!await policy.authorize(policy.ownerScope,operation))
      throw new Error("WINDOWS_NATIVE_READ_UNAUTHORIZED");
    const result=await action();
    if(!await policy.authorize(policy.ownerScope,operation))
      throw new Error("WINDOWS_NATIVE_READ_AUTH_REVOKED");
    return result;
  }
  async getState():Promise<WindowsReadState>{
    return this.withAuth("state",async()=>{
      const value=native(await this.options.invoker.observe({mode:"State"}),
        "state",false);
      const command:WindowsReadCommand={method:"get_state",arguments:{
        requestId:"11111111-2222-4333-8444-555555555550",
      }};
      const result=parseWindowsReadResult(command,{
        method:"get_state",requestId:command.arguments.requestId,
        scope:"local_hash_integrity_only",state:value.state,
      });
      if(result.method!=="get_state")throw new Error("WINDOWS_NATIVE_STATE_INVALID");
      return result.state;
    });
  }
  async inspectCandidate(tag:string,commitSha:string,runId:string,
    operationId:string,prepareOperationId:string):Promise<WindowsReadProof>{
    identity(tag,commitSha);
    if(!UUID.test(runId) || !UUID.test(operationId) ||
      !UUID.test(prepareOperationId))
      throw new Error("WINDOWS_NATIVE_PREPARE_IDS_INVALID");
    return this.withAuth("candidate",async()=>{
      // operationId cannot be established by the local journal; do not
      // represent this result as a trusted prepare_windows effect receipt.
      const value=native(await this.options.invoker.observe({
        mode:"Candidate",expectedTag:tag,expectedCommit:commitSha,
        expectedRunId:runId,expectedPrepareOperationId:prepareOperationId,
      }),"candidate",true);
      if(value.manifestSha256!==(
        record(value.localPrepareWitness)?value.localPrepareWitness.manifestSha256:undefined
      ) || typeof value.manifestSha256!=="string" ||
        !DIGEST.test(value.manifestSha256))
        throw new Error("WINDOWS_NATIVE_WITNESS_DIGEST_INVALID");
      const command:WindowsReadCommand={method:"inspect_candidate",arguments:{
        requestId:"11111111-2222-4333-8444-555555555550",
        tag,commitSha,runId,operationId,prepareOperationId,
      }};
      const result=parseWindowsReadResult(command,{
        method:"inspect_candidate",requestId:command.arguments.requestId,
        proof:proof(value,true),
      });
      if(result.method!=="inspect_candidate")
        throw new Error("WINDOWS_NATIVE_CANDIDATE_INVALID");
      return result.proof;
    });
  }
  async inspectActive(tag:string,commitSha:string):Promise<WindowsReadProof>{
    identity(tag,commitSha);
    return this.withAuth("active",async()=>{
      const value=native(await this.options.invoker.observe({
        mode:"Active",expectedTag:tag,expectedCommit:commitSha,
      }),"active",false);
      const command:WindowsReadCommand={method:"inspect_active",arguments:{
        requestId:"11111111-2222-4333-8444-555555555550",
        tag,commitSha,
      }};
      const result=parseWindowsReadResult(command,{
        method:"inspect_active",requestId:command.arguments.requestId,
        proof:proof(value,false),
      });
      if(result.method!=="inspect_active")
        throw new Error("WINDOWS_NATIVE_ACTIVE_INVALID");
      return result.proof;
    });
  }
}
