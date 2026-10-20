import {resolve} from "node:path";
import {AppError} from "@vs-code-gpt/shared";
import {ORACLE_CANDIDATE_CONNECT_PATH}
  from "@mcp-access-stack/update-control-contract";
import type {OracleCandidateHostConfig} from "@vs-code-gpt/local-agent";
import type {OracleCandidateProviderOptions,OracleCandidateProviderPort}
  from "./oracle-candidate-provider.js";
import {readProtectedOracleProviderToken} from "./oracle-provider-credential.js";

const PREFIX="MCP_V3_ORACLE_CANDIDATE_PROVIDER_";
export async function loadOracleCandidateProviderFromEnvironment(
  env:Readonly<Record<string,string|undefined>>,
  makePort:(config:OracleCandidateHostConfig)=>OracleCandidateProviderPort,
):Promise<OracleCandidateProviderOptions|undefined>{
  const fields=["ENABLED","URL","TOKEN_FILE","OWNER_SCOPE"] as const;
  if(!fields.some(field=>env[PREFIX+field]!==undefined))return undefined;
  const file=env[PREFIX+"TOKEN_FILE"]?.trim();
  const raw=env[PREFIX+"URL"]?.trim();
  const ownerScope=env[PREFIX+"OWNER_SCOPE"];
  if(process.platform!=="linux" || env[PREFIX+"ENABLED"]!=="1" ||
    env.MCP_V3_ORACLE_CANDIDATE_READ_ENABLED!=="1" ||
    !raw || !file || !ownerScope ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(ownerScope) ||
    ownerScope!==env.MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE)
    throw new AppError("CAPABILITY_UNSUPPORTED",
      "Oracle candidate provider is not enrolled.");
  let url:URL;
  try{url=new URL(raw);}catch{
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle candidate URL invalid.");
  }
  if(url.protocol!=="wss:" || !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    (url.port!=="" && url.port!=="443") ||
    url.pathname!==ORACLE_CANDIDATE_CONNECT_PATH ||
    url.username || url.password || url.search || url.hash)
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle candidate URL invalid.");
  for(const other of ["MCP_V3_ORACLE_SOURCE_PROVIDER_TOKEN_FILE",
    "MCP_V3_ORACLE_WORKFLOW_PROVIDER_TOKEN_FILE",
    "MCP_CONNECTOR_TOKEN_FILE"]){
    if(env[other]?.trim() && resolve(file)===resolve(env[other]!))
      throw new AppError("CAPABILITY_UNSUPPORTED",
        "Oracle candidate credential reused.");
  }
  const token=await readProtectedOracleProviderToken(file,env);
  const port=makePort({workspaceId:"mcp-access-stack",ownerScope});
  return {url,token,port};
}
