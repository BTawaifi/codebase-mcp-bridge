export const COMMANDS = {
  "test:unit": "npm test",
  lint: "npm run lint",
  typecheck: "npm run typecheck",
  build: "npm run build",
  "script:ps-parse": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-powershell-syntax.ps1"
} as const;

export type CommandId = keyof typeof COMMANDS;
export const COMMAND_IDS = Object.keys(COMMANDS) as [CommandId, ...CommandId[]];
