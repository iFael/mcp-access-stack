import { z } from "zod";

export const browserOperationModeSchema = z.enum([
  "auto",
  "interactive",
  "efficient",
  "diagnostic",
]);

export type BrowserOperationMode = z.infer<typeof browserOperationModeSchema>;
export type BrowserModeRoutingStrategy = "direct";
export type BrowserModeObservability = "standard" | "diagnostic";
export type BrowserModeProfileType = "persistent";

export interface BrowserOperationModeProfile {
  mode: BrowserOperationMode;
  routingStrategy: BrowserModeRoutingStrategy;
  profileType: BrowserModeProfileType;
  observability: BrowserModeObservability;
  retainDiagnosticArtifacts: boolean;
  allowAdvancedOperations: boolean;
  allowAutomaticFallback: false;
}

export const DEFAULT_BROWSER_OPERATION_MODE: BrowserOperationMode = "interactive";

const PROFILES: Readonly<Record<BrowserOperationMode, BrowserOperationModeProfile>> = {
  interactive: Object.freeze({
    mode: "interactive",
    routingStrategy: "direct",
    profileType: "persistent",
    observability: "standard",
    retainDiagnosticArtifacts: false,
    allowAdvancedOperations: false,
    allowAutomaticFallback: false,
  }),
  efficient: Object.freeze({
    mode: "efficient",
    routingStrategy: "direct",
    profileType: "persistent",
    observability: "standard",
    retainDiagnosticArtifacts: false,
    allowAdvancedOperations: false,
    allowAutomaticFallback: false,
  }),
  diagnostic: Object.freeze({
    mode: "diagnostic",
    routingStrategy: "direct",
    profileType: "persistent",
    observability: "diagnostic",
    retainDiagnosticArtifacts: true,
    allowAdvancedOperations: true,
    allowAutomaticFallback: false,
  }),
  auto: Object.freeze({
    mode: "auto",
    routingStrategy: "direct",
    profileType: "persistent",
    observability: "standard",
    retainDiagnosticArtifacts: false,
    allowAdvancedOperations: false,
    allowAutomaticFallback: false,
  }),
};

export function resolveBrowserOperationMode(
  mode: BrowserOperationMode = DEFAULT_BROWSER_OPERATION_MODE,
): BrowserOperationModeProfile {
  return PROFILES[mode];
}
