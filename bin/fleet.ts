#!/usr/bin/env node
// fleet — manage pi agents in Rex.
import { execFileSync, spawnSync } from "node:child_process";
import { findAgent, listAgents, readTranscript, request } from "../lib/registry.ts";
import { attach, spawn, toggleK9s, up } from "../lib/rex.ts";
import { runHome } from "../lib/home.ts";

const USAGE = `fleet — pi agents in Rex

  fleet up                          create/show the "fleet" session (home + master tabs)
  fleet home                        the home screen (todos + agents); runs in the home tab
  fleet spawn [opts] [-- prompt]    start a pi in a new tab with lazygit beside it
      -c, --cwd DIR                 directory (default: current)
      -n, --name NAME               agent id / tab name
      -w, --worktree BRANCH         create a sibling git worktree on BRANCH
      --diff | --no-git             live git diff instead of lazygit, or no git pane
  fleet ls [--json]                 list agents
  fleet attach ID                   jump to an agent's tab
  fleet read ID [N]                 print an agent's recent conversation
  fleet ask ID QUESTION             ask an agent live and wait for its answer
  fleet send ID MESSAGE             send an agent an instruction
  fleet k9s [CONTEXT]               toggle a k9s pane in the current tab
  fleet diff                        live, auto-refreshing git diff (used by --diff)
`;

const GLYPH: Record<string, string> = { working: "●", waiting: "◐", idle: "○", error: "✖", starting: "◌" };

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
        else if (f === "-w" || f === "--worktree") o.worktree = flags[++i];
        else if (f === "--diff") o.git = "diff";
        else if (f === "--no-git") o.git = "none";
        else if (!o.prompt) o.prompt = flags.slice(i).join(" "), (i = flags.length);
      }
      const r = spawn(o);
      console.log(`started ${r.name} in ${r.cwd}`);
      return;
    }
    case "ls": {
      const all = listAgents();
      if (args.includes("--json")) return console.log(JSON.stringify(all, null, 2));
      if (!all.length) return console.log("no agents running");
      for (const a of all)
        console.log(`${GLYPH[a.status]} ${a.id.padEnd(16)} ${a.status.padEnd(8)} ${a.host.padEnd(12)} ${`${a.repo}:${a.branch}`.padEnd(36)} ${a.lastTool ?? a.task ?? ""}`);
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
      const a = findAgent(need(args[0], "ID"));
      if (!a) throw new Error(`no agent ${args[0]}`);
      console.error(`asking ${a.id}… (waits until it finishes its current step)`);
      return console.log(await request(a.socket, { op: "ask", question: need(args.slice(1).join(" "), "QUESTION") }, 11 * 60_000));
    }
    case "send": {
      const a = findAgent(need(args[0], "ID"));
      if (!a) throw new Error(`no agent ${args[0]}`);
      await request(a.socket, { op: "send", message: need(args.slice(1).join(" "), "MESSAGE") });
      return console.log(`sent to ${a.id}`);
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
