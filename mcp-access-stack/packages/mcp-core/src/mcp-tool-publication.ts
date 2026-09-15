const publishedInputSchemaOverrides = new WeakMap<object, unknown>();

export function setMcpPublishedInputSchema(
  registeredTool: object,
  schema: unknown,
): void {
  publishedInputSchemaOverrides.set(registeredTool, schema);
}

export function getMcpPublishedInputSchema(
  registeredTool: object,
  fallback: unknown,
): unknown {
  return publishedInputSchemaOverrides.get(registeredTool) ?? fallback;
}
