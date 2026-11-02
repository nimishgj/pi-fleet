// The home screen: todos on top, running agents below. Plain ANSI, no deps.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { type AgentRecord, ensureDirs, listAgents, TODO_FILE, FLEET_DIR } from "./registry.ts";
import { attach, spawn } from "./rex.ts";

type Todo = { done: boolean; text: string; pi?: string };

const E = "\x1b[";
const c = {
  dim: (s: string) => `${E}2m${s}${E}22m`,
  bold: (s: string) => `${E}1m${s}${E}22m`,
  inv: (s: string) => `${E}7m${s}${E}27m`,
  fg: (n: number, s: string) => `${E}38;5;${n}m${s}${E}39m`,
};
const COL = { working: 114, waiting: 179, idle: 244, error: 204, starting: 244, accent: 111, host: 141, link: 81 } as const;
const GLYPH: Record<string, string> = { working: "●", waiting: "◐", idle: "○", error: "✖", starting: "◌" };
const STATE: Record<string, string> = { working: "working", waiting: "needs you", idle: "idle", error: "error", starting: "starting" };
const STATE_FILE = join(FLEET_DIR, "home.json");

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
  let state = loadState();
  let focus: "todo" | "agents" = todos.some((t) => !t.done) ? "todo" : "agents";
  let sel = { todo: 0, agents: 0 };
  let flash = "";
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
    const aBody = [c.dim(fit(`   ${fit("NAME", cw.id)}${fit("STATE", cw.st)}${fit("HOST", cw.host)}${fit("REPO · BRANCH", cw.repo)}DOING`, inner))];
    agents.forEach((a, i) => {
      const on = focus === "agents" && sel.agents === i;
      const host = a.host === hostname() ? "local" : a.host;
      const doing = a.status === "waiting" || a.status === "error" ? a.statusMsg ?? "" : a.lastTool ?? a.task ?? "";
      const plain = ` ${GLYPH[a.status]} ${fit(a.id, cw.id)}${fit(STATE[a.status], cw.st)}${fit(host, cw.host)}${fit(`${a.repo}:${a.branch}`, cw.repo)}${fit(doing.replace(/\s+/g, " "), lastW)}`;
      if (on) return aBody.push(c.inv(fit(plain, inner)));
      const sc = COL[a.status];
      aBody.push(
        ` ${c.fg(sc, GLYPH[a.status])} ${a.role === "master" ? c.fg(COL.accent, fit(a.id, cw.id)) : fit(a.id, cw.id)}${c.fg(sc, fit(STATE[a.status], cw.st))}${c.fg(COL.host, fit(host, cw.host))}${fit(`${a.repo}:${a.branch}`, cw.repo)}${c.dim(fit(doing.replace(/\s+/g, " "), lastW))}`,
      );
    });
    if (!agents.length) aBody.push(c.dim(fit("   no pi agents running — press n to start one", inner)));
    while (aBody.length < aH - 3) aBody.push(" ".repeat(inner));
    aBody[aH - 3] = c.dim(fit("  enter attach · n new pi · m master · r refresh · q quit", inner));
    const need = agents.filter((a) => a.status === "waiting" || a.status === "error").length;
    box(`agents  ${agents.length} running${need ? ` · ${need} need you` : ""}`, focus === "agents", aBody, aH);

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
    try {
      const r = spawn({ cwd: dir, prompt: t.text, worktree: wt || undefined, name, focus: false });
      t.pi = r.name;
      saveTodos(todos);
      state.lastDir = dir;
      writeFileSync(STATE_FILE, JSON.stringify(state));
      say(`started ${r.name} in ${r.cwd}`);
    } catch (e: any) {
      say(`spawn failed: ${e?.message || e}`);
    }
  }

  async function newAgent() {
    const dir = await ask("directory:", state.lastDir);
    if (!dir) return;
    const p = await ask("prompt (enter = none):", "");
    if (p === null) return;
    const name = await ask("agent name:", basename(dir.replace(/\/+$/, "")));
    if (!name) return;
    try {
      const r = spawn({ cwd: dir, prompt: p || undefined, name, focus: false });
      state.lastDir = dir;
      writeFileSync(STATE_FILE, JSON.stringify(state));
      say(`started ${r.name}`);
    } catch (e: any) {
      say(`spawn failed: ${e?.message || e}`);
    }
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
    const list = focus === "todo" ? todos.length : agents.length;
    const cur = sel[focus];
    switch (key) {
      case "q":
      case "\x03":
        process.exit(0);
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
        agents = listAgents();
        break;
      case "m":
        tryAttach("master");
        break;
      case "n":
        await newAgent();
        break;
      case "\r":
        if (focus === "agents") agents[cur] && tryAttach(agents[cur].id);
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
    if (prompt) return;
    agents = listAgents();
    sel.agents = Math.min(sel.agents, Math.max(0, agents.length - 1));
    draw();
  }, 2000);
  draw();
}
