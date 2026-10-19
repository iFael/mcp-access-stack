import { describe, expect, it } from "@jest/globals";
import { hasBrowserCaptchaChallenge } from "../../services/browser-captcha-detector.js";

describe("hasBrowserCaptchaChallenge", () => {
  it("does not mistake articles or example code for active CAPTCHA widgets", () => {
    expect(hasBrowserCaptchaChallenge('- heading "What is CAPTCHA?"\n- paragraph: "A reCAPTCHA tutorial"')).toBe(false);
    expect(hasBrowserCaptchaChallenge('- link "hCaptcha overview"')).toBe(false);
    expect(hasBrowserCaptchaChallenge("", ["https://example.com/articles/recaptcha"])).toBe(false);
  });

  it("detects accessible challenge widgets", () => {
    expect(hasBrowserCaptchaChallenge('- iframe "reCAPTCHA" [ref=challenge]')).toBe(true);
    expect(hasBrowserCaptchaChallenge('- checkbox "I\'m not a robot" [ref=challenge]')).toBe(true);
    expect(hasBrowserCaptchaChallenge('- iframe "Cloudflare Turnstile" [ref=challenge]')).toBe(true);
  });

  it("detects known challenge-provider frames without a matching aria label", () => {
    expect(hasBrowserCaptchaChallenge('- iframe', ["https://www.google.com/recaptcha/api2/anchor?k=x"])).toBe(true);
    expect(hasBrowserCaptchaChallenge("", ["https://newassets.hcaptcha.com/captcha/v1"])).toBe(true);
    expect(hasBrowserCaptchaChallenge("", ["https://challenges.cloudflare.com/turnstile/v0/"])).toBe(true);
    expect(hasBrowserCaptchaChallenge("", ["https://evil-google.com/recaptcha/api2/anchor"])).toBe(false);
  });
});
