// pi-fleet extension. Loaded by every pi.
//  - registers this pi in ~/.pi/coms/projects/default/agents/<id>.json
//  - serves ~/.pi/coms/sockets/<id>.sock so the master can ask it things live
//  - reports state to Rex (OSC 7501) so tabs show working / needs-you / error
//  - when FLEET_ROLE=master: adds fleet_* tools and a live fleet widget
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { hostname } from "node:os";
import { basename } from "node:path";
import {
  type AgentRecord,
  type Status,
  ensureDirs,
  findAgent,
  listAgents,
  readTranscript,
  removeRecord,
  request,
  socketPath,
  uniqueId,
  writeRecord,
} from "../lib/registry.ts";
import { attach, spawn, toggleK9s } from "../lib/rex.ts";

const ASK_MARKER = "[fleet] Question from the master pi";
const SEND_MARKER = "[fleet] Message from the master pi";
// Identity lives in process memory, not env, so a pi started by one of this pi's
// tools (a subprocess) never inherits and steals this id.
const G = globalThis as any;
G.__fleet ??= { name: process.env.FLEET_NAME, role: process.env.FLEET_ROLE, id: undefined as string | undefined };
delete process.env.FLEET_NAME;
delete process.env.FLEET_ROLE;
const isMaster = G.__fleet.role === "master";
// The master spawns agents into the Rex session it runs in.
if (isMaster && !process.env.FLEET_SESSION && process.env.REX_SESSION) process.env.FLEET_SESSION = process.env.REX_SESSION;

type Pending = { text: string; delivered: boolean; prev?: { status: Status; msg?: string }; resolve: (v: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

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
  const state = { idle: "idle", working: "working", waiting: "blocked", error: "error", starting: "working" }[status];
  let body = `state=${state}:app=pi`;
  if (status === "waiting") body += ":kind=question";
  if (msg) {
    const clean = msg.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 200);
    body += `:msg=${Buffer.from(clean, "utf8").toString("base64")}`;
  }
  process.stdout.write(`\x1b]7501;${body}\x1b\\`);
}

export default function fleet(pi: ExtensionAPI) {
  let rec: AgentRecord | undefined;
  let server: Server | undefined;
  let widgetTimer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let pending: Pending[] = [];
  let ctxRef: ExtensionContext | undefined;

  const save = (patch: Partial<AgentRecord>) => {
    if (!rec) return;
    rec = { ...rec, ...patch, lastActivity: Date.now() };
    writeRecord(rec);
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

  function startServer() {
    if (!rec) return;
    const path = socketPath(rec.id);
    rmSync(path, { force: true });
    server = createServer((sock) => {
      let buf = "";
      sock.on("data", async (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = "";
        const reply = (o: any) => sock.end(JSON.stringify(o) + "\n");
        try {
          const req = JSON.parse(line);
          if (req.op === "info") return reply({ ok: true, result: rec });
          if (req.op === "ask") return reply({ ok: true, result: await askLive(String(req.question), req.timeoutMs) });
          if (req.op === "send") {
            deliver(`${SEND_MARKER}:\n\n${req.message}`);
            return reply({ ok: true, result: "delivered" });
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
    if (rec?.status === "working") pi.sendUserMessage(text, { deliverAs: "followUp" });
    else pi.sendUserMessage(text);
  }

  function askLive(question: string, timeoutMs = 10 * 60_000): Promise<string> {
    const text =
      `${ASK_MARKER} (it is tracking all running agents). Answer briefly, then carry on with your task:\n\n${question}\n\n` +
      `Cover: what you are doing right now, what you have tried, and what you will do next.`;
    return new Promise((resolve, reject) => {
      const p: Pending = {
        text,
        delivered: false,
        prev: rec ? { status: rec.status, msg: rec.statusMsg } : undefined,
        resolve,
        reject,
        timer: setTimeout(() => {
          pending = pending.filter((x) => x !== p);
          reject(new Error("no answer before timeout"));
        }, timeoutMs),
      };
      pending.push(p);
      deliver(text);
    });
  }

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
    // Re-assert the record so a pruned or clobbered file heals itself.
    heartbeat = setInterval(() => rec && writeRecord(rec), 15_000);
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
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("agent session ended"));
    }
    pending = [];
    if (rec && e.reason === "quit") {
      osc("idle");
      removeRecord(rec.id, process.pid);
    }
  });

  pi.on("before_agent_start", async (e) => {
    if (rec && !rec.task && e.prompt && !e.prompt.startsWith("[fleet]")) save({ task: e.prompt.slice(0, 200) });
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
    for (const p of pending) if (!p.delivered && t.includes(ASK_MARKER) && t === p.text) p.delivered = true;
  });
  pi.on("agent_settled", async (_e, ctx) => {
    const m = lastAssistant(ctx);
    const text = m ? textOf(m.content).trim() : "";
    // Answer any live questions that were delivered in this run.
    const answered = pending.filter((x) => x.delivered);
    for (const p of answered) {
      clearTimeout(p.timer);
      p.resolve(text || "(no text answer)");
    }
    pending = pending.filter((x) => !x.delivered);
    // A run that only answered the master should not change what the user sees.
    const prev = answered[0]?.prev;
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
        const color = (s: Status) => ({ working: "success", waiting: "warning", error: "error", idle: "dim", starting: "dim" } as const)[s];
        const lines = others.map((a) => {
          const g = th.fg(color(a.status), glyph(a.status));
          const where = a.host === hostname() ? "" : th.fg("accent", ` @${a.host}`);
          const what = a.status === "waiting" || a.status === "error" ? a.statusMsg ?? "" : a.lastTool ?? a.task ?? "";
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
    description: "List every running pi agent: id, status (working/waiting/idle/error), host, repo, branch, task, last tool call.",
    parameters: Type.Object({}),
    async execute() {
      const all = listAgents().filter((a) => a.id !== rec?.id);
      if (!all.length) return ok("No other agents are running.");
      const rows = all.map(
        (a) =>
          `- ${a.id} [${a.status}] host=${a.host} repo=${a.repo} branch=${a.branch} cwd=${a.cwd}\n  task: ${a.task ?? "-"}\n  last: ${a.lastTool ?? "-"}${a.statusMsg ? `\n  note: ${a.statusMsg}` : ""}`,
      );
      return ok(rows.join("\n"), { agents: all });
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
      const targets = p.id === "*" ? listAgents().filter((a) => a.id !== rec?.id) : [findAgent(p.id)].filter(Boolean) as AgentRecord[];
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
      const ms = (p.timeoutSec ?? 600) * 1000;
      const answer = await request(a.socket, { op: "ask", question: p.question, timeoutMs: ms }, ms + 5000);
      return ok(`${a.id} answered:\n${answer}`);
    },
  });

  pi.registerTool({
    name: "fleet_send",
    label: "Fleet send",
    description: "Send an instruction to a running agent (delivered after it finishes its current work). Does not wait for a reply.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_id, p) {
      const a = findAgent(p.id);
      if (!a) return ok(`No agent named ${p.id}.`);
      await request(a.socket, { op: "send", message: p.message });
      return ok(`Sent to ${a.id}.`);
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
    }),
    async execute(_id, p) {
      const r = spawn({ cwd: p.cwd, prompt: p.prompt, name: p.name, worktree: p.worktree, focus: false });
      return ok(`Started ${r.name} in ${r.cwd} (Rex tab "${r.name}" in session fleet).`, r);
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
      `- To start work, use fleet_spawn (use a worktree when another agent already works in that repo).\n` +
      `- To let the user talk to an agent, use fleet_attach.`,
  }));
}

function glyph(s: Status): string {
  return { working: "●", waiting: "◐", idle: "○", error: "✖", starting: "◌" }[s];
}
