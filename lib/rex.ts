// Thin wrappers over the `rex` CLI. Every call is synchronous and returns parsed JSON.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type GitPane, findAgent, findSaved } from "./registry.ts";

/** Session to use: FLEET_SESSION (label or id), else "fleet". Read at call time. */
export const fleetSession = () => process.env.FLEET_SESSION || "fleet";
const HERE = dirname(new URL(import.meta.url).pathname);
export const FLEET_BIN = resolve(HERE, "..", "bin", "fleet.ts");

function rex(args: string[], server?: string): string {
  const full = server ? ["-S", server, ...args] : args;
  return execFileSync("rex", full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function rexJson(args: string[], server?: string): any {
  // --json must come before "--", or rex passes it to the command.
  const dd = args.indexOf("--");
  const withJson = dd < 0 ? [...args, "--json"] : [...args.slice(0, dd), "--json", ...args.slice(dd)];
  return JSON.parse(rex(withJson, server));
}

export function findSession(label = fleetSession(), server?: string): string | undefined {
  const { sessions } = rexJson(["ls"], server);
  return sessions.find((s: any) => s.label === label || s.session_id === label)?.session_id;
}

/** Run pi through an interactive zsh so the user's `pi` shell function (env, telemetry) applies. */
// The prompt and session file travel in env, not as "$@": .zshrc can clobber positional
// parameters (any bare `set foo` line does).
export function piCommand(env: Record<string, string>, prompt?: string, resume?: string): string[] {
  const all = { ...env, ...(prompt ? { FLEET_PROMPT: prompt } : {}), ...(resume ? { FLEET_RESUME: resume } : {}) };
  const envArgs = Object.entries(all).map(([k, v]) => `${k}=${v}`);
  const script =
    'p="$FLEET_PROMPT"; s="$FLEET_RESUME"; unset FLEET_PROMPT FLEET_RESUME; ' +
    'if [[ -n "$s" ]]; then pi --session "$s"; elif [[ -n "$p" ]]; then pi "$p"; else pi; fi';
  return ["--shell=none", "--", "env", ...envArgs, "zsh", "-ic", script];
}

/** The master's last conversation, if it can be reopened. */
function masterResume(): string | undefined {
  const s = findSaved("master");
  return s?.role === "master" && s.sessionFile && existsSync(s.sessionFile) ? s.sessionFile : undefined;
}

/** Create the fleet session with home + master tabs, or return the existing one. */
export function up(opts: { cwd?: string; server?: string } = {}): { session: string; created: boolean } {
  const existing = findSession(fleetSession(), opts.server);
  if (existing) return { session: existing, created: false };
  const cwd = opts.cwd || join(homedir(), "github");
  const created = rexJson(
    ["new", fleetSession(), "-c", cwd, "--window", "home", "--shell=none", "--", "node", FLEET_BIN, "home"],
    opts.server,
  );
  const session = created.session_id as string;
  // The master picks up its previous conversation, so it still knows the fleet after a restart.
  rex(["window", "new", "-s", session, "master", "-c", cwd, "--focus=false", ...piCommand({ FLEET_NAME: "master", FLEET_ROLE: "master" }, undefined, masterResume())], opts.server);
  return { session, created: true };
}

export type SpawnOpts = {
  name?: string;
  cwd: string;
  prompt?: string;
  worktree?: string; // branch name; creates ../<repo>-<name> worktree
  git?: GitPane;
  server?: string;
  focus?: boolean;
  resume?: string; // pi session file to reopen instead of starting fresh
  kb?: string[]; // pi-knowledge entry ids to attach to the starting prompt
};

export type SpawnResult = { name: string; cwd: string; session: string; window?: string; piBlock: string; gitBlock?: string };

export function spawn(o: SpawnOpts): SpawnResult {
  let cwd = resolve(o.cwd.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(cwd)) throw new Error(`no such directory: ${cwd}`);
  const name = (o.name || (o.worktree ? o.worktree.split("/").pop()! : basename(cwd))).replace(/[^A-Za-z0-9_.-]+/g, "-");

  if (o.worktree) {
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const wt = join(dirname(top), `${basename(top)}-${name}`);
    if (!existsSync(wt)) {
      const hasBranch = (() => {
        try {
          execFileSync("git", ["-C", top, "rev-parse", "--verify", "--quiet", o.worktree!], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })();
      const args = hasBranch ? ["worktree", "add", wt, o.worktree] : ["worktree", "add", "-b", o.worktree, wt];
      execFileSync("git", ["-C", top, ...args], { stdio: "ignore" });
    }
    cwd = wt;
  }

  const session = up({ server: o.server }).session;
  const focus = o.focus === false ? ["--focus=false"] : [];
  
  const isRepo = existsSync(join(cwd, ".git")) || (() => {
    try {
      execFileSync("git", ["-C", cwd, "rev-parse"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const git: GitPane = isRepo ? o.git ?? "lazygit" : "none";
  // FLEET_GIT lets the agent save its layout, so a restore rebuilds the same tab.
  const env: Record<string, string> = { FLEET_NAME: name, FLEET_ROLE: "worker", FLEET_GIT: git };
  // pi-knowledge: no checklist on the starting prompt; attach what was chosen at spawn time instead.
  if (o.prompt && !o.resume) env.FLEET_START = "1";
  if (o.kb?.length && !o.resume) env.FLEET_KB = o.kb.join(",");
  const win = rexJson(["window", "new", "-s", session, name, "-c", cwd, ...focus, ...piCommand(env, o.prompt, o.resume)], o.server);
  const piBlock = win.block_ids[0] as string;

  let gitBlock: string | undefined;
  if (git !== "none") {
    const cmd = git === "lazygit" ? ["--", "lazygit"] : ["--shell=none", "--", "node", FLEET_BIN, "diff"];
    const sp = rexJson(["split", "-s", session, "-b", piBlock, "--split=right", "--ratio", "50", "--label", "git", "--focus=false", "-c", cwd, ...cmd], o.server);
    gitBlock = sp.block_ids[0];
  }
  return { name, cwd, session, window: win.window_id, piBlock, gitBlock };
}

/** Bring back a stopped agent: same tab name, directory and git pane, reopening its pi conversation. */
export function restore(id: string, o: { server?: string; focus?: boolean } = {}): { name: string; resumed: boolean } {
  const s = findSaved(id);
  if (!s) throw new Error(`no saved agent named ${id}`);
  const live = findAgent(s.id);
  if (live && live.id === s.id) throw new Error(`${s.id} is already running`);
  if (!existsSync(s.cwd)) throw new Error(`${s.id}: its directory is gone (${s.cwd})`);
  const resume = s.sessionFile && existsSync(s.sessionFile) ? s.sessionFile : undefined;
  if (s.role === "master") {
    const r = up({ server: o.server });
    if (!r.created) {
      rex(["window", "new", "-s", r.session, "master", "-c", s.cwd, "--focus=false", ...piCommand({ FLEET_NAME: "master", FLEET_ROLE: "master" }, undefined, resume)], o.server);
    }
    return { name: "master", resumed: !!resume };
  }
  spawn({ name: s.id, cwd: s.cwd, git: s.git, resume, server: o.server, focus: o.focus ?? false });
  return { name: s.id, resumed: !!resume };
}

/** Bring an agent's pane to the front: focus its block and show its session in the Rex app. */
export function attach(id: string): string {
  const a = findAgent(id);
  if (!a) throw new Error(`no agent named ${id}`);
  if (!a.rex?.session || !a.rex.block) throw new Error(`${a.id} is not running inside Rex`);
  rex(["focus", "-s", a.rex.session, a.rex.block]);
  // `focus` only moves the server's active window. The Rex app keeps its own view,
  // so also ask the app to show that session *and* that window.
  const { blocks } = rexJson(["block", "ls", "-s", a.rex.session]);
  const win = blocks.find((b: any) => b.block_id === a.rex!.block)?.window_id;
  const args = ["do", "session.select", `session_id=${a.rex.session}`, ...(win ? [`window_id=${win}`] : [])];
  try {
    rex(args);
  } catch (e: any) {
    throw new Error(`focused ${a.id}, but the Rex app did not switch: ${String(e?.stderr || e?.message || e).trim()}`);
  }
  return a.id;
}

/** Toggle a k9s pane under the git pane (or under `block`) in the window that holds `block`. */
export function toggleK9s(session: string, block: string, context?: string): "opened" | "closed" {
  const { blocks } = rexJson(["block", "ls", "-s", session]);
  const me = blocks.find((b: any) => b.block_id === block);
  if (!me) throw new Error(`block ${block} not found in ${session}`);
  const inWindow = blocks.filter((b: any) => b.window_id === me.window_id);
  const k9s = inWindow.find((b: any) => b.label === "k9s");
  if (k9s) {
    rex(["block", "close", "-s", session, k9s.block_id]);
    return "closed";
  }
  const anchor = inWindow.find((b: any) => b.label === "git") ?? me;
  const args = ["--", "k9s", "--headless", ...(context ? ["--context", context] : [])];
  rex(["split", "-s", session, "-b", anchor.block_id, "--split=below", "--ratio", "45", "--label", "k9s", "--focus=false", ...args]);
  return "opened";
}
