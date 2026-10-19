/**
 * Detect active challenge widgets, not prose that merely mentions CAPTCHA.
 * Frame URLs come from browser-owned frame metadata, never page-supplied instructions.
 */
export function hasBrowserCaptchaChallenge(
  snapshot: string,
  frameUrls: readonly string[] = [],
): boolean {
  if (frameUrls.some(isKnownChallengeFrame)) return true;
  return snapshot.split(/\r?\n/u).some((line) => {
    const roleLine = line.trim();
    return /^-\s*iframe\s+"[^"]*(?:recaptcha|hcaptcha|cloudflare turnstile|arkose|funcaptcha)[^"]*"/iu.test(roleLine)
      || /^-\s*checkbox\s+"[^"]*(?:i(?:'|’)?m not a robot|não sou um robô)[^"]*"/iu.test(roleLine);
  });
}

function isKnownChallengeFrame(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    return (
      ((host === "google.com" || host.endsWith(".google.com") ||
        host === "recaptcha.net" || host.endsWith(".recaptcha.net")) &&
        path.startsWith("/recaptcha/"))
      || (host === "hcaptcha.com" || host.endsWith(".hcaptcha.com"))
      || (host === "challenges.cloudflare.com" && path.startsWith("/turnstile/"))
      || (host === "arkoselabs.com" || host.endsWith(".arkoselabs.com"))
      || (host === "funcaptcha.com" || host.endsWith(".funcaptcha.com"))
    );
  } catch {
    return false;
  }
}
