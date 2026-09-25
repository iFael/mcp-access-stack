import type { OperationContext } from "./contracts.js";
import type {
  CreateRepositoryInput,
  DeviceSummary,
  DiscoverLocalRepositoriesInput,
  DiscoverLocalRepositoriesResult,
  GetOnboardingStateInput,
  GetRepositoryInput,
  ImportRepositoriesInput,
  ImportRepositoriesResult,
  ListDevicesInput,
  ListDevicesResult,
  ListRepositoriesInput,
  ListRepositoriesResult,
  MaterializeRepositoryInput,
  MaterializeRepositoryResult,
  OnboardingState,
  RepositoryDetails,
  RevokeDeviceInput,
  RevokeDeviceResult,
  SyncRepositoryInput,
  SyncRepositoryResult,
} from "./repository-contracts.js";

export interface RepositoryExecutor {
  getOnboardingState(
    input: GetOnboardingStateInput,
    context?: OperationContext,
  ): Promise<OnboardingState>;
  listRepositories(
    input: ListRepositoriesInput,
    context?: OperationContext,
  ): Promise<ListRepositoriesResult>;
  getRepository(
    input: GetRepositoryInput,
    context?: OperationContext,
  ): Promise<RepositoryDetails>;
  createRepository(
    input: CreateRepositoryInput,
    context?: OperationContext,
  ): Promise<RepositoryDetails>;
  discoverLocalRepositories(
    input: DiscoverLocalRepositoriesInput,
    context?: OperationContext,
  ): Promise<DiscoverLocalRepositoriesResult>;
  importRepositories(
    input: ImportRepositoriesInput,
    context?: OperationContext,
  ): Promise<ImportRepositoriesResult>;
  materializeRepository(
    input: MaterializeRepositoryInput,
    context?: OperationContext,
  ): Promise<MaterializeRepositoryResult>;
  syncRepository(
    input: SyncRepositoryInput,
    context?: OperationContext,
  ): Promise<SyncRepositoryResult>;
  listDevices(
    input: ListDevicesInput,
    context?: OperationContext,
  ): Promise<ListDevicesResult>;
  revokeDevice(
    input: RevokeDeviceInput,
    context?: OperationContext,
  ): Promise<RevokeDeviceResult>;
}

export type { DeviceSummary };
