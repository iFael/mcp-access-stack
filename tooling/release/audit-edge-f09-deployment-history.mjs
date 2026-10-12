import {pathToFileURL} from "node:url";
import path from "node:path";

export const BASELINE = Object.freeze({
  deploymentId: "10535ed8-c51b-418e-a387-3cf9ba8fde82",
  versionId: "7b536d5f-8afb-4da0-927e-44cf6e23b6d6",
  candidateVersionId: "562c6fc3-78c7-4365-9c47-cc307f8c755e",
  rolloutRunId: "38220917035",
  cutoff: "2026-10-12T07:59:00Z",
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
function refuse(reason) {throw new Error("F09_DEPLOYMENT_AUDIT_" + reason);}
function record(x) {return x && typeof x === "object" && !Array.isArray(x);}

export function analyzeHistory(payload) {
  if (!record(payload) || payload.success !== true || !record(payload.result) ||
      !Array.isArray(payload.result.deployments) ||
      payload.result.deployments.length === 0 || payload.result.deployments.length > 100) {
    refuse("HISTORY_SHAPE_INVALID");
  }
  const deployments = payload.result.deployments;
  const validated = deployments.map(v => {
    if (!record(v) || !UUID.test(v.id ?? "") ||
        typeof v.created_on !== "string" || !Number.isFinite(Date.parse(v.created_on)) ||
        !Array.isArray(v.versions) || v.versions.length < 1 || v.versions.length > 20) {
      refuse("DEPLOYMENT_INVALID");
    }
    const versions = v.versions.map(x => {
      if (!record(x) || !UUID.test(x.version_id ?? "") ||
          typeof x.percentage !== "number" || !Number.isFinite(x.percentage) ||
          x.percentage <= 0 || x.percentage > 100) refuse("VERSION_INVALID");
      return {id:x.version_id,percentage:x.percentage};
    });
    if (Math.abs(versions.reduce((sum,x)=>sum+x.percentage,0)-100)>0.001) {
      refuse("SPLIT_INVALID");
    }
    return {id:v.id,createdAt:new Date(v.created_on).toISOString(),versions};
  });
  const first=validated[0];
  const targetAppearances=validated.filter(d =>
    d.versions.some(x=>x.id===BASELINE.candidateVersionId)).length;
  const later=validated.filter(d=>Date.parse(d.createdAt)>=Date.parse(BASELINE.cutoff)).length;
  const unchanged=first.id===BASELINE.deploymentId &&
    first.versions.length===1 && first.versions[0].id===BASELINE.versionId &&
    first.versions[0].percentage===100 && targetAppearances===0 && later===0;
  return {
    status:unchanged?"no_deployment_recorded":"reconciliation_required",
    activeDeploymentId:first.id,
    activeVersionId:first.versions.length===1?first.versions[0].id:"multiple",
    recordedDeployments:validated.length,
    targetVersionDeploymentCount:targetAppearances,
    deploymentsSinceFailedRunWindow:later,
  };
}

export async function auditOnce({account,token},fetchImpl=fetch) {
  if (!ACCOUNT.test(account ?? "") || typeof token!=="string" || token.length<12) {
    refuse("INPUT_INVALID");
  }
  let response;
  try {
    response=await fetchImpl(
      "https://api.cloudflare.com/client/v4/accounts/"+account+
        "/workers/scripts/mcp-access-stack/deployments",
      {method:"GET",headers:{authorization:"Bearer "+token,accept:"application/json"},
       redirect:"error",signal:AbortSignal.timeout(12000)},
    );
  } catch {refuse("NETWORK_UNAVAILABLE");}
  if(response.status!==200) refuse("GET_HTTP_FAILURE");
  let raw;
  try {raw=await response.text();} catch {refuse("BODY_READ_FAILED");}
  if(raw.length>256*1024) refuse("BODY_TOO_LARGE");
  let payload;
  try{payload=JSON.parse(raw);}catch{refuse("BODY_INVALID");}
  return analyzeHistory(payload);
}

export async function auditTwice(input,fn=auditOnce) {
  const a=await fn(input);
  const b=await fn(input);
  if(JSON.stringify(a)!==JSON.stringify(b)) refuse("HISTORY_CHANGED_BETWEEN_GETS");
  if(a.status!=="no_deployment_recorded") refuse("OUTCOME_NOT_RECONCILED");
  return a;
}

if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try {
    if(process.argv.length!==2) refuse("MODE_INVALID");
    const result=await auditTwice({
      account:process.env.CF_ACCOUNT_ID,token:process.env.CF_PROVENANCE_READ_TOKEN,
    });
    console.log(JSON.stringify({audit:"f09_failed_deployment",failedRunId:BASELINE.rolloutRunId,...result}));
  } catch(e){
    console.error(e.message?.startsWith("F09_DEPLOYMENT_AUDIT_")?e.message:
      "F09_DEPLOYMENT_AUDIT_UNEXPECTED");
    process.exitCode=1;
  }
}
