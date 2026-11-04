// The home screen: todos on top, running agents below. Plain ANSI, no deps.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type AgentRecord, type SavedAgent, ensureDirs, forgetAgent, listAgents, request, stoppedAgents, TODO_FILE, FLEET_DIR } from "./registry.ts";
import { attach, restore, spawn } from "./rex.ts";
import { loadKnowledge } from "./kb.ts";
import { spawnSync } from "node:child_process";

type Todo = { done: boolean; text: string; pi?: string };

const E = "\x1b[";
const c = {
  dim: (s: string) => `${E}2m${s}${E}22m`,
  bold: (s: string) => `${E}1m${s}${E}22m`,
  inv: (s: string) => `${E}7m${s}${E}27m`,
  fg: (n: number, s: string) => `${E}38;5;${n}m${s}${E}39m`,
};
const COL = { working: 114, waiting: 179, approval: 209, idle: 244, error: 204, starting: 244, accent: 111, host: 141, link: 81 } as const;
const GLYPH: Record<string, string> = { working: "●", waiting: "◐", approval: "⚠", idle: "○", error: "✖", starting: "◌" };
const STATE: Record<string, string> = { working: "working", waiting: "needs you", approval: "approve?", idle: "idle", error: "error", starting: "starting" };
const STATE_FILE = join(FLEET_DIR, "home.json");

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

const fit = (s: string, n: number) => (n <= 0 ? "" : s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s + " ".repeat(n - s.length));

function loadTodos(): Todo[] {
  if (!existsSync(TODO_FILE)) return [];
  const out: Todo[] = [];
  for (const line of readFileSync(TODO_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*[-*] \[( |x|X)\] (.*?)(?:\s+\(pi:([\w.-]+)\))?\s*$/);
    if (m) out.push({ done: m[1] !== " ", text: m[2], pi: m[3] });
  }
  return out;
}
function saveTodos(todos: Todo[]) {
  ensureDirs();
  writeFileSync(TODO_FILE, "# todo\n\n" + todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}${t.pi ? ` (pi:${t.pi})` : ""}`).join("\n") + "\n");
}
function loadState(): { lastDir: string } {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastDir: join(homedir(), "github") };
  }
}

export function runHome() {
  ensureDirs();
  // Agents started from here go into the session this home screen lives in.
  if (!process.env.FLEET_SESSION && process.env.REX_SESSION) process.env.FLEET_SESSION = process.env.REX_SESSION;
  let todos = loadTodos();
  let agents: AgentRecord[] = listAgents();
  let stopped: SavedAgent[] = stoppedAgents(agents);
  const refreshAgents = () => {
    agents = listAgents();
    stopped = stoppedAgents(agents);
  };
  /** The agents list holds running agents, then stopped ones. */
  const rowAt = (i: number): { live?: AgentRecord; gone?: SavedAgent } =>
    i < agents.length ? { live: agents[i] } : { gone: stopped[i - agents.length] };
  let state = loadState();
  let focus: "todo" | "agents" = todos.some((t) => !t.done) ? "todo" : "agents";
  let sel = { todo: 0, agents: 0 };
  let flash = "";
  // pi-knowledge (optional): suggestions from fleet agents are reviewed here, not in their tabs.
  let kbLib: any;
  let kbPending: any[] = [];
  let kbReview: any = null; // the suggestion being reviewed
  const refreshKb = () => {
    try {
      kbPending = kbLib ? kbLib.listPending().filter((s: any) => s.agent) : [];
    } catch {
      kbPending = [];
    }
  };
  loadKnowledge().then((k) => {
    kbLib = k;
    refreshKb();
    draw();
  });
  // line-input mode
  let prompt: { label: string; value: string; done: (v: string | null) => void } | null = null;

  const out = process.stdout;
  out.write(`${E}?1049h${E}?25l`);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const restore = () => out.write(`${E}?25h${E}?1049l`);
  process.on("exit", restore);

  function ask(label: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => {
      prompt = { label, value: initial, done: (v) => ((prompt = null), resolve(v), draw()) };
      draw();
    });
  }
  const say = (s: string) => ((flash = s), draw(), setTimeout(() => flash === s && ((flash = ""), draw()), 5000));

  function draw() {
    const W = out.columns || 100, H = out.rows || 30;
    const lines: string[] = [];
    const box = (title: string, active: boolean, body: string[], height: number) => {
      const col = active ? COL.accent : 240;
      const t = ` ${title} `;
      lines.push(c.fg(col, "╭─") + (active ? c.fg(COL.accent, c.bold(t)) : c.dim(t)) + c.fg(col, "─".repeat(Math.max(0, W - t.length - 3)) + "╮"));
      for (let i = 0; i < height - 2; i++) lines.push(c.fg(col, "│") + (body[i] ?? " ".repeat(W - 2)) + c.fg(col, "│"));
      lines.push(c.fg(col, "╰" + "─".repeat(W - 2) + "╯"));
    };
    const inner = W - 2;
    const live = new Set(agents.map((a) => a.id));

    // todos
    const tH = Math.max(6, Math.min(todos.length + 4, Math.floor((H - 2) * 0.45)));
    const tBody = todos.map((t, i) => {
      const on = focus === "todo" && sel.todo === i;
      const box = t.done ? c.fg(COL.working, "[x]") : c.dim("[ ]");
      const linkTxt = t.pi ? (live.has(t.pi) ? `→ ${t.pi}` : `→ ${t.pi} (ended)`) : t.done ? "" : "s start pi";
      const textW = Math.max(10, inner - 6 - linkTxt.length - 2);
      const text = fit(t.text, textW);
      let row = ` ${box} ${t.done ? c.dim(text) : text}  ` + (t.pi ? c.fg(live.has(t.pi) ? COL.link : 244, linkTxt) : c.dim(linkTxt));
      const pad = inner - (7 + textW + 2 + linkTxt.length);
      row += " ".repeat(Math.max(0, pad));
      return on ? c.inv(row) : row;
    });
    if (!todos.length) tBody.push(c.dim(fit("  no todos — press a to add one", inner)));
    while (tBody.length < tH - 3) tBody.push(" ".repeat(inner));
    tBody[tH - 3] = c.dim(fit("  a add · e edit · x done · d delete · s start pi · enter open · tab switch", inner));
    box(`todo  ${TODO_FILE.replace(homedir(), "~")}`, focus === "todo", tBody, tH);

    // agents
    const aH = H - tH - 1;
    const cw = { id: 16, st: 11, host: 10, repo: Math.min(40, Math.max(20, Math.floor(inner * 0.3))) };
    const lastW = Math.max(10, inner - 3 - cw.id - cw.st - cw.host - cw.repo);
    const header = c.dim(fit(`   ${fit("NAME", cw.id)}${fit("STATE", cw.st)}${fit("HOST", cw.host)}${fit("REPO · BRANCH", cw.repo)}DOING`, inner));
    const rowsLines: string[] = [];
    let selLine = 0;
    agents.forEach((a, i) => {
      const on = focus === "agents" && sel.agents === i;
      if (on) selLine = rowsLines.length;
      const host = a.host === hostname() ? "local" : a.host;
      const doing = a.status === "waiting" || a.status === "error" ? a.statusMsg ?? "" : a.status === "approval" ? "" : a.lastTool ?? a.task ?? "";
      const plain = ` ${GLYPH[a.status]} ${fit(a.id, cw.id)}${fit(STATE[a.status], cw.st)}${fit(host, cw.host)}${fit(`${a.repo}:${a.branch}`, cw.repo)}${fit(doing.replace(/\s+/g, " "), lastW)}`;
      const sc = COL[a.status];
      if (on) rowsLines.push(c.inv(fit(plain, inner)));
      else
        rowsLines.push(
          ` ${c.fg(sc, GLYPH[a.status])} ${a.role === "master" ? c.fg(COL.accent, fit(a.id, cw.id)) : fit(a.id, cw.id)}${c.fg(sc, fit(STATE[a.status], cw.st))}${c.fg(COL.host, fit(host, cw.host))}${fit(`${a.repo}:${a.branch}`, cw.repo)}${c.dim(fit(doing.replace(/\s+/g, " "), lastW))}`,
        );
      // Pending safety-guard approvals, one line each, under the agent.
      for (const p of a.approvals ?? []) {
        const what = `${p.severity === "destructive" ? "DESTRUCTIVE " : ""}${p.command ?? p.action}`.replace(/\s+/g, " ");
        const hint = on ? "  y allow · n block" : "";
        rowsLines.push(c.fg(COL.approval, fit(`     ⚠ ${fit(what, inner - 8 - hint.length)}${hint}`, inner)));
        if (on && p.reason) rowsLines.push(c.dim(fit(`       ${p.reason}`, inner)));
      }
    });
    if (!agents.length) rowsLines.push(c.dim(fit("   no pi agents running — press n to start one", inner)));
    if (stopped.length) {
      rowsLines.push(c.dim(fit(`   ── stopped · enter/R restore · A restore all · D forget ${"─".repeat(inner)}`, inner)));
      stopped.forEach((st, j) => {
        const on = focus === "agents" && sel.agents === agents.length + j;
        if (on) selLine = rowsLines.length;
        const when = ago(st.lastSeen);
        const plain = ` ◌ ${fit(st.id, cw.id)}${fit("stopped", cw.st)}${fit("local", cw.host)}${fit(`${st.repo}:${st.branch}`, cw.repo)}${fit(`${when} · ${(st.task ?? "").replace(/\s+/g, " ")}`, lastW)}`;
        rowsLines.push(on ? c.inv(fit(plain, inner)) : c.dim(fit(plain, inner)));
      });
    }
    // Scroll so the selected row stays visible.
    const visible = Math.max(1, aH - 4);
    const offset = Math.max(0, selLine - visible + 1);
    const aBody = [header, ...rowsLines.slice(offset, offset + visible)];
    while (aBody.length < aH - 3) aBody.push(" ".repeat(inner));
    aBody[aH - 3] = c.dim(fit("  enter attach · y/n approve · p next approval · n new pi · m master · R/A/D stopped · r refresh · q quit", inner));
    const need = agents.filter((a) => a.status === "waiting" || a.status === "error").length;
    const appr = agents.reduce((n, a) => n + (a.approvals?.length ?? 0), 0);
    box(`agents  ${agents.length} running${stopped.length ? ` · ${stopped.length} stopped` : ""}${appr ? ` · ⚠ ${appr} awaiting approval` : ""}${need ? ` · ${need} need you` : ""}${kbPending.length ? ` · 💡 ${kbPending.length} knowledge to review (K)` : ""}`, focus === "agents", aBody, aH);

    // Knowledge review: drawn over the bottom of the screen.
    if (kbReview) {
      // Fit plain text first, then colour it (fit counts characters, not escape codes).
      const row = (text: string, style: (x: string) => string = (x) => x) => style(fit(text, inner));
      const body = [
        row(` ${kbReview.title}   from ${kbReview.agent}`, c.bold),
        ...String(kbReview.body).split("\n").map((l: string) => row(`   ${l}`)),
        ...(kbReview.reason ? [row(`   why: ${kbReview.reason}`, c.dim)] : []),
        row(`   triggers: ${(kbReview.triggers ?? []).join(", ")}`, c.dim),
        row(""),
        row(" s review & save (opens your editor) · x skip, don't offer again · esc later · j next", (x) => c.fg(COL.accent, x)),
      ];
      const h = body.length + 2;
      lines.splice(Math.max(0, lines.length - h), h);
      box(`💡 save as knowledge?  ${kbPending.indexOf(kbReview) + 1}/${kbPending.length}`, true, body, h);
    }

    // status / prompt line
    const bottom = prompt ? `${c.fg(COL.accent, prompt.label)} ${prompt.value}${c.inv(" ")}` : flash ? c.fg(COL.waiting, ` ${flash}`) : c.dim(" fleet home");
    lines.push(bottom);
    // Box lines fill the full width, so no erase-to-EOL on them: at the last column
    // the cursor is in "pending wrap" and ESC[K would wipe the right border.
    const shown = lines.slice(0, H);
    const last = shown.length - 1;
    out.write(`${E}H` + shown.map((l, i) => (i === last ? `${E}2K` + l : l)).join("\r\n") + `${E}J`);
  }

  async function startForTodo(i: number) {
    const t = todos[i];
    if (!t) return;
    const dir = await ask("directory:", state.lastDir);
    if (!dir) return;
    const wt = await ask("worktree branch (enter = none):", "");
    if (wt === null) return;
    const name = await ask("agent name:", wt ? wt.split("/").pop()! : basename(dir.replace(/\/+$/, "")));
    if (!name) return;
    const kb = await askKnowledge(t.text);
    if (kb === null) return;
    try {
      const r = spawn({ cwd: dir, prompt: t.text, worktree: wt || undefined, name, kb, focus: false });
      t.pi = r.name;
      saveTodos(todos);
      state.lastDir = dir;
      writeFileSync(STATE_FILE, JSON.stringify(state));
      say(`started ${r.name} in ${r.cwd}`);
    } catch (e: any) {
      say(`spawn failed: ${e?.message || e}`);
    }
  }

  /** Knowledge to attach to a new agent's starting prompt, prefilled with the best matches. null = cancelled. */
  async function askKnowledge(promptText: string): Promise<string[] | null> {
    if (!kbLib) return [];
    let suggested: string[] = [];
    try {
      suggested = kbLib.rank(kbLib.currentIndex(), promptText).map((m: any) => m.entry.id);
    } catch {}
    const ids = kbLib.loadEntries().entries.map((e: any) => e.id);
    if (!ids.length) return [];
    const v = await ask(`knowledge ids, comma-separated (${ids.length} entries; enter = none):`, suggested.join(","));
    if (v === null) return null;
    const chosen = v.split(",").map((x) => x.trim()).filter(Boolean);
    const unknown = chosen.filter((x) => !ids.includes(x));
    if (unknown.length) say(`unknown knowledge ids ignored: ${unknown.join(", ")}`);
    return chosen.filter((x) => ids.includes(x));
  }

  /** Open the draft in the user's editor, outside the home screen, then save it. */
  function saveSuggestion(sg: any) {
    const file = join(tmpdir(), `fleet-kb-${sg.id}.md`);
    writeFileSync(file, kbLib.draftToText(sg));
    const editor = process.env.VISUAL || process.env.EDITOR || "nvim";
    out.write(`${E}?25h${E}?1049l`);
    process.stdin.setRawMode?.(false);
    const r = spawnSync(editor, [file], { stdio: "inherit" });
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    out.write(`${E}?1049h${E}?25l${E}2J`);
    if (r.status !== 0) return say(`editor exited with ${r.status}; not saved`);
    try {
      const d = kbLib.textToDraft(readFileSync(file, "utf8"));
      const e = kbLib.saveEntry(d);
      kbLib.resolveSuggestion(sg.id, "saved");
      say(`knowledge saved: ${e.title}`);
    } catch (err: any) {
      say(`not saved: ${err?.message || err}`);
    }
  }

  async function newAgent() {
    const dir = await ask("directory:", state.lastDir);
    if (!dir) return;
    const p = await ask("prompt (enter = none):", "");
    if (p === null) return;
    const name = await ask("agent name:", basename(dir.replace(/\/+$/, "")));
    if (!name) return;
    const kb = p ? await askKnowledge(p) : [];
    if (kb === null) return;
    try {
      const r = spawn({ cwd: dir, prompt: p || undefined, name, kb, focus: false });
      state.lastDir = dir;
      writeFileSync(STATE_FILE, JSON.stringify(state));
      say(`started ${r.name}`);
    } catch (e: any) {
      say(`spawn failed: ${e?.message || e}`);
    }
  }

  async function decide(a: AgentRecord | undefined, allow: boolean) {
    const p = a?.approvals?.[0];
    if (!a || !p) return say("nothing waiting for approval on this agent");
    try {
      await request(a.socket, { op: "approve", allow, approvalId: p.id });
      say(`${allow ? "allowed" : "blocked"} on ${a.id}: ${p.command ?? p.action}`);
    } catch (e: any) {
      say(`could not reach ${a.id}: ${e?.message || e}`);
    }
    refreshAgents();
  }

  function tryRestore(ids: string[]) {
    const done: string[] = [], bad: string[] = [];
    for (const id of ids.sort((a, b) => (a === "master" ? -1 : b === "master" ? 1 : 0))) {
      try {
        restore(id);
        done.push(id);
      } catch (e: any) {
        bad.push(`${id}: ${e?.message || e}`);
      }
    }
    say(bad.length ? `restore failed — ${bad.join("; ")}` : `restored ${done.join(", ")}`);
    setTimeout(() => (refreshAgents(), draw()), 1500);
  }

  function tryAttach(id: string) {
    try {
      attach(id);
      say(`attached to ${id}`);
    } catch (e: any) {
      say(e?.message || String(e));
    }
  }

  process.stdin.on("data", async (key: string) => {
    // Enter can arrive as CR, LF, or a CSI-u sequence depending on terminal modes.
    if (key === "\n" || key === "\x1b[13u" || key === "\r\n") key = "\r";
    if (prompt) {
      if (key === "\r") return prompt.done(prompt.value.trim());
      if (key === "\x1b" || key === "\x03") return prompt.done(null);
      if (key === "\x7f") prompt.value = prompt.value.slice(0, -1);
      else if (key === "\x15") prompt.value = "";
      else if (!key.startsWith("\x1b")) prompt.value += key.replace(/[\x00-\x1f]/g, "");
      return draw();
    }
    if (kbReview) {
      if (key === "s") saveSuggestion(kbReview);
      else if (key === "x") (kbLib.resolveSuggestion(kbReview.id, "skipped"), say(`skipped: ${kbReview.title}`));
      else if (key === "\x1b" || key === "q") {
        kbReview = null;
        return draw();
      } else if (key !== "j" && key !== "n") return draw();
      // next one (after save / skip / j)
      const at = kbPending.findIndex((s) => s.id === kbReview.id);
      refreshKb();
      kbReview = kbPending.length ? kbPending[Math.min(Math.max(0, key === "j" || key === "n" ? at + 1 : at), kbPending.length - 1)] : null;
      if (key === "j" && at + 1 >= kbPending.length) kbReview = kbPending[0] ?? null;
      return draw();
    }
    const list = focus === "todo" ? todos.length : agents.length + stopped.length;
    const cur = sel[focus];
    switch (key) {
      case "q":
      case "\x03":
        process.exit(0);
      case "K":
        refreshKb();
        if (!kbLib) say("pi-knowledge is not installed");
        else if (!kbPending.length) say("no knowledge suggestions from fleet agents");
        else kbReview = kbPending[0];
        break;
      case "\t":
        focus = focus === "todo" ? "agents" : "todo";
        break;
      case "j":
      case "\x1b[B":
        sel[focus] = Math.min(Math.max(0, list - 1), cur + 1);
        break;
      case "k":
      case "\x1b[A":
        sel[focus] = Math.max(0, cur - 1);
        break;
      case "r":
        todos = loadTodos();
        refreshAgents();
        break;
      case "m":
        if (!agents.some((a) => a.id === "master") && stopped.some((st) => st.id === "master")) tryRestore(["master"]);
        else tryAttach("master");
        break;
      case "R":
        if (focus === "agents" && rowAt(cur).gone) tryRestore([rowAt(cur).gone!.id]);
        else say("select a stopped agent to restore");
        break;
      case "A":
        if (stopped.length) tryRestore(stopped.map((st) => st.id));
        else say("no stopped agents");
        break;
      case "D": {
        const g = focus === "agents" ? rowAt(cur).gone : undefined;
        if (!g) {
          say("select a stopped agent to forget");
          break;
        }
        const v = await ask(`forget ${g.id}? its conversation file stays on disk (y/N):`);
        if (v?.toLowerCase() === "y") {
          forgetAgent(g.id);
          refreshAgents();
          sel.agents = Math.min(sel.agents, Math.max(0, agents.length + stopped.length - 1));
          say(`forgot ${g.id}`);
        }
        break;
      }
      case "p": {
        const i = agents.findIndex((a) => a.approvals?.length);
        if (i < 0) say("nothing waiting for approval");
        else ((focus = "agents"), (sel.agents = i));
        break;
      }
      case "y":
      case "n":
        if (focus === "agents" && rowAt(cur).live?.approvals?.length) {
          await decide(rowAt(cur).live, key === "y");
          break;
        }
        if (key === "n") await newAgent();
        break;
      case "\r":
        if (focus === "agents") {
          const r = rowAt(cur);
          if (r.live) tryAttach(r.live.id);
          else if (r.gone) tryRestore([r.gone.id]);
        }
        else if (todos[cur]?.pi && agents.some((a) => a.id === todos[cur].pi)) tryAttach(todos[cur].pi!);
        else if (todos[cur] && !todos[cur].done) await startForTodo(cur);
        break;
      default:
        if (focus !== "todo") break;
        if (key === "a") {
          const v = await ask("new todo:");
          if (v) (todos.unshift({ done: false, text: v }), (sel.todo = 0), saveTodos(todos));
        } else if (key === "e" && todos[cur]) {
          const v = await ask("edit:", todos[cur].text);
          if (v) ((todos[cur].text = v), saveTodos(todos));
        } else if (key === "x" && todos[cur]) {
          todos[cur].done = !todos[cur].done;
          saveTodos(todos);
        } else if (key === "d" && todos[cur]) {
          todos.splice(cur, 1);
          sel.todo = Math.max(0, Math.min(sel.todo, todos.length - 1));
          saveTodos(todos);
        } else if (key === "s" && todos[cur] && !todos[cur].done) await startForTodo(cur);
    }
    draw();
  });

  out.on("resize", () => (out.write(`${E}2J`), draw()));
  setInterval(() => {
    if (prompt || kbReview) return;
    refreshAgents();
    refreshKb();
    sel.agents = Math.min(sel.agents, Math.max(0, agents.length + stopped.length - 1));
    draw();
  }, 2000);
  draw();
}
