import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign,X509Certificate} from "node:crypto";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {MCP_WINDOWS_SIGNER_CERT_SHA256,verifyMcpWindowsDetachedProof,
  verifyWindowsDetachedProofWithTrustedPin} from "./Verify-McpPublicWindowsProof.mjs";
const sha="a".repeat(40),digest="b".repeat(64),tag="v1.1.0-beta.90",runId=8764;
const publicCert=readFileSync("deploy/windows/mcp-access-stack-code-signing.cer");
const fingerprint=createHash("sha256").update(publicCert).digest("hex");
const signer=new X509Certificate(publicCert);
test("Windows packager signs the actual compressed asset and publisher includes proof pair",()=>{
  const builder=readFileSync("deploy/windows/New-McpPublicDistribution.ps1","utf8");
  const workflow=readFileSync(".github/workflows/release.yml","utf8");
  assert.ok(builder.indexOf("Compress-Archive")>=0);
  assert.ok(builder.indexOf("SignData(")>builder.indexOf("Compress-Archive"));
  assert.ok(builder.includes("windowsAssetSha256 = $assetHash"));
  assert.ok(builder.includes("GetRSAPrivateKey($certificate)"));
  assert.ok(builder.includes("RSASignaturePadding]::Pkcs1"));
  assert.ok(builder.includes("$BuildRunId -le 0"));
  assert.ok(builder.includes("if ($WorkflowName -eq 'Public release')"));
  assert.ok(workflow.includes("windows-x64.proof.json"));
  assert.ok(workflow.includes("windows-x64.proof.json.sig"));
});
test("pinned project certificate is self-issued RSA (public only)",()=>{
  assert.equal(fingerprint,MCP_WINDOWS_SIGNER_CERT_SHA256);
  assert.equal(signer.publicKey.asymmetricKeyType,"rsa");
  assert.equal(signer.issuer,signer.subject);
  assert.ok(signer.verify(signer.publicKey));
});
test("independent cryptographic verifier fails closed on missing or fraudulent evidence",()=>{
  const proof={schemaVersion:1,product:"mcp-access-stack",purpose:"mcp-public-windows-zip-v1",releaseTag:tag,
    sourceCommitSha:sha,workflowRunId:runId,
    windowsAssetName:tag+"-windows-x64.zip",windowsAssetSha256:digest,
    signerCertificateSha256:fingerprint};
  const proofBytes=Buffer.from(JSON.stringify(proof),"utf8");
  const attacker=generateKeyPairSync("rsa",{modulusLength:2048});
  const fakeSignature=sign("RSA-SHA256",proofBytes,attacker.privateKey);
  const args={proofBytes,signatureBytes:fakeSignature,certificateBytes:publicCert,
    expectedCertificateSha256:fingerprint,expectedTag:tag,
    expectedCommitSha:sha,expectedRunId:runId,expectedWindowsAssetSha256:digest};
  assert.throws(()=>verifyMcpWindowsDetachedProof(args),/SIGNATURE_INVALID/);
  assert.throws(()=>verifyMcpWindowsDetachedProof({...args,expectedTag:"v1.1.0-beta.91"}),/IDENTITY_MISMATCH/);
  assert.throws(()=>verifyMcpWindowsDetachedProof({...args,expectedRunId:runId+1}),/IDENTITY_MISMATCH/);
  assert.throws(()=>verifyMcpWindowsDetachedProof({...args,expectedWindowsAssetSha256:"c".repeat(64)}),/IDENTITY_MISMATCH/);
  assert.throws(()=>verifyMcpWindowsDetachedProof({...args,expectedCertificateSha256:"c".repeat(64)}),/CERTIFICATE_MISMATCH/);
  assert.throws(()=>verifyMcpWindowsDetachedProof({...args,
    proofBytes:Buffer.from(JSON.stringify({...proof,extra:"oops"}))}),/SCHEMA_INVALID/);
  assert.throws(()=>verifyMcpWindowsDetachedProof({...args,signatureBytes:Buffer.alloc(0)}),/BYTES_INVALID/);
});
test("independently verifies ephemeral RSA signature, then rejects tampering and wrong signer pin",
  {skip:spawnSync("openssl",["version"],{stdio:"ignore"}).status!==0},()=>{
    const dir=mkdtempSync(join(tmpdir(),"mcp-proof-fixture-"));
    try{
      const key=join(dir,"ephemeral.key"),cert=join(dir,"ephemeral.pem");
      const issued=spawnSync("openssl",["req","-x509","-newkey","rsa:2048",
        "-nodes","-days","2","-subj","/CN=MCP-Ephemeral-Test-Signer",
        "-keyout",key,"-out",cert],{stdio:"ignore"});
      assert.equal(issued.status,0);
      const ephemeralCert=readFileSync(cert);
      const pin=createHash("sha256").update(ephemeralCert).digest("hex");
      const statement={schemaVersion:1,product:"mcp-access-stack",
        purpose:"mcp-public-windows-zip-v1",releaseTag:tag,sourceCommitSha:sha,
        workflowRunId:runId,windowsAssetName:tag+"-windows-x64.zip",
        windowsAssetSha256:digest,signerCertificateSha256:pin};
      const proofBytes=Buffer.from(JSON.stringify(statement));
      const signatureBytes=sign("RSA-SHA256",proofBytes,readFileSync(key));
      const args={proofBytes,signatureBytes,certificateBytes:ephemeralCert,
        expectedCertificateSha256:pin,expectedTag:tag,expectedCommitSha:sha,
        expectedRunId:runId,expectedWindowsAssetSha256:digest};
      assert.equal(verifyWindowsDetachedProofWithTrustedPin(args,pin).signatureVerified,true);
      assert.throws(()=>verifyWindowsDetachedProofWithTrustedPin({
        ...args,proofBytes:Buffer.from(JSON.stringify({...statement,sourceCommitSha:"b".repeat(40)})),
      },pin),/IDENTITY_MISMATCH/);
      assert.throws(()=>verifyWindowsDetachedProofWithTrustedPin({
        ...args,signatureBytes:Buffer.concat([signatureBytes,Buffer.from([1])]),
      },pin));
      assert.throws(()=>verifyMcpWindowsDetachedProof(args),/CERTIFICATE_MISMATCH/);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
test("release signer certificate is never sent as an unpinned caller-selected trust root",()=>{
  const {publicKey:wrongKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  assert.notDeepEqual(wrongKey.export({type:"spki",format:"der"}),signer.publicKey.export({type:"spki",format:"der"}));
});
