import {chmodSync,mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,jest} from "@jest/globals";
import {WINDOWS_READ_CONNECT_PATH} from "@mcp-access-stack/update-control-contract";
import {loadWindowsReadProviderFromEnvironment} from
  "../../../src/edge/windows-read-provider-host.js";

const url="wss://mcp-v3-update-control.workers.dev"+WINDOWS_READ_CONNECT_PATH;
const token="windows-read-provider-enrollment-".padEnd(48,"z");
const owner="trusted:windows-read";
let dir:string|undefined;
afterEach(()=>{if(dir)rmSync(dir,{force:true,recursive:true});dir=undefined;});
function fixture(){
  dir=mkdtempSync(join(tmpdir(),"windows-host-enrollment-"));
  const scripts=join(dir,"scripts"),installation=join(dir,"installation"),
    secrets=join(dir,"credentials");
  mkdirSync(scripts);mkdirSync(installation);mkdirSync(secrets);
  const file=join(secrets,"windows-provider.token");
  writeFileSync(file,token+"\n",{mode:0o600});
  return {
    MCP_V3_WINDOWS_READ_ENABLED:"1",
    MCP_V3_WINDOWS_READ_OWNER_SCOPE:owner,
    MCP_V3_WINDOWS_READ_PROVIDER_ENABLED:"1",
    MCP_V3_WINDOWS_READ_PROVIDER_URL:url,
    MCP_V3_WINDOWS_READ_PROVIDER_OWNER_SCOPE:owner,
    MCP_V3_WINDOWS_READ_PROVIDER_TOKEN_FILE:file,
    MCP_V3_WINDOWS_READ_PROVIDER_INSTALLATION_ROOT:installation,
    MCP_V3_WINDOWS_READ_PROVIDER_SCRIPTS_ROOT:scripts,
    MCP_V3_WINDOWS_READ_PROVIDER_READER_SHA256:"a".repeat(64),
    MCP_V3_WINDOWS_READ_PROVIDER_PUBLIC_HELPER_SHA256:"b".repeat(64),
    MCP_V3_WINDOWS_READ_PROVIDER_NODE_HELPER_SHA256:"c".repeat(64),
  };
}
function authority(allowed=true){
  const verifyWindowsTokenAcl=jest.fn(async(_file:string,_owner:string)=>allowed);
  const authorize=jest.fn(async()=>true);
  return {trust:{platform:"win32" as const,
    credentialAuthority:{verifyWindowsTokenAcl},
    policy:{ownerScope:owner,authorize}},verifyWindowsTokenAcl};
}
describe("Windows provider host enrollment is explicit and fail closed",()=>{
  it("is dormant without provider-specific configuration",async()=>{
    const {trust,verifyWindowsTokenAcl}=authority();
    expect(await loadWindowsReadProviderFromEnvironment({},trust)).toBeUndefined();
    expect(verifyWindowsTokenAcl).not.toHaveBeenCalled();
  });
  it("returns strict WSS options only after trusted ACL and owner checks",async()=>{
    const env=fixture(),{trust,verifyWindowsTokenAcl}=authority();
    const options=await loadWindowsReadProviderFromEnvironment(env,trust);
    expect(options?.url.href).toBe(url);
    expect(options?.token).toBe(token);
    expect(options?.port).toHaveProperty("getState");
    expect(options?.port).toHaveProperty("inspectCandidate");
    expect(options?.port).toHaveProperty("inspectActive");
    expect(options?.port).not.toHaveProperty("getHealth");
    expect(verifyWindowsTokenAcl).toHaveBeenCalledWith(
      env.MCP_V3_WINDOWS_READ_PROVIDER_TOKEN_FILE,owner);
  });
  it("requires a native ACL authority; POSIX mode alone never authorizes",async()=>{
    const env=fixture();
    const {trust}=authority(false);
    await expect(loadWindowsReadProviderFromEnvironment(env,trust))
      .rejects.toThrow("not enrolled");
    await expect(loadWindowsReadProviderFromEnvironment(env,{
      ...trust,credentialAuthority:undefined as never})).rejects.toThrow();
    chmodSync(env.MCP_V3_WINDOWS_READ_PROVIDER_TOKEN_FILE,0o600);
    await expect(loadWindowsReadProviderFromEnvironment(env,trust))
      .rejects.toThrow();
  });
  it("rejects partial setup, wrong host, owner mismatch and untrusted URL",async()=>{
    const env=fixture(),{trust}=authority();
    await expect(loadWindowsReadProviderFromEnvironment({
      MCP_V3_WINDOWS_READ_PROVIDER_ENABLED:"1",
    },trust)).rejects.toThrow();
    await expect(loadWindowsReadProviderFromEnvironment(env,{
      ...trust,platform:"linux",
    })).rejects.toThrow();
    await expect(loadWindowsReadProviderFromEnvironment({
      ...env,MCP_V3_WINDOWS_READ_OWNER_SCOPE:"foreign",
    },trust)).rejects.toThrow();
    await expect(loadWindowsReadProviderFromEnvironment({
      ...env,MCP_V3_WINDOWS_READ_PROVIDER_URL:
        "wss://evil.example"+WINDOWS_READ_CONNECT_PATH,
    },trust)).rejects.toThrow();
    await expect(loadWindowsReadProviderFromEnvironment({
      ...env,MCP_V3_WINDOWS_READ_PROVIDER_READER_SHA256:"bad",
    },trust)).rejects.toThrow();
  });
  it("sanitizes ACL authority failures and never reads the token",async()=>{
    const env=fixture();
    const {trust}=authority();
    const verifyWindowsTokenAcl=jest.fn(async()=>{throw new Error("sensitive internal path");});
    await expect(loadWindowsReadProviderFromEnvironment(env,{
      ...trust,credentialAuthority:{verifyWindowsTokenAcl},
    })).rejects.toThrow("not enrolled");
    expect(verifyWindowsTokenAcl).toHaveBeenCalledTimes(1);
  });
  it("fails closed when ACL authorization is revoked during token read",async()=>{
    const env=fixture(),{trust}=authority();
    let checks=0;
    const verifyWindowsTokenAcl=jest.fn(async()=>++checks===1);
    await expect(loadWindowsReadProviderFromEnvironment(env,{
      ...trust,credentialAuthority:{verifyWindowsTokenAcl},
    })).rejects.toThrow("not enrolled");
    expect(verifyWindowsTokenAcl).toHaveBeenCalledTimes(2);
  });
  it("rejects redirected token parent directories",async()=>{
    if(process.platform==="win32")return;
    const env=fixture(),{trust,verifyWindowsTokenAcl}=authority();
    const redirected=join(dir!,"redirected-credentials");
    symlinkSync(join(dir!,"credentials"),redirected,"dir");
    await expect(loadWindowsReadProviderFromEnvironment({
      ...env,MCP_V3_WINDOWS_READ_PROVIDER_TOKEN_FILE:
        join(redirected,"windows-provider.token"),
    },trust)).rejects.toThrow("not enrolled");
    expect(verifyWindowsTokenAcl).not.toHaveBeenCalled();
  });
  it("refuses reuse, paths below mutable tree and symlink tokens",async()=>{
    const env=fixture(),{trust}=authority();
    await expect(loadWindowsReadProviderFromEnvironment({
      ...env,MCP_V3_ORACLE_ACTIVE_PROVIDER_TOKEN_FILE:
        env.MCP_V3_WINDOWS_READ_PROVIDER_TOKEN_FILE,
    },trust)).rejects.toThrow();
    await expect(loadWindowsReadProviderFromEnvironment({
      ...env,MCP_V3_WINDOWS_READ_PROVIDER_SCRIPTS_ROOT:
        join(env.MCP_V3_WINDOWS_READ_PROVIDER_INSTALLATION_ROOT,"releases"),
    },trust)).rejects.toThrow();
    await expect(loadWindowsReadProviderFromEnvironment({
      ...env,MCP_V3_WINDOWS_READ_PROVIDER_TOKEN_FILE:
        join(env.MCP_V3_WINDOWS_READ_PROVIDER_SCRIPTS_ROOT,"secret"),
    },trust)).rejects.toThrow();
    const link=join(dir!,"credential-link");
    symlinkSync(env.MCP_V3_WINDOWS_READ_PROVIDER_TOKEN_FILE,link);
    await expect(loadWindowsReadProviderFromEnvironment({
      ...env,MCP_V3_WINDOWS_READ_PROVIDER_TOKEN_FILE:link,
    },trust)).rejects.toThrow();
  });
});
