import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {afterEach,describe,expect,it} from "@jest/globals";
import {resolveOracleRemoteSourceReadPort} from "../../src/oracle-source-host-binding.js";

let dir:string|undefined;
afterEach(()=>{if(dir)rmSync(dir,{recursive:true,force:true});dir=undefined;});
function config(){
  dir=mkdtempSync(path.join(tmpdir(),"oracle-source-host-"));
  const file=path.join(dir,"hmac");
  writeFileSync(file,"b".repeat(64)+"\n",{mode:0o600});
  return {
    UPDATE_CONTROL_ORACLE_SOURCE_ENABLED:"1",
    UPDATE_CONTROL_ORACLE_SOURCE_URL:
      "https://mcp-v3-update-control.workers.dev/_internal/oracle-source-read",
    UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE:file,
  };
}
describe("Oracle source read-only host enrollment",()=>{
  it("defaults disabled and rejects partial opt-in or wrong endpoint",()=>{
    expect(resolveOracleRemoteSourceReadPort({})).toBeUndefined();
    expect(()=>resolveOracleRemoteSourceReadPort({
      UPDATE_CONTROL_ORACLE_SOURCE_ENABLED:"1",
    })).toThrow("INCOMPLETE");
    expect(()=>resolveOracleRemoteSourceReadPort({
      ...config(),UPDATE_CONTROL_ORACLE_SOURCE_URL:"https://malicious.example/_internal/oracle-source-read",
    })).toThrow("ENDPOINT_INVALID");
  });
  it("accepts a dedicated protected HMAC file and builds typed read-only port",()=>{
    const port=resolveOracleRemoteSourceReadPort(config());
    expect(port).toBeDefined();
    expect(typeof port?.readMainHead).toBe("function");
    expect(typeof port?.readCommitChecks).toBe("function");
  });
  it("fails closed on wide mode, symlink, invalid key",()=>{
    if(process.platform==="win32")return;
    const env=config();
    chmodSync(env.UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE,0o644);
    expect(()=>resolveOracleRemoteSourceReadPort(env)).toThrow();
    chmodSync(env.UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE,0o600);
    const link=path.join(dir!,"link");
    symlinkSync(env.UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE,link);
    expect(()=>resolveOracleRemoteSourceReadPort({
      ...env,UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE:link,
    })).toThrow();
    writeFileSync(env.UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE,"invalid\n");
    expect(()=>resolveOracleRemoteSourceReadPort(env)).toThrow();
  });
});
