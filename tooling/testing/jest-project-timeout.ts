import { jest } from "@jest/globals";

const timeout = (globalThis as { __PROJECT_TEST_TIMEOUT_MS__?: unknown }).__PROJECT_TEST_TIMEOUT_MS__;
if (typeof timeout === "number") jest.setTimeout(timeout);
