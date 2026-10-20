import {constants} from "node:fs";
import {lstat,open} from "node:fs/promises";
import {dirname,isAbsolute,join,parse,resolve,sep,win32} from "node:path";
import {AppError} from "@vs-code-gpt/shared";
import {WINDOWS_READ_CONNECT_PATH} from "@mcp-access-stack/update-control-contract";
import {createWindowsFixedScriptInvoker}
  from "./windows-fixed-script-observer.js";
import {WindowsNativeReadPort,type WindowsNativeReadPolicy}
  from "./windows-read-native-port.js";
import {
  validateWindowsReadProviderOptions,
  type WindowsReadProviderOptions,
} from "./windows-read-provider.js";

const PREFIX="MCP_V3_WINDOWS_READ_PROVIDER_";
const FIELDS=["ENABLED","URL","TOKEN_FILE","OWNER_SCOPE",
  "INSTALLATION_ROOT","SCRIPTS_ROOT","READER_SHA256",
  "PUBLIC_HELPER_SHA256","NODE_HELPER_SHA256"] as const;
const HEX=/^[a-f0-9]{64}$/u;
const TOKEN=/^[A-Za-z0-9_.-]{32,256}$/u;
const SCOPE=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
async function assertNoRedirectedCredentialAncestors(file:string):Promise<void>{
  const dir=dirname(file),root=parse(dir).root;
  let current=root;
  for(const item of dir.slice(root.length).split(sep).filter(Boolean)){
    current=join(current,item);
    const entry=await lstat(current);
    if(!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("credential parent redirected");
  }
}
const OTHER_TOKEN_FILES=[
  "MCP_CONNECTOR_TOKEN_FILE",
  "MCP_V3_ORACLE_SOURCE_PROVIDER_TOKEN_FILE",
  "MCP_V3_ORACLE_WORKFLOW_PROVIDER_TOKEN_FILE",
  "MCP_V3_ORACLE_CANDIDATE_PROVIDER_TOKEN_FILE",
  "MCP_V3_ORACLE_ACTIVE_PROVIDER_TOKEN_FILE",
  "MCP_V3_WINDOWS_PREPARE_PROVIDER_TOKEN_FILE",
] as const;

export interface WindowsHostCredentialAuthority {
  /** Must verify the Windows file owner and full DACL, not POSIX mode bits.
   * Authorizations for Users/Everyone/Authenticated Users or inherited write
   * grants must fail. A fake authority must never be installed in production. */
  verifyWindowsTokenAcl(file:string,ownerScope:string):Promise<boolean>;
}
export interface WindowsReadHostEnrollment {
  readonly platform?:NodeJS.Platform;
  readonly credentialAuthority:WindowsHostCredentialAuthority;
  readonly policy:WindowsNativeReadPolicy;
}
/** No startup registration. This only returns options for an explicitly
 * provisioned Windows-only process with an independent ACL authority. */
export async function loadWindowsReadProviderFromEnvironment(
  env:Readonly<Record<string,string|undefined>>,
  trust:WindowsReadHostEnrollment,
):Promise<WindowsReadProviderOptions|undefined>{
  if(!FIELDS.some(field=>env[PREFIX+field]!==undefined))return undefined;
  const fail=():never=>{throw new AppError("CAPABILITY_UNSUPPORTED",
    "Windows native read provider is not enrolled.");};
  if((trust.platform??process.platform)!=="win32" ||
    env[PREFIX+"ENABLED"]!=="1" ||
    env.MCP_V3_WINDOWS_READ_ENABLED!=="1" ||
    !trust.credentialAuthority ||
    typeof trust.credentialAuthority.verifyWindowsTokenAcl!=="function" ||
    !trust.policy || typeof trust.policy.authorize!=="function")
    return fail();
  const owner=env[PREFIX+"OWNER_SCOPE"];
  if(!owner || !SCOPE.test(owner) ||
    owner!==env.MCP_V3_WINDOWS_READ_OWNER_SCOPE ||
    trust.policy.ownerScope!==owner)return fail();
  const raw=env[PREFIX+"URL"],tokenFile=env[PREFIX+"TOKEN_FILE"];
  const installationRoot=env[PREFIX+"INSTALLATION_ROOT"];
  const scriptsRoot=env[PREFIX+"SCRIPTS_ROOT"];
  const hashes=[
    env[PREFIX+"READER_SHA256"],env[PREFIX+"PUBLIC_HELPER_SHA256"],
    env[PREFIX+"NODE_HELPER_SHA256"],
  ];
  if(!raw || !tokenFile || !installationRoot || !scriptsRoot ||
    !isAbsolute(tokenFile) || !isAbsolute(installationRoot) ||
    !isAbsolute(scriptsRoot) || hashes.some(hash=>!HEX.test(hash??"")))
    return fail();
  let url:URL;
  try{url=new URL(raw);}catch{return fail();}
  if(url.protocol!=="wss:" ||
    !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    url.pathname!==WINDOWS_READ_CONNECT_PATH || url.username || url.password ||
    url.search || url.hash || (url.port!=="" && url.port!=="443"))
    return fail();
  const installation=resolve(installationRoot);
  const scripts=resolve(scriptsRoot);
  const file=resolve(tokenFile);
  const winPath=(value:string)=>win32.normalize(value).toLowerCase();
  const within=(parent:string,child:string)=>{
    const delta=win32.relative(parent,child);
    return delta==="" || (delta!==".." &&
      !delta.startsWith(".."+win32.sep) && !win32.isAbsolute(delta));
  };
  if(within(winPath(installation),winPath(scripts)) ||
    within(winPath(scripts),winPath(installation)) ||
    within(winPath(installation),winPath(file)) ||
    within(winPath(scripts),winPath(file)) ||
    OTHER_TOKEN_FILES.some(other=>env[other] &&
      winPath(env[other]!)===winPath(file)))
    return fail();
  // Deployment must supply an independent Windows ACL authority; stat.mode
  // is not evidence of Windows NTFS file permissions.
  let authorized=false;
  try{
    await assertNoRedirectedCredentialAncestors(file);
    authorized=await trust.credentialAuthority.verifyWindowsTokenAcl(file,owner);
  }catch{return fail();}
  if(!authorized)return fail();
  let token:string;
  try{
    await assertNoRedirectedCredentialAncestors(file);
    const before=await lstat(file);
    if(!before.isFile() || before.isSymbolicLink() ||
      before.size<32 || before.size>258)throw new Error("unsafe token");
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const opened=await handle.stat();
      if(!opened.isFile() || opened.dev!==before.dev ||
        opened.ino!==before.ino || opened.size!==before.size)
        throw new Error("token changed");
      const rawToken=await handle.readFile("utf8");
      const after=await lstat(file);
      if(after.dev!==before.dev || after.ino!==before.ino ||
        after.size!==before.size || after.mtimeMs!==before.mtimeMs)
        throw new Error("token changed");
      token=rawToken.endsWith("\r\n")?rawToken.slice(0,-2):
        rawToken.endsWith("\n")?rawToken.slice(0,-1):rawToken;
      if(!TOKEN.test(token))throw new Error("token format");
    }finally{await handle.close();}
  }catch{return fail();}
  // Revalidate the credential ACL after the read to reject an enrollment
  // whose permissions changed while the token was being accessed.
  try{
    await assertNoRedirectedCredentialAncestors(file);
    if(!await trust.credentialAuthority.verifyWindowsTokenAcl(file,owner))
      return fail();
  }catch{return fail();}
  const invoker=createWindowsFixedScriptInvoker({
    installationRoot:installation,scriptsRoot:scripts,
    expectedReaderSha256:hashes[0]!,
    expectedHelperSha256:{
      "PublicDistribution.Common.ps1":hashes[1]!,
      "WindowsExecutionNode.Common.ps1":hashes[2]!,
    },
    platform:"win32",
  });
  const port=new WindowsNativeReadPort({platform:"win32",
    invoker,policy:trust.policy});
  const options={url,token,port};
  validateWindowsReadProviderOptions(options);
  return options;
}
