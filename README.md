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
  "autoCleanOrphans": true,
  "defaultModel": null
}
```

The repository's `config.json` is only the default. The user file overrides it
and survives git updates. Partial user configs are merged over the defaults.

- `maxConcurrent`: execution slots shared by the whole descendant tree. Default
  `2`; clamped to `1–32`. Extra tasks wait in a FIFO queue. A parent blocked in
  `wait` or parked until its descendants finish lends its slot back, then
  reacquires one before continuing, so nested delegation also works at `1`.
- `autoCleanOrphans`: remove child-session groups whose recorded parent session
  file no longer exists. Default `true`.
- `defaultModel`: optional `provider/model-id[:thinking]` selector for children
  without a more specific model. Omitted, `null`, or blank preserves parent-model
  inheritance. An invalid/unavailable selected default fails preflight rather
  than silently falling back to the parent's model.

Model precedence for new children:

```text
per-call model > agent frontmatter model > defaultModel > parent's active model
```

For example, set `"defaultModel": "mistral/deepseek-v4-1-flash-1017"` if that
provider/model is available in your Pi model registry. This is a default, not a
lock: per-call and agent-specific models still take precedence. It does not
change the main agent's model. An optional thinking suffix is used only when no
more specific thinking setting applies; otherwise thinking still inherits.

Resuming an existing child preserves its saved model unless the caller explicitly
switches it. Legacy children without a saved model use the current agent-specific
model, then `defaultModel`, then the parent's active model.

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
- Built-in roles: `task` (general-purpose execution), `scout` (read-only
  investigation), and `review` (read-only review). `worker` aliases `task`,
  unless a custom agent overrides that name.
- Custom agents load from `~/.pi/agent/agents/*.md` and trusted-project
  `.pi/agents/*.md`; untrusted project definitions cannot override role prompts.
  Optional frontmatter `model`, `thinking`, and `tools` accept null-like values
  as unset. An explicit `tools: []` selects no tools; listed names are preserved
  exactly, so selecting search tools never silently grants `bash` access.
- At most 8 tasks per call.
- Completed results auto-deliver in small batches without waiting for unrelated
  children. Use `wait` when blocked instead of polling.
- Reports are saved in the parent transcript independently of the best-effort
  follow-up that wakes the parent. Clearing Pi's message queue cannot discard
  a report; `wait` can recover a handoff that is not yet acknowledged.

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
- Only `model`/`thinking`: switch without starting a new turn. Updates for the
  same child are serialized; startup and cleanup wait for pending updates so
  the live model, thinking level, and saved selection stay consistent.
- Results still arrive through `wait` or auto-delivery.
- A stopped child cannot resume until its previous execution has finished
  cleaning up, so two runs never write to the same transcript concurrently.

This is one compact control tool, not separate `resume` and `send_message`
tools. It is not OMP's `agent://` / `proc://` URI system.

## Child sessions

- Fresh context by default; no parent chat history.
- Child cwd is the parent cwd. Session IDs follow Pi's validation rules,
  including dotted IDs, and cannot escape the subagent session directory.
- Child settings inherit the parent working directory and global/project
  settings, including `shellCommandPrefix`.
- Child model precedence:
  per-task `model` → custom-agent frontmatter → `defaultModel` → parent.
- Child thinking precedence:
  per-task `thinking` or `model:thinking` → custom-agent frontmatter → selected
  default model's thinking suffix → parent.
- Extension loading/startup/runtime errors are returned as deduplicated warnings
  with the result instead of disappearing in a headless child. Nonfatal optional
  extension errors do not automatically fail otherwise successful work.
- Each child independently loads configured global/trusted-project extensions
  and the standard codemode, tool-search, and MCP builtins. Project trust is
  inherited; disabled builtins stay disabled. Parent-bound tool instances and
  extension runtimes are never shared. Temporary CLI-only extensions/settings
  are not automatically reproduced; UI-only extensions may not work headlessly.
- Built-in roles do not restrict tools. They use the configured tool selection
  and extension tools, including web search/fetch when those extensions are
  installed. Custom agents may still explicitly declare a `tools` list.
- Child system prompts use their role instructions, not the parent's `SYSTEM.md`.
  Project context files, skills, themes, and prompt templates are not
  automatically loaded. Pi can still append `APPEND_SYSTEM.md` independently.
- Children can delegate further without a depth limit. Every session owns its
  own `task`/`wait`/`agent` tools and mailbox; results go to the immediate parent.
  A delegating child stays alive until descendants settle and it has processed
  their results. Stopping a branch or closing its session stops descendants too.
- `scout`/`review` read-only behavior is instruction-level, including delegated
  tasks, not a tool restriction or filesystem sandbox.
- Sessions are stored under:

```text
~/.pi/agent/subagents/<parent-session-id>/
```

New child metadata records `parentSessionId` and `parentSessionFile`. On
`session_start` and `/subagents` listing, orphaned child groups whose parent file
no longer exists are removed. The currently open parent and live descendant
groups are protected, including when a parent file moves. Old sessions without
`parentSessionFile` are left untouched.

Saved metadata and model/thinking selections follow the active journal branch;
large shared contexts or later output cannot hide them behind a fixed byte
window. Reading history uses Pi's in-memory migration logic without rewriting
journals, and cyclic parent links are ignored safely.

### Built-in role instructions

The shared introduction is only:

> 你是受主 Agent 委派的子 Agent。根据收到的任务工作。

`task` is a general-purpose executor: inspect first, preserve unrelated work,
make minimal changes, keep scratch files in `/tmp`, and verify the result.
`scout` gathers evidence without changing state. `review` reports concrete,
evidence-backed issues, distinguishing defects, conditional risks, and missing
verification. Their complete Chinese role prompts are in `BUILTIN_AGENTS` in
`index.ts`; custom Markdown agent definitions override the corresponding built-in
without inheriting its introduction or body.

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

The `/subagents` picker and active-task widget show a parent/child tree, not a
flat list. Saved-session trees are reconstructed from their session IDs and
parent session directories. Every picker row remains selectable, including
indented descendants; `/subagents view` can also open a nested transcript.
Stopping an active nested ID or its ancestor propagates down that branch.
Follow-up/resume tools address the calling session's direct children. Cleaning
saved sessions removes the whole descendant tree, even with orphan cleanup off.

The `/subagents` picker colors statuses using the active Pi theme: running uses
accent, queued uses warning, completed uses success, failed uses error, stopped
uses muted, and saved uses dim. Agent ids stay unstyled for reliable selection.

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
- Extension loading has per-session overhead (including separate MCP
  connections), and arbitrary extensions may have their own background behavior.
- Configured extensions can recreate model routes/credentials in a child, but
  virtual models or credentials registered only in the parent's temporary
  runtime are not guaranteed to be inherited through the public SDK.
- Delegation has no depth cap; the shared concurrency budget limits simultaneous
  execution, not total work or cumulative token usage.
- `scout`/`review` read-only is prompt-level, not a sandbox.
- No per-task `cwd`, `isolated`, `steps`, `tools`, or `outputSchema`.
- No child token/cost accounting.
- `wait` has no timeout. A forced stop reports when cleanup is still pending;
  an uncooperative tool keeps its execution slot and transcript locked until it
  actually settles. The plugin does not fake termination or reuse a busy session;
  orderly reload/shutdown also waits for cleanup.
- Viewer live refresh shows persisted messages; streaming partial output is not
  yet integrated.

## Development

```bash
npm install --legacy-peer-deps
npm test
```

Tests use Node's built-in runner and a stubbed Pi API; they do not call models,
read credentials, or touch normal Pi sessions. TypeScript is a development-only
compiler dependency. Runtime still uses the same three tools and only the
`session_start` / `session_shutdown` hooks. A regression test freezes the tool
schemas and descriptions byte-for-byte.

With the Pi 1.5.2+ peer packages available, run `npm run typecheck` (including
unused-code checks) and `npm run test:sdk` for the real-SDK offline integration checks. A simulated provider and temporary web
extension exercise nested delegation, codemode tool calls, session isolation,
shutdown, and idle-parent wakeups at a concurrency of one. It also verifies a
child default model/thinking distinct from the parent's, trusted role loading,
and model-switch/resume persistence after large contexts and transcript output.
Tool results are checked structurally, including child extension warnings.
All fixtures stay in `/tmp`; no real model requests or user credentials are used.

## License

MIT
