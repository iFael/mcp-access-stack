import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {afterEach,describe,expect,it} from "@jest/globals";
import {ORACLE_CANDIDATE_DISPATCH_PATH} from "@mcp-access-stack/update-control-contract";
import {resolveOracleRemoteCandidatePort}
  from "../../src/oracle-candidate-host-binding.js";
import {composeOracleHostReleaseCapabilities}
  from "../../src/oracle-source-host-binding.js";
let folder:string|undefined;
afterEach(()=>{if(folder)rmSync(folder,{recursive:true,force:true});folder=undefined;});
function settings(mode=0o600){
  folder=mkdtempSync(path.join(tmpdir(),"oracle-candidate-host-"));
  const file=path.join(folder,"candidate");
  writeFileSync(file,"c".repeat(64)+"\n",{mode:0o600});
  chmodSync(file,mode);
  return {
    UPDATE_CONTROL_ORACLE_CANDIDATE_ENABLED:"1",
    UPDATE_CONTROL_ORACLE_CANDIDATE_URL:
      "https://mcp-v3-update-control.workers.dev"+ORACLE_CANDIDATE_DISPATCH_PATH,
    UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE:file,
  };
}
describe("Oracle single-writer candidate reader with a distinct HMAC",()=>{
  it("is absent by default and fails closed on partial enrollment",()=>{
    expect(resolveOracleRemoteCandidatePort({})).toBeUndefined();
    expect(()=>resolveOracleRemoteCandidatePort({
      UPDATE_CONTROL_ORACLE_CANDIDATE_ENABLED:"1",
    })).toThrow("HOST_INCOMPLETE");
    expect(()=>resolveOracleRemoteCandidatePort({
      ...settings(),
      UPDATE_CONTROL_ORACLE_CANDIDATE_URL:
        "https://evil.example"+ORACLE_CANDIDATE_DISPATCH_PATH,
    })).toThrow("ENDPOINT_INVALID");
  });
  it("pins credential and requires an independently authorized ledger capability",()=>{
    const env=settings();
    const port=resolveOracleRemoteCandidatePort(env);
    expect(typeof port?.inspect).toBe("function");
    expect(()=>composeOracleHostReleaseCapabilities(env,{}))
      .toThrow("ORACLE_CANDIDATE_HOST_AUTH_REQUIRED");
    const registry=composeOracleHostReleaseCapabilities(env,{
      authorizeCandidateRead:async()=>true,
    });
    expect(registry.ready).toBe(false);
    expect(registry.capabilities.has("validate_oracle_candidate")).toBe(true);
    expect(registry.missingActions).not.toContain("validate_oracle_candidate");
    expect(registry.missingActions).toContain("deploy_edge");
    expect(()=>registry.createExecutor(null as never)).toThrow("RELEASE_CAPABILITY_INCOMPLETE");
    expect(()=>composeOracleHostReleaseCapabilities(env,{
      authorizeCandidateRead:async()=>true,
      oracleCandidate:{installationRoot:"/var/lib/mcp-access-stack",
        authorize:async()=>true},
    })).toThrow("DUPLICATE_HOST");
  });
  it("rejects path reuse, symlink, weak permission and invalid key",()=>{
    if(process.platform==="win32")return;
    const env=settings();
    expect(()=>resolveOracleRemoteCandidatePort({...env,
      UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE:env.UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE,
    })).toThrow("CREDENTIAL_REUSED");
    chmodSync(env.UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE,0o644);
    expect(()=>resolveOracleRemoteCandidatePort(env)).toThrow();
    chmodSync(env.UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE,0o600);
    const link=path.join(folder!,"link");
    symlinkSync(env.UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE,link);
    expect(()=>resolveOracleRemoteCandidatePort({...env,
      UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE:link,
    })).toThrow();
    writeFileSync(env.UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE,"invalid\n");
    expect(()=>resolveOracleRemoteCandidatePort(env)).toThrow();
  });
});
