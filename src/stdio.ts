import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeServer, createBridgeServices } from "./createBridgeServer.js";

const server = createBridgeServer(createBridgeServices());
const transport = new StdioServerTransport();

await server.connect(transport);
