import assert from "node:assert/strict";

type ToolResult = { content: { type?: string; text: string }[] };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

type RegisteredTool = {
  handler: ToolHandler;
};

export function registeredTool(server: unknown, name: string): ToolHandler {
  const registered = (server as { _registeredTools?: Record<string, RegisteredTool> })._registeredTools;
  assert.ok(registered?.[name], `expected ${name} to be registered`);
  return registered[name].handler;
}
