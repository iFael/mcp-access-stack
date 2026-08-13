import { AppError } from "@vs-code-gpt/shared";
import { z } from "zod";

const exactOriginSchema = z.string().transform((value, context) => {
  try {
    return new URL(value).origin;
  } catch {
    context.addIssue({ code: "custom", message: "Expected an absolute origin URL." });
    return z.NEVER;
  }
});

const requestMethodSchema = z.enum(["GET", "HEAD", "POST"]);

export const authorizedSiteRequestRuleSchema = z
  .object({
    methods: z.array(requestMethodSchema).min(1).max(3).transform(uniqueSorted),
    pathname: z.string().min(1).max(2_000).refine(
      (value) => value.startsWith("/"),
      { message: "Authorized request pathnames must be absolute URL paths." },
    ),
    queryKeys: z
      .array(z.string().min(1).max(128))
      .max(50)
      .default([])
      .transform(uniqueSorted),
    resourceTypes: z
      .array(z.string().min(1).max(50))
      .min(1)
      .max(20)
      .transform(uniqueSorted)
      .optional(),
    frames: z
      .array(z.string().min(1).max(120))
      .min(1)
      .max(20)
      .transform(uniqueSorted)
      .optional(),
    navigation: z.boolean().optional(),
    requiresSemanticPermit: z.boolean().default(false),
  })
  .strict();
export type AuthorizedSiteRequestRule = z.infer<
  typeof authorizedSiteRequestRuleSchema
>;

export const authorizedSiteSemanticActionRuleSchema = z
  .object({
    operation: z.enum(["frame-click", "frame-sequence-click"]),
    framePath: z.array(z.string().min(1).max(120)).min(1).max(10),
    selector: z.string().min(1).max(2_000).optional(),
    text: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine(
    (value) => Number(value.selector !== undefined) + Number(value.text !== undefined) === 1,
    { message: "A semantic action rule requires exactly one selector or text target." },
  );
export type AuthorizedSiteSemanticActionRule = z.infer<
  typeof authorizedSiteSemanticActionRuleSchema
>;

export const authorizedSiteRequestPolicySchema = z
  .object({
    rules: z.array(authorizedSiteRequestRuleSchema).min(1).max(100),
    semanticActions: z
      .array(authorizedSiteSemanticActionRuleSchema)
      .max(100)
      .default([]),
  })
  .strict();
export type AuthorizedSiteRequestPolicy = z.infer<
  typeof authorizedSiteRequestPolicySchema
>;

export const authorizedSitePolicySchema = z
  .object({
    siteId: z.string().min(1).max(128),
    entryUrl: z.url(),
    allowedOrigins: z.array(exactOriginSchema).min(1).max(20),
    deniedOrigins: z.array(exactOriginSchema).max(20),
    accessMode: z.literal("business-read-only"),
    loginStrategy: z.enum(["none", "credential-broker"]),
    credentialAccountId: z.string().min(1).max(128).optional(),
    requestPolicy: authorizedSiteRequestPolicySchema.optional(),
  })
  .strict();
export type AuthorizedSitePolicy = z.infer<typeof authorizedSitePolicySchema>;

export interface ClassifiedSiteUrl {
  kind: "public" | "private" | "denied";
  origin: string;
  policy?: AuthorizedSitePolicy;
}

export interface AuthorizedSiteRequestDescriptor {
  origin: string;
  method: string;
  pathname: string;
  queryKeys: readonly string[];
  resourceType: string;
  frame: string;
  navigation: boolean;
  semanticPermit: boolean;
}

export interface AuthorizedSiteSemanticActionDescriptor {
  operation: AuthorizedSiteSemanticActionRule["operation"];
  framePath: readonly string[];
  selector?: string;
  text?: string;
}

export class BrowserSitePolicyRegistry {
  private readonly policies = new Map<string, AuthorizedSitePolicy>();
  private readonly privateOrigins = new Map<string, AuthorizedSitePolicy>();
  private readonly deniedOrigins = new Set<string>();

  constructor(initialPolicies: readonly AuthorizedSitePolicy[]) {
    for (const value of initialPolicies) {
      const policy = authorizedSitePolicySchema.parse(value);
      if (this.policies.has(policy.siteId)) {
        throw new AppError(
          "POLICY_INVALID",
          `Duplicate browser private-site policy ${policy.siteId}.`,
        );
      }
      this.policies.set(policy.siteId, policy);
      for (const origin of policy.allowedOrigins) {
        const existing = this.privateOrigins.get(origin);
        if (existing && existing.siteId !== policy.siteId) {
          throw new AppError(
            "POLICY_INVALID",
            `Private origin ${origin} belongs to more than one site policy.`,
          );
        }
        this.privateOrigins.set(origin, policy);
      }
      for (const origin of policy.deniedOrigins) {
        this.deniedOrigins.add(origin);
      }
    }
  }

  require(siteId: string): AuthorizedSitePolicy {
    const policy = this.policies.get(siteId);
    if (!policy) {
      throw new AppError(
        "SITE_POLICY_NOT_FOUND",
        "The requested private-site policy is not configured.",
      );
    }
    return policy;
  }

  classify(value: string | URL): ClassifiedSiteUrl {
    const url = value instanceof URL ? value : new URL(value);
    const origin = url.origin;
    if (this.deniedOrigins.has(origin)) {
      return { kind: "denied", origin };
    }
    const policy = this.privateOrigins.get(origin);
    return policy
      ? { kind: "private", origin, policy }
      : { kind: "public", origin };
  }

  privateOriginValues(): string[] {
    return [...this.privateOrigins.keys()];
  }

  deniedOriginValues(): string[] {
    return [...this.deniedOrigins];
  }

  publicCapabilities(): Array<{
    siteId: string;
    accessMode: AuthorizedSitePolicy["accessMode"];
    loginStrategy: AuthorizedSitePolicy["loginStrategy"];
  }> {
    return [...this.policies.values()].map((policy) => ({
      siteId: policy.siteId,
      accessMode: policy.accessMode,
      loginStrategy: policy.loginStrategy,
    }));
  }
}

export function isAuthorizedSiteRequestAllowed(
  policy: AuthorizedSitePolicy,
  descriptor: AuthorizedSiteRequestDescriptor,
): boolean {
  const requestPolicy = policy.requestPolicy;
  if (!requestPolicy) return true;
  if (!policy.allowedOrigins.includes(descriptor.origin)) return false;
  const method = descriptor.method.toUpperCase();
  const queryKeys = uniqueSorted([...descriptor.queryKeys]);
  return requestPolicy.rules.some((rule) =>
    rule.methods.includes(method as "GET" | "HEAD" | "POST") &&
    rule.pathname === descriptor.pathname &&
    arraysEqual(rule.queryKeys, queryKeys) &&
    (rule.resourceTypes === undefined || rule.resourceTypes.includes(descriptor.resourceType)) &&
    (rule.frames === undefined || rule.frames.includes(descriptor.frame)) &&
    (rule.navigation === undefined || rule.navigation === descriptor.navigation) &&
    (!rule.requiresSemanticPermit || descriptor.semanticPermit)
  );
}

export function isAuthorizedSiteSemanticActionAllowed(
  policy: AuthorizedSitePolicy,
  descriptor: AuthorizedSiteSemanticActionDescriptor,
): boolean {
  const rules = policy.requestPolicy?.semanticActions ?? [];
  return rules.some((rule) =>
    rule.operation === descriptor.operation &&
    arraysEqual(rule.framePath, descriptor.framePath) &&
    (rule.selector === undefined || rule.selector === descriptor.selector) &&
    (rule.text === undefined || normalizeSemanticText(rule.text) === normalizeSemanticText(descriptor.text))
  );
}

export function deriveProductionOrigin(devUrl: URL): string | undefined {
  if (!devUrl.hostname.toLocaleLowerCase("en-US").startsWith("dev-")) {
    return undefined;
  }
  const production = new URL(devUrl.href);
  production.hostname = production.hostname.slice(4);
  production.pathname = "/";
  production.search = "";
  production.hash = "";
  return production.origin;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeSemanticText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/gu, " ")
    .trim();
}
