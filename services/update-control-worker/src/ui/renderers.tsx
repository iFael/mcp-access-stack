import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "./components/alert.js";
import { Badge } from "./components/badge.js";
import { Button } from "./components/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/card.js";
import { Input } from "./components/input.js";
import { Label } from "./components/label.js";
import { Separator } from "./components/separator.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/table.js";
import { cn } from "./lib/utils.js";

export type UpdateCenterRole = "admin" | "user";
export type EnrollmentAction = "/enroll" | "/join";

export interface UserPageViewModel {
  state: string;
  email?: string;
  error?: string;
}

export interface UserSessionPageViewModel {
  displayName: string;
  email: string;
  role: UpdateCenterRole;
  csrf: CsrfFieldViewModel;
  adminHref?: string;
}

export interface CsrfFieldViewModel {
  name: string;
  value: string;
}

export interface AdminUserViewModel {
  email: string;
  displayName: string;
  role: UpdateCenterRole;
  status: "active" | "revoked";
  /** Supply only when the server offers revoke for this user. */
  revokeAction?: string;
}

export interface AdminPageViewModel {
  csrf: CsrfFieldViewModel;
  actions: {
    invite: string;
    logout: string;
  };
  users: readonly AdminUserViewModel[];
  error?: string;
}

/** Rendered only for an informational or error state; successful OAuth redirects directly. */
export interface OAuthPageViewModel {
  message: string;
  error?: string;
}

/**
 * qrImageSrc accepts only a same-origin path or the server-generated SVG data URI.
 * Never pass the provisioning URI itself.
 */
export interface EnrollmentPageViewModel {
  action: EnrollmentAction;
  state: string;
  email?: string;
  emailReadonly?: boolean;
  displayName?: string;
  qrImageSrc?: string;
  manualSecret?: string;
  error?: string;
}

export interface InviteCreatedPageViewModel {
  joinHref: string;
  expiresMinutes: number;
}

/** Displays recovery codes issued by enrollment; login recovery uses /user's code field. */
export interface RecoveryPageViewModel {
  codes: readonly string[];
}

interface DocumentProps {
  children: ReactNode;
  title: string;
}

function Document({ children, title }: DocumentProps) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <title>{`${title} · Update Center`}</title>
        <link rel="stylesheet" href="/assets/update-control.css" />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <div className="mx-auto flex min-h-dvh w-full flex-col">
          <header className="border-b border-border">
            <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
              <a
                href="/user"
                className="rounded-sm text-sm font-semibold tracking-wide text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                Update Center
              </a>
              <Badge variant="outline">MCP Access Stack</Badge>
            </div>
          </header>
          {children}
          <footer className="mt-auto border-t border-border">
            <div className="mx-auto w-full max-w-7xl px-4 py-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
              Update Center · Human session and MCP credentials remain separate.
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}

interface PageProps {
  children: ReactNode;
  wide?: boolean;
}

function Page({ children, wide = false }: PageProps) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={cn(
        "mx-auto flex w-full flex-1 flex-col gap-6 px-4 py-8 outline-none sm:px-6 sm:py-12 lg:px-8",
        wide ? "max-w-7xl" : "max-w-2xl",
      )}
    >
      {children}
    </main>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="grid gap-3">
      <Badge variant="outline" className="w-fit">
        {eyebrow}
      </Badge>
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function ErrorAlert({ message }: { message: string | undefined }) {
  if (!message) {
    return null;
  }

  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>Unable to continue</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function documentMarkup(title: string, children: ReactNode): string {
  return `<!DOCTYPE html>${renderToStaticMarkup(
    <Document title={title}>{children}</Document>,
  )}`;
}

export function renderUserPage(viewModel: UserPageViewModel): string {
  return documentMarkup(
    "Sign in",
    <Page>
      <PageHeading
        eyebrow="Human session"
        title="Sign in to Update Center"
        description="Sign in with your account and an authenticator or single-use recovery code."
      />
      <Card>
        <CardHeader>
          <CardTitle>Human session sign-in</CardTitle>
          <CardDescription>
            This session is for the web interface. MCP access uses its separate OAuth credential.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ErrorAlert message={viewModel.error} />
          <form method="post" action="/user" className="mt-5 grid gap-5">
            <input type="hidden" name="state" value={viewModel.state} />
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                required
                defaultValue={viewModel.email ?? ""}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="code">Authenticator or recovery code</Label>
              <Input
                id="code"
                name="code"
                type="text"
                autoComplete="one-time-code"
                required
              />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </Page>,
  );
}

export function renderUserSessionPage(viewModel: UserSessionPageViewModel): string {
  return documentMarkup(
    "Signed in",
    <Page>
      <PageHeading
        eyebrow="Human session"
        title="Signed in to Update Center"
        description="Your web session is active. MCP access continues to use its separate OAuth credential."
      />
      <Card>
        <CardHeader>
          <CardTitle>{viewModel.displayName}</CardTitle>
          <CardDescription>{viewModel.email}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Role</span>
            <Badge variant={viewModel.role === "admin" ? "default" : "secondary"}>
              {viewModel.role}
            </Badge>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            {viewModel.adminHref ? (
              <a
                href={viewModel.adminHref}
                className={cn(
                  "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground",
                  "outline-none hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                )}
              >
                Open administration
              </a>
            ) : null}
            <form method="post" action="/user/logout">
              <input type="hidden" name={viewModel.csrf.name} value={viewModel.csrf.value} />
              <Button type="submit" variant="outline">
                Sign out
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </Page>,
  );
}

export function renderAdminPage(viewModel: AdminPageViewModel): string {
  const csrfField = (
    <input type="hidden" name={viewModel.csrf.name} value={viewModel.csrf.value} />
  );

  return documentMarkup(
    "Update Center",
    <Page wide>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <PageHeading
          eyebrow="Administrator"
          title="Update Center"
          description="Manage Update Center users and invitations."
        />
        <form method="post" action={viewModel.actions.logout}>
          {csrfField}
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </div>
      <ErrorAlert message={viewModel.error} />
      <section aria-labelledby="overview-heading" className="grid gap-4">
        <div className="grid gap-4">
          <h2 id="overview-heading" className="text-lg font-semibold tracking-tight">
            Overview
          </h2>
          <Separator />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Human access</CardTitle>
              <CardDescription>Local sign-in uses an authenticator or recovery code.</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="secondary">Web session</Badge>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>MCP access</CardTitle>
              <CardDescription>OAuth credentials remain separate from the human session.</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="outline">OAuth</Badge>
            </CardContent>
          </Card>
        </div>
      </section>
      <section aria-labelledby="users-heading" className="grid gap-4">
        <div className="grid gap-4">
          <h2 id="users-heading" className="text-lg font-semibold tracking-tight">
            Users
          </h2>
          <Separator />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Create invite link</CardTitle>
            <CardDescription>
              Generate a one-time link for a new user. The link expires after 30 minutes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form method="post" action={viewModel.actions.invite}>
              {csrfField}
              <Button type="submit">Create invite link</Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Current users</CardTitle>
            <CardDescription>Review existing accounts and server-provided revoke actions.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <caption className="sr-only">Update Center users</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Display name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewModel.users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground">
                      No users are available.
                    </TableCell>
                  </TableRow>
                ) : (
                  viewModel.users.map((user) => (
                    <TableRow key={user.email}>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>{user.displayName}</TableCell>
                      <TableCell>
                        <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                          {user.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{user.status}</Badge>
                      </TableCell>
                      <TableCell>
                        {user.revokeAction ? (
                          <form method="post" action={user.revokeAction}>
                            {csrfField}
                            <Button
                              type="submit"
                              variant="outline"
                              aria-label={`Revoke access for ${user.email}`}
                            >
                              Revoke
                            </Button>
                          </form>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </Page>,
  );
}

export function renderOAuthPage(viewModel: OAuthPageViewModel): string {
  return documentMarkup(
    "OAuth status",
    <Page>
      <PageHeading
        eyebrow="OAuth"
        title={viewModel.error ? "Authorization unavailable" : "OAuth request"}
        description="A valid human session continues through the server redirect. Without one, sign in at /user."
      />
      <Alert
        variant={viewModel.error ? "destructive" : "default"}
        role={viewModel.error ? "alert" : "status"}
      >
        <AlertTitle>{viewModel.error ? "Unable to continue" : "Request status"}</AlertTitle>
        <AlertDescription>{viewModel.error ?? viewModel.message}</AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>Separate credentials</CardTitle>
          <CardDescription>
            The human web session and MCP OAuth credential are handled separately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-6 text-muted-foreground">{viewModel.message}</p>
        </CardContent>
      </Card>
    </Page>,
  );
}

export function renderEnrollmentPage(viewModel: EnrollmentPageViewModel): string {
  const isSvgDataImage = viewModel.qrImageSrc?.startsWith("data:image/svg+xml;charset=utf-8,") ?? false;
  const isSameOriginPath = Boolean(
    viewModel.qrImageSrc &&
    viewModel.qrImageSrc.startsWith("/") &&
    !viewModel.qrImageSrc.startsWith("//") &&
    !viewModel.qrImageSrc.includes("\\") &&
    !viewModel.qrImageSrc.includes("?") &&
    !viewModel.qrImageSrc.includes("#"),
  );
  if (viewModel.qrImageSrc && !isSvgDataImage && !isSameOriginPath) {
    throw new TypeError("Enrollment QR image must use a safe same-origin path or server-generated SVG data URI.");
  }

  return documentMarkup(
    "Authenticator enrollment",
    <Page>
      <PageHeading
        eyebrow="Secure enrollment"
        title="Set up an authenticator"
        description="Follow the enrollment instructions, then enter a current authenticator code."
      />
      <ErrorAlert message={viewModel.error} />
      <Card>
        <CardHeader>
          <CardTitle>Authenticator setup</CardTitle>
          <CardDescription>{viewModel.email ?? "Update Center account"}</CardDescription>
        </CardHeader>
        <CardContent className="grid justify-items-center gap-5">
          {viewModel.qrImageSrc ? (
            <img
              src={viewModel.qrImageSrc}
              alt="Authenticator enrollment QR code"
              className="size-52 rounded-md bg-white p-3"
            />
          ) : null}
          {viewModel.manualSecret ? (
            <details className="w-full max-w-sm rounded-md border border-border bg-background p-4 text-sm">
              <summary className="cursor-pointer font-medium">Use a manual setup key instead</summary>
              <code
                data-manual-totp-secret={viewModel.manualSecret}
                className="mt-3 block overflow-x-auto rounded-md border border-border p-3 font-mono text-xs"
              >
                {viewModel.manualSecret}
              </code>
            </details>
          ) : null}
          <form method="post" action={viewModel.action} className="grid w-full max-w-sm gap-4">
            <input type="hidden" name="state" value={viewModel.state} />
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                required
                readOnly={viewModel.emailReadonly}
                defaultValue={viewModel.email ?? ""}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="display_name">Display name</Label>
              <Input
                id="display_name"
                name="display_name"
                type="text"
                autoComplete="name"
                required
                defaultValue={viewModel.displayName ?? ""}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="code">Current authenticator code</Label>
              <Input
                id="code"
                name="code"
                type="text"
                autoComplete="one-time-code"
                required
              />
            </div>
            <Button type="submit">Continue enrollment</Button>
          </form>
        </CardContent>
      </Card>
    </Page>,
  );
}

export function renderInviteCreatedPage(viewModel: InviteCreatedPageViewModel): string {
  return documentMarkup(
    "Invitation created",
    <Page>
      <PageHeading
        eyebrow="Administrator"
        title="Invitation created"
        description={`This one-time link expires in ${viewModel.expiresMinutes} minutes.`}
      />
      <Card>
        <CardHeader>
          <CardTitle>Share this invite link</CardTitle>
          <CardDescription>
            Send the link to the intended user through a trusted channel. It can be used once.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <a
            href={viewModel.joinHref}
            className="break-all rounded-md border border-border bg-background p-3 font-mono text-sm underline underline-offset-4"
          >
            {viewModel.joinHref}
          </a>
          <a
            href="/admin"
            className="w-fit rounded-sm text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            Back to administration
          </a>
        </CardContent>
      </Card>
    </Page>,
  );
}

export function renderRecoveryPage(viewModel: RecoveryPageViewModel): string {
  return documentMarkup(
    "Recovery codes",
    <Page>
      <PageHeading
        eyebrow="Account recovery"
        title="Save your recovery codes"
        description="Each code works once. Store them somewhere private and keep them separate from your authenticator."
      />
      <Card>
        <CardHeader>
          <CardTitle>One-time recovery codes</CardTitle>
          <CardDescription>
            These codes are shown in this static response only. They are not copied into a client data blob.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <ul aria-label="Recovery codes" className="grid gap-2 rounded-md border border-border bg-background p-4 sm:grid-cols-2">
            {viewModel.codes.map((code, index) => (
              <li key={index}>
                <code data-recovery-code={code} className="font-mono text-sm">{code}</code>
              </li>
            ))}
          </ul>
          <Alert role="status">
            <AlertTitle>Keep these codes private</AlertTitle>
            <AlertDescription>
              Login recovery uses the code field on the sign-in form.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </Page>,
  );
}

