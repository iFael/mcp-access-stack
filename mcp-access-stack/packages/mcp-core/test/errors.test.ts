import { describe, expect, test } from "@jest/globals";
import { AppError } from "../src/index.js";

describe("AppError serialization", () => {
  test("preserves code and message while serializing sanitized operational details", () => {
    const error = new AppError("BLOCKED_PATH", "Path is blocked by workspace policy.", {
      details: {
        path: "apps/auth-api/.env",
        policyRule: "**/.env",
        operation: "read_file",
        reason: "Path is blocked by workspace policy.",
        safeAlternative: "run_workspace_validation(secret-scan)",
      },
    });

    expect(error.toJSON()).toEqual({
      code: "BLOCKED_PATH",
      message: "Path is blocked by workspace policy.",
      details: {
        path: "apps/auth-api/.env",
        policyRule: "**/.env",
        operation: "read_file",
        reason: "Path is blocked by workspace policy.",
        safeAlternative: "run_workspace_validation(secret-scan)",
      },
    });
  });
});
