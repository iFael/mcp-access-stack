import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import type { BrowserDriverKind } from "../drivers/browser-driver.js";
import type { BrowserOperationMode } from "../policies/browser-operation-mode.js";

const require = createRequire(import.meta.url);

interface PlaywrightRegistryExecutable {
  executablePath(): string;
}

interface PlaywrightCoreBundle {
  registry: {
    registry: {
      findExecutable(name: string): PlaywrightRegistryExecutable | undefined;
    };
  };
}

export const browserAnnouncedAdvancedCapabilities = [
  "console",
  "network",
  "trace",
  "video",
  "pdf",
  "diagnostics",
] as const;

export type BrowserAnnouncedAdvancedCapability =
  (typeof browserAnnouncedAdvancedCapabilities)[number];

export type BrowserAdvancedCapabilityAvailability = Readonly<
  Record<BrowserAnnouncedAdvancedCapability, boolean>
>;

export interface BrowserAdvancedReadinessSnapshot {
  ffmpegAvailable: boolean;
  activeTraces: number;
  activeVideos: number;
  artifactStorageBytes: number;
  artifactCount: number;
}

export interface BrowserWorkerReadiness {
  status: "ready" | "idle" | "degraded" | "disconnected";
  ready: boolean;
  connected: boolean;
  mode: BrowserOperationMode;
  driver: BrowserDriverKind;
  advancedCapabilitiesAvailable: boolean;
  capabilities: BrowserAdvancedCapabilityAvailability;
  ffmpegAvailable: boolean;
  activeTraces: number;
  activeVideos: number;
  artifactStorageBytes: number;
  artifactCount: number;
}

export interface BrowserDependencyProbe {
  isFfmpegAvailable(): Promise<boolean>;
}

export class NodeBrowserDependencyProbe implements BrowserDependencyProbe {
  private ffmpegAvailability: Promise<boolean> | undefined;

  isFfmpegAvailable(): Promise<boolean> {
    this.ffmpegAvailability ??= probePlaywrightFfmpeg();
    return this.ffmpegAvailability;
  }
}

export class StaticBrowserDependencyProbe implements BrowserDependencyProbe {
  constructor(private readonly ffmpegAvailable: boolean) {}

  async isFfmpegAvailable(): Promise<boolean> {
    return this.ffmpegAvailable;
  }
}

export function unavailableAdvancedReadiness(): BrowserAdvancedReadinessSnapshot {
  return {
    ffmpegAvailable: false,
    activeTraces: 0,
    activeVideos: 0,
    artifactStorageBytes: 0,
    artifactCount: 0,
  };
}

async function probePlaywrightFfmpeg(): Promise<boolean> {
  return (await resolvePlaywrightFfmpegPath()) !== undefined;
}

export async function resolvePlaywrightFfmpegPath(): Promise<
  string | undefined
> {
  try {
    const bundle = require("playwright-core/lib/coreBundle") as PlaywrightCoreBundle;
    const executable = bundle.registry.registry.findExecutable("ffmpeg");
    const executablePath = executable?.executablePath();
    if (!executablePath) return undefined;
    await access(executablePath);
    return executablePath;
  } catch {
    return undefined;
  }
}
