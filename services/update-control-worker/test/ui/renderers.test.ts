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
  it("renders /user with state, email, and one code field for TOTP or recovery", () => {
    const markup = renderUserPage({
      state: "state-user",
      email: "admin+<test>@example.invalid",
      error: "The authenticator or recovery code was not accepted.",
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<h1[^>]*>Sign in to Update Center<\/h1>/);
    assert.match(markup, /<form[^>]*action="\/user"[^>]*method="post"/);
    assert.match(markup, /<label[^>]*for="email"/);
    assert.match(markup, /<label[^>]*for="code"/);
    assert.match(markup, /name="state" value="state-user"/);
    assert.match(markup, /name="email"/);
    assert.match(markup, /name="code"/);
    assert.doesNotMatch(markup, /name="csrfToken"|name="totp"|user\/recovery/);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /admin\+&lt;test&gt;@example\.invalid/);
  });

  it("renders the admin Users panel with parameterized actions and no run or role controls", () => {
    const markup = renderAdminPage({
      csrf: { name: "csrf", value: "csrf-admin" },
      actions: {
        invite: "/admin/invite-action",
        logout: "/admin/sign-out-action",
      },
      users: [
        {
          email: "user@example.invalid",
          displayName: "User Example",
          role: "user",
          revokeAction: "/admin/revoke/user-1",
        },
        {
          email: "admin@example.invalid",
          displayName: "Admin Example",
          role: "admin",
        },
      ],
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<h1[^>]*>Update Center<\/h1>/);
    assert.match(markup, /<h2[^>]*>Users<\/h2>/);
    assert.match(markup, /<form[^>]*action="\/admin\/invite-action"[^>]*method="post"/);
    assert.match(markup, /<form[^>]*action="\/admin\/sign-out-action"[^>]*method="post"/);
    assert.match(markup, /<form[^>]*action="\/admin\/revoke\/user-1"[^>]*method="post"/);
    assert.match(markup, /aria-label="Revoke access for user@example\.invalid"/);
    assert.match(markup, /name="csrf" value="csrf-admin"/);
    assert.match(markup, /name="email"/);
    assert.match(markup, /Invite user/);
    assert.match(markup, /User Example/);
    assert.match(markup, /Admin Example/);
    assert.match(markup, />user</);
    assert.match(markup, />admin</);
    assert.doesNotMatch(markup, /Recent runs|Run history|<select|name="role"|promote/i);
    assert.match(markup, /<th[^>]*scope="col"[^>]*>Email<\/th>/);
    assert.match(markup, /<caption class="sr-only">Update Center users<\/caption>/);
  });

  it("renders OAuth informational and error states without consent protocol fields", () => {
    const markup = renderOAuthPage({
      message: "The request is continuing through the server redirect.",
      error: "Sign in to continue.",
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<h1[^>]*>Authorization unavailable<\/h1>/);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /Sign in to continue\./);
    assert.doesNotMatch(markup, /<form|name="decision"|csrfToken|approve|deny/i);
  });

  it("renders enrollment on a supplied /enroll or /join action with real form field names", () => {
    const markup = renderEnrollmentPage({
      action: "/join",
      state: "state-join",
      email: "user@example.invalid",
      displayName: "User Example",
      qrImagePath: "/server-provided/enrollment-image",
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<h1[^>]*>Set up an authenticator<\/h1>/);
    assert.match(markup, /<img[^>]*src="\/server-provided\/enrollment-image"/);
    assert.match(markup, /alt="Authenticator enrollment QR code"/);
    assert.match(markup, /<form[^>]*action="\/join"[^>]*method="post"/);
    assert.match(markup, /name="state" value="state-join"/);
    assert.match(markup, /name="email"/);
    assert.match(markup, /name="display_name"/);
    assert.match(markup, /name="code"/);
    assert.doesNotMatch(markup, /user\/enrollment|name="csrfToken"|name="totp"|otpauth:\/\//i);
    assert.throws(
      () => renderEnrollmentPage({
        action: "/enroll",
        state: "state-enroll",
        qrImagePath: "//external.example.invalid/image",
      }),
      /same-origin path/,
    );
  });

  it("shows recovery codes as static HTML and leaves login recovery on /user", () => {
    const markup = renderRecoveryPage({
      codes: ["recovery-ONE-TIME-01", "recovery-ONE-TIME-02"],
    });

    expectStaticDarkDocument(markup);
    assert.match(markup, /<h1[^>]*>Save your recovery codes<\/h1>/);
    assert.match(markup, /role="status"/);
    assert.match(markup, /<code[^>]*>recovery-ONE-TIME-01<\/code>/);
    assert.match(markup, /<code[^>]*>recovery-ONE-TIME-02<\/code>/);
    assert.match(markup, /Login recovery uses the code field on the sign-in form\./);
    assert.doesNotMatch(markup, /<form|user\/recovery|csrfToken|data-react/i);
  });
});
