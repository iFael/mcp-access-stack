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
  CardFooter,
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

export interface UserPageViewModel {
  csrfToken: string;
  email?: string;
  error?: string;
  recoveryHref: string;
}

export interface AdminRunViewModel {
  id: string;
  status: string;
  startedAt: string;
  summary: string;
}

export interface AdminPageViewModel {
  administrator: {
    displayName: string;
    email: string;
    role: UpdateCenterRole;
  };
  error?: string;
  runs: readonly AdminRunViewModel[];
}

export interface OAuthPageViewModel {
  clientName: string;
  csrfToken: string;
  error?: string;
  scopes: readonly string[];
}

/**
 * The fixed same-origin QR endpoint must return a no-store image and must never
 * log or expose the provisioning URI in request metadata.
 */
export interface EnrollmentPageViewModel {
  accountLabel: string;
  csrfToken: string;
  error?: string;
}

export interface RecoveryPageViewModel {
  codes: readonly string[];
  continueAction: string;
  csrfToken: string;
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
        description="Use your account and a current code from your authenticator."
      />
      <Card>
        <CardHeader>
          <CardTitle>Authenticator sign-in</CardTitle>
          <CardDescription>
            This session is for the web interface. MCP access uses its separate OAuth credential.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <ErrorAlert message={viewModel.error} />
          <form method="post" action="/user" className="grid gap-5">
            <input type="hidden" name="csrfToken" value={viewModel.csrfToken} />
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
              <Label htmlFor="totp">Authenticator code</Label>
              <Input
                id="totp"
                name="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6,8}"
                minLength={6}
                maxLength={8}
                required
              />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
          <p className="text-center text-sm">
            <a
              href={viewModel.recoveryHref}
              className="rounded-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Use a recovery code
            </a>
          </p>
        </CardContent>
      </Card>
    </Page>,
  );
}

export function renderAdminPage(viewModel: AdminPageViewModel): string {
  return documentMarkup(
    "Update Center",
    <Page wide>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <PageHeading
          eyebrow="Administrator"
          title="Update Center"
          description="Review update runs and their read-only evidence."
        />
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <div className="grid gap-1">
            <span className="text-sm font-medium">{viewModel.administrator.displayName}</span>
            <span className="text-xs text-muted-foreground">{viewModel.administrator.email}</span>
          </div>
          <Badge variant={viewModel.administrator.role === "admin" ? "default" : "secondary"}>
            {viewModel.administrator.role}
          </Badge>
        </div>
      </div>
      <ErrorAlert message={viewModel.error} />
      <section aria-labelledby="runs-heading" className="grid gap-4">
        <div className="grid gap-4">
          <h2 id="runs-heading" className="text-lg font-semibold tracking-tight">
            Recent runs
          </h2>
          <Separator />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Run history</CardTitle>
            <CardDescription>Update state and evidence from the Update Center read API.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <caption className="sr-only">Recent Update Center runs</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewModel.runs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
                      No update runs are available.
                    </TableCell>
                  </TableRow>
                ) : (
                  viewModel.runs.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        <code className="font-mono text-xs">{run.id}</code>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{run.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <time dateTime={run.startedAt}>{run.startedAt}</time>
                      </TableCell>
                      <TableCell className="min-w-56 whitespace-normal">{run.summary}</TableCell>
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
    "Authorize access",
    <Page>
      <PageHeading
        eyebrow="OAuth authorization"
        title="Authorize access"
        description="Review the access requested by this connected application."
      />
      <ErrorAlert message={viewModel.error} />
      <Card>
        <CardHeader>
          <CardTitle>{viewModel.clientName}</CardTitle>
          <CardDescription>
            This application requests access to Update Center read-only data.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <h2 className="text-sm font-medium">Requested access</h2>
          <ul className="grid gap-2 text-sm text-muted-foreground">
            {viewModel.scopes.map((scope) => (
              <li key={scope}>
                <Badge variant="secondary">{scope}</Badge>
              </li>
            ))}
          </ul>
          <Separator />
          <p className="text-sm leading-6 text-muted-foreground">
            Continuing reuses your existing human session. This page does not expose MCP credentials.
          </p>
        </CardContent>
        <CardFooter className="flex-col items-stretch sm:flex-row sm:justify-end">
          <form method="post" action="/oauth" className="w-full sm:w-auto">
            <input type="hidden" name="csrfToken" value={viewModel.csrfToken} />
            <input type="hidden" name="decision" value="deny" />
            <Button type="submit" variant="outline" className="w-full sm:w-auto">
              Cancel
            </Button>
          </form>
          <form method="post" action="/oauth" className="w-full sm:w-auto">
            <input type="hidden" name="csrfToken" value={viewModel.csrfToken} />
            <input type="hidden" name="decision" value="approve" />
            <Button type="submit" className="w-full sm:w-auto">
              Continue
            </Button>
          </form>
        </CardFooter>
      </Card>
    </Page>,
  );
}

export function renderEnrollmentPage(viewModel: EnrollmentPageViewModel): string {
  return documentMarkup(
    "Authenticator enrollment",
    <Page>
      <PageHeading
        eyebrow="Secure enrollment"
        title="Set up an authenticator"
        description="Scan this one-time enrollment code, then verify a current code to finish setup."
      />
      <ErrorAlert message={viewModel.error} />
      <Card>
        <CardHeader>
          <CardTitle>Authenticator setup</CardTitle>
          <CardDescription>{viewModel.accountLabel}</CardDescription>
        </CardHeader>
        <CardContent className="grid justify-items-center gap-5">
          <img
            src="/user/enrollment/qr"
            alt="Authenticator enrollment QR code"
            className="size-52 rounded-md bg-white p-3"
          />
          <p className="max-w-md text-center text-sm leading-6 text-muted-foreground">
            Scan the code with your authenticator app. The enrollment image is private to this session.
          </p>
          <form method="post" action="/user/enrollment" className="grid w-full max-w-sm gap-4">
            <input type="hidden" name="csrfToken" value={viewModel.csrfToken} />
            <div className="grid gap-2">
              <Label htmlFor="totp">Current authenticator code</Label>
              <Input
                id="totp"
                name="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6,8}"
                minLength={6}
                maxLength={8}
                required
              />
            </div>
            <Button type="submit">Verify and finish setup</Button>
          </form>
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
                <code className="font-mono text-sm">{code}</code>
              </li>
            ))}
          </ul>
          <Alert role="status">
            <AlertTitle>Keep these codes private</AlertTitle>
            <AlertDescription>
              Leave this page only after you have stored the codes safely.
            </AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter>
          <form method="post" action={viewModel.continueAction} className="w-full">
            <input type="hidden" name="csrfToken" value={viewModel.csrfToken} />
            <Button type="submit" className="w-full sm:w-auto">
              Continue
            </Button>
          </form>
        </CardFooter>
      </Card>
    </Page>,
  );
}

