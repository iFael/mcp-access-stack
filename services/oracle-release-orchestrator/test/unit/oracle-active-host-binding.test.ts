import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {afterEach,describe,expect,it} from "@jest/globals";
import {ORACLE_ACTIVE_DISPATCH_PATH} from "@mcp-access-stack/update-control-contract";
import {resolveOracleRemoteActivePort} from "../../src/oracle-active-host-binding.js";
import {composeOracleHostReleaseCapabilities} from "../../src/oracle-source-host-binding.js";
let folder:string|undefined;
afterEach(()=>{if(folder)rmSync(folder,{recursive:true,force:true});folder=undefined;});
function env(){
  folder=mkdtempSync(path.join(tmpdir(),"oracle-active-host-"));
  const file=path.join(folder,"active");
  writeFileSync(file,"a".repeat(64)+"\n",{mode:0o600});
  return {UPDATE_CONTROL_ORACLE_ACTIVE_ENABLED:"1",
    UPDATE_CONTROL_ORACLE_ACTIVE_URL:
      "https://mcp-v3-update-control.workers.dev"+ORACLE_ACTIVE_DISPATCH_PATH,
    UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE:file};
}
describe("dedicated protected Oracle ACTIVE HMAC credential",()=>{
  it("defaults disabled, refuses partial configuration and foreign endpoints",()=>{
    expect(resolveOracleRemoteActivePort({})).toBeUndefined();
    expect(()=>resolveOracleRemoteActivePort({
      UPDATE_CONTROL_ORACLE_ACTIVE_ENABLED:"1"})).toThrow("INCOMPLETE");
    expect(()=>resolveOracleRemoteActivePort({...env(),
      UPDATE_CONTROL_ORACLE_ACTIVE_URL:"https://evil.example"+ORACLE_ACTIVE_DISPATCH_PATH
    })).toThrow("ENDPOINT_INVALID");
  });
  it("creates a read-only typed port, never an effect host",()=>{
    const port=resolveOracleRemoteActivePort(env())!;
    expect(typeof port.inspectActive).toBe("function");
    expect(typeof port.getState).toBe("function");
    expect(typeof port.getHealth).toBe("function");
    expect("promote" in port).toBe(false);
  });
  it("enrolls only with independent release authorization; incomplete registry remains NO-GO",()=>{
    const active=env();
    expect(()=>composeOracleHostReleaseCapabilities(active,{}))
      .toThrow("ORACLE_ACTIVE_HOST_AUTH_REQUIRED");
    const registry=composeOracleHostReleaseCapabilities(active,{
      authorizeActiveHealth:async()=>true,
    });
    expect(registry.ready).toBe(false);
    expect(registry.capabilities.has("verify_oracle_health")).toBe(true);
    expect(registry.missingActions).toContain("verify_windows_health");
    expect(()=>registry.createExecutor(null as never))
      .toThrow("RELEASE_CAPABILITY_INCOMPLETE");
    expect(()=>composeOracleHostReleaseCapabilities(active,{
      authorizeActiveHealth:async()=>true,
      oracleActiveHealth:{port:null as never,authorize:async()=>true},
    })).toThrow("ORACLE_ACTIVE_DUPLICATE_HOST");
  });
  it("rejects credential reuse, symlinks, wide modes and invalid HMAC",()=>{
    if(process.platform==="win32")return;
    const settings=env();
    expect(()=>resolveOracleRemoteActivePort({...settings,
      UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE:settings.UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE
    })).toThrow("CREDENTIAL_REUSED");
    chmodSync(settings.UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE,0o644);
    expect(()=>resolveOracleRemoteActivePort(settings)).toThrow();
    chmodSync(settings.UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE,0o600);
    const link=path.join(folder!,"link");
    symlinkSync(settings.UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE,link);
    expect(()=>resolveOracleRemoteActivePort({...settings,
      UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE:link})).toThrow();
    writeFileSync(settings.UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE,"bad\n");
    expect(()=>resolveOracleRemoteActivePort(settings)).toThrow();
  });
});