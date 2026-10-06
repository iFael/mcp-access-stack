export const UPDATE_CONTROL_TOTP_ISSUER = "MCP V3";
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const RECOVERY_CODE_COUNT = 8;

export function isTotpEncryptionKey(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}
