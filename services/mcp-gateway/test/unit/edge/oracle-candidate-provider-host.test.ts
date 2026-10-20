import {chmodSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,jest} from "@jest/globals";
import {ORACLE_CANDIDATE_CONNECT_PATH}
  from "@mcp-access-stack/update-control-contract";
import {loadOracleCandidateProviderFromEnvironment}
  from "../../../src/edge/oracle-candidate-provider-host.js";
const token="c".repeat(48);
const env={
  MCP_V3_ORACLE_CANDIDATE_PROVIDER_ENABLED:"1",
  MCP_V3_ORACLE_CANDIDATE_PROVIDER_URL:
    "wss://mcp-v3-update-control.workers.dev"+ORACLE_CANDIDATE_CONNECT_PATH,
  MCP_V3_ORACLE_CANDIDATE_PROVIDER_OWNER_SCOPE:"trusted:oracle-candidate",
  MCP_V3_ORACLE_CANDIDATE_READ_ENABLED:"1",
  MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE:"trusted:oracle-candidate",
};
let dir:string|undefined;
afterEach(()=>{if(dir)rmSync(dir,{recursive:true,force:true});dir=undefined;});
function config(mode=0o600){
  dir=mkdtempSync(join(tmpdir(),"oracle-candidate-provider-"));
  const path=join(dir,"token");
  writeFileSync(path,token+"\n",{mode:0o600});chmodSync(path,mode);
  return {...env,MCP_V3_ORACLE_CANDIDATE_PROVIDER_TOKEN_FILE:path};
}
const port={readCandidate:async(tag:string,sha:string)=>({
  releaseTag:tag,sourceCommitSha:sha,
  manifestSha256:"b".repeat(64),verifiedArtifactCount:1,
})};
describe("Oracle candidate provider distinct enrollment",()=>{
  it("is absent unless configured and refuses partial setup",async()=>{
    expect(await loadOracleCandidateProviderFromEnvironment({},()=>port)).toBeUndefined();
    await expect(loadOracleCandidateProviderFromEnvironment({
      MCP_V3_ORACLE_CANDIDATE_PROVIDER_ENABLED:"1",
    },()=>port)).rejects.toThrow("not enrolled");
  });
  it("pins host ownership and rejects reusing source or workflow credential",async()=>{
    if(process.platform!=="linux")return;
    const options=config();
    const create=jest.fn((_config:unknown)=>port);
    const loaded=await loadOracleCandidateProviderFromEnvironment(options,create);
    expect(loaded?.token).toBe(token);
    expect(create).toHaveBeenCalledWith({workspaceId:"mcp-access-stack",
      ownerScope:"trusted:oracle-candidate"});
    await expect(loadOracleCandidateProviderFromEnvironment({
      ...options,MCP_V3_ORACLE_WORKFLOW_PROVIDER_TOKEN_FILE:
        options.MCP_V3_ORACLE_CANDIDATE_PROVIDER_TOKEN_FILE,
    },create)).rejects.toThrow("credential reused");
    await expect(loadOracleCandidateProviderFromEnvironment({
      ...options,MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE:"wrong",
    },create)).rejects.toThrow("not enrolled");
  });
  it("rejects unsafe URLs and world-readable tokens",async()=>{
    if(process.platform!=="linux")return;
    const options=config(0o644);
    await expect(loadOracleCandidateProviderFromEnvironment(options,()=>port))
      .rejects.toThrow("credential unavailable");
    chmodSync(options.MCP_V3_ORACLE_CANDIDATE_PROVIDER_TOKEN_FILE,0o600);
    await expect(loadOracleCandidateProviderFromEnvironment({
      ...options,MCP_V3_ORACLE_CANDIDATE_PROVIDER_URL:
        "wss://evil.example"+ORACLE_CANDIDATE_CONNECT_PATH,
    },()=>port)).rejects.toThrow("URL invalid");
  });
});
