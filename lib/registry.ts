// Shared between the pi extension (loaded by jiti) and the `fleet` CLI (run by
// Node's built-in type stripping). Keep to erasable TypeScript only: no enums,
// namespaces, or constructor parameter properties.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const COMS = process.env.FLEET_COMS_DIR || join(homedir(), ".pi", "coms");
export const PROJECT = process.env.FLEET_PROJECT || "default";
export const AGENTS_DIR = join(COMS, "projects", PROJECT, "agents");
export const SOCKETS_DIR = join(COMS, "sockets");
export const FLEET_DIR = join(homedir(), ".pi", "fleet");
export const TODO_FILE = join(FLEET_DIR, "todo.md");

export type Status = "idle" | "working" | "waiting" | "error" | "starting";

export type AgentRecord = {
  id: string;
  role: "master" | "worker";
  pid: number;
  host: string;
  cwd: string;
  repo: string;
  branch: string;
  sessionFile?: string;
  socket: string;
  rex?: { server?: string; session?: string; block?: string };
  status: Status;
  statusMsg?: string;
  task?: string; // first user prompt, trimmed
  lastTool?: string;
  lastActivity: number;
  startedAt: number;
};

export function ensureDirs(): void {
  for (const d of [AGENTS_DIR, SOCKETS_DIR, FLEET_DIR]) mkdirSync(d, { recursive: true });
}

export function recordPath(id: string): string {
  return join(AGENTS_DIR, `${id}.json`);
}

export function socketPath(id: string): string {
  return join(SOCKETS_DIR, `${id}.sock`);
}

export function writeRecord(rec: AgentRecord): void {
  ensureDirs();
  const p = recordPath(rec.id);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2));
  renameSync(tmp, p);
}

/** Remove a record. With `ownerPid`, only if the record still belongs to that process. */
export function removeRecord(id: string, ownerPid?: number): void {
  if (ownerPid !== undefined) {
    try {
      const cur = JSON.parse(readFileSync(recordPath(id), "utf8"));
      if (cur.pid !== ownerPid) return; // a newer process took this id
    } catch {
      return;
    }
  }
  rmSync(recordPath(id), { force: true });
  rmSync(socketPath(id), { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** All registered agents on this machine. Records of dead processes are pruned. */
export function listAgents(): AgentRecord[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const out: AgentRecord[] = [];
  for (const f of readdirSync(AGENTS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(AGENTS_DIR, f), "utf8")) as AgentRecord;
      if (rec.host === hostname() && !alive(rec.pid)) {
        removeRecord(rec.id);
        continue;
      }
      out.push(rec);
    } catch {
      /* half-written or foreign file; skip */
    }
  }
  const order = (r: AgentRecord) => (r.role === "master" ? 0 : 1);
  return out.sort((a, b) => order(a) - order(b) || a.startedAt - b.startedAt);
}

export function findAgent(id: string): AgentRecord | undefined {
  const all = listAgents();
  return all.find((a) => a.id === id) ?? all.find((a) => a.id.startsWith(id));
}

/** Pick an unused id based on a preferred name. */
export function uniqueId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "pi";
  const taken = new Set(listAgents().map((a) => a.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

// ── socket protocol: one JSON request line, one JSON response line ─────────

export type Request =
  | { op: "info" }
  | { op: "ask"; question: string; timeoutMs?: number }
  | { op: "send"; message: string };

export function request(sock: string, req: Request, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    let buf = "";
    const t = setTimeout(() => {
      c.destroy();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(t);
        c.end();
        try {
          const res = JSON.parse(buf.slice(0, nl));
          res.ok ? resolve(res.result) : reject(new Error(res.error || "request failed"));
        } catch (e) {
          reject(e);
        }
      }
    });
    c.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

// ── transcripts: read a pi session file without touching the agent ─────────

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => {
      if (c.type === "text") return c.text;
      if (c.type === "toolCall") return `[tool ${c.name}] ${summarizeArgs(c.arguments)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeArgs(args: any): string {
  if (!args) return "";
  const v = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query;
  const s = typeof v === "string" ? v : JSON.stringify(args);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * Compact plain-text transcript of the last `limit` messages of the active branch.
 * Follows parentId links from the last entry so abandoned branches are skipped.
 */
export function readTranscript(sessionFile: string, limit = 40): string {
  if (!sessionFile || !existsSync(sessionFile)) return "(no session file yet)";
  const entries: any[] = [];
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* partial trailing line while the agent is writing */
    }
  }
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const branch: any[] = [];
  let cur = [...entries].reverse().find((e) => e.id && e.type !== "session");
  while (cur) {
    branch.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  branch.reverse();
  const lines: string[] = [];
  for (const e of branch) {
    if (e.type === "compaction" && e.summary) lines.push(`[earlier work, summarized]\n${clip(e.summary, 2000)}`);
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "user") lines.push(`USER: ${clip(textOf(m.content), 1500)}`);
    else if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t) lines.push(`AGENT: ${clip(t, 1500)}`);
      if (m.stopReason === "error" && m.errorMessage) lines.push(`AGENT ERROR: ${clip(m.errorMessage, 300)}`);
    } else if (m.role === "toolResult") {
      lines.push(`  ${m.isError ? "✖" : "↳"} ${m.toolName}: ${clip(textOf(m.content).replace(/\s+/g, " "), 240)}`);
    } else if (m.role === "bashExecution") {
      lines.push(`USER RAN: ${m.command} (exit ${m.exitCode})`);
    }
  }
  return lines.slice(-limit).join("\n");
}
