import type {
  SourceControlExecutor,
  WorkspaceExecutor,
} from "@vs-code-gpt/shared";

export type TestExecutor = WorkspaceExecutor & SourceControlExecutor;

export function createTestExecutor(
  overrides: Partial<TestExecutor> = {},
): TestExecutor {
  return new Proxy(overrides as TestExecutor, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (value !== undefined) return value;
      if (typeof property !== "string") return value;
      return async () => {
        throw new Error(`Unexpected test executor call: ${property}`);
      };
    },
  });
}
