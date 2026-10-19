import {execFile as execFileCallback} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile,lstat} from "node:fs/promises";
import {isAbsolute,join,resolve,sep,parse} from "node:path";
import {promisify} from "node:util";
import type {WindowsNativeReadInvoker} from "./windows-read-native-port.js";

const execFile=promisify(execFileCallback);
const READER="Get-McpWindowsExecutionNodeReadEvidence.ps1";
const DEPENDENCIES=["PublicDistribution.Common.ps1",
  "WindowsExecutionNode.Common.ps1"] as const;
const SHA=/^[a-f0-9]{64}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const COMMIT=/^[a-f0-9]{40}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
type Observation=Parameters<WindowsNativeReadInvoker["observe"]>[0];
export interface WindowsFixedScriptConfig{
  /** Trusted host configuration only, never sourced from RPC input. */
  readonly installationRoot:string;
  readonly scriptsRoot:string;
  /** Pinned from the trusted release inventory; not provided by the caller. */
  readonly expectedReaderSha256:string;
  readonly expectedHelperSha256:Readonly<{
    "PublicDistribution.Common.ps1":string;
    "WindowsExecutionNode.Common.ps1":string;
  }>;
  readonly platform?:NodeJS.Platform;
}
export interface WindowsFixedScriptDependencies{
  readonly execute?:(file:string,args:readonly string[])=>Promise<string>;
}
function allowed(input:Observation):void{
  if(input.mode==="State"){
    if(Object.keys(input).length!==1)throw new Error("WINDOWS_READER_STATE_INPUT_INVALID");
    return;
  }
  const names=["mode","expectedTag","expectedCommit",
    ...(input.mode==="Candidate"?["expectedRunId","expectedPrepareOperationId"]:[])];
  if(Object.keys(input).length!==names.length ||
    !names.every(key=>Object.hasOwn(input,key)) ||
    typeof input.expectedTag!=="string" || !TAG.test(input.expectedTag) ||
    input.expectedTag.includes("..") ||
    typeof input.expectedCommit!=="string" || !COMMIT.test(input.expectedCommit))
    throw new Error("WINDOWS_READER_IDENTITY_INVALID");
  if(input.mode==="Candidate" &&
    (typeof input.expectedRunId!=="string" || !UUID.test(input.expectedRunId) ||
     typeof input.expectedPrepareOperationId!=="string" ||
      !UUID.test(input.expectedPrepareOperationId)))
    throw new Error("WINDOWS_READER_OPERATION_INVALID");
}
async function noReparseAncestors(path:string):Promise<void>{
  const absolute=resolve(path),root=parse(absolute).root;
  let current=root;
  const relative=absolute.slice(root.length).split(sep).filter(Boolean);
  for(const item of relative){
    current=join(current,item);
    const stat=await lstat(current);
    if(stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("WINDOWS_READER_REDIRECTED");
  }
}
export function createWindowsFixedScriptInvoker(config:WindowsFixedScriptConfig,
  dependencies:WindowsFixedScriptDependencies={}):WindowsNativeReadInvoker{
  if((config.platform??process.platform)!=="win32" ||
    !isAbsolute(config.installationRoot) ||
    !isAbsolute(config.scriptsRoot) ||
    !SHA.test(config.expectedReaderSha256) ||
    !config.expectedHelperSha256 ||
    DEPENDENCIES.some(name=>!SHA.test(config.expectedHelperSha256[name])) ||
    config.installationRoot.includes("\0") ||
    config.scriptsRoot.includes("\0"))
    throw new Error("WINDOWS_READER_NOT_CONFIGURED");
  const root=resolve(config.scriptsRoot);
  const installation=resolve(config.installationRoot);
  const script=join(root,READER);
  const binary=join(process.env.SystemRoot??"C:\\Windows",
    "System32","WindowsPowerShell","v1.0","powershell.exe");
  const execute=dependencies.execute??(async(file,args)=>{
    const output=await execFile(file,[...args],{windowsHide:true,
      shell:false,timeout:20_000,maxBuffer:8192,encoding:"utf8"});
    if(output.stderr.trim())throw new Error("WINDOWS_READER_STDERR");
    return output.stdout;
  });
  return {async observe(input){
    allowed(input);
    await noReparseAncestors(root);
    await noReparseAncestors(installation);
    // Windows realpath() can change case without changing the target.
    // noReparseAncestors() has already checked every directory component.
    // The read-only script dot-sources these two helpers; pin all three files
    // to the trusted release inventory rather than only the primary script.
    const pinned:ReadonlyArray<readonly [string,string]>=[
      [READER,config.expectedReaderSha256],
      ...DEPENDENCIES.map(name=>[name,config.expectedHelperSha256[name]] as const),
    ];
    for(const [filename,digest] of pinned){
      const target=join(root,filename);
      const stat=await lstat(target);
      if(!stat.isFile() || stat.isSymbolicLink() ||
        stat.size<128 || stat.size>131072)
        throw new Error("WINDOWS_READER_SCRIPT_UNTRUSTED");
      const bytes=await readFile(target);
      const after=await lstat(target);
      if(bytes.length!==stat.size || after.ino!==stat.ino ||
        after.dev!==stat.dev || after.size!==stat.size ||
        after.mtimeMs!==stat.mtimeMs ||
        createHash("sha256").update(bytes).digest("hex")!==digest)
        throw new Error("WINDOWS_READER_HASH_MISMATCH");
    }
    const args=["-NoLogo","-NoProfile","-NonInteractive",
      "-File",script,"-InstallationRoot",installation,"-Mode",input.mode];
    if(input.mode!=="State"){
      args.push("-ExpectedTag",input.expectedTag!,
        "-ExpectedCommit",input.expectedCommit!);
      if(input.mode==="Candidate")
        args.push("-ExpectedRunId",input.expectedRunId!,
          "-ExpectedPrepareOperationId",input.expectedPrepareOperationId!);
    }
    if(!dependencies.execute){
      await noReparseAncestors(resolve(binary,".."));
      const runtime=await lstat(binary);
      if(!runtime.isFile() || runtime.isSymbolicLink())
        throw new Error("WINDOWS_POWERSHELL_UNTRUSTED");
    }
    const result=await execute(binary,args);
    if(Buffer.byteLength(result,"utf8")>2048)
      throw new Error("WINDOWS_READER_OUTPUT_OVERSIZE");
    return result;
  }};
}
