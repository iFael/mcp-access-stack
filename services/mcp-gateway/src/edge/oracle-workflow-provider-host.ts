import {resolve} from "node:path";
import {AppError} from "@vs-code-gpt/shared";
import {ORACLE_WORKFLOW_CONNECT_PATH} from "@mcp-access-stack/update-control-contract";
import type {OracleReleaseGitHubReadConfig,OracleReleaseGitHubWorkflowPolicy}
  from "@vs-code-gpt/local-agent";
import type {OracleWorkflowProviderOptions,OracleWorkflowProviderPort}
  from "./oracle-workflow-provider.js";
import {readProtectedOracleProviderToken} from "./oracle-provider-credential.js";

const PREFIX="MCP_V3_ORACLE_WORKFLOW_PROVIDER_";
/** Enrollment is opt-in. Dispatch needs its own explicit functional switch
 * plus the LocalAgent's standard per-repository write ACL and receipts.
 * Reconciliation/tag reads remain subject to the host ACL. */
export async function loadOracleWorkflowProviderFromEnvironment(
  env:Readonly<Record<string,string|undefined>>,
  makePort:(config:OracleReleaseGitHubReadConfig,
    policy:OracleReleaseGitHubWorkflowPolicy)=>OracleWorkflowProviderPort,
):Promise<OracleWorkflowProviderOptions|undefined>{
  const fields=["ENABLED","URL","TOKEN_FILE","OWNER","REPOSITORY","OWNER_SCOPE",
    "DISPATCH_ENABLED"] as const;
  if(!fields.some(field=>env[PREFIX+field]!==undefined))return undefined;
  if(process.platform!=="linux" || env[PREFIX+"ENABLED"]!=="1")
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle workflow provider is not enabled for Linux.");
  const urlRaw=env[PREFIX+"URL"]?.trim();
  const file=env[PREFIX+"TOKEN_FILE"]?.trim();
  const owner=env[PREFIX+"OWNER"]?.trim();
  const repository=env[PREFIX+"REPOSITORY"]?.trim();
  const ownerScope=env[PREFIX+"OWNER_SCOPE"];
  const mode=env[PREFIX+"DISPATCH_ENABLED"];
  if(!urlRaw || !file || !owner || !repository || !ownerScope ||
    !/^[A-Za-z0-9-]{1,100}$/u.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(repository) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(ownerScope) ||
    (mode!==undefined && mode!=="0" && mode!=="1"))
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle workflow host policy is incomplete.");
  let url:URL;
  try{url=new URL(urlRaw);}catch{
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle workflow provider URL invalid.");
  }
  if(url.protocol!=="wss:" || !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    (url.port!=="" && url.port!=="443") || url.pathname!==ORACLE_WORKFLOW_CONNECT_PATH ||
    url.username || url.password || url.search || url.hash)
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle workflow provider URL invalid.");

  for(const other of ["MCP_V3_ORACLE_SOURCE_PROVIDER_TOKEN_FILE","MCP_CONNECTOR_TOKEN_FILE"]){
    const path=env[other];
    if(path?.trim() && resolve(path)===resolve(file))
      throw new AppError("CAPABILITY_UNSUPPORTED","Oracle workflow provider credential reused.");
  }
  const token=await readProtectedOracleProviderToken(file,env);
  const config:OracleReleaseGitHubReadConfig={
    workspaceId:"mcp-access-stack",owner,repository,ownerScope,
  };
  const policy:OracleReleaseGitHubWorkflowPolicy={
    authorizeWorkflow:async input=>env[PREFIX+"ENABLED"]==="1" &&
      (input.mode==="reconcile" || env[PREFIX+"DISPATCH_ENABLED"]==="1"),
    authorizeTagRead:async()=>env[PREFIX+"ENABLED"]==="1",
    authorizeDistribution:async()=>env[PREFIX+"ENABLED"]==="1",
  };
  const port=makePort(config,policy);
  return {url,token,port};
}
