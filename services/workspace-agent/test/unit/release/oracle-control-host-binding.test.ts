import { chmodSync,mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach,describe,expect,it } from "@jest/globals";
import {loadOracleControlBindingFromEnvironment} from "../../../src/release/oracle-control-host-binding.js";
import {OracleControlCaller} from "../../../src/release/oracle-control-caller.js";

const vars={
  MCP_V3_ORACLE_CONTROL_ENABLED:"1",
  MCP_V3_ORACLE_CONTROL_ENDPOINT:
    "https://mcp-v3-update-control.workers.dev/_internal/oracle-release-advance",
  MCP_V3_ORACLE_CONTROL_OWNER_SCOPE:"operator:release",
};
const secret="e".repeat(64);
let folder:string|undefined;
afterEach(()=>{if(folder)rmSync(folder,{recursive:true,force:true});folder=undefined;});
function fixture(mode=0o600){
  folder=mkdtempSync(path.join(tmpdir(),"oracle-control-host-"));
  const cred=path.join(folder,"hmac");
  writeFileSync(cred,secret+"\n",{mode:0o600});
  chmodSync(cred,mode);
  return cred;
}
const config=(file:string)=>({...vars,MCP_V3_ORACLE_CONTROL_HMAC_FILE:file});

describe("MCP V3 remote-agent Oracle release host enrollment",()=>{
  it("defaults disabled; rejects partial and explicit disabled configuration",async()=>{
    expect(await loadOracleControlBindingFromEnvironment({})).toBeUndefined();
    await expect(loadOracleControlBindingFromEnvironment({
      MCP_V3_ORACLE_CONTROL_ENABLED:"1",
    })).rejects.toThrow("incomplete");
    await expect(loadOracleControlBindingFromEnvironment({
      ...config(fixture()),MCP_V3_ORACLE_CONTROL_ENABLED:"0",
    })).rejects.toThrow("not authorized");
  });
  it("loads protected key only from a host-owned file and binds one exact owner scope",async()=>{
    if(process.platform!=="linux")return;
    const binding=await loadOracleControlBindingFromEnvironment(config(fixture()));
    expect(binding).toBeDefined();
    expect(await binding!.key()).toBe(secret);
    expect(new OracleControlCaller(binding!)).toBeDefined();
    const input={runId:"11111111-2222-4333-8444-555555555555",
      operationId:"11111111-2222-4333-8444-555555555556",
      expectedSourceSha:"a".repeat(40),expectedLastSeq:0};
    expect(await binding!.authorize(input,"operator:release")).toBe(true);
    expect(await binding!.authorize(input,"operator:other")).toBe(false);
    expect(await binding!.authorize(input,"")).toBe(false);
  });
  it("rejects unprotected files, symlinks, malformed key and missing credential",async()=>{
    if(process.platform!=="linux")return;
    const file=fixture(0o644);
    await expect(loadOracleControlBindingFromEnvironment(config(file)))
      .rejects.toThrow("credential is unavailable");
    chmodSync(file,0o600);
    const link=path.join(folder!,"link");
    symlinkSync(file,link);
    await expect(loadOracleControlBindingFromEnvironment(config(link)))
      .rejects.toThrow("credential is unavailable");
    writeFileSync(file,"bad-key\n",{mode:0o600});
    await expect(loadOracleControlBindingFromEnvironment(config(file)))
      .rejects.toThrow("credential is unavailable");
    await expect(loadOracleControlBindingFromEnvironment(
      config(path.join(folder!,"missing")))).rejects.toThrow("credential is unavailable");
  });
  it("accepts 0440 systemd credentials only inside the system credential directory",async()=>{
    if(process.platform!=="linux")return;
    const file=fixture(0o440);
    await expect(loadOracleControlBindingFromEnvironment(config(file)))
      .rejects.toThrow("credential is unavailable");
    const accepted=await loadOracleControlBindingFromEnvironment({
      ...config(file),CREDENTIALS_DIRECTORY:folder,
    });
    expect(await accepted!.key()).toBe(secret);
    await expect(loadOracleControlBindingFromEnvironment({
      ...config(file),CREDENTIALS_DIRECTORY:path.dirname(folder!),
    })).rejects.toThrow("credential is unavailable");
  });
  it("rejects any unauthorized owner-scope shape or operator impersonation by config",async()=>{
    if(process.platform!=="linux")return;
    await expect(loadOracleControlBindingFromEnvironment({
      ...config(fixture()),MCP_V3_ORACLE_CONTROL_OWNER_SCOPE:"  ",
    })).rejects.toThrow("incomplete");
    await expect(loadOracleControlBindingFromEnvironment({
      ...config(fixture()),MCP_V3_ORACLE_CONTROL_OWNER_SCOPE:"owner\nimpersonate",
    })).rejects.toThrow("incomplete");
  });
});
