import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {afterEach,describe,expect,it} from "@jest/globals";
import {composeOracleHostReleaseCapabilities} from "../../src/oracle-source-host-binding.js";
import {resolveOracleRemoteWorkflowPort} from "../../src/oracle-workflow-host-binding.js";
import {ORACLE_WORKFLOW_DISPATCH_PATH} from "@mcp-access-stack/update-control-contract";

let folder:string|undefined;
afterEach(()=>{if(folder)rmSync(folder,{recursive:true,force:true});folder=undefined;});
function environment(){
  folder=mkdtempSync(path.join(tmpdir(),"oracle-workflow-host-"));
  const file=path.join(folder,"workflow");
  writeFileSync(file,"a".repeat(64)+"\n",{mode:0o600});
  return {
    UPDATE_CONTROL_ORACLE_WORKFLOW_ENABLED:"1",
    UPDATE_CONTROL_ORACLE_WORKFLOW_URL:
      "https://mcp-v3-update-control.workers.dev"+ORACLE_WORKFLOW_DISPATCH_PATH,
    UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE:file,
    UPDATE_CONTROL_ORACLE_WORKFLOW_OWNER:"octo",
    UPDATE_CONTROL_ORACLE_WORKFLOW_REPOSITORY:"repo",
  };
}
describe("trusted Oracle workflow HMAC host binding",()=>{
  it("stays disabled by default, rejects partial input and foreign endpoint",()=>{
    expect(resolveOracleRemoteWorkflowPort({})).toBeUndefined();
    expect(()=>resolveOracleRemoteWorkflowPort({
      UPDATE_CONTROL_ORACLE_WORKFLOW_ENABLED:"1",
    })).toThrow("INCOMPLETE");
    expect(()=>resolveOracleRemoteWorkflowPort({
      ...environment(),
      UPDATE_CONTROL_ORACLE_WORKFLOW_URL:
        "https://evil.example"+ORACLE_WORKFLOW_DISPATCH_PATH,
    })).toThrow("ENDPOINT_INVALID");
  });
  it("uses protected independent key, pins repo and registers only real tag bootstrap",()=>{
    const env=environment();
    const port=resolveOracleRemoteWorkflowPort(env);
    expect(port).toBeDefined();
    const registry=composeOracleHostReleaseCapabilities(env,{
      authorizeWorkflow:async()=>true,
    });
    expect(registry.ready).toBe(false);
    expect([...registry.capabilities.keys()]).toEqual(["publish_release_tag"]);
    expect(registry.missingActions).toContain("publish_signed_release");
    expect(registry.missingActions).toContain("build_and_sign_release");
    expect(()=>registry.createExecutor(null as never)).toThrow("RELEASE_CAPABILITY_INCOMPLETE");
    expect(()=>composeOracleHostReleaseCapabilities(env,{})).toThrow(
      "ORACLE_WORKFLOW_HOST_AUTH_REQUIRED");
  });
  it("composes source reads and workflow tag without sharing credentials or policy",async()=>{
    const env=environment();
    const sourceFile=path.join(folder!,"source-distinct");
    writeFileSync(sourceFile,"b".repeat(64)+"\n",{mode:0o600});
    const joined={...env,UPDATE_CONTROL_ORACLE_SOURCE_ENABLED:"1",
      UPDATE_CONTROL_ORACLE_SOURCE_URL:
        "https://mcp-v3-update-control.workers.dev/_internal/oracle-source-read",
      UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE:sourceFile};
    let canDispatch=true;
    const registry=composeOracleHostReleaseCapabilities(joined,{
      authorizeRead:async()=>false,
      authorizeWorkflow:async()=>canDispatch,
    });
    expect([...registry.capabilities.keys()]).toEqual([
      "resolve_main_commit","verify_canonical_ci","publish_release_tag",
    ]);
    expect(registry.ready).toBe(false);
    const bootstrap=registry.capabilities.get("publish_release_tag")!;
    const run={status:"running",sourceCommitSha:"a".repeat(40),
      targetRelease:"v1.1.0-beta.90"} as never;
    expect(await bootstrap.authorize(null as never,run)).toBe(true);
    canDispatch=false;
    expect(await bootstrap.authorize(null as never,run)).toBe(false);
    expect(await registry.capabilities.get("resolve_main_commit")!.authorize(
      null as never,run)).toBe(false);
  });
  it("rejects shared credential paths and repeated HMAC value across domains",()=>{
    const env=environment();
    expect(()=>resolveOracleRemoteWorkflowPort({
      ...env,UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE:env.UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE,
    })).toThrow("CREDENTIAL_REUSED");
    const other=path.join(folder!,"source");
    writeFileSync(other,"a".repeat(64)+"\n",{mode:0o600});
    expect(()=>resolveOracleRemoteWorkflowPort({
      ...env,UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE:other,
    })).toThrow("CREDENTIAL_REUSED");
  });
  it("rejects unprotected and symlinked key files without leaking credentials",()=>{
    if(process.platform==="win32")return;
    const env=environment();
    chmodSync(env.UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE,0o644);
    expect(()=>resolveOracleRemoteWorkflowPort(env)).toThrow();
    chmodSync(env.UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE,0o600);
    const link=path.join(folder!,"link");
    symlinkSync(env.UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE,link);
    expect(()=>resolveOracleRemoteWorkflowPort({
      ...env,UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE:link,
    })).toThrow();
  });
});
