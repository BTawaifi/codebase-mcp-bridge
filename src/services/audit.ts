import fs from "node:fs/promises";
import path from "node:path";

type AuditEvent = {
  client: string;
  tool: string;
  repo: string;
  status: "ok" | "error";
  durationMs: number;
  resultSize?: number;
  error?: string;
};

export class AuditService {
  private readonly logPath: string;
  private readonly enabled: boolean;
  private ready: Promise<void> | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(repoRoot: string) {
    this.logPath = path.join(repoRoot, ".ai-bridge", "audit.jsonl");
    this.enabled = process.env.BRIDGE_ENABLE_AUDIT === "true";
  }

  log(event: AuditEvent): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.ready ??= fs.mkdir(path.dirname(this.logPath), { recursive: true }).then(() => undefined);
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
    this.writeTail = this.writeTail.then(async () => {
      await this.ready;
      await fs.appendFile(this.logPath, line, "utf8");
    });
    return this.writeTail;
  }
}
