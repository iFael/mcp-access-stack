/** Locally measured Windows evidence is never remote authorization.
 * This parser intentionally cannot issue a WindowsCandidateReceipt. */
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
type Slot={readonly releaseId:string;readonly manifestSha256:string}|null;
type State={readonly active:Slot;readonly previous:Slot;readonly candidate:Slot};
export type WindowsLocalEvidence={
  readonly platform:"windows";
  readonly scope:"local_hash_integrity_only";
  readonly kind:"candidate"|"active"|"state";
  readonly state:State;
  readonly releaseTag?:string;
  readonly sourceCommitSha?:string;
  readonly manifestSha256?:string;
  readonly verifiedArtifactCount?:number;
  readonly localPrepareWitness?:{
    readonly kind:"local_candidate_prepare";
    readonly runId:string;
    readonly prepareOperationId:string;
    readonly releaseId:string;
    readonly manifestSha256:string;
  };
};
const obj=(value:unknown):value is Record<string,unknown>=>
  value!==null && typeof value==="object" && !Array.isArray(value);
const fields=(value:Record<string,unknown>,names:readonly string[])=>
  Object.keys(value).length===names.length && names.every(k=>Object.hasOwn(value,k));
function parseSlot(value:unknown):Slot{
  if(value===null)return null;
  if(!obj(value) || !fields(value,["releaseId","manifestSha256"]) ||
    typeof value.releaseId!=="string" || !ID.test(value.releaseId) ||
    value.releaseId.includes("..") ||
    typeof value.manifestSha256!=="string" || !DIGEST.test(value.manifestSha256))
    throw new Error("WINDOWS_LOCAL_POINTER_INVALID");
  return {releaseId:value.releaseId,manifestSha256:value.manifestSha256};
}
export type WindowsExpectedRead={
  readonly mode:"candidate"|"active"|"state";
  readonly tag?:string;
  readonly commit?:string;
  readonly runId?:string;
  readonly prepareOperationId?:string;
};
export function parseWindowsLocalEvidence(
  input:unknown,expectation:WindowsExpectedRead,
):WindowsLocalEvidence{
  if(!obj(input) || input.platform!=="windows" ||
    input.scope!=="local_hash_integrity_only" ||
    input.kind!==expectation.mode || !obj(input.state) ||
    !fields(input.state,["active","previous","candidate"]))
    throw new Error("WINDOWS_LOCAL_SCOPE_INVALID");
  const state={active:parseSlot(input.state.active),
    previous:parseSlot(input.state.previous),
    candidate:parseSlot(input.state.candidate)};
  if(state.active && (state.active.releaseId===state.previous?.releaseId ||
    state.active.releaseId===state.candidate?.releaseId))
    throw new Error("WINDOWS_LOCAL_POINTER_CONFLICT");
  const base=["platform","kind","scope","state"];
  if(expectation.mode==="state"){
    if(!fields(input,base) || Object.keys(expectation).length!==1)
      throw new Error("WINDOWS_LOCAL_STATE_INVALID");
    return {platform:"windows",kind:"state",scope:"local_hash_integrity_only",state};
  }
  const {tag,commit,runId,prepareOperationId}=expectation;
  if(!tag || !TAG.test(tag) || tag.includes("..") ||
    !commit || !SHA.test(commit) ||
    (!!runId !== !!prepareOperationId) ||
    (runId!==undefined && (!UUID.test(runId) || !UUID.test(prepareOperationId!))))
    throw new Error("WINDOWS_LOCAL_ARGUMENTS_INVALID");
  const witnessRequested=runId!==undefined;
  if(expectation.mode!=="candidate" && witnessRequested)
    throw new Error("WINDOWS_LOCAL_ACTIVE_WITNESS_FORBIDDEN");
  if(!fields(input,[...base,"releaseTag","sourceCommitSha",
    "manifestSha256","verifiedArtifactCount",
    ...(witnessRequested?["localPrepareWitness"]:[])]))
    throw new Error("WINDOWS_LOCAL_FIELDS_INVALID");
  const pointer=expectation.mode==="candidate"?state.candidate:state.active;
  if(input.releaseTag!==tag || input.sourceCommitSha!==commit ||
    pointer?.releaseId!==tag.slice(1) ||
    pointer.manifestSha256!==input.manifestSha256 ||
    !Number.isSafeInteger(input.verifiedArtifactCount) ||
    (input.verifiedArtifactCount as number)<1 ||
    (input.verifiedArtifactCount as number)>64 ||
    (expectation.mode==="active" && (state.candidate!==null || !state.previous)))
    throw new Error("WINDOWS_LOCAL_EVIDENCE_MISMATCH");
  const witness=input.localPrepareWitness;
  if(witnessRequested && (!obj(witness) ||
    !fields(witness,["kind","runId","prepareOperationId","releaseId","manifestSha256"]) ||
    witness.kind!=="local_candidate_prepare" ||
    witness.runId!==runId || witness.prepareOperationId!==prepareOperationId ||
    witness.releaseId!==pointer.releaseId ||
    witness.manifestSha256!==pointer.manifestSha256))
    throw new Error("WINDOWS_LOCAL_WITNESS_MISMATCH");
  return {platform:"windows",scope:"local_hash_integrity_only",
    kind:expectation.mode,state,
    releaseTag:tag,sourceCommitSha:commit,
    manifestSha256:pointer.manifestSha256,
    verifiedArtifactCount:input.verifiedArtifactCount as number,
    ...(witnessRequested?{localPrepareWitness:{
      kind:"local_candidate_prepare" as const,runId:runId!,
      prepareOperationId:prepareOperationId!,
      releaseId:pointer.releaseId,manifestSha256:pointer.manifestSha256}}:{})};
}
