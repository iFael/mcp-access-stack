import { strict as assert } from "node:assert";
import {
  renderAdminPage,
  renderEnrollmentPage,
  renderOAuthPage,
  renderRecoveryPage,
  renderUserPage,
} from "../../src/ui/renderers.js";

function expectStaticDarkDocument(markup: string): void {
  assert.match(markup, /^<!DOCTYPE html>/);
  assert.match(markup, /<html lang="en"[^>]*>/);
  assert.match(markup, /<link rel="stylesheet" href="\/assets\/update-control\.css"\/>/);
  assert.match(markup, /<a href="#main-content"[^>]*>Skip to content<\/a>/);
  assert.match(markup, /<main id="main-content" tabindex="-1"/);
  assert.match(markup, /focus-visible:ring-\[3px\]/);
  assert.doesNotMatch(markup, /<script\b/i);
  assert.doesNotMatch(markup, /\sstyle=/i);
  assert.doesNotMatch(markup, /\son[a-z]+=/i);
  assert.doesNotMatch(markup, /data-reactroot|__reactProps|__NEXT_DATA__/i);
}

describe("Update Center server-rendered UI", () => {
  it("renders the human TOTP login as accessible native POST markup", () => {
    const markup = renderUserPage({
      csrfToken: "csrf-user",
      email: "admin+<test>@example.invalid",
      error: "The authenticator code was not accepted.",
      recoveryHref: "/user/recovery",
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<main\b/);
    assert.match(markup, /<h1[^>]*>Sign in to Update Center<\/h1>/);
    assert.match(markup, /<form[^>]*action="\/user"[^>]*method="post"/);
    assert.match(markup, /<label[^>]*for="email"/);
    assert.match(markup, /<label[^>]*for="totp"/);
    assert.match(markup, /name="csrfToken" value="csrf-user"/);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /href="\/user\/recovery"/);
    assert.match(markup, /admin\+&lt;test&gt;@example\.invalid/);
  });

  it("renders admin run data in a semantic table with column headers", () => {
    const markup = renderAdminPage({
      administrator: {
        displayName: "Admin Example",
        email: "admin@example.invalid",
        role: "admin",
      },
      runs: [
        {
          id: "run-042",
          status: "succeeded",
          startedAt: "2026-10-07T02:00:00Z",
          summary: "Read-only status check",
        },
      ],
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<h1[^>]*>Update Center<\/h1>/);
    assert.match(markup, /<table\b/);
    assert.match(markup, /<th[^>]*scope="col"[^>]*>Run<\/th>/);
    assert.match(markup, /<th[^>]*scope="col"[^>]*>Status<\/th>/);
    assert.match(markup, /<caption class="sr-only">Recent Update Center runs<\/caption>/);
    assert.match(markup, /run-042/);
    assert.match(markup, /Admin Example/);
    assert.match(markup, />admin</);
  });

  it("renders the OAuth authorization view using native POST decisions", () => {
    const markup = renderOAuthPage({
      clientName: "ChatGPT Desktop",
      csrfToken: "csrf-oauth",
      scopes: ["update:read"],
      error: "Review this request.",
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<h1[^>]*>Authorize access<\/h1>/);
    assert.match(markup, /ChatGPT Desktop/);
    assert.match(markup, /update:read/);
    assert.match(markup, /action="\/oauth"[^>]*method="post"/);
    assert.match(markup, /name="decision" value="approve"/);
    assert.match(markup, /name="decision" value="deny"/);
    assert.match(markup, /name="csrfToken" value="csrf-oauth"/);
  });

  it("renders enrollment QR as a same-origin image without provisioning URI text", () => {
    const markup = renderEnrollmentPage({
      accountLabel: "admin@example.invalid",
      csrfToken: "csrf-enrollment",
      error: "Scan the code, then enter a current authenticator code.",
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<h1[^>]*>Set up an authenticator<\/h1>/);
    assert.match(markup, /<img[^>]*src="\/user\/enrollment\/qr"/);
    assert.match(markup, /alt="Authenticator enrollment QR code"/);
    assert.match(markup, /name="totp"/);
    assert.match(markup, /action="\/user\/enrollment"[^>]*method="post"/);
    assert.doesNotMatch(markup, /otpauth:\/\//i);
    assert.doesNotMatch(markup, /provisioningUri|provisioning_uri/i);
  });

  it("shows recovery codes in static HTML with no client data blob", () => {
    const markup = renderRecoveryPage({
      codes: ["recovery-ONE-TIME-01", "recovery-ONE-TIME-02"],
      csrfToken: "csrf-recovery",
      continueAction: "/user/recovery/complete",
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<h1[^>]*>Save your recovery codes<\/h1>/);
    assert.match(markup, /role="status"/);
    assert.match(markup, /<code[^>]*>recovery-ONE-TIME-01<\/code>/);
    assert.match(markup, /<code[^>]*>recovery-ONE-TIME-02<\/code>/);
    assert.match(markup, /action="\/user\/recovery\/complete"[^>]*method="post"/);
    assert.match(markup, /name="csrfToken" value="csrf-recovery"/);
  });
});
