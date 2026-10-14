export type ActionRiskClass = "read_only" | "reversible_write" | "external_impact" | "high_risk";

const TOOL_RISK = new Map<string, ActionRiskClass>([
  ["workspace.list", "read_only"],
  ["workspace.status", "read_only"],
  ["code.search", "read_only"],
  ["code.read", "read_only"],
  ["code.symbols", "read_only"],
  ["code.references", "read_only"],
  ["git.status", "read_only"],
  ["git.diff", "read_only"],

  ["code.patch", "reversible_write"],
  ["code.write", "reversible_write"],
  ["code.delete", "reversible_write"],
  ["code.rollback", "reversible_write"],
  ["git.commit", "reversible_write"],
  ["validation.run", "reversible_write"],

  ["git.push", "external_impact"],
  ["command.run", "high_risk"],
]);

export function classifyTool(tool: string): ActionRiskClass {
  return TOOL_RISK.get(tool) ?? "high_risk";
}
