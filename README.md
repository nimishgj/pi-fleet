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
  It can also start agents (`fleet_spawn`, optionally in a new git worktree), give them work (`fleet_send`, then
  `fleet_task` to see how it went) and switch you to one (`fleet_attach`).
- **agent tabs**: pi on the left, lazygit on the right. `/fleet k9s [context]` (or `fleet k9s`) toggles a k9s pane (`k9s --headless`).
  Rex tab headers show each agent's state (working / needs you / error) via the Program Status Protocol.

## Knowledge (pi-knowledge)

If [pi-knowledge](../pi-knowledge) is installed, fleet uses it without blocking agents:

- An agent's starting prompt never shows the knowledge checklist. Choose knowledge when you start it instead:
  `fleet spawn --kb id1,id2 -- PROMPT`, the home screen's start flow (prefilled with the best matches), or the master,
  which searches the knowledge base (`kb_search`) and passes ids to `fleet_spawn`.
- Knowledge suggestions from fleet agents are reviewed on **home**: the agents box shows `💡 N knowledge to review`;
  press `K`, then `s` to edit and save in your editor, `x` to skip for good, `esc` for later.

## After a restart

Restarting Rex or the Mac ends every pi, but nothing is lost: each agent fleet started is saved in
`~/.pi/fleet/saved/<id>.json` (directory, git pane, pi session file, task), and those files outlive the process.

- `fleet up` brings back home and the master; the master reopens its previous conversation.
- Home lists the others under **stopped**: `enter`/`R` restores one, `A` all, `D` forgets one. A restored agent gets
  its tab back with the same name, directory and git pane, and pi resumes its conversation (`pi --session`).
- `fleet restore ID… | --all`, `fleet forget ID…`; `fleet ls` shows stopped agents too.
- The master sees stopped agents in `fleet_list`, can `fleet_read` them, and has `fleet_restore`.

Not kept: in-flight A2A tasks (the message is still in the agent's conversation, but the caller gets no reply) and
commands that were running inside an agent. A pi you started by hand, outside fleet, is not saved.

## Safety approvals

When safety-guard asks "Allow once / Block", the agent shows `⚠ approve?` on home with the exact command
(and its Rex tab shows blocked). On home: `p` jumps to the next one, `y` allows, `n` blocks. The prompt in the
agent's own tab still works; whichever human answers first wins. `fleet pending` lists them;
`fleet approve ID` / `fleet deny ID` answer from a terminal (interactive only, asks you to type yes).

Only a human can approve: the master has no approve tool, the CLI refuses without a TTY, and safety-guard blocks
agent commands that try to approve or talk to the fleet sockets. Requires the matching safety-guard change
(it publishes `fleet:approval_request` on `pi.events` and accepts a `decide(allow)` callback).

## Talking between agents: A2A

Agents talk over [A2A v1.0](https://a2a-protocol.org/latest/specification/) (JSON-RPC binding). Each pi serves,
on `127.0.0.1` at a random port (recorded as `a2a` in its registry file):

- `GET /.well-known/agent-card.json`: its agent card (who it is, repo/branch, status, two skills).
- `POST /a2a/v1`: `SendMessage`, `GetTask`, `CancelTask`, `ListTasks`. Needs `A2A-Version: 1.0` and
  `Authorization: Bearer $(cat ~/.pi/fleet/a2a-token)` (created on first use, mode 600). No streaming or push.

A message becomes an A2A task. It is delivered into the agent's conversation after its current step, and the task
completes with the agent's reply when that run ends. Message metadata `"fleet.kind": "question"` means "answer and
carry on" (the agent's status is left as it was); anything else is an instruction. A reply ending in `?` makes the
task `input-required`: answer with `SendMessage` carrying the same `taskId`.

```
fleet ask ID QUESTION        # blocking SendMessage, prints the reply
fleet send ID MESSAGE        # returnImmediately, prints the task id   (-t TASK_ID to answer input-required)
fleet task ID TASK_ID        # state + reply
fleet tasks ID | card ID
```

Safety approvals are **not** on A2A, because models can call A2A. They stay on the Unix socket.

## CLI

```
fleet spawn [-c DIR] [-n NAME] [-w BRANCH] [--diff|--no-git] [--kb ID,…] -- PROMPT
fleet ls | attach ID | read ID [N] | k9s [CTX] | diff
fleet restore ID... | --all | forget ID...
fleet ask ID QUESTION | send [-t TASK_ID] ID MESSAGE | task ID TASK_ID | tasks ID | card ID
fleet pending | approve ID | deny ID
```

`FLEET_SESSION` picks a different Rex session (label or id); default `fleet`.

## How it works

- `extension/index.ts` is loaded by every pi (the pi-fleet package in `~/.pi/agent/settings.json`). Each pi writes
  `~/.pi/coms/projects/default/agents/<id>.json` (status, task, last tool, session file, Rex block, A2A endpoint),
  serves A2A (`lib/a2a.ts`), and listens on `~/.pi/coms/sockets/<id>.sock` for human approvals only (`info`, `approve`).
- Status: `working` on agent start, `waiting` when the agent's last reply ends in a question, `error` on a failed
  run, else `idle`. A live ask from the master restores the previous status afterwards.
- With `FLEET_ROLE=master` (set by `fleet up`) the extension adds the `fleet_*` tools, a fleet widget, and
  coordinator instructions to the system prompt.
- `lib/rex.ts` drives Rex through the `rex` CLI. pi is launched via `zsh -ic` so your `pi` shell function applies;
  the prompt goes through `FLEET_PROMPT`, not argv.

Requires Node ≥ 23.6 (runs TypeScript directly), Rex, lazygit, k9s (optional), delta (optional, for `--diff`).

## Not yet

- Other machines: A2A listens on 127.0.0.1 only and the registry is per machine. Next step: also listen on the
  tailnet address and share agent cards between machines.
- A Rex key binding for the k9s toggle (init.lua).
