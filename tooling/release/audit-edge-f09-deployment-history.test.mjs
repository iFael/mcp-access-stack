import {test} from "node:test";
import assert from "node:assert/strict";
import {BASELINE,analyzeHistory,auditOnce,auditTwice} from "./audit-edge-f09-deployment-history.mjs";

const record=(id,version,created_on="2026-10-08T03:27:40Z")=>({
 id,created_on,versions:[{version_id:version,percentage:100}],
});
const history=(rows)=>({success:true,result:{deployments:rows}});
const historical=()=>history([record(BASELINE.deploymentId,BASELINE.versionId)]);

test("old deployment remains active, no new version or post-window deployment",()=>{
 const v=analyzeHistory(historical());
 assert.equal(v.status,"no_deployment_recorded");
 assert.equal(v.recordedDeployments,1);
 assert.equal(v.targetVersionDeploymentCount,0);
 assert.equal(v.deploymentsSinceFailedRunWindow,0);
});

test("new target deployed in history is not marked absent",()=>{
 const v=analyzeHistory(history([
  record("fb3bb4b4-7844-4cf8-999d-ec4feae04a95",BASELINE.candidateVersionId,"2026-10-12T08:00:38Z"),
  record(BASELINE.deploymentId,BASELINE.versionId),
 ]));
 assert.equal(v.status,"reconciliation_required");
 assert.equal(v.targetVersionDeploymentCount,1);
});

test("third party deployment after failed request fails closed",()=>{
 const v=analyzeHistory(history([
  record("a1a3e332-ad27-46c8-8c3a-4411c3d7812d",BASELINE.versionId,"2026-10-12T08:01:15Z"),
  record(BASELINE.deploymentId,BASELINE.versionId),
 ]));
 assert.equal(v.status,"reconciliation_required");
 assert.equal(v.deploymentsSinceFailedRunWindow,1);
});

test("malformed response, missing version, or traffic split are rejected",()=>{
 assert.throws(()=>analyzeHistory({success:true,result:{deployments:[]}}),/HISTORY_SHAPE/);
 assert.throws(()=>analyzeHistory(history([record("bad",BASELINE.versionId)])),/DEPLOYMENT_INVALID/);
 assert.throws(()=>analyzeHistory(history([{
   ...record(BASELINE.deploymentId,BASELINE.versionId),
   versions:[{version_id:BASELINE.versionId,percentage:50}],
 }])),/SPLIT_INVALID/);
});

test("network requests are GET only and do not output secrets",async()=>{
 let calls=0;
 const f=async(url,opts)=>{
  calls++;
  assert.equal(opts.method,"GET");
  assert.match(url,/\/deployments$/);
  assert.equal(opts.headers.authorization,"Bearer "+ "x".repeat(20));
  return {status:200,text:async()=>JSON.stringify(historical())};
 };
 const r=await auditOnce({account:"a".repeat(32),token:"x".repeat(20)},f);
 assert.equal(r.status,"no_deployment_recorded");
 assert.equal(calls,1);
});

test("dual snapshots must be identical and consistent",async()=>{
 const good=async()=>analyzeHistory(historical());
 assert.equal((await auditTwice({},good)).status,"no_deployment_recorded");
 let reads=0;
 const drift=async()=>++reads===1?analyzeHistory(historical()):analyzeHistory(history([
   record(BASELINE.deploymentId,BASELINE.versionId),
   record("ea6e5b40-f2a8-475e-9c89-a0560b389212",BASELINE.versionId),
 ]));
 await assert.rejects(auditTwice({},drift),/HISTORY_CHANGED/);
});

test("HTTP/JSON malformed observations fail closed",async()=>{
 await assert.rejects(auditOnce({account:"a".repeat(32),token:"x".repeat(20)},
  async()=>({status:403,text:async()=>JSON.stringify(historical())})),/GET_HTTP_FAILURE/);
 await assert.rejects(auditOnce({account:"a".repeat(32),token:"x".repeat(20)},
  async()=>({status:200,text:async()=>"{not-json"})),/BODY_INVALID/);
});
