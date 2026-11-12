#!/usr/bin/env node
// fleet — manage pi agents in Rex.
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { type AgentRecord, findAgent, findSaved, forgetAgent, listAgents, readTranscript, request, stoppedAgents } from "../lib/registry.ts";
import { askAgent, fetchCard, getTask, listTasks, shortState, taskText, tellAgent } from "../lib/a2a.ts";
import { attach, restore, spawn, toggleK9s, up } from "../lib/rex.ts";
import { runHome } from "../lib/home.ts";

const USAGE = `fleet — pi agents in Rex

  fleet up                          create/show the "fleet" session (home + master tabs)
  fleet home                        the home screen (todos + agents); runs in the home tab
  fleet spawn [opts] [-- prompt]    start a pi in a new tab with lazygit beside it
      -c, --cwd DIR                 directory (default: current)
      -n, --name NAME               agent id / tab name
      --diff | --no-git             live git diff instead of lazygit, or no git pane
      --kb ID[,ID…]                 attach pi-knowledge entries to the starting prompt
      -s, --session LABEL           open it in Rex session LABEL (created if missing) instead of the fleet session
  fleet ls [--json]                 list running agents, then stopped ones that can be restored
  fleet restore ID... | --all       bring back stopped agents (same tab, dir, git pane; pi resumes its conversation)
  fleet forget ID...                remove stopped agents from the restore list
  fleet attach ID                   jump to an agent's tab
  fleet read ID [N]                 print an agent's recent conversation
  fleet ask ID QUESTION             ask an agent live and wait for its answer (A2A)
  fleet send ID MESSAGE             give an agent an instruction; prints the A2A task id
      -t, --task TASK_ID            answer an agent whose task is input-required
  fleet task ID TASK_ID             show an A2A task's state and the agent's reply
  fleet tasks ID                    list the A2A tasks an agent has been given
  fleet card ID                     print an agent's A2A agent card
  fleet pending                     list safety-guard prompts waiting for you
  fleet approve ID | fleet deny ID  answer an agent's oldest pending prompt (interactive only)
  fleet k9s [CONTEXT]               toggle a k9s pane in the current tab
  fleet diff                        live, auto-refreshing git diff (used by --diff)
`;

const GLYPH: Record<string, string> = { working: "●", waiting: "◐", approval: "⚠", idle: "○", error: "✖", starting: "◌" };

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "up": {
      const r = up();
      try {
        execFileSync("rex", ["do", "session.select", `session_id=${r.session}`], { stdio: "ignore" });
      } catch {}
      console.log(r.created ? `created session fleet (${r.session})` : `session fleet already running (${r.session})`);
      return;
    }
    case "home":
      return runHome();
    case "spawn": {
      const o: any = { cwd: process.cwd() };
      const dd = args.indexOf("--");
      const flags = dd >= 0 ? args.slice(0, dd) : args;
      if (dd >= 0) o.prompt = args.slice(dd + 1).join(" ");
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        if (f === "-c" || f === "--cwd") o.cwd = flags[++i];
        else if (f === "-n" || f === "--name") o.name = flags[++i];
        else if (f === "--diff") o.git = "diff";
        else if (f === "--no-git") o.git = "none";
        else if (f === "-w" || f === "--worktree") throw new Error("git worktrees are not supported: agents work in the existing checkout");
        else if (f === "--session" || f === "-s") o.session = String(flags[++i] ?? "");
        else if (f === "--kb") o.kb = String(flags[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        else if (!o.prompt) o.prompt = flags.slice(i).join(" "), (i = flags.length);
      }
      const r = spawn(o);
      console.log(`started ${r.name} in ${r.cwd}`);
      return;
    }
    case "ls": {
      const all = listAgents();
      const stopped = stoppedAgents(all);
      if (args.includes("--json")) return console.log(JSON.stringify({ running: all, stopped }, null, 2));
      if (!all.length) console.log("no agents running");
      for (const a of all)
        console.log(`${GLYPH[a.status]} ${a.id.padEnd(16)} ${a.status.padEnd(8)} ${a.host.padEnd(12)} ${`${a.repo}:${a.branch}`.padEnd(36)} ${a.lastTool ?? a.task ?? ""}`);
      if (stopped.length) {
        console.log(`\nstopped (fleet restore ID | --all):`);
        for (const s of stopped)
          console.log(`◌ ${s.id.padEnd(16)} ${"stopped".padEnd(8)} ${new Date(s.lastSeen).toLocaleString().padEnd(22)} ${`${s.repo}:${s.branch}`.padEnd(36)} ${s.task ?? ""}`);
      }
      return;
    }
    case "restore": {
      const ids = args.includes("--all") ? stoppedAgents().map((s) => s.id) : args;
      if (!ids.length) throw new Error(args.includes("--all") ? "nothing to restore" : `missing ID\n\n${USAGE}`);
      // The master first, so it is there when the others come back.
      ids.sort((a, b) => (a === "master" ? -1 : b === "master" ? 1 : 0));
      let failed = 0;
      for (const id of ids) {
        try {
          const r = restore(id);
          console.log(`restored ${r.name}${r.resumed ? "" : " (no saved conversation; started fresh)"}`);
        } catch (e: any) {
          failed++;
          console.error(`${id}: ${e?.message || e}`);
        }
      }
      if (failed) process.exitCode = 1;
      return;
    }
    case "forget": {
      if (!args.length) throw new Error(`missing ID\n\n${USAGE}`);
      for (const id of args) {
        const s = findSaved(id);
        if (!s) console.error(`no saved agent ${id}`);
        else if (listAgents().some((a) => a.id === s.id)) console.error(`${s.id} is running; quit it first`);
        else (forgetAgent(s.id), console.log(`forgot ${s.id}`));
      }
      return;
    }
    case "attach":
      return console.log(`attached to ${attach(need(args[0], "ID"))}`);
    case "read": {
      const a = findAgent(need(args[0], "ID"));
      if (!a) throw new Error(`no agent ${args[0]}`);
      return console.log(readTranscript(a.sessionFile ?? "", Number(args[1]) || 40));
    }
    case "ask": {
      const a = agent(args[0]);
      console.error(`asking ${a.id}… (waits until it finishes its current step)`);
      const t = await askAgent(a, need(args.slice(1).join(" "), "QUESTION"), { from: "the user (fleet CLI)" });
      if (t.status.state !== "TASK_STATE_COMPLETED") console.error(`[task ${t.id}: ${shortState(t.status.state)}]`);
      return console.log(taskText(t));
    }
    case "send": {
      const a = agent(args[0]);
      let rest = args.slice(1), taskId: string | undefined;
      if (rest[0] === "-t" || rest[0] === "--task") (taskId = rest[1]), (rest = rest.slice(2));
      const t = await tellAgent(a, need(rest.join(" "), "MESSAGE"), { from: "the user (fleet CLI)", taskId });
      return console.log(`sent to ${a.id} · task ${t.id} (${shortState(t.status.state)})`);
    }
    case "task": {
      const a = agent(args[0]);
      const t = await getTask(a, need(args[1], "TASK_ID"), 0);
      return console.log(`${shortState(t.status.state)}${taskText(t) ? `\n${taskText(t)}` : ""}`);
    }
    case "tasks": {
      const a = agent(args[0]);
      const { tasks } = await listTasks(a, { includeArtifacts: true, historyLength: 1 });
      if (!tasks.length) return console.log(`${a.id}: no tasks`);
      for (const t of tasks) {
        const asked = t.history?.[0]?.parts?.[0]?.text ?? "";
        console.log(`${t.id}  ${shortState(t.status.state).padEnd(14)} ${(t.status.timestamp ?? "").slice(11, 19)}  ${taskText(t).replace(/\s+/g, " ").slice(0, 80) || asked.slice(0, 80)}`);
      }
      return;
    }
    case "card":
      return console.log(JSON.stringify(await fetchCard(agent(args[0])), null, 2));
    case "pending": {
      const rows = listAgents().flatMap((a) => (a.approvals ?? []).map((p) => ({ a, p })));
      if (!rows.length) return console.log("nothing waiting for approval");
      for (const { a, p } of rows) console.log(`⚠ ${a.id.padEnd(16)} ${p.severity.padEnd(12)} ${p.command ?? p.action}${p.reason ? `\n  ${p.reason}` : ""}`);
      return;
    }
    case "approve":
    case "deny": {
      // Human-only: agents run tools without a TTY, so they cannot get past this.
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${cmd} must be run by a person in an interactive terminal`);
      const a = findAgent(need(args[0], "ID"));
      if (!a) throw new Error(`no agent ${args[0]}`);
      const p = a.approvals?.[0];
      if (!p) return console.log(`${a.id}: nothing waiting for approval`);
      console.log(`${a.id} wants to run (${p.severity}):\n  ${p.command ?? p.action}${p.reason ? `\n  ${p.reason}` : ""}`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question(`${cmd === "approve" ? "Allow" : "Block"} it? type yes: `)).trim().toLowerCase();
      rl.close();
      if (ans !== "yes") return console.log("cancelled");
      await request(a.socket, { op: "approve", allow: cmd === "approve", approvalId: p.id });
      return console.log(`${cmd === "approve" ? "allowed" : "blocked"} on ${a.id}`);
    }
    case "k9s": {
      const s = process.env.REX_SESSION, b = process.env.REX_BLOCK;
      if (!s || !b) throw new Error("run this inside a Rex pane");
      return console.log(`k9s ${toggleK9s(s, b, args[0])}`);
    }
    case "diff":
      return diffLoop();
    default:
      process.stdout.write(USAGE);
      if (cmd && cmd !== "help" && cmd !== "-h" && cmd !== "--help") process.exitCode = 2;
  }
}

function agent(id: string | undefined): AgentRecord {
  const a = findAgent(need(id, "ID"));
  if (!a) throw new Error(`no agent ${id}`);
  return a;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}\n\n${USAGE}`);
  return v;
}

/** Redraw `git diff` whenever it changes. Uses delta if installed. */
function diffLoop() {
  let last = "";
  const hasDelta = spawnSync("sh", ["-c", "command -v delta"]).status === 0;
  const draw = () => {
    const cols = String(process.stdout.columns || 100);
    const raw = spawnSync("git", ["--no-pager", "diff", "--stat", "--patch", "--color=always", "HEAD"], { encoding: "utf8" }).stdout || "";
    if (raw === last) return;
    last = raw;
    const out = hasDelta && raw ? spawnSync("delta", ["--width", cols, "--paging=never"], { input: raw, encoding: "utf8" }).stdout : raw;
    process.stdout.write("\x1b[H\x1b[2J" + (out || "\x1b[2mno changes\x1b[0m\n"));
  };
  draw();
  setInterval(draw, 2000);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`fleet: ${e?.message || e}`);
  process.exit(1);
});
