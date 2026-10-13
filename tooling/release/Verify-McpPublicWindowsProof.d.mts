export interface McpWindowsDetachedProofInput {
  readonly proofBytes:Uint8Array;
  readonly signatureBytes:Uint8Array;
  readonly certificateBytes:Uint8Array;
  readonly expectedCertificateSha256:string;
  readonly expectedTag:string;
  readonly expectedCommitSha:string;
  readonly expectedRunId:number;
  readonly expectedWindowsAssetSha256:string;
}
export interface McpWindowsDetachedProofResult {
  readonly signatureVerified:true;
  readonly windowsAssetSha256:string;
  readonly sourceCommitSha:string;
  readonly workflowRunId:number;
  readonly releaseTag:string;
  readonly signerCertificateSha256:string;
}
export declare const MCP_WINDOWS_SIGNER_CERT_SHA256:string;
export declare function verifyMcpWindowsDetachedProof(
  input:McpWindowsDetachedProofInput,
):McpWindowsDetachedProofResult;
export declare function verifyWindowsDetachedProofWithTrustedPin(
  input:McpWindowsDetachedProofInput,trustedCertificateSha256:string,
):McpWindowsDetachedProofResult;
