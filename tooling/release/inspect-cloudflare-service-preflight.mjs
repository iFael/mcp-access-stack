import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST="https://api.cloudflare.com/client/v4/accounts/";
const WORKER="mcp-access-stack";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ACCOUNT=/^[a-f0-9]{32}$/u;
const TAG=/^[a-zA-Z0-9._-]{1,64}$/u;
const MAX_BYTES=256*1024;
const SOURCES=new Set(["wrangler","api","dash","terraform","unknown",
  "cf_cli","dash_template","integration","quick_editor","playground","workersci"]);

export class ServiceInspectionError extends Error {
  constructor(code){super(code);this.name="ServiceInspectionError";this.code=code;}
}
function fail(code){throw new ServiceInspectionError(code);}
function obj(v){return v!==null&&typeof v==="object"&&!Array.isArray(v);}
function check(v,re,code){if(typeof v!=="string"||!re.test(v))fail(code);return v;}

async function readJson(response){
  if(response?.status!==200)fail("CLOUDFLARE_GET_FAILED");
  const reader=response.body?.getReader();
  if(!reader)fail("RESPONSE_STREAM_INVALID");
  let size=0;const chunks=[];
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>MAX_BYTES)fail("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  }finally{await reader.cancel().catch(()=>{});}
  const all=new Uint8Array(size);
  let i=0;
  for(const chunk of chunks){all.set(chunk,i);i+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(all));}
  catch{fail("RESPONSE_JSON_INVALID");}
}
function result(doc){
  if(!obj(doc)||doc.success!==true||!obj(doc.result))fail("RESPONSE_SHAPE_INVALID");
  return doc.result;
}
function activeDeployment(doc){
  const rows=result(doc).deployments;
  if(!Array.isArray(rows)||rows.length<1||rows.length>100)fail("DEPLOYMENT_LIST_INVALID");
  const active=rows[0];
  if(!obj(active)||!UUID.test(active.id)||!Array.isArray(active.versions)||
    active.versions.length!==1||!obj(active.versions[0])||
    !UUID.test(active.versions[0].version_id)||active.versions[0].percentage!==100){
    fail("DEPLOYMENT_TRAFFIC_INVALID");
  }
  return {deployment:active.id,version:active.versions[0].version_id};
}
function readTag(value){
  if(value===undefined||value===null)return null;
  return check(value,TAG,"MIGRATION_TAG_INVALID");
}
function serviceMetadata(doc){
  const service=result(doc);
  if(!obj(service.default_environment)||!obj(service.default_environment.script))
    fail("SERVICE_METADATA_INVALID");
  const script=service.default_environment.script;
  const migrationTag=readTag(script.migration_tag);
  if(script.last_deployed_from!==undefined&&script.last_deployed_from!==null&&
    typeof script.last_deployed_from!=="string")fail("SERVICE_METADATA_INVALID");
  const source=SOURCES.has(script.last_deployed_from) ? script.last_deployed_from : "unverified";
  return {migrationTag,source};
}
function activeVersionTag(doc,expectedId){
  const version=result(doc);
  if(version.id!==expectedId)fail("VERSION_CAS_MISMATCH");
  if(!obj(version.resources)||!obj(version.resources.script))fail("VERSION_METADATA_INVALID");
  const runtime=version.resources.script_runtime;
  if(runtime!==undefined&&runtime!==null&&!obj(runtime))fail("VERSION_METADATA_INVALID");
  return readTag(runtime?.migration_tag);
}
function parity(tag,expected){
  return tag===null?"unverified":tag===expected?"matching":"different";
}

export async function inspectServiceUploadPreconditions(input,fetchImpl=fetch){
  if(!obj(input))fail("INPUT_INVALID");
  const accountId=check(input.accountId,ACCOUNT,"ACCOUNT_ID_INVALID");
  const expectedDeploymentId=check(input.expectedDeploymentId,UUID,"DEPLOYMENT_ID_INVALID");
  const expectedVersionId=check(input.expectedVersionId,UUID,"VERSION_ID_INVALID");
  const expectedMigrationTag=check(input.expectedMigrationTag,TAG,"EXPECTED_TAG_INVALID");
  if(typeof input.token!=="string"||input.token.length<12)fail("READ_TOKEN_INVALID");

  const read=async url=>{
    let response;
    try{response=await fetchImpl(url,{
      method:"GET",redirect:"error",
      headers:{authorization:"Bearer "+input.token,accept:"application/json",
        "user-agent":"mcp-edge-beta84-service-preflight"},
      signal:AbortSignal.timeout(10000),
    });}catch{fail("CLOUDFLARE_NETWORK_FAILED");}
    return readJson(response);
  };
  const url=HOST+accountId+"/workers/";
  const deployments=url+"scripts/"+WORKER+"/deployments";
  const service=url+"services/"+WORKER;
  const version=url+"scripts/"+WORKER+"/versions/"+expectedVersionId;
  const first=activeDeployment(await read(deployments));
  if(first.deployment!==expectedDeploymentId||first.version!==expectedVersionId)
    fail("ACTIVE_CAS_MISMATCH");
  const before=serviceMetadata(await read(service));
  const versionTag=activeVersionTag(await read(version),expectedVersionId);
  const after=serviceMetadata(await read(service));
  if(before.migrationTag!==after.migrationTag||before.source!==after.source)
    fail("SERVICE_CHANGED_DURING_READ");
  const final=activeDeployment(await read(deployments));
  if(final.deployment!==first.deployment||final.version!==first.version)
    fail("DEPLOYMENT_CHANGED_DURING_READ");

  const serviceParity=parity(before.migrationTag,expectedMigrationTag);
  const versionParity=parity(versionTag,expectedMigrationTag);
  const consistency=before.migrationTag===null||versionTag===null ? "unverified" :
    before.migrationTag===versionTag?"matching":"different";
  // Read-only token proves that GET works, never publisher authorization.
  // Do NOT infer Editor/WRITE from GET success or /tokens/verify status.
  return {
    worker:WORKER,activeDeploymentId:first.deployment,activeVersionId:first.version,
    serviceMigrationTagParity:serviceParity,
    activeVersionMigrationTagParity:versionParity,
    serviceVersionTagConsistency:consistency,
    lastDeployedFrom:before.source,
    publisherWriteScope:"unverified",
    inspection:"read_only",
  };
}

async function main(){
  const root=path.resolve(fileURLToPath(new URL("../../",import.meta.url)));
  const canonical=JSON.parse(await readFile(path.join(root,
    "services/mcp-edge-gateway/wrangler.jsonc"),"utf8"));
  if(canonical.name!==WORKER||!Array.isArray(canonical.migrations)||
    canonical.migrations.length!==1||canonical.migrations[0]?.tag!=="v1"||
    JSON.stringify(canonical.migrations[0]?.new_sqlite_classes)!=='["McpSession"]'||
    canonical.durable_objects?.bindings?.length!==1||
    canonical.durable_objects.bindings[0]?.class_name!=="McpSession")
    fail("CANONICAL_CONFIG_DRIFT");
  const inspection=await inspectServiceUploadPreconditions({
    accountId:process.env.CF_ACCOUNT_ID,
    token:process.env.CF_PROVENANCE_READ_TOKEN,
    expectedDeploymentId:process.env.EXPECTED_ACTIVE_DEPLOYMENT_ID,
    expectedVersionId:process.env.EXPECTED_ACTIVE_VERSION_ID,
    expectedMigrationTag:"v1",
  });
  console.log(JSON.stringify(inspection));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(e=>{
    console.error("service_preflight: "+
      (e instanceof ServiceInspectionError?e.code:"INSPECTION_UNAVAILABLE"));
    process.exitCode=1;
  });
}
