import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it} from "@jest/globals";
import {resolveOracleControlTransport,startFromEnvironment} from "../../src/server.js";

let folder:string|undefined;
afterEach(()=>{if(folder)rmSync(folder,{recursive:true,force:true});folder=undefined;});
function setup(mode=0o600){
  folder=mkdtempSync(path.join(tmpdir(),"oracle-control-enrollment-"));
  const file=path.join(folder,"control-token");
  writeFileSync(file,"c".repeat(48)+"\n",{mode:0o600});
  chmodSync(file,mode);
  return {
    UPDATE_CONTROL_ORACLE_CONTROL_ENABLED:"1",
    UPDATE_CONTROL_ORACLE_CONTROL_URL:
      "wss://mcp-v3-update-control.workers.dev/_internal/oracle-release-control",
    UPDATE_CONTROL_ORACLE_CONTROL_TOKEN_FILE:file,
  };
}
describe("Oracle single-writer secure control enrollment",()=>{
  it("stays disabled by default; rejects incomplete or explicitly off configuration",()=>{
    expect(resolveOracleControlTransport({})).toBeUndefined();
    expect(()=>resolveOracleControlTransport({UPDATE_CONTROL_ORACLE_CONTROL_ENABLED:"1"}))
      .toThrow("ORACLE_CONTROL_CONFIG_INCOMPLETE");
    expect(()=>resolveOracleControlTransport({
      ...setup(),UPDATE_CONTROL_ORACLE_CONTROL_ENABLED:"0",
    })).toThrow("ORACLE_CONTROL_CONFIG_INCOMPLETE");
  });
  it("loads protected independent credential for the exact outbound WSS route",()=>{
    const config=resolveOracleControlTransport(setup(),"r".repeat(48));
    expect(config?.url.pathname).toBe("/_internal/oracle-release-control");
    expect(config?.credential).toBe("c".repeat(48));
  });
  it("rejects the read credential and any wrong or HTTP endpoint",()=>{
    const config=setup();
    expect(()=>resolveOracleControlTransport(config,"c".repeat(48)))
      .toThrow("ORACLE_CONTROL_MUST_NOT_REUSE_READ_CREDENTIAL");
    expect(()=>resolveOracleControlTransport({
      ...config,UPDATE_CONTROL_ORACLE_CONTROL_URL:
        "https://mcp-v3-update-control.workers.dev/_internal/oracle-release-control",
    })).toThrow("ORACLE_CONTROL_CONFIG_INVALID");
    expect(()=>resolveOracleControlTransport({
      ...config,UPDATE_CONTROL_ORACLE_CONTROL_URL:
        "wss://example.com/_internal/oracle-release-control",
    })).toThrow("ORACLE_CONTROL_CONFIG_INVALID");
  });
  it("rejects symlinks and unprotected files",()=>{
    if(process.platform==="win32")return;
    const config=setup(0o644);
    expect(()=>resolveOracleControlTransport(config)).toThrow("unavailable or invalid");
    chmodSync(config.UPDATE_CONTROL_ORACLE_CONTROL_TOKEN_FILE,0o600);
    const linked=path.join(folder!,"link");
    symlinkSync(config.UPDATE_CONTROL_ORACLE_CONTROL_TOKEN_FILE,linked);
    expect(()=>resolveOracleControlTransport({
      ...config,UPDATE_CONTROL_ORACLE_CONTROL_TOKEN_FILE:linked,
    })).toThrow("unavailable or invalid");
  });
  it("cannot start any mutating Oracle channel without complete typed capability registry",()=>{
    const config=setup();
    expect(()=>startFromEnvironment({
      ...config,
      ORCHESTRATOR_LEDGER_PATH:path.join(folder!,"ledger.sqlite"),
      ORCHESTRATOR_RELEASE_ROOT:path.join(folder!,"releases"),
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN:"r".repeat(48),
    })).toThrow("ORACLE_CONTROL_REQUIRES_AUTHORIZED_CAPABILITIES");
  });
});
