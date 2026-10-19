import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";
import { inspectServiceUploadPreconditions, ServiceInspectionError } from "./inspect-cloudflare-service-preflight.mjs";

const ACCOUNT="a".repeat(32), TOKEN="synthetic-read-only-token";
const VERSION="7b536d5f-8afb-4da0-927e-44cf6e23b6d6";
const DEPLOY="10535ed8-c51b-418e-a387-3cf9ba8fde82";
const OTHER="21535ed8-c51b-418e-a387-3cf9ba8fde82";
const input={accountId:ACCOUNT, token:TOKEN, expectedDeploymentId:DEPLOY,
  expectedVersionId:VERSION, expectedMigrationTag:"v1"};

function mock(o={}) {
  const calls=[];
  let deploymentReads=0, serviceReads=0;
  const fetchImpl=async(url,options)=>{
    assert.equal(options.method,"GET");
    assert.equal(options.redirect,"error");
    assert.equal(options.body,undefined);
    assert.equal(options.headers.authorization,"Bearer "+TOKEN);
    const p=new URL(url);
    assert.equal(p.origin,"https://api.cloudflare.com");
    assert.ok(p.pathname.startsWith("/client/v4/accounts/"+ACCOUNT+"/workers/"));
    calls.push(p.pathname);
    const isDeploy=p.pathname.endsWith("/scripts/mcp-access-stack/deployments");
    const isService=p.pathname.endsWith("/services/mcp-access-stack");
    if(isDeploy)deploymentReads++;
    if(isService)serviceReads++;
    const result=isDeploy ? {deployments:[{
      id:o.driftDeployment&&deploymentReads===2?OTHER:DEPLOY,
      versions:o.splitTraffic?[{version_id:VERSION,percentage:50},{version_id:OTHER,percentage:50}]
        :[{version_id:o.wrongActiveVersion?OTHER:VERSION,percentage:100}]
    }]}:isService ? {default_environment:{script:
      o.badServiceShape?[]:{
        ...(!o.omitServiceTag?{migration_tag:o.serviceTag??"v1"}:{}),
        ...(!o.omitOrigin?{last_deployed_from:o.origin??"wrangler"}:{}),
        ...(o.driftService&&serviceReads===2?{migration_tag:"v9"}:{})
      }}} :{id:VERSION,resources:{script:{etag:"0123456789abcdef"},
        script_runtime:o.omitVersionRuntime?{}:{migration_tag:o.versionTag??"v1"}}};
    const response={success:true,result};
    if(o.oversized)response.extra="synthetic-secret".repeat(20000);
    return new Response(JSON.stringify(response),{status:o.http??200});
  };
  return {calls,fetchImpl};
}
async function errorCase(o,code) {
 const f=mock(o);
 await assert.rejects(()=>inspectServiceUploadPreconditions(input,f.fetchImpl),
   e=>e instanceof ServiceInspectionError&&e.code===code&&
      !String(e.message).includes(TOKEN));
}
test("reads only service, active version, and deployments with two-sided CAS; sanitizes response",async()=>{
  const f=mock();
  const result=await inspectServiceUploadPreconditions(input,f.fetchImpl);
  assert.deepEqual(f.calls.map(p=>p.split("/").slice(-2).join("/")),
    ["mcp-access-stack/deployments","services/mcp-access-stack",
     "versions/"+VERSION,"services/mcp-access-stack","mcp-access-stack/deployments"]);
  assert.equal(result.serviceMigrationTagParity,"matching");
  assert.equal(result.activeVersionMigrationTagParity,"matching");
  assert.equal(result.serviceVersionTagConsistency,"matching");
  assert.equal(result.lastDeployedFrom,"wrangler");
  assert.equal(result.publisherWriteScope,"unverified");
  assert.equal(result.activeDeploymentId,DEPLOY);
  const serialized=JSON.stringify(result);
  for(const secret of [ACCOUNT,TOKEN,"synthetic-secret","permission_groups","policies"])
    assert.ok(!serialized.includes(secret));
});
test("detects service tag different even if active immutable version is matching",async()=>{
 const result=await inspectServiceUploadPreconditions(input,mock({serviceTag:"v2",origin:"dash"}).fetchImpl);
 assert.equal(result.serviceMigrationTagParity,"different");
 assert.equal(result.activeVersionMigrationTagParity,"matching");
 assert.equal(result.serviceVersionTagConsistency,"different");
 assert.equal(result.lastDeployedFrom,"dash");
 assert.ok(!JSON.stringify(result).includes('"v2"'));
});
test("missing migration metadata is unverified, never deemed pending",async()=>{
 for(const o of [{omitServiceTag:true},{omitVersionRuntime:true},{omitServiceTag:true,omitVersionRuntime:true}]){
   const r=await inspectServiceUploadPreconditions(input,mock(o).fetchImpl);
   assert.equal(r.serviceVersionTagConsistency,"unverified");
 }
});
test("known deployment source is allowlisted, unexpected source not leaked",async()=>{
 for(const [origin,expected] of [["api","api"],["terraform","terraform"],
   ["unknown","unknown"],["not-a-real-source","unverified"]]){
   const r=await inspectServiceUploadPreconditions(input,mock({origin}).fetchImpl);
   assert.equal(r.lastDeployedFrom,expected);
   assert.equal(r.publisherWriteScope,"unverified");
 }
});
test("rejects invalid/mismatched service, split traffic, CAS drift, HTTP errors",async()=>{
 await errorCase({badServiceShape:true},"SERVICE_METADATA_INVALID");
 await errorCase({splitTraffic:true},"DEPLOYMENT_TRAFFIC_INVALID");
 await errorCase({driftDeployment:true},"DEPLOYMENT_CHANGED_DURING_READ");
 await errorCase({driftService:true},"SERVICE_CHANGED_DURING_READ");
 await errorCase({wrongActiveVersion:true},"ACTIVE_CAS_MISMATCH");
 await errorCase({http:403},"CLOUDFLARE_GET_FAILED");
 await errorCase({oversized:true},"RESPONSE_TOO_LARGE");
});
test("invalid inputs fail before GET and never expose credentials",async()=>{
 const f=mock();
 for(const bad of [{expectedDeploymentId:"wrong"},{expectedVersionId:"wrong"},
  {accountId:"wrong"},{token:"short"},{expectedMigrationTag:"v1/escape"}]){
  await assert.rejects(()=>inspectServiceUploadPreconditions({...input,...bad},f.fetchImpl),
    e=>e instanceof ServiceInspectionError);
 }
 assert.equal(f.calls.length,0);
});
test("manual workflow has GET-only read token; CI validates suite",async()=>{
 const root=path.resolve(fileURLToPath(new URL("../../",import.meta.url)));
 const workflow=await readFile(path.join(root,".github/workflows/cloudflare-service-preflight.yml"),"utf8");
 const doc=YAML.parseDocument(workflow,{uniqueKeys:true});
 assert.equal(doc.errors.length,0);
 const w=doc.toJS();
 assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs),
   ["expected_main_sha","expected_active_deployment_id","expected_active_version_id"]);
 assert.equal(w.permissions.contents,"read");
 assert.equal(w.jobs.inspect.environment,"cloudflare-observability");
 assert.equal(w.concurrency["cancel-in-progress"],false);
 assert.match(workflow,/CF_PROVENANCE_READ_TOKEN/);
 assert.match(workflow,/GITHUB_RUN_ATTEMPT/);
 assert.match(workflow,/inspect-cloudflare-service-preflight\.mjs/);
 assert.doesNotMatch(workflow,/CLOUDFLARE_API_TOKEN|public-release|wrangler\s+versions|upload-artifact|curl\s+-X\s+POST/);
 const ci=await readFile(path.join(root,".github/workflows/ci.yml"),"utf8");
 assert.match(ci,/node --test[^\n]*inspect-cloudflare-service-preflight\.test\.mjs/);
});
