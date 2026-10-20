import {describe,expect,it,jest} from "@jest/globals";
import {ReloadableLocalAgent} from "../../../src/companion/reloadable-local-agent.js";
import type {LocalAgent} from "@vs-code-gpt/local-agent";

const tag="v1.1.0-beta.90",sha="a".repeat(40);
const receipt={releaseTag:tag,sourceCommitSha:sha,
  manifestSha256:"b".repeat(64),verifiedArtifactCount:13};
const host={workspaceId:"mcp-access-stack" as const,
  ownerScope:"trusted:oracle-candidate"};
function harness(fake:Partial<LocalAgent>|null){
  const reloadable=new ReloadableLocalAgent();
  const state=reloadable as unknown as {currentAgent:LocalAgent|null;generation:number};
  state.currentAgent=fake as LocalAgent|null;state.generation=1;
  return {reloadable,state};
}
describe("Oracle candidate read port follows exact host policy generation",()=>{
  it("never exposes candidate bytes or caller-chosen workspace/scope",async()=>{
    const inspect=jest.fn(async(_input:unknown,_context:unknown)=>receipt);
    const {reloadable}=harness({oracleInspectCandidate:inspect} as Partial<LocalAgent>);
    expect(await reloadable.oracleCandidateReadPort(host).readCandidate(tag,sha))
      .toEqual(receipt);
    expect(inspect).toHaveBeenCalledWith(
      {workspaceId:"mcp-access-stack",tag,commitSha:sha},
      {ownerScope:host.ownerScope});
  });
  it("rejects an offline or revoked host before and after in-flight reads",async()=>{
    const {reloadable,state}=harness(null);
    const port=reloadable.oracleCandidateReadPort(host);
    await expect(port.readCandidate(tag,sha)).rejects.toThrow("offline");
    let finish!: (value:typeof receipt)=>void;
    const pending=new Promise<typeof receipt>(resolve=>{finish=resolve;});
    const inspect=jest.fn(async(_input:unknown,_context:unknown)=>pending);
    state.currentAgent={oracleInspectCandidate:inspect} as unknown as LocalAgent;
    const result=port.readCandidate(tag,sha);
    await Promise.resolve();
    state.currentAgent=null;state.generation++;
    finish(receipt);
    await expect(result).rejects.toThrow("policy changed");
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it("fails closed when a receipt is forged or the caller input is malformed",async()=>{
    const inspect=jest.fn(async(_input:unknown,_context:unknown)=>({...receipt,manifestSha256:"invalid"}));
    const {reloadable}=harness({oracleInspectCandidate:inspect} as Partial<LocalAgent>);
    const port=reloadable.oracleCandidateReadPort(host);
    await expect(port.readCandidate(tag,sha)).rejects.toThrow("RECEIPT_INVALID");
    await expect(port.readCandidate("../state",sha)).rejects.toThrow("REQUEST_INVALID");
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
