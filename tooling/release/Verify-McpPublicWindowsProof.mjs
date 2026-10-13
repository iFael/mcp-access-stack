import {createHash,verify,constants,X509Certificate} from "node:crypto";

/** Trusted source-control pin: SHA-256 of the shipped public DER signer cert.
 * A caller may NOT substitute a certificate or change the trust anchor. */
export const MCP_WINDOWS_SIGNER_CERT_SHA256 =
  "a9177136662887555dfe0e59d11b48e670d0f63cf4b340bf3b20e1d8a1541408";

const HEX64=/^[a-f0-9]{64}$/u;
const HEX40=/^[a-f0-9]{40}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;
const EXPECTED_KEYS=[
  "product","purpose","releaseTag","schemaVersion","signerCertificateSha256",
  "sourceCommitSha","windowsAssetName","windowsAssetSha256","workflowRunId",
];
function hash(bytes){return createHash("sha256").update(bytes).digest("hex");}
function bytes(value,max){
  if(!(value instanceof Uint8Array)||value.byteLength<1||value.byteLength>max)
    throw new Error("WINDOWS_PROOF_BYTES_INVALID");
  return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
}
/** Detached RSASSA-PKCS1-v1_5/SHA-256 proof from the EXACT pinned Windows
 * project signing certificate. This only authenticates the declared zip hash,
 * workflow run and commit; does not check in-ZIP Authenticode or Unix Sigstore. */
export function verifyMcpWindowsDetachedProof(input){
  return verifyWindowsDetachedProofWithTrustedPin(input,MCP_WINDOWS_SIGNER_CERT_SHA256);
}

/** Pure verifier with an explicit trusted pin for ephemeral test certificates.
 * Production callers MUST use verifyMcpWindowsDetachedProof instead. */
export function verifyWindowsDetachedProofWithTrustedPin({
  proofBytes,signatureBytes,certificateBytes,
  expectedCertificateSha256,expectedTag,expectedCommitSha,expectedRunId,
  expectedWindowsAssetSha256,
},trustedCertificateSha256){
  const statement=bytes(proofBytes,4096);
  const signature=bytes(signatureBytes,8192);
  const certificate=bytes(certificateBytes,8192);
  if(!HEX64.test(trustedCertificateSha256)||
     expectedCertificateSha256!==trustedCertificateSha256 ||
     hash(certificate)!==trustedCertificateSha256)
    throw new Error("WINDOWS_PROOF_CERTIFICATE_MISMATCH");
  if(!TAG.test(expectedTag)||expectedTag.length>128||
    expectedTag.includes("-oracle.")||expectedTag.includes("-companion.")||
    !HEX40.test(expectedCommitSha)||!HEX64.test(expectedWindowsAssetSha256)||
    !Number.isSafeInteger(expectedRunId)||expectedRunId<=0)
    throw new Error("WINDOWS_PROOF_IDENTITY_INVALID");
  let proof;
  try {proof=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(statement));}
  catch {throw new Error("WINDOWS_PROOF_SCHEMA_INVALID");}
  if(!proof||typeof proof!=="object"||Array.isArray(proof)||
    JSON.stringify(Object.keys(proof).sort())!==JSON.stringify(EXPECTED_KEYS)||
    proof.schemaVersion!==1||proof.product!=="mcp-access-stack"||
    proof.purpose!=="mcp-public-windows-zip-v1"||
    !HEX64.test(proof.signerCertificateSha256)||!HEX64.test(proof.windowsAssetSha256)||
    !HEX40.test(proof.sourceCommitSha)||
    typeof proof.releaseTag!=="string"||
    typeof proof.windowsAssetName!=="string"||
    !Number.isSafeInteger(proof.workflowRunId))
    throw new Error("WINDOWS_PROOF_SCHEMA_INVALID");
  if(proof.signerCertificateSha256!==trustedCertificateSha256||
    proof.releaseTag!==expectedTag||proof.sourceCommitSha!==expectedCommitSha||
    proof.workflowRunId!==expectedRunId||
    proof.windowsAssetName!==expectedTag+"-windows-x64.zip"||
    proof.windowsAssetSha256!==expectedWindowsAssetSha256)
    throw new Error("WINDOWS_PROOF_IDENTITY_MISMATCH");
  let x509;
  try {x509=new X509Certificate(certificate);}
  catch {throw new Error("WINDOWS_PROOF_CERTIFICATE_INVALID");}
  if(x509.publicKey.asymmetricKeyType!=="rsa" ||
    (x509.publicKey.asymmetricKeyDetails?.modulusLength??0)<2048 ||
    x509.issuer!==x509.subject||!x509.verify(x509.publicKey)||
    Date.parse(x509.validFrom)>Date.now()||Date.parse(x509.validTo)<Date.now())
    throw new Error("WINDOWS_PROOF_CERTIFICATE_INVALID");
  const verified=verify("RSA-SHA256",statement,{
    key:x509.publicKey,padding:constants.RSA_PKCS1_PADDING,
  },signature);
  if(!verified)throw new Error("WINDOWS_PROOF_SIGNATURE_INVALID");
  return Object.freeze({signatureVerified:true,windowsAssetSha256:expectedWindowsAssetSha256,
    sourceCommitSha:expectedCommitSha,workflowRunId:expectedRunId,releaseTag:expectedTag,
    signerCertificateSha256:trustedCertificateSha256});
}
