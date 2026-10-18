import {chmodSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,jest} from "@jest/globals";
import {ORACLE_ACTIVE_CONNECT_PATH}
  from "@mcp-access-stack/update-control-contract";
import {loadOracleActiveProviderFromEnvironment}
  from "../../../src/edge/oracle-active-provider-host.js";
const token="c".repeat(48);
const env={
  MCP_V3_ORACLE_ACTIVE_PROVIDER_ENABLED:"1",
  MCP_V3_ORACLE_ACTIVE_PROVIDER_URL:
    "wss://mcp-v3-update-control.workers.dev"+ORACLE_ACTIVE_CONNECT_PATH,
  MCP_V3_ORACLE_ACTIVE_PROVIDER_OWNER_SCOPE:"trusted:oracle-active",
  MCP_V3_ORACLE_ACTIVE_READ_ENABLED:"1",
  MCP_V3_ORACLE_ACTIVE_READ_OWNER_SCOPE:"trusted:oracle-active",
};
let dir:string|undefined;
afterEach(()=>{if(dir)rmSync(dir,{recursive:true,force:true});dir=undefined;});
function config(mode=0o600){
  dir=mkdtempSync(join(tmpdir(),"oracle-active-provider-"));
  const path=join(dir,"token");
  writeFileSync(path,token+"\n",{mode:0o600});chmodSync(path,mode);
  return {...env,MCP_V3_ORACLE_ACTIVE_PROVIDER_TOKEN_FILE:path};
}
const port={
  inspectActive:async(tag:string,sha:string)=>({
    releaseTag:tag,sourceCommitSha:sha,
    manifestSha256:"b".repeat(64),verifiedArtifactCount:1,
  }),
  getState:async()=>({active:null,previous:null,candidate:null}),
};
describe("Oracle active provider distinct enrollment",()=>{
  it("is absent unless configured and refuses partial setup",async()=>{
    expect(await loadOracleActiveProviderFromEnvironment({},()=>port)).toBeUndefined();
    await expect(loadOracleActiveProviderFromEnvironment({
      MCP_V3_ORACLE_ACTIVE_PROVIDER_ENABLED:"1",
    },()=>port)).rejects.toThrow("not enrolled");
  });
  it("pins host ownership and rejects reusing source or workflow credential",async()=>{
    if(process.platform!=="linux")return;
    const options=config();
    const create=jest.fn((_config:unknown)=>port);
    const loaded=await loadOracleActiveProviderFromEnvironment(options,create);
    expect(loaded?.token).toBe(token);
    expect(create).toHaveBeenCalledWith({workspaceId:"mcp-access-stack",
      ownerScope:"trusted:oracle-active"});
    await expect(loadOracleActiveProviderFromEnvironment({
      ...options,MCP_V3_ORACLE_CANDIDATE_PROVIDER_TOKEN_FILE:
        options.MCP_V3_ORACLE_ACTIVE_PROVIDER_TOKEN_FILE,
    },create)).rejects.toThrow("credential reused");
    await expect(loadOracleActiveProviderFromEnvironment({
      ...options,MCP_V3_ORACLE_ACTIVE_READ_OWNER_SCOPE:"wrong",
    },create)).rejects.toThrow("not enrolled");
  });
  it("rejects unsafe URLs and world-readable tokens",async()=>{
    if(process.platform!=="linux")return;
    const options=config(0o644);
    await expect(loadOracleActiveProviderFromEnvironment(options,()=>port))
      .rejects.toThrow("credential unavailable");
    chmodSync(options.MCP_V3_ORACLE_ACTIVE_PROVIDER_TOKEN_FILE,0o600);
    await expect(loadOracleActiveProviderFromEnvironment({
      ...options,MCP_V3_ORACLE_ACTIVE_PROVIDER_URL:
        "wss://evil.example"+ORACLE_ACTIVE_CONNECT_PATH,
    },()=>port)).rejects.toThrow("URL invalid");
  });
});
