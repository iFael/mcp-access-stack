import pino, { type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: null,
    redact: {
      paths: [
        "req.headers.authorization",
        "authorization",
        "token",
        "arguments",
        "result",
        "content",
      ],
      censor: "[redacted]",
    },
  });
}
