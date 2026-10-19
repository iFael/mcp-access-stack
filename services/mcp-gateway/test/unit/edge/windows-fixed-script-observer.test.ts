import {createHash} from "node:crypto";
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,jest} from "@jest/globals";
import {createWindowsFixedScriptInvoker}
  from "../../../src/edge/windows-fixed-script-observer.js";
import {WindowsNativeReadPort}
  from "../../../src/edge/windows-read-native-port.js";

const tag="v1.1.0-beta.90",sha="a".repeat(40),digest="b".repeat(64);
const runId="11111111-2222-4333-8444-555555555551";
const operationId="11111111-2222-4333-8444-555555555552";
const prepareId="11111111-2222-4333-8444-555555555553";
const candidate={releaseId:tag.slice(1),manifestSha256:digest};
const evidence={platform:"windows",kind:"candidate",
  scope:"local_hash_integrity_only",
  state:{active:null,previous:null,candidate},
  releaseTag:tag,sourceCommitSha:sha,manifestSha256:digest,
  verifiedArtifactCount:9,
  localPrepareWitness:{kind:"local_candidate_prepare",
    runId,prepareOperationId:prepareId,releaseId:candidate.releaseId,
    manifestSha256:digest}};
let dir:string|undefined;
afterEach(()=>{if(dir){rmSync(dir,{force:true,recursive:true});dir=undefined;}});
function fixture(){
  dir=mkdtempSync(join(tmpdir(),"windows-fixed-read-"));
  const scripts=join(dir,"scripts"),installation=join(dir,"installation");
  mkdirSync(scripts);mkdirSync(installation);
  const names=["Get-McpWindowsExecutionNodeReadEvidence.ps1",
    "PublicDistribution.Common.ps1","WindowsExecutionNode.Common.ps1"] as const;
  const hashes:Record<string,string>={};
  for(const name of names){
    const content=("# pinned Windows-only evidence reader, no mutations\n").repeat(5)+name;
    writeFileSync(join(scripts,name),content);
    hashes[name]=createHash("sha256").update(content).digest("hex");
  }
  const config={
    scriptsRoot:scripts,installationRoot:installation,platform:"win32" as const,
    expectedReaderSha256:hashes[names[0]]!,
    expectedHelperSha256:{
      "PublicDistribution.Common.ps1":hashes[names[1]]!,
      "WindowsExecutionNode.Common.ps1":hashes[names[2]]!,
    },
  };
  return {config,scripts,installation};
}
describe("pinned Windows fixed-script observation, no native activation",()=>{
  it("allows only a pinned read-only script with fixed typed arguments",async()=>{
    const {config,installation}=fixture();
    const execute=jest.fn(async(_exe:string,_args:readonly string[])=>
      JSON.stringify(evidence));
    const invoker=createWindowsFixedScriptInvoker(config,{execute});
    const authorize=jest.fn(async()=>true);
    const port=new WindowsNativeReadPort({platform:"win32",
      invoker,policy:{ownerScope:"trusted:windows-read",authorize}});
    const proof=await port.inspectCandidate(tag,sha,runId,operationId,prepareId);
    expect(proof.scope).toBe("local_hash_integrity_only");
    expect(execute).toHaveBeenCalledTimes(1);
    const args=execute.mock.calls[0]![1];
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("-File");
    expect(args).toContain("-ExpectedRunId");
    expect(args).toContain(prepareId);
    expect(args).toContain(installation);
    expect(args).not.toContain("-Command");
    expect(args).not.toContain("-ExecutionPolicy");
    expect(args).not.toContain(operationId);
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("rejects replaced helper content before executing the script",async()=>{
    const {config,scripts}=fixture();
    const execute=jest.fn(async()=>JSON.stringify(evidence));
    const invoker=createWindowsFixedScriptInvoker(config,{execute});
    writeFileSync(join(scripts,"PublicDistribution.Common.ps1"),"modified");
    await expect(invoker.observe({mode:"State"})).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects untrusted script redirection and caller-supplied paths",async()=>{
    const {config,scripts}=fixture();
    const execute=jest.fn(async()=>JSON.stringify(evidence));
    const invoker=createWindowsFixedScriptInvoker(config,{execute});
    await expect(invoker.observe({mode:"State",filePath:"C:\\secret"} as never))
      .rejects.toThrow("STATE_INPUT_INVALID");
    await expect(invoker.observe({mode:"Candidate",expectedTag:tag,
      expectedCommit:sha,expectedRunId:runId,
      expectedPrepareOperationId:prepareId,
      path:"C:\\secret"} as never)).rejects.toThrow("IDENTITY_INVALID");
    expect(execute).not.toHaveBeenCalled();
    const reader=join(scripts,"Get-McpWindowsExecutionNodeReadEvidence.ps1");
    rmSync(reader);
    symlinkSync(join(scripts,"PublicDistribution.Common.ps1"),reader);
    await expect(invoker.observe({mode:"State"})).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("refuses invalid configuration, oversize results and unsafe identifiers",async()=>{
    const {config}=fixture();
    expect(()=>createWindowsFixedScriptInvoker({...config,platform:"linux"}))
      .toThrow("NOT_CONFIGURED");
    expect(()=>createWindowsFixedScriptInvoker({...config,
      expectedReaderSha256:"bad"})).toThrow("NOT_CONFIGURED");
    const execute=jest.fn(async()=>"x".repeat(4096));
    const invoker=createWindowsFixedScriptInvoker(config,{execute});
    await expect(invoker.observe({mode:"State"})).rejects.toThrow("OVERSIZE");
    await expect(invoker.observe({mode:"Candidate",expectedTag:"v1.1.0..bad",
      expectedCommit:sha,expectedRunId:runId,expectedPrepareOperationId:prepareId}))
      .rejects.toThrow("IDENTITY_INVALID");
  });
});
