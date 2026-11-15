# pi-subagents

Lightweight, OMP-inspired subagents for [Pi](https://pi.dev).

It keeps the model-facing surface small:

- `task` — start one or more child agents
- `wait` — wait for the first settled result
- `agent` — message / steer / resume a child, and optionally switch its model or thinking level

No extra system-prompt section and no per-turn hooks. The extension only uses
`session_start` and `session_shutdown`.

## Install

From GitHub:

```bash
pi install git:github.com/YoungJurry/pi-subagents
```

Or copy this directory to:

```text
~/.pi/agent/extensions/subagents/
```

Then run `/reload` or restart Pi.

## Configuration

User configuration lives at:

```text
~/.pi/agent/subagents.json
```

```json
{
  "maxConcurrent": 2,
  "autoCleanOrphans": true
}
```

The repository's `config.json` is only the default. The user file overrides it
and survives git updates. Partial user configs are merged over the defaults.

- `maxConcurrent`: maximum running child agents. Default `2`; clamped to `1–32`.
  Extra tasks wait in a FIFO queue.
- `autoCleanOrphans`: remove child-session groups whose recorded parent session
  file no longer exists. Default `true`.

No environment variables are used. Reload/restart after changing the file.

## Tools

### `task`

```json
{
  "context": "shared goal, interfaces, constraints",
  "tasks": [
    {
      "task": "self-contained assignment with target files and acceptance checks",
      "agent": "scout",
      "solutionSpace": "bounded fix or open investigation",
      "name": "optional label",
      "model": "provider/model-id[:thinking]",
      "thinking": "off|minimal|low|medium|high|xhigh|max"
    }
  ]
}
```

- Starts child Pi sessions and returns IDs immediately.
- `context` is written once per `task` call; every child receives it.
- Default agent is `task`.
- Built-in roles: `task`, `general`, `scout`, `review`; `worker` aliases `task`.
- Custom agents load from `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`.
- At most 8 tasks per call.
- Results auto-deliver after the batch settles. Use `wait` when blocked instead
  of polling.

### `wait`

No parameters. Returns the first settled result, or immediately when nothing is
running.

### `agent`

```json
{
  "id": "agent-...",
  "message": "optional",
  "model": "provider/model-id[:thinking]",
  "thinking": "off|minimal|low|medium|high|xhigh|max"
}
```

At least one of `message`, `model`, or `thinking` is required.

- Running target: `message` is a steer; model/thinking switch applies to the next
  request.
- Queued/starting target: the message is delivered with the start; the new
  model/thinking is used when it starts.
- Finished/saved target: `message` resumes the same session as a follow-up task.
- Only `model`/`thinking`: switch without starting a new turn.
- Results still arrive through `wait` or auto-delivery.

This is one compact control tool, not separate `resume` and `send_message`
tools. It is not OMP's `agent://` / `proc://` URI system.

## Child sessions

- Fresh context by default; no parent chat history.
- Child cwd is the parent cwd.
- Child settings inherit the parent working directory and global/project
  settings, including `shellCommandPrefix`.
- Child model/thinking precedence:
  per-task `thinking` or `model:thinking` → custom-agent frontmatter → parent.
- Child does not inherit parent extensions, project context files, skills, or
  parent prompt instructions.
- Child tools are role-specific:
  - `task` / `general`: `read`, `bash`, `edit`, `write`
  - `scout` / `review`: `read`, `bash`
- Children cannot spawn further subagents.
- Sessions are stored under:

```text
~/.pi/agent/subagents/<parent-session-id>/
```

New child metadata records `parentSessionId` and `parentSessionFile`. On
`session_start` and `/subagents` listing, child groups whose parent file no
longer exists are removed. Old sessions without `parentSessionFile` are left
untouched.

## Commands

```text
/subagents                          list active and saved subagents
/subagents view <id>                open the native transcript viewer
/subagents resume <id> <task>       continue a saved/completed child
/subagents stop <id>                stop a running/queued child
/subagents clean                    delete this parent's saved child sessions
```

The viewer reuses Pi's native `UserMessageComponent`,
`AssistantMessageComponent`, `ToolExecutionComponent`, and Markdown theme.
It supports scrolling, paging, jumping to top/bottom, expanding tools, hiding
thinking, refresh, and Esc to close.

## TUI

A widget below the editor shows active/queued tasks, elapsed time, resolved
`provider/model:thinking`, tool count, and the last tool. It is placed
`belowEditor` so it does not compete with Pi Voice's above-editor widget.

## Token cost

Measured with the current Pi config, `o200k`, and Codex tool serialization:

| Part | Tokens |
|---|---:|
| `task` | ~225 |
| `wait` | ~59 |
| `agent` | ~159 |
| System prompt | 0 |
| **Added total** | **~434** |

Actual totals depend on cwd/date, provider serialization, and other tools.

## Limitations

- No `workpool`, IRC, `proc://`, `agent://`, or `history://`.
- No worktree isolation/merge/apply.
- No `seance`, structured `yield`, completion probe, prewalk, or model roles.
- No detached runner across Pi exit/reload.
- No child extensions, so children do not get `web_search`/`fetch`.
- `scout`/`review` read-only is prompt-level, not a sandbox.
- No per-task `cwd`, `isolated`, `steps`, `tools`, or `outputSchema`.
- No child token/cost accounting.
- `wait` has no timeout.
- Viewer live refresh shows persisted messages; streaming partial output is not
  yet integrated.

## License

MIT
