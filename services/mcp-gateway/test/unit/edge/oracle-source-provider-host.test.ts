import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it} from "@jest/globals";
import {loadOracleSourceProviderFromEnvironment}
  from "../../../src/edge/oracle-source-provider-host.js";
import {ORACLE_SOURCE_CONNECT_PATH} from "@mcp-access-stack/update-control-contract";
const fields={
  MCP_V3_ORACLE_SOURCE_PROVIDER_ENABLED:"1",
  MCP_V3_ORACLE_SOURCE_PROVIDER_URL:
    "wss://mcp-v3-update-control.workers.dev"+ORACLE_SOURCE_CONNECT_PATH,
  MCP_V3_ORACLE_SOURCE_PROVIDER_OWNER:"octo",
  MCP_V3_ORACLE_SOURCE_PROVIDER_REPOSITORY:"repo",
  MCP_V3_ORACLE_SOURCE_PROVIDER_OWNER_SCOPE:"trusted:release-operator",
};
let folder:string|undefined;
afterEach(()=>{if(folder)rmSync(folder,{recursive:true,force:true});folder=undefined;});
function make(mode=0o600){
  folder=mkdtempSync(path.join(tmpdir(),"mcp-oracle-source-provider-"));
  const file=path.join(folder,"token");
  writeFileSync(file,"p".repeat(48)+"\n",{mode:0o600});chmodSync(file,mode);
  return {...fields,MCP_V3_ORACLE_SOURCE_PROVIDER_TOKEN_FILE:file};
}
const factory=(c:{owner:string;repository:string;ownerScope:string})=>{
  expect(c).toMatchObject({owner:"octo",repository:"repo",ownerScope:"trusted:release-operator"});
  return {readMainHead:async()=> "a".repeat(40),readCommitChecks:async()=>({})};
};
describe("Oracle source host enrollment",()=>{
  it("defaults disabled and refuses partial or wrong URL",async()=>{
    expect(await loadOracleSourceProviderFromEnvironment({},factory)).toBeUndefined();
    await expect(loadOracleSourceProviderFromEnvironment({
      MCP_V3_ORACLE_SOURCE_PROVIDER_ENABLED:"1"},factory)).rejects.toThrow();
    if(process.platform==="linux"){
      await expect(loadOracleSourceProviderFromEnvironment({
        ...make(),MCP_V3_ORACLE_SOURCE_PROVIDER_URL:
          "wss://malicious.example"+ORACLE_SOURCE_CONNECT_PATH,
      },factory)).rejects.toThrow("URL invalid");
    }
  });
  it("uses host-owned repository identity and protected token",async()=>{
    if(process.platform!=="linux")return;
    const options=await loadOracleSourceProviderFromEnvironment(make(),factory);
    expect(options?.token).toBe("p".repeat(48));
    expect(options?.url.pathname).toBe(ORACLE_SOURCE_CONNECT_PATH);
  });
  it("fails closed on wide file permissions, symlinks and wrong ownerScope",async()=>{
    if(process.platform!=="linux")return;
    const config=make(0o644);
    await expect(loadOracleSourceProviderFromEnvironment(config,factory)).rejects.toThrow("credential unavailable");
    chmodSync(config.MCP_V3_ORACLE_SOURCE_PROVIDER_TOKEN_FILE,0o600);
    const link=path.join(folder!,"link");
    symlinkSync(config.MCP_V3_ORACLE_SOURCE_PROVIDER_TOKEN_FILE,link);
    await expect(loadOracleSourceProviderFromEnvironment({
      ...config,MCP_V3_ORACLE_SOURCE_PROVIDER_TOKEN_FILE:link,
    },factory)).rejects.toThrow("credential unavailable");
    await expect(loadOracleSourceProviderFromEnvironment({
      ...config,MCP_V3_ORACLE_SOURCE_PROVIDER_OWNER_SCOPE:"\nspoof",
    },factory)).rejects.toThrow("host policy is incomplete");
  });
});
