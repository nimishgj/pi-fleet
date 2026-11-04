// A2A v1.0 over the JSON-RPC binding: the subset pi-fleet uses between agents.
// Spec: https://a2a-protocol.org/latest/specification/
//
// Each pi serves, on 127.0.0.1 only:
//   GET  /.well-known/agent-card.json   its agent card (public)
//   POST /a2a/v1                        JSON-RPC: SendMessage, GetTask, CancelTask, ListTasks
// JSON-RPC calls need `Authorization: Bearer <~/.pi/fleet/a2a-token>` and `A2A-Version: 1.0`.
//
// Safety approvals are deliberately NOT part of A2A: models can call A2A, and only a
// human may answer a safety prompt. Those stay on the Unix socket (see registry.ts).
//
// Erasable TypeScript only (Node type stripping): no enums, namespaces, parameter properties.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type AgentRecord, ensureDirs, FLEET_DIR } from "./registry.ts";

export const A2A_VERSION = "1.0";
export const AGENT_VERSION = "0.2.0";
export const TOKEN_FILE = join(FLEET_DIR, "a2a-token");
export const RPC_PATH = "/a2a/v1";
export const CARD_PATH = "/.well-known/agent-card.json";

// ── data model (spec §4.1) ─────────────────────────────────────────────────

export type TaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED";
export type Part = { text?: string; data?: unknown; url?: string; raw?: string; mediaType?: string; filename?: string; metadata?: Record<string, unknown> };
export type Message = {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
};
export type Artifact = { artifactId: string; name?: string; parts: Part[] };
export type Task = {
  id: string;
  contextId?: string;
  status: { state: TaskState; message?: Message; timestamp?: string };
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
};

export const TERMINAL = new Set<TaskState>(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"]);
export const INTERRUPTED = new Set<TaskState>(["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]);
export const isSettled = (s: TaskState) => TERMINAL.has(s) || INTERRUPTED.has(s);

/** Metadata keys pi-fleet puts on messages. */
export const META_KIND = "fleet.kind"; // "question" (answer and carry on) | "instruction" (do this)
export const META_FROM = "fleet.from"; // who is talking, e.g. "the master pi"
export const META_TIMEOUT = "fleet.timeoutMs";

export const now = () => new Date().toISOString();

export function textMessage(role: Message["role"], text: string, extra: Partial<Message> = {}): Message {
  return { messageId: randomUUID(), role, parts: [{ text }], ...extra };
}

/** The readable answer in a task: its artifacts, else its status message. */
export function taskText(t: Task): string {
  const fromParts = (ps: Part[] = []) => ps.map((p) => p.text ?? (p.data !== undefined ? JSON.stringify(p.data) : "")).filter(Boolean).join("\n");
  const art = (t.artifacts ?? []).map((a) => fromParts(a.parts)).filter(Boolean).join("\n\n");
  return art || fromParts(t.status.message?.parts) || "";
}

export const shortState = (s: TaskState) => s.replace("TASK_STATE_", "").toLowerCase().replace("_", "-");

// ── errors (spec §5.4, §9.5) ───────────────────────────────────────────────

export class RpcError extends Error {
  code: number;
  reason?: string;
  constructor(code: number, message: string, reason?: string) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}
export const E = {
  parse: () => new RpcError(-32700, "Invalid JSON"),
  invalidRequest: (m = "Invalid request") => new RpcError(-32600, m),
  methodNotFound: (m: string) => new RpcError(-32601, `Method not found: ${m}`),
  invalidParams: (m: string) => new RpcError(-32602, m),
  taskNotFound: (id: string) => new RpcError(-32001, `Task not found: ${id}`, "TASK_NOT_FOUND"),
  notCancelable: (id: string) => new RpcError(-32002, `Task ${id} is already finished`, "TASK_NOT_CANCELABLE"),
  pushNotSupported: () => new RpcError(-32003, "Push notifications are not supported", "PUSH_NOTIFICATION_NOT_SUPPORTED"),
  unsupported: (m: string) => new RpcError(-32004, m, "UNSUPPORTED_OPERATION"),
  contentType: (m: string) => new RpcError(-32005, m, "CONTENT_TYPE_NOT_SUPPORTED"),
  noExtendedCard: () => new RpcError(-32007, "No extended agent card", "EXTENDED_AGENT_CARD_NOT_CONFIGURED"),
  version: (v: string) => new RpcError(-32009, `A2A version ${v || "0.3 (no A2A-Version header)"} is not supported; use ${A2A_VERSION}`, "VERSION_NOT_SUPPORTED"),
};

// ── shared token ───────────────────────────────────────────────────────────

/** Per-machine bearer token, readable only by this account. Created on first use. */
export function token(): string {
  ensureDirs();
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = randomBytes(32).toString("hex");
  try {
    writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600, flag: "wx" });
    return t;
  } catch {
    return readFileSync(TOKEN_FILE, "utf8").trim(); // another process created it first
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── agent card (spec §4.4) ─────────────────────────────────────────────────

export function agentCard(rec: AgentRecord, rpcUrl: string): object {
  return {
    name: rec.id,
    description:
      `pi coding agent "${rec.id}" (${rec.role}) working in ${rec.repo}:${rec.branch} at ${rec.cwd} on ${rec.host}. ` +
      `Status: ${rec.status}${rec.statusMsg ? ` (${rec.statusMsg})` : ""}. Task: ${rec.task ?? "none yet"}.`,
    version: AGENT_VERSION,
    supportedInterfaces: [{ url: rpcUrl, protocolBinding: "JSONRPC", protocolVersion: A2A_VERSION }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "question",
        name: "Answer a question",
        description:
          `Ask ${rec.id} something. It answers after its current step and then carries on with its task. ` +
          `Set message metadata "${META_KIND}": "question".`,
        tags: ["status", "question", "coordination"],
        examples: ["What are you doing right now, what have you tried, and what is next?"],
      },
      {
        id: "instruction",
        name: "Take an instruction",
        description:
          `Give ${rec.id} work to do. It is delivered after the current step; the task completes when ${rec.id} finishes ` +
          `that run and holds its final reply. This is the default when "${META_KIND}" is not set.`,
        tags: ["instruction", "coding", "coordination"],
        examples: ["Also add a regression test for the flaky case."],
      },
    ],
    securitySchemes: {
      fleetToken: { httpAuthSecurityScheme: { scheme: "Bearer", description: `The token in ${TOKEN_FILE} on this machine.` } },
    },
    securityRequirements: [{ schemes: { fleetToken: { list: [] } } }],
  };
}

// ── server ─────────────────────────────────────────────────────────────────

export type A2AHandlers = {
  card: (rpcUrl: string) => object;
  sendMessage: (params: any) => Promise<{ task: Task } | { message: Message }>;
  getTask: (params: any) => Task;
  cancelTask: (params: any) => Task;
  listTasks: (params: any) => object;
};

export type A2AServer = { server: Server; url: string; cardUrl: string };

/** Listen on 127.0.0.1 at a free port. */
export function startA2AServer(h: A2AHandlers): Promise<A2AServer> {
  const secret = token();
  let rpcUrl = "";
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url || "/").split("?")[0];
    if (req.method === "GET" && path === CARD_PATH) return send(res, 200, h.card(rpcUrl), { "Cache-Control": "no-cache" });
    if (path !== RPC_PATH) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "use POST" }, { Allow: "POST" });

    const auth = String(req.headers.authorization || "");
    if (!sameSecret(auth, `Bearer ${secret}`)) return send(res, 401, { error: "missing or wrong bearer token" }, { "WWW-Authenticate": "Bearer" });

    let body: any;
    let id: any = null;
    try {
      const raw = await readBody(req, 1 << 20);
      try {
        body = JSON.parse(raw);
      } catch {
        throw E.parse();
      }
      if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") throw E.invalidRequest();
      id = body.id ?? null;
      const v = String(req.headers["a2a-version"] ?? "").trim();
      if (v !== A2A_VERSION) throw E.version(v);
      const result = await dispatch(body.method, body.params ?? {});
      send(res, 200, { jsonrpc: "2.0", id, result });
    } catch (e: any) {
      const err = e instanceof RpcError ? e : new RpcError(-32603, e?.message || String(e));
      const error: any = { code: err.code, message: err.message };
      if (err.reason) error.data = [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: err.reason, domain: "a2a-protocol.org", metadata: { timestamp: now() } }];
      send(res, 200, { jsonrpc: "2.0", id, error });
    }
  }

  async function dispatch(method: string, params: any): Promise<any> {
    switch (method) {
      case "SendMessage":
        return h.sendMessage(params);
      case "GetTask":
        return h.getTask(params);
      case "CancelTask":
        return h.cancelTask(params);
      case "ListTasks":
        return h.listTasks(params);
      case "SendStreamingMessage":
      case "SubscribeToTask":
        throw E.unsupported("Streaming is not supported; use SendMessage and GetTask");
      case "CreateTaskPushNotificationConfig":
      case "GetTaskPushNotificationConfig":
      case "ListTaskPushNotificationConfigs":
      case "DeleteTaskPushNotificationConfig":
        throw E.pushNotSupported();
      case "GetExtendedAgentCard":
        throw E.noExtendedCard();
      default:
        throw E.methodNotFound(method);
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as any;
      rpcUrl = `http://127.0.0.1:${port}${RPC_PATH}`;
      resolve({ server, url: rpcUrl, cardUrl: `http://127.0.0.1:${port}${CARD_PATH}` });
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers });
  res.end(data);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(E.invalidRequest("Request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── client ─────────────────────────────────────────────────────────────────

let rpcSeq = 0;

/** One JSON-RPC call. Uses node:http (not fetch) so a long blocking SendMessage isn't cut off at 5 minutes. */
export function rpc(url: string, method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcSeq, method, params });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "A2A-Version": A2A_VERSION,
          Authorization: `Bearer ${token()}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString("utf8");
          let out: any;
          try {
            out = JSON.parse(text);
          } catch {
            return reject(new Error(`A2A ${method}: HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          }
          if (res.statusCode !== 200) return reject(new Error(`A2A ${method}: HTTP ${res.statusCode}: ${out.error ?? text.slice(0, 200)}`));
          if (out.error) return reject(new RpcError(out.error.code, out.error.message));
          resolve(out.result);
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`A2A ${method} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end(body);
  });
}

function endpoint(a: AgentRecord): string {
  if (!a.a2a?.url) throw new Error(`${a.id} has no A2A endpoint yet (it is running an older pi-fleet; /reload it)`);
  return a.a2a.url;
}

/** Ask an agent a question and wait for its answer (blocking SendMessage). */
export async function askAgent(a: AgentRecord, question: string, opts: { from: string; timeoutMs?: number }): Promise<Task> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const message = textMessage("ROLE_USER", question, { metadata: { [META_KIND]: "question", [META_FROM]: opts.from, [META_TIMEOUT]: timeoutMs } });
  const r = await rpc(endpoint(a), "SendMessage", { message, configuration: { acceptedOutputModes: ["text/plain"] } }, timeoutMs + 15_000);
  return r.task ?? { id: "", status: { state: "TASK_STATE_COMPLETED", message: r.message } };
}

/** Give an agent an instruction without waiting (returnImmediately). Optionally continue a task waiting for input. */
export async function tellAgent(a: AgentRecord, text: string, opts: { from: string; taskId?: string }): Promise<Task> {
  const message = textMessage("ROLE_USER", text, { taskId: opts.taskId, metadata: { [META_KIND]: "instruction", [META_FROM]: opts.from } });
  const r = await rpc(endpoint(a), "SendMessage", { message, configuration: { returnImmediately: true, acceptedOutputModes: ["text/plain"] } });
  return r.task;
}

export function getTask(a: AgentRecord, id: string, historyLength?: number): Promise<Task> {
  return rpc(endpoint(a), "GetTask", historyLength === undefined ? { id } : { id, historyLength });
}

export function listTasks(a: AgentRecord, params: Record<string, unknown> = {}): Promise<{ tasks: Task[]; totalSize: number }> {
  return rpc(endpoint(a), "ListTasks", params);
}

export async function fetchCard(a: AgentRecord): Promise<any> {
  if (!a.a2a?.card) throw new Error(`${a.id} has no A2A endpoint yet`);
  const res = await fetch(a.a2a.card);
  if (!res.ok) throw new Error(`agent card: HTTP ${res.status}`);
  return res.json();
}
