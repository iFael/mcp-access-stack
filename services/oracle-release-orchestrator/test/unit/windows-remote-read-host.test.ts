import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "@jest/globals";
import {WINDOWS_READ_DISPATCH_PATH}
  from "@mcp-access-stack/update-control-contract";
import {resolveWindowsRemoteReadPort}
  from "../../src/windows-remote-read-host.js";
let dir:string|undefined;
afterEach(()=>{if(dir){rmSync(dir,{recursive:true,force:true});dir=undefined;}});
function config(){
  dir=mkdtempSync(join(tmpdir(),"windows-read-auth-"));
  const file=join(dir,"hmac");
  writeFileSync(file,"d".repeat(64)+"\n",{mode:0o600});
  return {UPDATE_CONTROL_WINDOWS_READ_ENABLED:"1",
    UPDATE_CONTROL_WINDOWS_READ_URL:"https://mcp-v3-update-control.workers.dev"+
      WINDOWS_READ_DISPATCH_PATH,
    UPDATE_CONTROL_WINDOWS_READ_HMAC_FILE:file};
}
describe("Windows read HMAC enrollment kept independent and dormant",()=>{
  it("never enrolls implicitly and refuses incomplete or foreign endpoints",()=>{
    expect(resolveWindowsRemoteReadPort({})).toBeUndefined();
    expect(()=>resolveWindowsRemoteReadPort({
      UPDATE_CONTROL_WINDOWS_READ_ENABLED:"1"})).toThrow("INCOMPLETE");
    expect(()=>resolveWindowsRemoteReadPort({...config(),
      UPDATE_CONTROL_WINDOWS_READ_URL:"https://evil.example"+
        WINDOWS_READ_DISPATCH_PATH})).toThrow("ENDPOINT_INVALID");
  });
  it("loads independently protected key without enabling any effect port",()=>{
    if(process.platform==="win32")return;
    const env=config();
    const port=resolveWindowsRemoteReadPort(env)!;
    expect(typeof port.getState).toBe("function");
    expect(typeof port.inspectCandidate).toBe("function");
    expect("prepareWindows" in port).toBe(false);
    expect(()=>resolveWindowsRemoteReadPort({...env,
      UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE:
        env.UPDATE_CONTROL_WINDOWS_READ_HMAC_FILE})).toThrow("REUSED");
  });
  it("rejects symlinked, world-readable or malformed credentials",()=>{
    if(process.platform==="win32")return;
    const env=config();
    chmodSync(env.UPDATE_CONTROL_WINDOWS_READ_HMAC_FILE,0o644);
    expect(()=>resolveWindowsRemoteReadPort(env)).toThrow("CREDENTIAL_INVALID");
    chmodSync(env.UPDATE_CONTROL_WINDOWS_READ_HMAC_FILE,0o600);
    const link=join(dir!,"link");
    symlinkSync(env.UPDATE_CONTROL_WINDOWS_READ_HMAC_FILE,link);
    expect(()=>resolveWindowsRemoteReadPort({...env,
      UPDATE_CONTROL_WINDOWS_READ_HMAC_FILE:link})).toThrow("CREDENTIAL_INVALID");
    writeFileSync(env.UPDATE_CONTROL_WINDOWS_READ_HMAC_FILE,"bad\n");
    expect(()=>resolveWindowsRemoteReadPort(env)).toThrow("CREDENTIAL_INVALID");
  });
});
