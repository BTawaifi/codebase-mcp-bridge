import "dotenv/config";
import path from "node:path";
import { WorkspaceService } from "./services/workspaces.js";

const workspaces = new WorkspaceService();
const [action, value, option] = process.argv.slice(2);

switch (action) {
  case "list":
    console.log(await workspaces.listWorkspaces());
    break;
  case "trust": {
    if (!value) usage("workspace path is required");
    if (!path.isAbsolute(value)) usage("workspace path must be absolute");
    console.log(await workspaces.trustWorkspace({ path: value, id: option }));
    break;
  }
  case "untrust":
    if (!value) usage("workspace id is required");
    console.log(await workspaces.untrustWorkspace(value));
    break;
  default:
    usage();
}

function usage(error?: string): never {
  if (error) console.error(error);
  console.error("Usage:");
  console.error("  npm run workspace -- list");
  console.error("  npm run workspace -- trust <absolute-path> [workspace-id]");
  console.error("  npm run workspace -- untrust <workspace-id>");
  process.exit(1);
}
