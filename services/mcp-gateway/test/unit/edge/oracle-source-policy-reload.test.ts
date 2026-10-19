import {describe,expect,it} from "@jest/globals";
import {ReloadableLocalAgent} from "../../../src/companion/reloadable-local-agent.js";
import type {LocalAgent} from "@vs-code-gpt/local-agent";
const config={workspaceId:"mcp-access-stack" as const,owner:"octo",repository:"repo",
  ownerScope:"trusted:release-operator"};
describe("Oracle reverse source rejects policy-generation drift",()=>{
  it("does not return a GitHub result when agent policy reloads while request is pending",async()=>{
    const reloadable=new ReloadableLocalAgent();
    let resolve!: (v:string)=>void;
    const pending=new Promise<string>(r=>{resolve=r;});
    const inner={
      releaseReadGitHubMainHead:async()=>pending,
      githubGetCommitChecks:async()=>{throw new Error("not used");},
    } as unknown as LocalAgent;
    const unsafe=reloadable as unknown as {currentAgent:LocalAgent|null;generation:number};
    unsafe.currentAgent=inner;unsafe.generation=1;
    const port=reloadable.oracleSourceReadPort(config);
    const result=port.readMainHead();
    await Promise.resolve();
    unsafe.currentAgent=null;unsafe.generation=2;
    resolve("a".repeat(40));
    await expect(result).rejects.toThrow("policy changed");
  });
});
