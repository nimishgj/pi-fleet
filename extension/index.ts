// pi-fleet extension. Loaded by every pi.
//  - registers this pi in ~/.pi/coms/projects/default/agents/<id>.json
//  - serves A2A v1.0 on 127.0.0.1 (agent card + JSON-RPC) so other agents can ask it
//    things and give it work (lib/a2a.ts)
//  - serves ~/.pi/coms/sockets/<id>.sock for human-only safety approvals
//  - reports state to Rex (OSC 7501) so tabs show working / needs-you / error
//  - when FLEET_ROLE=master: adds fleet_* tools and a live fleet widget
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { hostname } from "node:os";
import { basename } from "node:path";
import {
  type AgentRecord,
  type Approval,
  type Status,
  ensureDirs,
  findAgent,
  listAgents,
  readTranscript,
  removeRecord,
  stoppedAgents,
  type GitPane,
  findSaved,
  saveAgent,
  socketPath,
  uniqueId,
  writeRecord,
} from "../lib/registry.ts";
import { attach, restore, spawn, toggleK9s } from "../lib/rex.ts";
import {
  type A2AServer,
  type Message,
  type Task,
  type TaskState,
  E,
  META_FROM,
  META_KIND,
  META_TIMEOUT,
  INTERRUPTED,
  TERMINAL,
  agentCard,
  askAgent,
  getTask,
  isSettled,
  now,
  shortState,
  startA2AServer,
  taskText,
  tellAgent,
  textMessage,
} from "../lib/a2a.ts";

const MASTER = "the master pi";
const LIVE_QUESTION_SUFFIX = "\n\nCover: what you are doing right now, what you have tried, and what you will do next.";
const MAX_TASKS = 200;
// Identity lives in process memory, not env, so a pi started by one of this pi's
// tools (a subprocess) never inherits and steals this id.
const G = globalThis as any;
G.__fleet ??= { name: process.env.FLEET_NAME, role: process.env.FLEET_ROLE, git: process.env.FLEET_GIT, id: undefined as string | undefined };
delete process.env.FLEET_NAME;
delete process.env.FLEET_ROLE;
delete process.env.FLEET_GIT;
// Only agents fleet started (or the master) are saved for restore; a pi you ran by hand is not.
const restorable = !!G.__fleet.name || G.__fleet.role === "master";
const isMaster = G.__fleet.role === "master";
// The master spawns agents into the Rex session it runs in.
if (isMaster && !process.env.FLEET_SESSION && process.env.REX_SESSION) process.env.FLEET_SESSION = process.env.REX_SESSION;

/** An A2A message delivered (or about to be) into this pi's conversation, waiting for the run that answers it. */
type Pending = {
  taskId: string;
  kind: "question" | "instruction";
  text: string; // exact prompt text, used to spot delivery in message_end
  delivered: boolean;
  prev?: { status: Status; msg?: string };
  timer: NodeJS.Timeout;
};

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

function osc(status: Status, msg?: string) {
  if (!process.env.REX_BLOCK || !process.stdout.isTTY) return;
  const state = { idle: "idle", working: "working", waiting: "blocked", approval: "blocked", error: "error", starting: "working" }[status];
  let body = `state=${state}:app=pi`;
  if (status === "waiting") body += ":kind=question";
  if (status === "approval") body += ":kind=permission";
  if (msg) {
    const clean = msg.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 200);
    body += `:msg=${Buffer.from(clean, "utf8").toString("base64")}`;
  }
  process.stdout.write(`\x1b]7501;${body}\x1b\\`);
}

export default function fleet(pi: ExtensionAPI) {
  let rec: AgentRecord | undefined;
  let server: Server | undefined; // approval socket
  let a2a: A2AServer | undefined;
  let widgetTimer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let pending: Pending[] = [];
  // A2A tasks this pi has been given, newest last.
  const tasks = new Map<string, Task>();
  const waiters = new Map<string, (() => void)[]>();
  let ctxRef: ExtensionContext | undefined;
  // safety-guard prompts waiting for a human, keyed by approval id
  const approvals = new Map<string, Approval & { decide: (allow: boolean) => void }>();
  const publicApprovals = (): Approval[] => [...approvals.values()].map(({ decide, ...a }) => a);

  const save = (patch: Partial<AgentRecord>) => {
    if (!rec) return;
    rec = { ...rec, ...patch, lastActivity: Date.now() };
    writeRecord(rec);
  };
  /** Remember this agent so `fleet restore` / home can bring it back after a restart. */
  const persist = () => {
    if (!rec || !restorable) return;
    const prev = findSaved(rec.id);
    const git = (G.__fleet.git as GitPane | undefined) ?? (prev?.id === rec.id ? prev.git : undefined) ?? (rec.role === "master" ? "none" : "lazygit");
    try {
      saveAgent({ id: rec.id, role: rec.role, cwd: rec.cwd, repo: rec.repo, branch: rec.branch, sessionFile: rec.sessionFile, git, task: rec.task, lastStatus: rec.status, lastSeen: Date.now() });
    } catch {
      /* never break the session over this */
    }
  };
  const setStatus = (status: Status, msg?: string) => {
    if (!rec) return;
    const changed = rec.status !== status || rec.statusMsg !== msg;
    save({ status, statusMsg: msg });
    if (changed) osc(status, msg);
  };

  function lastAssistant(ctx: ExtensionContext): any {
    const branch = ctx.sessionManager.getBranch() as any[];
    for (let i = branch.length - 1; i >= 0; i--) {
      const m = branch[i]?.message;
      if (branch[i]?.type === "message" && m?.role === "assistant") return m;
    }
    return undefined;
  }

  // ── approval socket (human-only; never exposed over A2A) ───────────────
  function startServer() {
    if (!rec) return;
    const path = socketPath(rec.id);
    rmSync(path, { force: true });
    server = createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = "";
        const reply = (o: any) => sock.end(JSON.stringify(o) + "\n");
        try {
          const req = JSON.parse(line);
          if (req.op === "info") return reply({ ok: true, result: rec });
          if (req.op === "approve") {
            // Human decision from the fleet home screen or `fleet approve`.
            const a = req.approvalId ? approvals.get(req.approvalId) : [...approvals.values()][0];
            if (!a) return reply({ ok: false, error: "nothing waiting for approval" });
            a.decide(req.allow === true);
            return reply({ ok: true, result: { id: a.id, allow: req.allow === true, command: a.command ?? a.action } });
          }
          reply({ ok: false, error: `unknown op ${req.op}` });
        } catch (e: any) {
          reply({ ok: false, error: e?.message || String(e) });
        }
      });
      sock.on("error", () => {});
    });
    server.listen(path);
  }

  function deliver(text: string) {
    if (rec?.status === "working" || rec?.status === "approval") pi.sendUserMessage(text, { deliverAs: "followUp" });
    else pi.sendUserMessage(text);
  }

  // ── A2A tasks ──────────────────────────────────────────────────────────
  function setTaskState(t: Task, state: TaskState, message?: Message) {
    t.status = { state, message, timestamp: now() };
    if (isSettled(state)) {
      const ws = waiters.get(t.id) ?? [];
      waiters.delete(t.id);
      for (const w of ws) w();
    }
  }

  function waitSettled(t: Task): Promise<void> {
    if (isSettled(t.status.state)) return Promise.resolve();
    return new Promise((resolve) => waiters.set(t.id, [...(waiters.get(t.id) ?? []), resolve]));
  }

  /** A copy for the wire, trimmed to historyLength (unset = all, 0 = none). */
  function view(t: Task, historyLength?: unknown, includeArtifacts = true): Task {
    const out: Task = { ...t, status: { ...t.status } };
    if (typeof historyLength === "number") out.history = historyLength <= 0 ? undefined : (t.history ?? []).slice(-historyLength);
    if (!includeArtifacts) delete out.artifacts;
    if (!out.history?.length) delete out.history;
    return out;
  }

  function remember(t: Task) {
    tasks.set(t.id, t);
    while (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value!);
  }

  async function a2aSendMessage(params: any) {
    const msg = params?.message;
    if (!msg || typeof msg.messageId !== "string" || !Array.isArray(msg.parts) || !msg.parts.length) throw E.invalidParams("message needs messageId and parts");
    if (msg.role && msg.role !== "ROLE_USER") throw E.invalidParams("message role must be ROLE_USER");
    const body = msg.parts
      .map((p: any) => (typeof p?.text === "string" ? p.text : p?.data !== undefined ? JSON.stringify(p.data, null, 2) : ""))
      .filter(Boolean)
      .join("\n");
    if (!body) throw E.contentType("Only text and data parts are supported");
    const meta = msg.metadata ?? {};

    let t: Task | undefined;
    if (msg.taskId) {
      t = tasks.get(msg.taskId);
      if (!t) throw E.taskNotFound(msg.taskId);
      if (msg.contextId && msg.contextId !== t.contextId) throw E.invalidParams("contextId does not match the task");
      if (!INTERRUPTED.has(t.status.state)) throw E.unsupported(`Task ${t.id} is ${shortState(t.status.state)}, not waiting for input`);
    } else {
      t = { id: randomUUID(), contextId: msg.contextId || randomUUID(), status: { state: "TASK_STATE_SUBMITTED", timestamp: now() }, history: [], metadata: {} };
      remember(t);
    }
    const kind: Pending["kind"] = (meta[META_KIND] ?? t.metadata?.[META_KIND]) === "question" ? "question" : "instruction";
    const from = String(meta[META_FROM] ?? t.metadata?.[META_FROM] ?? "another agent").slice(0, 80);
    t.metadata = { ...t.metadata, [META_KIND]: kind, [META_FROM]: from };
    t.history!.push({ ...msg, role: "ROLE_USER", taskId: t.id, contextId: t.contextId });

    const text =
      kind === "question"
        ? `[fleet] Question from ${from} (A2A task ${t.id.slice(0, 8)}). Answer briefly, then carry on with your task:\n\n${body}`
        : `[fleet] Message from ${from} (A2A task ${t.id.slice(0, 8)}):\n\n${body}`;
    const timeoutMs = Math.max(5_000, Math.min(Number(meta[META_TIMEOUT]) || 30 * 60_000, 2 * 60 * 60_000));
    const p: Pending = {
      taskId: t.id,
      kind,
      text,
      delivered: false,
      prev: rec ? { status: rec.status, msg: rec.statusMsg } : undefined,
      timer: setTimeout(() => {
        pending = pending.filter((x) => x !== p);
        const task = tasks.get(p.taskId);
        if (task && !TERMINAL.has(task.status.state)) setTaskState(task, "TASK_STATE_FAILED", textMessage("ROLE_AGENT", "No answer before the timeout."));
      }, timeoutMs),
    };
    pending.push(p);
    setTaskState(t, "TASK_STATE_WORKING");
    deliver(text);

    const hl = params?.configuration?.historyLength;
    if (params?.configuration?.returnImmediately === true) return { task: view(t, hl) };
    await waitSettled(t);
    return { task: view(t, hl) };
  }

  function a2aGetTask(params: any): Task {
    const t = tasks.get(String(params?.id ?? ""));
    if (!t) throw E.taskNotFound(String(params?.id ?? ""));
    return view(t, params?.historyLength);
  }

  function a2aCancelTask(params: any): Task {
    const t = tasks.get(String(params?.id ?? ""));
    if (!t) throw E.taskNotFound(String(params?.id ?? ""));
    if (TERMINAL.has(t.status.state)) throw E.notCancelable(t.id);
    for (const p of pending.filter((x) => x.taskId === t.id)) clearTimeout(p.timer);
    pending = pending.filter((x) => x.taskId !== t.id);
    // A message already in the conversation can't be taken back; the agent may still act on it.
    setTaskState(t, "TASK_STATE_CANCELED", textMessage("ROLE_AGENT", "Canceled by the caller."));
    return view(t);
  }

  function a2aListTasks(params: any) {
    let all = [...tasks.values()];
    if (params?.contextId) all = all.filter((t) => t.contextId === params.contextId);
    if (params?.status) all = all.filter((t) => t.status.state === params.status);
    if (params?.statusTimestampAfter) all = all.filter((t) => (t.status.timestamp ?? "") > String(params.statusTimestampAfter));
    all.sort((a, b) => (b.status.timestamp ?? "").localeCompare(a.status.timestamp ?? ""));
    const pageSize = Math.max(1, Math.min(Number(params?.pageSize) || 50, 100));
    const offset = Math.max(0, Number(params?.pageToken) || 0);
    const page = all.slice(offset, offset + pageSize).map((t) => view(t, params?.historyLength, params?.includeArtifacts === true));
    return { tasks: page, nextPageToken: offset + pageSize < all.length ? String(offset + pageSize) : "", pageSize, totalSize: all.length };
  }

  /** The run that saw a delivered A2A message has settled: its last reply answers the task. */
  function finishTask(p: Pending, reply: string, stopReason?: string) {
    clearTimeout(p.timer);
    const t = tasks.get(p.taskId);
    if (!t || TERMINAL.has(t.status.state)) return;
    const answer = textMessage("ROLE_AGENT", reply || "(no text answer)", { taskId: t.id, contextId: t.contextId });
    t.history!.push(answer);
    if (stopReason === "error" || stopReason === "aborted") {
      return setTaskState(t, "TASK_STATE_FAILED", answer);
    }
    t.artifacts = [{ artifactId: randomUUID(), name: "reply", parts: [{ text: reply || "(no text answer)" }] }];
    // A reply that ends in a question needs the caller's input; continue with SendMessage + taskId.
    setTaskState(t, /\?\s*$/.test(reply) ? "TASK_STATE_INPUT_REQUIRED" : "TASK_STATE_COMPLETED", answer);
  }

  // ── safety-guard approvals ─────────────────────────────────────────────
  pi.events.on("fleet:approval_request", (req: any) => {
    if (!req?.id || typeof req.decide !== "function") return;
    approvals.set(req.id, {
      id: String(req.id),
      action: String(req.action ?? "action"),
      command: req.command ? String(req.command) : undefined,
      reason: req.reason ? String(req.reason) : undefined,
      severity: String(req.severity ?? "risky"),
      since: Date.now(),
      decide: req.decide,
    });
    save({ approvals: publicApprovals() });
    setStatus("approval", `approve? ${req.command ?? req.action}`.slice(0, 160));
  });
  pi.events.on("fleet:approval_done", (e: any) => {
    if (!approvals.delete(e?.id)) return;
    save({ approvals: publicApprovals() });
    const next = [...approvals.values()][0];
    if (next) setStatus("approval", `approve? ${next.command ?? next.action}`.slice(0, 160));
    else setStatus("working", rec?.lastTool);
  });

  // ── lifecycle ──────────────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    ctxRef = ctx;
    ensureDirs();
    // Keep one id for the whole process, across /new, /resume and reloads.
    const id: string = G.__fleet.id || uniqueId(G.__fleet.name || basename(ctx.cwd));
    G.__fleet.id = id;
    const top = git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
    const firstUser = (ctx.sessionManager.getBranch() as any[]).find((e) => e.type === "message" && e.message?.role === "user");
    rec = {
      id,
      role: isMaster ? "master" : "worker",
      pid: process.pid,
      host: hostname(),
      cwd: ctx.cwd,
      repo: top ? basename(top) : basename(ctx.cwd),
      branch: git(ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      socket: socketPath(id),
      rex: { server: process.env.REX_SERVER, session: process.env.REX_SESSION, block: process.env.REX_BLOCK },
      status: "idle",
      task: firstUser ? textOf(firstUser.message.content).slice(0, 200) : undefined,
      lastActivity: Date.now(),
      startedAt: Date.now(),
    };
    writeRecord(rec);
    startServer();
    try {
      a2a = await startA2AServer({
        card: (url) => agentCard(rec!, url),
        sendMessage: a2aSendMessage,
        getTask: a2aGetTask,
        cancelTask: a2aCancelTask,
        listTasks: a2aListTasks,
      });
      save({ a2a: { url: a2a.url, card: a2a.cardUrl } });
    } catch (e: any) {
      if (ctx.hasUI) ctx.ui.notify(`fleet: A2A server did not start: ${e?.message || e}`, "error");
    }
    persist();
    // Re-assert the record so a pruned or clobbered file heals itself.
    heartbeat = setInterval(() => {
      if (!rec) return;
      writeRecord(rec);
      persist();
    }, 15_000);
    osc("idle");
    if (ctx.hasUI) ctx.ui.setStatus("fleet", `fleet: ${id}`);
    if (isMaster && ctx.hasUI) startWidget(ctx);
  });

  pi.on("session_shutdown", async (e) => {
    if (widgetTimer) clearInterval(widgetTimer);
    if (heartbeat) clearInterval(heartbeat);
    widgetTimer = heartbeat = undefined;
    server?.close();
    server = undefined;
    a2a?.server.close();
    a2a?.server.closeAllConnections?.();
    a2a = undefined;
    for (const p of pending) {
      clearTimeout(p.timer);
      const t = tasks.get(p.taskId);
      if (t && !TERMINAL.has(t.status.state)) setTaskState(t, "TASK_STATE_FAILED", textMessage("ROLE_AGENT", "The agent's session ended."));
    }
    pending = [];
    if (rec && e.reason === "quit") {
      osc("idle");
      removeRecord(rec.id, process.pid);
    }
  });

  pi.on("before_agent_start", async (e) => {
    if (rec && !rec.task && e.prompt && !e.prompt.startsWith("[fleet]")) {
      save({ task: e.prompt.slice(0, 200) });
      persist();
    }
  });
  pi.on("agent_start", async () => setStatus("working", rec?.task?.slice(0, 80)));
  pi.on("tool_execution_start", async (e) => {
    const a: any = e.args ?? {};
    const detail = a.command ?? a.path ?? a.file_path ?? a.pattern ?? "";
    const lastTool = `${e.toolName} ${String(detail).replace(/\s+/g, " ").slice(0, 120)}`.trim();
    save({ lastTool });
    osc("working", lastTool);
  });
  pi.on("message_end", async (e) => {
    const m: any = e.message;
    if (m?.role !== "user") return;
    const t = textOf(m.content);
    for (const p of pending) if (!p.delivered && t === p.text) p.delivered = true;
  });
  pi.on("agent_settled", async (_e, ctx) => {
    const m = lastAssistant(ctx);
    const text = m ? textOf(m.content).trim() : "";
    // Answer the A2A tasks whose messages were delivered in this run.
    const answered = pending.filter((x) => x.delivered);
    for (const p of answered) finishTask(p, text, m?.stopReason);
    pending = pending.filter((x) => !x.delivered);
    // A run that only answered a question should not change what the user sees.
    const prev = answered.length && answered.every((p) => p.kind === "question") ? answered[0].prev : undefined;
    if (prev && prev.status !== "working") return setStatus(prev.status, prev.msg);
    if (m?.stopReason === "error") setStatus("error", (m.errorMessage || "error").slice(0, 120));
    else if (m?.stopReason === "aborted") setStatus("idle", "interrupted");
    else if (/\?\s*$/.test(text)) setStatus("waiting", text.split("\n").filter(Boolean).pop()?.slice(0, 160));
    else setStatus("idle", text.split("\n").filter(Boolean).pop()?.slice(0, 160));
  });

  // ── /fleet command (every pi) ──────────────────────────────────────────
  pi.registerCommand("fleet", {
    description: "fleet: list agents · attach <id> · k9s [context]",
    handler: async (args, ctx) => {
      const [sub, ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
      try {
        if (sub === "attach" && rest[0]) return ctx.ui.notify(`attached to ${attach(rest[0])}`, "info");
        if (sub === "k9s") {
          const s = process.env.REX_SESSION, b = process.env.REX_BLOCK;
          if (!s || !b) return ctx.ui.notify("not running inside Rex", "error");
          return ctx.ui.notify(`k9s ${toggleK9s(s, b, rest[0])}`, "info");
        }
        const lines = listAgents().map((a) => `${glyph(a.status)} ${a.id.padEnd(14)} ${a.status.padEnd(8)} ${a.repo}:${a.branch}  ${a.lastTool ?? ""}`);
        ctx.ui.notify(lines.join("\n") || "no agents", "info");
      } catch (e: any) {
        ctx.ui.notify(e?.message || String(e), "error");
      }
    },
  });

  if (!isMaster) return;

  // ── master only: widget ────────────────────────────────────────────────
  function startWidget(ctx: ExtensionContext) {
    const draw = () => {
      try {
        const others = listAgents().filter((a) => a.id !== rec?.id);
        const th = ctx.ui.theme;
        const color = (s: Status) => ({ working: "success", waiting: "warning", approval: "warning", error: "error", idle: "dim", starting: "dim" } as const)[s];
        const lines = others.map((a) => {
          const g = th.fg(color(a.status), glyph(a.status));
          const where = a.host === hostname() ? "" : th.fg("accent", ` @${a.host}`);
          const what = a.status === "waiting" || a.status === "error" || a.status === "approval" ? a.statusMsg ?? "" : a.lastTool ?? a.task ?? "";
          return `${g} ${a.id.padEnd(14)}${where} ${th.fg("dim", what.slice(0, 70))}`;
        });
        ctx.ui.setWidget("fleet", lines.length ? [th.fg("accent", "fleet"), ...lines] : [th.fg("dim", "fleet: no other agents running")]);
      } catch {
        /* never let the widget crash the session */
      }
    };
    draw();
    widgetTimer = setInterval(draw, 3000);
  }

  // ── master only: tools ─────────────────────────────────────────────────
  const ok = (text: string, details: any = {}) => ({ content: [{ type: "text" as const, text }], details });

  pi.registerTool({
    name: "fleet_list",
    label: "Fleet list",
    description:
      "List every running pi agent (id, status, host, repo, branch, task, last tool call), plus stopped agents that can be restored " +
      "(e.g. after Rex or the Mac restarted).",
    parameters: Type.Object({}),
    async execute() {
      const running = listAgents();
      const all = running.filter((a) => a.id !== rec?.id);
      const stopped = stoppedAgents(running);
      const stoppedText = stopped.length
        ? `\n\nStopped (restorable with fleet_restore; fleet_read still works on them):\n` +
          stopped.map((s) => `- ${s.id} [stopped, was ${s.lastStatus ?? "?"}] repo=${s.repo} branch=${s.branch} cwd=${s.cwd} last seen ${new Date(s.lastSeen).toLocaleString()}\n  task: ${s.task ?? "-"}`).join("\n")
        : "";
      if (!all.length) return ok(`No other agents are running.${stoppedText}`, { agents: [], stopped });
      const rows = all.map(
        (a) =>
          `- ${a.id} [${a.status}] host=${a.host} repo=${a.repo} branch=${a.branch} cwd=${a.cwd}\n  task: ${a.task ?? "-"}\n  last: ${a.lastTool ?? "-"}${a.statusMsg ? `\n  note: ${a.statusMsg}` : ""}${(a.approvals ?? []).map((p) => `\n  WAITING FOR HUMAN APPROVAL: ${p.command ?? p.action} (${p.severity}${p.reason ? `: ${p.reason}` : ""})`).join("")}`,
      );
      return ok(rows.join("\n") + stoppedText, { agents: all, stopped });
    },
  });

  pi.registerTool({
    name: "fleet_read",
    label: "Fleet read",
    description:
      "Read the recent conversation of an agent from its session file WITHOUT interrupting it. Default way to find out what an agent is doing, has tried, and plans next. Pass id='*' to read all agents.",
    parameters: Type.Object({
      id: Type.String({ description: "agent id, or * for all" }),
      limit: Type.Optional(Type.Number({ description: "messages per agent (default 40)" })),
    }),
    async execute(_id, p) {
      // Running agents, then stopped ones (their conversations are still on disk).
      type T = { id: string; status: string; repo: string; branch: string; host: string; sessionFile?: string };
      const running: T[] = listAgents().filter((a) => a.id !== rec?.id);
      const stopped: T[] = stoppedAgents().filter((s) => s.id !== rec?.id).map((s) => ({ ...s, status: "stopped", host: hostname() }));
      const targets =
        p.id === "*" ? running : [running.find((a) => a.id === p.id) ?? stopped.find((a) => a.id === p.id) ?? running.find((a) => a.id.startsWith(p.id)) ?? stopped.find((a) => a.id.startsWith(p.id))].filter(Boolean) as T[];
      if (!targets.length) return ok(`No agent matches ${p.id}.`);
      const out = targets.map(
        (a) => `=== ${a.id} [${a.status}] ${a.repo}:${a.branch} (${a.host}) ===\n${readTranscript(a.sessionFile ?? "", p.limit ?? 40)}`,
      );
      return ok(out.join("\n\n"));
    },
  });

  pi.registerTool({
    name: "fleet_ask",
    label: "Fleet ask (live)",
    description:
      "Ask a running agent a question LIVE. The question is added to its conversation after its current step and you get its reply. Only use when the user explicitly asks to check live / ask the agent directly; otherwise use fleet_read.",
    parameters: Type.Object({
      id: Type.String(),
      question: Type.String(),
      timeoutSec: Type.Optional(Type.Number({ description: "default 600" })),
    }),
    async execute(_id, p, signal) {
      const a = findAgent(p.id);
      if (!a) return ok(`No agent named ${p.id}.`);
      const t = await askAgent(a, p.question + LIVE_QUESTION_SUFFIX, { from: MASTER, timeoutMs: (p.timeoutSec ?? 600) * 1000 });
      const state = shortState(t.status.state);
      const head = state === "completed" ? `${a.id} answered` : state === "input-required" ? `${a.id} answered and asks you back (task ${t.id})` : `${a.id}: task ${state}`;
      return ok(`${head}:\n${taskText(t)}`, { task: t });
    },
  });

  pi.registerTool({
    name: "fleet_send",
    label: "Fleet send",
    description:
      "Send an instruction to a running agent (delivered after its current step). Does not wait: returns an A2A task id; " +
      "check the outcome later with fleet_task. Pass taskId to answer an agent whose task is input-required.",
    parameters: Type.Object({
      id: Type.String(),
      message: Type.String(),
      taskId: Type.Optional(Type.String({ description: "continue this input-required task instead of starting a new one" })),
    }),
    async execute(_id, p) {
      const a = findAgent(p.id);
      if (!a) return ok(`No agent named ${p.id}.`);
      const t = await tellAgent(a, p.message, { from: MASTER, taskId: p.taskId });
      return ok(`Sent to ${a.id} (task ${t.id}, ${shortState(t.status.state)}).`, { task: t });
    },
  });

  pi.registerTool({
    name: "fleet_task",
    label: "Fleet task",
    description: "Check an A2A task you gave an agent with fleet_send or fleet_ask: its state (working, completed, input-required, failed, canceled) and the agent's reply.",
    parameters: Type.Object({ id: Type.String({ description: "agent id" }), taskId: Type.String() }),
    async execute(_id, p) {
      const a = findAgent(p.id);
      if (!a) return ok(`No agent named ${p.id}.`);
      const t = await getTask(a, p.taskId, 0);
      const reply = taskText(t);
      return ok(`${a.id} task ${t.id}: ${shortState(t.status.state)}${reply ? `\n${reply}` : ""}`, { task: t });
    },
  });

  pi.registerTool({
    name: "fleet_spawn",
    label: "Fleet spawn",
    description:
      "Start a new pi agent in its own Rex tab with lazygit beside it. Optionally create a git worktree on a branch so it does not collide with other agents in the same repo.",
    parameters: Type.Object({
      cwd: Type.String({ description: "repo or directory to work in" }),
      prompt: Type.String({ description: "task for the new agent" }),
      name: Type.Optional(Type.String({ description: "short id, e.g. flaky-test" })),
      worktree: Type.Optional(Type.String({ description: "branch name; creates a sibling worktree" })),
      kb: Type.Optional(
        Type.Array(Type.String(), {
          description: "knowledge entry ids to attach to the starting prompt (find them with kb_search); the agent gets their exact text",
        }),
      ),
    }),
    async execute(_id, p) {
      const r = spawn({ cwd: p.cwd, prompt: p.prompt, name: p.name, worktree: p.worktree, kb: p.kb, focus: false });
      return ok(`Started ${r.name} in ${r.cwd} (Rex tab "${r.name}" in session fleet)${p.kb?.length ? ` with knowledge: ${p.kb.join(", ")}` : ""}.`, r);
    },
  });

  pi.registerTool({
    name: "fleet_restore",
    label: "Fleet restore",
    description:
      "Bring back a stopped agent (listed under Stopped by fleet_list): reopens its Rex tab in the same directory with its git pane, " +
      "and pi resumes its previous conversation. Only restore agents the user asks for.",
    parameters: Type.Object({ id: Type.String({ description: "stopped agent id" }) }),
    async execute(_id, p) {
      const r = restore(p.id, { focus: false });
      return ok(`Restored ${r.name}${r.resumed ? " with its previous conversation" : " (its conversation file was missing, so it starts fresh)"}.`);
    },
  });

  pi.registerTool({
    name: "fleet_attach",
    label: "Fleet attach",
    description: "Switch the user's Rex view to an agent's tab so they can talk to it directly.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p) {
      return ok(`Switched to ${attach(p.id)}.`);
    },
  });

  pi.on("before_agent_start", async (e) => ({
    systemPrompt:
      e.systemPrompt +
      `\n\n# Fleet master\nYou are the master pi. You coordinate other pi agents running in Rex tabs.\n` +
      `- "What is everyone doing?" → fleet_list, then fleet_read id='*', and report per agent: doing now / tried / next. Lead with agents that need the user (waiting, error).\n` +
      `- Only use fleet_ask when the user asks to check live or ask the agent directly.\n` +
      `- fleet_ask and fleet_send talk to agents over A2A. fleet_send returns a task id; use fleet_task to see how it went. An input-required task means the agent asked something back: answer with fleet_send and that taskId.\n` +
      `- To start work, use fleet_spawn (use a worktree when another agent already works in that repo). If the kb_search tool exists, search the knowledge base for the task first and pass the relevant entry ids as kb; the new agent will not be asked to pick knowledge itself.\n` +
      `- To let the user talk to an agent, use fleet_attach.\n` +
      `- After a restart, agents show as stopped in fleet_list. You can still fleet_read them. Restore one with fleet_restore only when the user asks.\n` +
      `- Safety approvals (status "approval") can only be answered by the human: tell them to press y/n on that agent in the fleet home tab, or run \`fleet approve <id>\` / \`fleet deny <id>\`. You have no way to approve, and must never try to work around a safety-guard prompt.`,
  }));
}

function glyph(s: Status): string {
  return { working: "●", waiting: "◐", approval: "⚠", idle: "○", error: "✖", starting: "◌" }[s];
}
