# pi-fleet

Run many pi agents in Rex and keep track of them from one place. Terminal only.

```
fleet up        # session "fleet": tab "home" (todos + agents) and tab "master" (a pi that sees every agent)
```

- **home**: todos on top (`~/.pi/fleet/todo.md`), running agents below.
  `j/k` move · `tab` switch list · `enter` attach / start · `a` add · `e` edit · `x` done · `d` delete ·
  `s` start a pi for the todo (asks dir, optional worktree branch, name) · `n` new pi · `m` master · `q` quit
- **master**: ask "what's everyone doing?" → it reads each agent's conversation (no interruption) and
  reports doing / tried / next. Say "ask X live" to put the question to the agent itself.
  It can also start agents (`fleet_spawn`, optionally in a new git worktree) and switch you to one (`fleet_attach`).
- **agent tabs**: pi on the left, lazygit on the right. `/fleet k9s [context]` (or `fleet k9s`) toggles a k9s pane (`k9s --headless`).
  Rex tab headers show each agent's state (working / needs you / error) via the Program Status Protocol.

## CLI

```
fleet spawn [-c DIR] [-n NAME] [-w BRANCH] [--diff|--no-git] -- PROMPT
fleet ls | attach ID | read ID [N] | ask ID QUESTION | send ID MESSAGE | k9s [CTX] | diff
```

`FLEET_SESSION` picks a different Rex session (label or id); default `fleet`.

## How it works

- `extension/index.ts` is loaded by every pi (`extensions` in `~/.pi/agent/settings.json`). Each pi writes
  `~/.pi/coms/projects/default/agents/<id>.json` (status, task, last tool, session file, Rex block) and listens on
  `~/.pi/coms/sockets/<id>.sock` (`info`, `ask`, `send`; JSON lines).
- Status: `working` on agent start, `waiting` when the agent's last reply ends in a question, `error` on a failed
  run, else `idle`. A live ask from the master restores the previous status afterwards.
- With `FLEET_ROLE=master` (set by `fleet up`) the extension adds the `fleet_*` tools, a fleet widget, and
  coordinator instructions to the system prompt.
- `lib/rex.ts` drives Rex through the `rex` CLI. pi is launched via `zsh -ic` so your `pi` shell function applies;
  the prompt goes through `FLEET_PROMPT`, not argv.

Requires Node ≥ 23.6 (runs TypeScript directly), Rex, lazygit, k9s (optional), delta (optional, for `--diff`).

## Not yet

- Other machines: registry and sockets are per machine. Plan: run `fleet` against `rex -S <host>` and relay
  `ask`/`read` over the remote Rex host.
- A Rex key binding for the k9s toggle (init.lua).
