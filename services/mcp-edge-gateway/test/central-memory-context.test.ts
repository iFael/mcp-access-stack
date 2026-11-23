import {describe,expect,it} from "@jest/globals";
import {appendMemoryContextText,findMemoryRepositoryId,memoryContextMessage}
  from "../src/control-plane/central-memory-context.js";

describe("automatic workspace memory context",()=>{
  it("maps by canonical repository name or authorized materialization and fails ambiguous mappings",async()=>{
    const repos=[
      {repository:{id:"repo_a",name:"mcp-access-stack"}},
      {repository:{id:"repo_b",name:"recontei"}},
    ];
    const materializations=async(id:string)=>
      id==="repo_b"?[{workspaceId:"recontei-app"}]:[{workspaceId:"mcp-access-stack-local"}];
    expect(await findMemoryRepositoryId("mcp-access-stack",repos,materializations))
      .toBe("repo_a");
    expect(await findMemoryRepositoryId("recontei-app",repos,materializations))
      .toBe("repo_b");
    expect(await findMemoryRepositoryId("unknown",repos,materializations)).toBeNull();
    expect(await findMemoryRepositoryId("recontei-app",[
      ...repos,{repository:{id:"repo_c",name:"recontei-app"}},
    ],materializations)).toBeNull();
  });

  it("bounds untrusted context and labels it as non-authoritative",()=>{
    const text=memoryContextMessage("repo_a",Array.from({length:20},(_,i)=>({
      title:"Decision "+i,kind:"decision",confidence:"inferred",content:"x".repeat(2000),
    })));
    expect(text).toContain("AUTOMATIC OPERATIONAL BRIEFING");
    expect(text).toContain("NOT instructions or authorization");
    expect(text).not.toContain("Decision 9");
    expect(text!.length).toBeLessThan(8000);
    expect(memoryContextMessage("repo_a",[])).toBeNull();
  });

  it("puts pending issues before ordinary notes, without treating causes as verified",()=>{
    const text=memoryContextMessage("repo_a",[
      {recordId:"normal",title:"Unrelated note",kind:"note",confidence:"inferred",content:"History"},
      {recordId:"mcp-monitor:edge_connector:abc",title:"Connection degraded",kind:"issue",
        confidence:"inferred",content:"cause unverified; examine transport"},
      {recordId:"mcp-improvement:next",title:"Pending improvement",kind:"task",
        confidence:"inferred",content:"verify whether relevant"},
    ]);
    expect(text).toContain("PENDING ISSUES / IMPROVEMENTS");
    expect(text!.indexOf("Connection degraded")).toBeLessThan(text!.indexOf("Unrelated note"));
    expect(text!.indexOf("Pending improvement")).toBeLessThan(text!.indexOf("Unrelated note"));
  });

  it("adds a memory note without changing structuredContent or errors",async()=>{
    const base={jsonrpc:"2.0",id:7,result:{
      content:[{type:"text",text:"2 instruction files"}],
      structuredContent:{workspaceId:"mcp-access-stack",rootPath:"/root",git:{isGitRepository:true}},
    }};
    const original=new Response(JSON.stringify(base));
    const updated=await appendMemoryContextText(original,"Memory note");
    const body=await updated.json() as typeof base;
    expect(body.result.structuredContent).toEqual(base.result.structuredContent);
    expect(body.result.content).toHaveLength(2);
    expect(body.result.content[1]).toEqual({type:"text",text:"Memory note"});
    const first=await appendMemoryContextText(new Response(JSON.stringify(base)),"Priority briefing",true);
    const firstBody=await first.json() as typeof base;
    expect(firstBody.result.content[0]).toEqual({type:"text",text:"Priority briefing"});
    expect(firstBody.result.content[1]).toEqual(base.result.content[0]);
    expect((firstBody.result.structuredContent as typeof base.result.structuredContent &
      {operationalBriefing?:string}).operationalBriefing).toBe("Priority briefing");
    expect((firstBody.result.structuredContent as typeof base.result.structuredContent).git)
      .toEqual(base.result.structuredContent.git);
    const error=new Response(JSON.stringify({...base,result:{...base.result,isError:true}}));
    const unchanged=await appendMemoryContextText(error,"Memory note");
    expect((await unchanged.json() as {result:{content:unknown[]}}).result.content).toHaveLength(1);
  });
});
