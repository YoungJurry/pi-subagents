/**
 * Pi-native, OMP-inspired subagents.
 *
 * Lightweight scope:
 * - task({ context, tasks[] }) starts child Pi sessions and returns IDs immediately.
 * - wait() returns the first settled result, or immediately when nothing is running.
 * - Results auto-deliver as a follow-up message; full transcripts stay on disk.
 * - /subagents lists, views, stops and resumes child sessions.
 *
 * Deliberately not implemented: workpool, IRC, proc://, worktree isolation,
 * seance, structured yield, completion probe, detached runner.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createAgentSession,
	CustomMessageComponent,
	DefaultResourceLoader,
	getAgentDir,
	getMarkdownTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Container, matchesKey, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const USER_CONFIG_PATH = join(getAgentDir(), "subagents.json");

interface ExtensionConfig {
	maxConcurrent?: number;
	autoCleanOrphans?: boolean;
}

function loadConfig(): ExtensionConfig {
	let config: ExtensionConfig = {};
	for (const path of [DEFAULT_CONFIG_PATH, USER_CONFIG_PATH]) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object") config = { ...config, ...parsed };
		} catch {
			// Missing or invalid files fall back to the next/default config.
		}
	}
	return config;
}

const CONFIG = loadConfig();

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Status = "queued" | "running" | "completed" | "failed" | "stopped";

interface AgentDefinition {
	name: string;
	description?: string;
	tools: string[];
	prompt: string;
	model?: string;
	thinking?: string;
	source?: string;
}

interface TaskInput {
	task: string;
	agent?: string;
	solutionSpace?: string;
	name?: string;
	model?: string;
	thinking?: ThinkingLevel;
	/** Internal: resume an existing session instead of starting a fresh one. */
	resume?: boolean;
}

interface TaskRecord {
	id: string;
	name: string;
	agent: string;
	task: string;
	context: string;
	status: Status;
	startedAt: number;
	endedAt?: number;
	sessionFile?: string;
	result?: string;
	error?: string;
	child?: any;
	finished: boolean;
	modelSpec?: string;
	thinking?: string;
	agentDef?: AgentDefinition;
	activity?: string;
	toolCount?: number;
	unsubscribe?: () => void;
	stopTimer?: ReturnType<typeof setTimeout>;
	finalized?: boolean;
	stopRequested?: boolean;
	resolvedModel?: string;
	resolvedThinking?: string;
	toolDefinitions?: Map<string, any>;
	pendingMessages?: string[];
	promptStarted?: boolean;
}

interface TaskResult {
	deliveryId: string;
	id: string;
	name: string;
	agent: string;
	status: Status;
	text: string;
	sessionFile?: string;
	error?: string;
	durationMs: number;
}

interface SavedTask {
	id: string;
	name: string;
	agent: string;
	task: string;
	context: string;
	modelSpec?: string;
	thinking?: string;
	sessionFile: string;
	createdAt: number;
	status: "saved";
	parentSessionFile?: string | null;
}

const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
	task: {
		name: "task",
		description: "General coding worker",
		tools: ["read", "bash", "edit", "write"],
		prompt:
			"You are a focused coding worker. Complete only the assigned task. Inspect before editing, preserve unrelated work, verify with focused checks, and return a concise result. Do not delegate further.",
	},
	general: {
		name: "general",
		description: "General worker with the same tools as task",
		tools: ["read", "bash", "edit", "write"],
		prompt:
			"You are a focused general worker. Complete only the assigned task. Inspect before editing, preserve unrelated work, verify with focused checks, and return a concise result. Do not delegate further.",
	},
	scout: {
		name: "scout",
		description: "Read-only investigation",
		tools: ["read", "bash"],
		prompt:
			"You are a read-only investigator. Use read and bash only to inspect; never modify files or run state-changing commands. Return concise findings with file paths and line references.",
	},
	review: {
		name: "review",
		description: "Read-only code review",
		tools: ["read", "bash"],
		prompt:
			"You are a read-only code reviewer. Inspect the assignment and report concrete bugs, risks, and missing tests with file and line references. Do not modify files.",
	},
};

const TASK_DESCRIPTION =
	"Delegate independent work to subagents in one batch. Results auto-deliver, so do not poll. agent defaults to task; use scout or review for read-only work, or a custom agent name. Give each task a self-contained assignment; put shared background in context, not in every task.";

const WAIT_DESCRIPTION = "Wait for the first settled subagent result; use only when blocked.";

const TaskItem = Type.Object(
	{
		task: Type.String({ minLength: 1 }),
		agent: Type.Optional(Type.String()),
		solutionSpace: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
	},
	{ additionalProperties: false },
);

const TaskParams = Type.Object(
	{
		context: Type.String({ minLength: 1 }),
		tasks: Type.Array(TaskItem, { minItems: 1, maxItems: 8 }),
	},
	{ additionalProperties: false },
);

const WaitParams = Type.Object({}, { additionalProperties: false });

const AgentParams = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		message: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
	},
	{ additionalProperties: false },
);

const AGENT_DESCRIPTION =
	"Control a subagent. message: steer a running target, queue for a starting target, or resume a finished/saved target. model/thinking: switch its model or thinking; with message, switch before delivery. At least one of message, model, or thinking is required.";

const PI_TOOLS = new Set(["read", "bash", "edit", "write"]);
const BASH_ALIASES = new Set(["grep", "find", "glob", "ls", "rg", "ast_grep"]);

function parseList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const text = value.trim().replace(/^\[/, "").replace(/\]$/, "");
	const items = text
		.split(",")
		.map((item) => item.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function normalizeTools(tools: string[] | undefined): string[] {
	const out = new Set<string>();
	for (const tool of tools ?? []) {
		if (PI_TOOLS.has(tool)) out.add(tool);
		else if (BASH_ALIASES.has(tool)) out.add("bash");
	}
	if (out.size > 0) {
		if (out.has("bash")) out.add("read");
		return [...out];
	}
	return tools && tools.length > 0 ? ["read", "bash"] : ["read", "bash", "edit", "write"];
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
	const text = raw.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "").replace(/^\s*\n/, "");
	const lines = text.split("\n");
	if (lines[0] !== "---") return { data: {}, body: raw };
	let end = -1;
	for (let index = 1; index < lines.length; index++) {
		if (lines[index] === "---") {
			end = index;
			break;
		}
	}
	if (end < 0) return { data: {}, body: raw };
	const data: Record<string, string> = {};
	const frontmatter = lines.slice(1, end);
	for (let index = 0; index < frontmatter.length; index++) {
		const line = frontmatter[index];
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
		if (!value && index + 1 < frontmatter.length && /^\s*-\s+/.test(frontmatter[index + 1])) {
			const items: string[] = [];
			while (index + 1 < frontmatter.length && /^\s*-\s+/.test(frontmatter[index + 1])) {
				items.push(frontmatter[++index].replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
			}
			value = items.join(",");
		}
		if (key && value) data[key] = value;
	}
	return { data, body: lines.slice(end + 1).join("\n").replace(/^\s*\n/, "") };
}

function parseAgentFile(file: string, source: string): AgentDefinition | undefined {
	try {
		const raw = readFileSync(file, "utf8");
		const { data, body } = parseFrontmatter(raw);
		const name = (data.name || basename(file, ".md")).trim();
		if (!name) return undefined;
		return {
			name,
			description: data.description,
			tools: normalizeTools(parseList(data.tools)),
			prompt:
				body.trim() ||
				`You are the ${name} subagent. Complete only the assigned task and return a concise result.`,
			model: data.model,
			thinking: data.thinking || data["thinking-level"],
			source,
		};
	} catch {
		return undefined;
	}
}

function loadAgents(ctx: ExtensionContext): Record<string, AgentDefinition> {
	const agents: Record<string, AgentDefinition> = { ...BUILTIN_AGENTS };
	for (const dir of [join(getAgentDir(), "agents"), join(ctx.cwd, ".pi", "agents")]) {
		if (!existsSync(dir)) continue;
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const agent = parseAgentFile(join(dir, file), dir);
			if (agent) agents[agent.name] = agent;
		}
	}
	return agents;
}

function resolveAgent(agents: Record<string, AgentDefinition>, name: string | undefined): AgentDefinition {
	const key = name?.trim() || "task";
	const agent = agents[key] ?? (key === "worker" ? agents.task : undefined);
	if (!agent) {
		throw new Error(`Unknown agent: ${key}. Available: ${Object.keys(agents).sort().join(", ")}`);
	}
	return agent;
}

function thinkingFor(value: string | undefined): ThinkingLevel | undefined {
	switch (value) {
		case "off":
			return "off";
		case "minimal":
			return "minimal";
		case "lo":
		case "low":
			return "low";
		case "med":
		case "medium":
			return "medium";
		case "hi":
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		case "max":
			return "max";
		default:
			return undefined;
	}
}

function modelEffort(spec: string | undefined): string | undefined {
	if (!spec) return undefined;
	const colon = spec.lastIndexOf(":");
	if (colon < 0) return undefined;
	return thinkingFor(spec.slice(colon + 1));
}

function resolveModel(ctx: ExtensionContext, spec: string | undefined): any {
	if (!spec) return ctx.model;
	const slash = spec.indexOf("/");
	if (slash < 1 || slash === spec.length - 1) {
		throw new Error(`Model must be provider/id[:thinking], got ${JSON.stringify(spec)}`);
	}
	const provider = spec.slice(0, slash);
	const rest = spec.slice(slash + 1);
	const colon = rest.lastIndexOf(":");
	const suffix = colon > 0 ? rest.slice(colon + 1) : "";
	const id = thinkingFor(suffix) ? rest.slice(0, colon) : rest;
	const model = ctx.modelRegistry.find(provider, id);
	if (!model) throw new Error(`Model not available: ${provider}/${id}`);
	return model;
}

function textOf(message: any): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function modelLabel(spec: string | undefined, thinking: string | undefined): string {
	const base = spec?.replace(/:(off|minimal|low|medium|high|xhigh|max|lo|med|hi)$/, "") || "inherit";
	return `${base}:${thinking || "inherit"}`;
}

function preview(text: string, limit = 5000): string {
	if (text.length <= limit) return text;
	const head = text.slice(0, limit);
	const cut = head.lastIndexOf("\n");
	return (cut > limit / 2 ? head.slice(0, cut) : head) + "\n[preview truncated]";
}

function formatResult(result: TaskResult): string {
	const body = (result.error ? `<error>${result.error}</error>` : "")
		+ (result.text || !result.error ? `<output>\n${preview(result.text)}\n</output>` : "");
	const pointer =
		result.text.length > 5000 && result.sessionFile
			? `\n<full-transcript>${result.sessionFile}</full-transcript>`
			: "";
	return `<task-result id="${result.id}" agent="${result.agent}" status="${result.status}" duration="${Math.round(result.durationMs / 1000)}s">\n${body}${pointer}\n</task-result>`;
}

function readTail(file: string, bytes = 200_000): string {
	try {
		const size = statSync(file).size;
		const start = Math.max(0, size - bytes);
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(Math.min(bytes, size));
			const length = readSync(fd, buffer, 0, buffer.length, start);
			return buffer.subarray(0, length).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

function transcriptText(file: string): string {
	if (!existsSync(file)) return "(transcript not found)";
	const lines = readTail(file).trim().split("\n").slice(-2000);
	const out: string[] = [];
	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message?.role === "user") {
				const text = textOf(message);
				if (text) out.push(`USER:\n${text}`);
			} else if (message?.role === "assistant") {
				const text = textOf(message);
				if (text) out.push(`ASSISTANT:\n${text}`);
				for (const part of message.content ?? []) {
					if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
						out.push(`THINKING:\n${part.thinking.trim()}`);
					} else if (part?.type === "toolCall") {
						out.push(`TOOL CALL ${part.name}:\n${JSON.stringify(part.arguments ?? {}, null, 2)}`);
					}
				}
			} else if (message?.role === "toolResult") {
				out.push(`TOOL RESULT ${message.toolName}:\n${textOf(message)}`);
			}
		} catch {
			// Ignore malformed lines.
		}
	}
	const text = out.join("\n\n");
	return text.length > 50000 ? text.slice(-50000) : text;
}

interface TranscriptSnapshot {
	agent: {
		name: string;
		status: string;
		model?: string;
		thinking?: string;
		role?: string;
	};
	cwd: string;
	messages: any[];
	toolDefinitions: Map<string, any>;
	createdAt: number;
	activity?: { label: string; since: number };
}

function statusIcon(status: string): string {
	switch (status) {
		case "queued": return "◷";
		case "running": return "●";
		case "completed": return "✓";
		case "failed": return "✗";
		case "stopped": return "■";
		default: return "○";
	}
}

function statusColor(status: string): string {
	switch (status) {
		case "queued": return "dim";
		case "running": return "warning";
		case "completed": return "success";
		case "failed": return "error";
		case "stopped": return "muted";
		default: return "muted";
	}
}

function framedRow(theme: any, content: string, innerWidth: number, selected = false): string {
	let body = truncateToWidth(content, innerWidth, "", true);
	if (selected) body = theme.bg("selectedBg", body);
	return `${theme.fg("border", "│")}${body}${theme.fg("border", "│")}`;
}

function framedRule(theme: any, innerWidth: number, left: string, right: string): string {
	return theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
}

function contentText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
		.filter(Boolean)
		.join("\n");
}

function formatTimestamp(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "unknown";
	return new Date(timestamp).toLocaleString();
}

function buildSnapshot(task: TaskRecord | SavedTask, cwd: string): TranscriptSnapshot {
	const file = task.sessionFile;
	const messages: any[] = [];
	if (file && existsSync(file)) {
		for (const line of readTail(file, 2_000_000).split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type === "message" && entry.message) messages.push(entry.message);
		}
	}
	const record = task as TaskRecord;
	const saved = task as SavedTask;
	return {
		agent: {
			name: task.name,
			status: task.status,
			model: "resolvedModel" in record ? record.resolvedModel ?? record.modelSpec : saved.modelSpec,
			thinking: "resolvedThinking" in record ? record.resolvedThinking ?? record.thinking : saved.thinking,
			role: task.agent,
		},
		cwd,
		messages,
		toolDefinitions: "toolDefinitions" in record ? record.toolDefinitions ?? new Map() : new Map(),
		createdAt: "startedAt" in record ? record.startedAt : saved.createdAt,
		activity: "activity" in record && record.activity
			? { label: record.activity, since: record.startedAt }
			: undefined,
	};
}

class TranscriptViewer {
	private snapshot?: TranscriptSnapshot;
	private error?: string;
	private content = new Container();
	private scrollOffset = 0;
	private followTail = true;
	private expandedTools = false;
	private hideThinking = false;
	private lastBodyHeight = 1;
	private lastBodyLines = 0;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private toolDefinitions = new Map<string, any>();
	private toolComponents = new Map<string, ToolExecutionComponent>();
	private readonly clock: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: any,
		private readonly theme: any,
		private readonly keybindings: any,
		private readonly loadTranscript: () => TranscriptSnapshot,
		private readonly done: () => void,
	) {
		this.refresh();
		this.clock = setInterval(() => {
			if (this.snapshot?.agent.status === "running") {
				this.refresh();
				this.tui.requestRender();
			}
		}, 1000);
		(this.clock as any).unref?.();
	}

	private refresh(): void {
		try {
			this.snapshot = this.loadTranscript();
			this.toolDefinitions = new Map(this.snapshot.toolDefinitions);
			this.error = undefined;
			this.rebuildContent();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private rebuildContent(): void {
		this.content = new Container();
		this.toolComponents.clear();
		const snapshot = this.snapshot;
		if (!snapshot) return;
		const markdownTheme = getMarkdownTheme();
		const pendingTools = new Map<string, ToolExecutionComponent>();

		for (const message of snapshot.messages) {
			switch (message.role) {
				case "user": {
					const text = contentText(message.content);
					if (text) {
						if (this.content.children.length > 0) this.content.addChild(new Spacer(1));
						this.content.addChild(new UserMessageComponent(text, markdownTheme, 0));
					}
					break;
				}
				case "assistant": {
					this.content.addChild(new AssistantMessageComponent(message, this.hideThinking, markdownTheme, "thinking hidden", 0));
					for (const block of message.content ?? []) {
						if (block.type !== "toolCall") continue;
						let component = this.toolComponents.get(block.id);
						if (!component) {
							component = new ToolExecutionComponent(
								block.name,
								block.id,
								block.arguments,
								{ showImages: false },
								this.toolDefinitions.get(block.name),
								this.tui,
								snapshot.cwd,
							);
							this.toolComponents.set(block.id, component);
							component.markExecutionStarted();
							component.setArgsComplete();
						}
						component.setExpanded(this.expandedTools);
						this.content.addChild(component);
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							component.updateResult({
								content: [{
									type: "text",
									text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error"),
								}],
								isError: true,
							});
						} else {
							pendingTools.set(block.id, component);
						}
					}
					break;
				}
				case "toolResult": {
					const component = pendingTools.get(message.toolCallId);
					if (component) {
						component.updateResult(message);
						pendingTools.delete(message.toolCallId);
					} else {
						const text = contentText(message.content);
						this.content.addChild(new Text(
							this.theme.fg(message.isError ? "error" : "toolOutput", `[${message.toolName}] ${text}`),
							1,
							0,
						));
					}
					break;
				}
				case "custom": {
					if (message.display) {
						const component = new CustomMessageComponent(message, undefined, markdownTheme, 0);
						component.setExpanded(this.expandedTools);
						this.content.addChild(component);
					}
					break;
				}
				case "bashExecution": {
					const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
					component.appendOutput(message.output + (message.truncated ? "\n[output truncated]" : ""));
					component.setExpanded(this.expandedTools);
					component.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
					this.content.addChild(component);
					break;
				}
				case "compactionSummary": {
					const component = new CompactionSummaryMessageComponent(message, markdownTheme);
					component.setExpanded(this.expandedTools);
					this.content.addChild(component);
					break;
				}
				case "branchSummary": {
					const component = new BranchSummaryMessageComponent(message, markdownTheme);
					component.setExpanded(this.expandedTools);
					this.content.addChild(component);
					break;
				}
			}
		}
	}

	private maxScroll(): number {
		return Math.max(0, this.lastBodyLines - this.lastBodyHeight);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "app.tools.expand")) {
			this.expandedTools = !this.expandedTools;
			this.rebuildContent();
		} else if (this.keybindings.matches(data, "app.thinking.toggle")) {
			this.hideThinking = !this.hideThinking;
			this.rebuildContent();
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			this.followTail = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.scrollOffset = Math.min(this.maxScroll(), this.scrollOffset + 1);
			this.followTail = this.scrollOffset >= this.maxScroll();
		} else if (this.keybindings.matches(data, "tui.editor.cursorLeft") || matchesKey(data, "pageUp")) {
			this.followTail = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - this.lastBodyHeight);
		} else if (this.keybindings.matches(data, "tui.editor.cursorRight") || matchesKey(data, "pageDown")) {
			this.scrollOffset = Math.min(this.maxScroll(), this.scrollOffset + this.lastBodyHeight);
			this.followTail = this.scrollOffset >= this.maxScroll();
		} else if (matchesKey(data, "home")) {
			this.followTail = false;
			this.scrollOffset = 0;
		} else if (matchesKey(data, "end")) {
			this.followTail = true;
			this.scrollOffset = this.maxScroll();
		} else if (data === "t") {
			this.followTail = false;
			this.scrollOffset = 0;
		} else if (data === "b") {
			this.followTail = true;
			this.scrollOffset = this.maxScroll();
		} else if (data === "r") {
			this.refresh();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const bodyHeight = Math.max(1, Math.floor(this.tui.terminal.rows * 0.84) - 7);
		const bodyLines = this.error
			? [this.theme.fg("error", this.error)]
			: this.content.render(innerWidth);
		this.lastBodyHeight = bodyHeight;
		this.lastBodyLines = bodyLines.length;
		const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
		if (this.followTail) this.scrollOffset = maxScroll;
		else this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const visible = bodyLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
		const snapshot = this.snapshot;
		const agent = snapshot?.agent;
		const title = agent
			? `${statusIcon(agent.status)} ${agent.name}${agent.role ? ` (${agent.role})` : ""}`
			: "Sub-agent transcript";
		const metadata = agent
			? `${agent.status} · thinking ${agent.thinking ?? "unknown"} · ${agent.model ?? "inherit"} · ${snapshot.messages.length} messages`
			: "unavailable";
		const scroll = bodyLines.length > bodyHeight
			? ` · lines ${this.scrollOffset + 1}-${Math.min(bodyLines.length, this.scrollOffset + bodyHeight)}/${bodyLines.length}`
			: "";
		const lines = [
			framedRule(this.theme, innerWidth, "╭", "╮"),
			framedRow(this.theme, ` ${this.theme.fg("accent", this.theme.bold(title))}`, innerWidth),
			framedRow(this.theme, ` ${this.theme.fg("dim", `${metadata}${scroll}`)}`, innerWidth),
			framedRule(this.theme, innerWidth, "├", "┤"),
		];
		for (const line of visible) lines.push(framedRow(this.theme, line, innerWidth));
		for (let index = visible.length; index < bodyHeight; index++) lines.push(framedRow(this.theme, "", innerWidth));
		lines.push(
			framedRule(this.theme, innerWidth, "├", "┤"),
			framedRow(
				this.theme,
				` ${this.theme.fg("dim", `Esc close · ↑↓ scroll · ←→ page · t/b ends · ^O tools ${this.expandedTools ? "on" : "off"} · ^T thinking ${this.hideThinking ? "hidden" : "shown"} · r refresh`)}`,
				innerWidth,
			),
			framedRow(this.theme, ` ${this.theme.fg("dim", snapshot ? `created ${formatTimestamp(snapshot.createdAt)}` : "Read-only")}`, innerWidth),
			framedRule(this.theme, innerWidth, "╰", "╯"),
		);
		return lines;
	}

	invalidate(): void {
		this.content.invalidate();
	}

	dispose(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		clearInterval(this.clock);
		this.toolComponents.clear();
	}
}

async function showTranscript(ctx: ExtensionContext, id: string, task: TaskRecord | SavedTask): Promise<void> {
	const file = task.sessionFile;
	if (!file) {
		ctx.ui.notify(`No transcript for ${id}`, "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(transcriptText(file).slice(0, 2000) || "(empty transcript)", "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => {
			let viewer: TranscriptViewer;
			viewer = new TranscriptViewer(
				tui,
				theme,
				keybindings,
				() => buildSnapshot(task, ctx.cwd),
				() => {
					viewer.dispose();
					done();
				},
			);
			return viewer;
		},
		{ overlay: true, overlayOptions: { width: "92%", maxHeight: "90%" } },
	);
}

function sessionDir(ctx: ExtensionContext): string {
	return join(getAgentDir(), "subagents", ctx.sessionManager.getSessionId());
}

function readHead(file: string, bytes = 65536): string {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(bytes);
		const length = readSync(fd, buffer, 0, bytes, 0);
		return buffer.subarray(0, length).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function loadSaved(ctx: ExtensionContext): SavedTask[] {
	const dir = sessionDir(ctx);
	if (!existsSync(dir)) return [];
	const saved: SavedTask[] = [];
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return saved;
	}
	for (const file of files) {
		if (!file.endsWith(".jsonl")) continue;
		const path = join(dir, file);
		let header: any;
		let meta: any;
		let modelOverride: any;
		try {
			for (const line of readTail(path, 256_000).split("\n")) {
				if (!line.trim()) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry.type === "custom" && entry.customType === "omp-subagent-model") {
					modelOverride = entry.data;
				}
			}
			for (const line of readHead(path).split("\n").slice(0, 80)) {
				if (!line.trim()) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry.type === "session") header = entry;
				if (entry.type === "custom" && entry.customType === "omp-subagent") meta = entry.data;
			}
		} catch {
			continue;
		}
		if (!meta) continue;
		saved.push({
			id: meta.id ?? header?.id ?? basename(file, ".jsonl"),
			name: meta.name ?? meta.id ?? basename(file, ".jsonl"),
			agent: meta.agent ?? "task",
			task: meta.task ?? "",
			context: meta.context ?? "",
			modelSpec: modelOverride?.model ?? meta.model,
			thinking: modelOverride?.thinking ?? meta.thinking,
			sessionFile: path,
			createdAt: Number(meta.createdAt ?? Date.parse(header?.timestamp ?? "")) || 0,
			status: "saved",
			parentSessionFile: meta.parentSessionFile ?? null,
		});
	}
	return saved.sort((a, b) => b.createdAt - a.createdAt);
}

function cleanOrphans(): void {
	if (CONFIG.autoCleanOrphans === false) return;
	const root = join(getAgentDir(), "subagents");
	if (!existsSync(root)) return;
	let dirs: string[];
	try {
		dirs = readdirSync(root);
	} catch {
		return;
	}
	for (const name of dirs) {
		const dir = join(root, name);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		let files: string[];
		try {
			files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}
		let parentFile: string | null | undefined;
		for (const file of files) {
			try {
				for (const line of readHead(join(dir, file)).split("\n").slice(0, 80)) {
					if (!line.trim()) continue;
					let entry: any;
					try {
						entry = JSON.parse(line);
					} catch {
						continue;
					}
					if (entry.type === "custom" && entry.customType === "omp-subagent") {
						parentFile = entry.data?.parentSessionFile;
						break;
					}
				}
			} catch {
				// Ignore unreadable child sessions.
			}
			if (parentFile !== undefined) break;
		}
		if (parentFile && !existsSync(resolve(parentFile))) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best effort.
			}
		}
	}
}

function persistModelSelection(file: string, cwd: string, modelSpec: string | undefined, thinking: string | undefined): void {
	if (!file || !existsSync(file)) return;
	const manager = SessionManager.open(file, dirname(file), cwd);
	manager.appendCustomEntry("omp-subagent-model", {
		model: modelSpec,
		thinking,
		createdAt: Date.now(),
	});
}

interface Waiter {
	resolve: (result: TaskResult | undefined) => void;
	reject: (error: Error) => void;
}

class SubagentManager {
	private tasks = new Map<string, TaskRecord>();
	private pending: TaskResult[] = [];
	private sent = new Set<string>();
	private context?: ExtensionContext;
	private waiters: Waiter[] = [];
	private slotWaiters: Array<() => void> = [];
	private flushTimer?: ReturnType<typeof setTimeout>;
	private ticker?: ReturnType<typeof setInterval>;
	private ui?: ExtensionContext["ui"];
	private closed = false;
	private active = 0;
	private readonly maxConcurrent = (() => {
		const raw = Number(CONFIG.maxConcurrent ?? 2);
		if (!Number.isFinite(raw)) return 2;
		return Math.max(1, Math.min(32, Math.floor(raw)));
	})();

	constructor(private pi: ExtensionAPI) {}

	setContext(ctx: ExtensionContext): void {
		this.ui = ctx.ui;
		this.context = ctx;
		this.pruneDelivered();
	}

	private ensureTicker(): void {
		if (this.ticker) return;
		this.ticker = setInterval(() => this.renderWidget(), 1000);
		(this.ticker as any).unref?.();
	}

	private stopTicker(): void {
		if (!this.ticker) return;
		clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private renderWidget(): void {
		if (this.closed) return;
		const active = this.list().filter(
			(record) => record.status === "queued" || record.status === "running",
		);
		if (active.length === 0) {
			this.stopTicker();
			try {
				this.ui?.setWidget("subagents", undefined, { placement: "belowEditor" });
			} catch {
				// UI may be stale after a session replacement.
			}
			return;
		}
		this.ensureTicker();
		const lines = [`Subagents · ${active.length} active`];
		for (const record of active.slice(0, 6)) {
			const elapsed = Math.max(0, Math.round((Date.now() - record.startedAt) / 1000));
			const icon = record.status === "queued" ? "○" : "●";
			const activity = record.activity ? ` · ${record.activity}` : "";
			const tools = record.toolCount ? ` · ${record.toolCount} tools` : "";
			const model = modelLabel(
				record.resolvedModel ?? record.modelSpec,
				record.resolvedThinking ?? record.thinking,
			);
			lines.push(`${icon} ${record.agent} ${record.name} · ${elapsed}s · ${model}${tools}${activity}`);
		}
		if (active.length > 6) lines.push(`+${active.length - 6} more`);
		try {
			this.ui?.setWidget("subagents", lines, { placement: "belowEditor" });
		} catch {
			// UI may be stale after a session replacement.
		}
	}

	async start(ctx: ExtensionContext, context: string, tasks: TaskInput[]): Promise<TaskRecord[]> {
		const agents = loadAgents(ctx);
		const prepared = tasks.map((input) => {
			const agentDef = resolveAgent(agents, input.agent);
			const modelSpec = input.model ?? agentDef.model;
			if (modelSpec) resolveModel(ctx, modelSpec);
			return { input, agentDef };
		});
		const records: TaskRecord[] = [];
		for (const { input, agentDef } of prepared) {
			const id = `agent-${randomUUID().slice(0, 8)}`;
			const record: TaskRecord = {
				id,
				name: input.name?.trim() || id,
				agent: agentDef.name,
				task: input.solutionSpace?.trim()
					? `${input.task}\n\n# Solution space\n${input.solutionSpace.trim()}`
					: input.task,
				context,
				status: "queued",
				startedAt: Date.now(),
				finished: false,
				modelSpec: input.model ?? agentDef.model,
				thinking:
					thinkingFor(input.thinking) ??
					modelEffort(input.model) ??
					thinkingFor(agentDef.thinking) ??
					modelEffort(agentDef.model),
				agentDef,
				resolvedModel:
					input.model ??
					agentDef.model ??
					(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
				resolvedThinking:
					thinkingFor(input.thinking) ??
					modelEffort(input.model) ??
					thinkingFor(agentDef.thinking) ??
					modelEffort(agentDef.model) ??
					ctx.thinkingLevel,
			};
			this.tasks.set(id, record);
			records.push(record);
			void this.run(ctx, record, input);
		}
		this.renderWidget();
		return records;
	}

	async resume(
		ctx: ExtensionContext,
		id: string,
		task: string,
		modelSpec?: string,
		thinking?: string,
	): Promise<TaskRecord> {
		const active = this.tasks.get(id);
		if (active && !active.finished) {
			throw new Error(`Subagent ${id} is still running or stopping`);
		}
		const saved = loadSaved(ctx).find((item) => item.id === id);
		if (!saved) throw new Error(`Unknown subagent: ${id}`);
		const dir = sessionDir(ctx);
		const sessionManager = SessionManager.open(saved.sessionFile, dir, ctx.cwd);
		const record: TaskRecord = {
			id: saved.id,
			name: saved.name,
			agent: saved.agent,
			task,
			context: saved.context,
			status: "queued",
			startedAt: Date.now(),
			finished: false,
			modelSpec: modelSpec ?? saved.modelSpec,
			thinking: thinking ?? modelEffort(modelSpec) ?? saved.thinking ?? modelEffort(saved.modelSpec),
			resolvedModel:
				modelSpec ??
				saved.modelSpec ??
				(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
			resolvedThinking:
				thinking ??
				modelEffort(modelSpec) ??
				saved.thinking ??
				modelEffort(saved.modelSpec) ??
				ctx.thinkingLevel,
			sessionFile: saved.sessionFile,
		};
		this.tasks.set(id, record);
		void this.run(ctx, record, { task, agent: saved.agent, resume: true }, sessionManager);
		return record;
	}

	private async acquire(): Promise<void> {
		if (this.active < this.maxConcurrent) {
			this.active++;
			return;
		}
		await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
	}

	private release(): void {
		const next = this.slotWaiters.shift();
		if (next) next();
		else this.active = Math.max(0, this.active - 1);
	}

	private async run(
		ctx: ExtensionContext,
		record: TaskRecord,
		input: TaskInput,
		existingSessionManager?: SessionManager,
	): Promise<void> {
		await this.acquire();
		if (this.closed || record.finished || record.stopRequested) {
			this.release();
			return;
		}
		record.status = "running";
		record.startedAt = Date.now();
		this.renderWidget();
		try {
			const agentDef = record.agentDef ?? resolveAgent(loadAgents(ctx), record.agent);
			record.agentDef = agentDef;
			const dir = sessionDir(ctx);
			mkdirSync(dir, { recursive: true });
			const sessionManager = existingSessionManager ?? SessionManager.create(ctx.cwd, dir);
			if (!existingSessionManager) {
				sessionManager.appendCustomEntry("omp-subagent", {
					version: 1,
					id: record.id,
					parentSessionId: ctx.sessionManager.getSessionId(),
					agent: record.agent,
					name: record.name,
					task: record.task,
					context: record.context,
					model: record.modelSpec,
					thinking: record.thinking,
					parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
					createdAt: record.startedAt,
				});
			} else {
				sessionManager.appendCustomEntry("omp-subagent-resume", {
					version: 1,
					id: record.id,
					task: record.task,
					createdAt: record.startedAt,
				});
			}
			const settings = SettingsManager.create(ctx.cwd, getAgentDir());
			const loader = new DefaultResourceLoader({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				settingsManager: settings,
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
				systemPrompt: agentDef.prompt,
			});
			await loader.reload();
			const modelRuntime = await this.childRuntime(ctx);
			const model = resolveModel(ctx, record.modelSpec);
			const thinkingLevel = thinkingFor(record.thinking) ?? ctx.thinkingLevel;
			if (this.closed || record.finished || record.stopRequested) {
				throw new Error("Stopped by user");
			}
			const { session: child } = await createAgentSession({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				settingsManager: settings,
				resourceLoader: loader,
				modelRuntime,
				model,
				thinkingLevel,
				sessionManager,
				tools: agentDef.tools,
			});
			record.child = child;
			record.toolDefinitions = new Map(
				child.getAllTools().map((tool: any) => [tool.name, child.getToolDefinition(tool.name)]),
			);
			record.resolvedModel = child.model ? `${child.model.provider}/${child.model.id}` : record.modelSpec;
			record.resolvedThinking = child.thinkingLevel ?? thinkingLevel;
			record.sessionFile = child.sessionManager.getSessionFile() ?? record.sessionFile;
			this.renderWidget();
			let lastAssistant: any;
			record.unsubscribe = child.subscribe((event: any) => {
				if (event?.type === "message_end" && event.message?.role === "assistant") {
					lastAssistant = event.message;
				}
				if (event?.type === "tool_execution_start") {
					record.activity = event.toolName;
					record.toolCount = (record.toolCount ?? 0) + 1;
					this.renderWidget();
				}
			});
			await child.bindExtensions({ mode: "print" });
			if (this.closed || record.finished || record.stopRequested) {
				throw new Error("Stopped by user");
			}
			const pending = record.pendingMessages ?? [];
			record.pendingMessages = [];
			const prompt = input.resume
				? `# Follow-up\n${record.task}`
				: `${record.context}\n\n# Assignment\n${record.task}`;
			const promptWithPending = pending.length > 0
				? `${prompt}\n\n# Queued message\n${pending.join("\n\n")}`
				: prompt;
			record.promptStarted = true;
			await child.prompt(promptWithPending);
			// Read this run's events, not old history (whose length can change during compaction).
			const last = lastAssistant;
			record.result = textOf(last);
			if (record.stopRequested || last?.stopReason === "aborted") {
				record.status = "stopped";
				record.error ??= last?.errorMessage || "Subagent aborted";
			} else if (!last || last.stopReason === "error" || last.stopReason === "length" || !record.result) {
				record.status = "failed";
				record.error = last?.errorMessage || (last?.stopReason === "length"
					? "Subagent reached its output limit"
					: "Subagent produced no assistant text");
			} else {
				record.status = "completed";
			}
		} catch (error) {
			record.status = record.status === "stopped" ? "stopped" : "failed";
			record.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (record.stopTimer) {
				clearTimeout(record.stopTimer);
				record.stopTimer = undefined;
			}
			record.endedAt = Date.now();
			record.finished = true;
			try {
				record.unsubscribe?.();
			} catch {
				// Best effort.
			}
			try {
				record.child?.dispose?.();
			} catch {
				// Best effort.
			}
			// Capacity belongs to the actual run, not to an early stop notification.
			this.release();
			if (!record.finalized) this.deliver(record);
			this.settleWaiters();
			this.renderWidget();
		}
	}

	private async childRuntime(ctx: ExtensionContext): Promise<ModelRuntime> {
		const runtime = await ModelRuntime.create({
			authPath: join(getAgentDir(), "auth.json"),
			modelsPath: join(getAgentDir(), "models.json"),
			refreshOnCreate: false,
		});
		for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
			const native = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
			if (native) {
				runtime.registerNativeProvider(native);
				continue;
			}
			const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
			if (config) runtime.registerProvider(providerId, config);
		}
		return runtime;
	}

	private deliver(record: TaskRecord): void {
		if (this.closed || record.finalized) return;
		record.finalized = true;
		this.pruneDelivered();
		const result: TaskResult = {
			deliveryId: randomUUID(),
			id: record.id,
			name: record.name,
			agent: record.agent,
			status: record.status,
			text: record.result ?? "",
			sessionFile: record.sessionFile,
			error: record.error,
			durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
		};
		this.renderWidget();
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve(result);
			this.settleWaiters();
			return;
		}
		this.pending.push(result);
		this.scheduleFlush();
		this.settleWaiters();
	}

	private hasActive(): boolean {
		return [...this.tasks.values()].some((record) => !record.finished);
	}

	private settleWaiters(): void {
		if (!this.hasActive()) {
			for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined);
		}
	}

	private pruneDelivered(): void {
		// A handed-off notification is not an acknowledgement. Keep the mailbox until
		// the report is actually in the parent transcript, or wait() consumes it.
		if (this.pending.length === 0) return;
		const acknowledged = new Set<string>();
		for (const entry of this.context?.sessionManager.getBranch() ?? []) {
			if (entry.type !== "custom_message" || entry.customType !== "subagent-result") continue;
			const details = entry.details as { deliveryId?: string; results?: TaskResult[] } | undefined;
			for (const result of Array.isArray(details?.results) ? details.results : details ? [details] : []) {
				if (typeof result?.deliveryId === "string") acknowledged.add(result.deliveryId);
			}
		}
		this.pending = this.pending.filter((result) => {
			if (!acknowledged.has(result.deliveryId)) return true;
			this.sent.delete(result.deliveryId);
			return false;
		});
	}

	private scheduleFlush(): void {
		if (this.closed || this.flushTimer || !this.pending.some((result) => !this.sent.has(result.deliveryId))) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flushPending();
		}, 50);
	}

	private flushPending(): void {
		if (this.closed || this.pending.length === 0) return;
		this.pruneDelivered();
		const results = this.pending.filter((result) => !this.sent.has(result.deliveryId));
		if (results.length === 0) return;
		try {
			// Pi persists context-only messages immediately when idle, or at the next
			// safe turn boundary when busy. Unlike follow-ups, clearQueue() cannot
			// discard this report. Only the small wake-up message is best-effort.
			this.pi.sendMessage(
				{
					customType: "subagent-result",
					content: results.map(formatResult).join("\n"),
					display: true,
					details: results.length === 1 ? results[0] : { results },
				},
				{ triggerTurn: false },
			);
			for (const result of results) this.sent.add(result.deliveryId);
			this.pi.sendMessage(
				{ customType: "subagent-ready", content: "Subagent results are available above.", display: false },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// Keep unacknowledged reports recoverable through wait() after a failed send.
		}
	}

	async wait(signal?: AbortSignal): Promise<TaskResult | undefined> {
		if (signal?.aborted) throw new Error("aborted");
		this.pruneDelivered();
		if (this.pending.length > 0) {
			const result = this.pending.shift()!;
			this.sent.delete(result.deliveryId);
			this.scheduleFlush();
			return result;
		}
		if (!this.hasActive()) return undefined;
		return await new Promise<TaskResult | undefined>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject };
			this.waiters.push(waiter);
			const onAbort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(new Error("aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const originalResolve = waiter.resolve;
			waiter.resolve = (result) => {
				signal?.removeEventListener("abort", onAbort);
				originalResolve(result);
			};
		});
	}

	private async switchModel(
		ctx: ExtensionContext,
		id: string,
		modelSpec?: string,
		thinking?: string,
	): Promise<TaskRecord | SavedTask> {
		const model = modelSpec ? resolveModel(ctx, modelSpec) : undefined;
		const active = this.tasks.get(id);
		const saved = active ? undefined : loadSaved(ctx).find((item) => item.id === id);
		const record = active ?? saved;
		if (!record) throw new Error(`Unknown subagent: ${id}`);
		const nextModel = modelSpec ?? record.modelSpec;
		const nextThinking = thinking ?? modelEffort(modelSpec) ?? record.thinking ?? modelEffort(nextModel);
		if (active?.status === "running" && active.child) {
			if (model) await active.child.setModel(model);
			if (nextThinking) active.child.setThinkingLevel(nextThinking);
			active.modelSpec = nextModel;
			active.thinking = nextThinking;
			active.resolvedModel = active.child.model
				? `${active.child.model.provider}/${active.child.model.id}`
				: nextModel;
			active.resolvedThinking = active.child.thinkingLevel ?? nextThinking;
			persistModelSelection(active.sessionFile, ctx.cwd, active.modelSpec, active.thinking);
			return active;
		}
		if (active) {
			active.modelSpec = nextModel;
			active.thinking = nextThinking;
			active.resolvedModel = nextModel;
			active.resolvedThinking = nextThinking;
			persistModelSelection(active.sessionFile, ctx.cwd, nextModel, nextThinking);
			return active;
		}
		persistModelSelection(saved!.sessionFile, ctx.cwd, nextModel, nextThinking);
		return { ...saved!, modelSpec: nextModel, thinking: nextThinking };
	}

	async message(
		ctx: ExtensionContext,
		id: string,
		message: string,
		modelSpec?: string,
		thinking?: string,
	): Promise<{ kind: "steered" | "queued" | "resumed"; record: TaskRecord }> {
		if (modelSpec || thinking) await this.switchModel(ctx, id, modelSpec, thinking);
		const active = this.tasks.get(id);
		if (active?.status === "running") {
			if (active.child && active.promptStarted) {
				await active.child.steer(message);
				return { kind: "steered", record: active };
			}
			(active.pendingMessages ??= []).push(message);
			return { kind: "queued", record: active };
		}
		if (active?.status === "queued") {
			(active.pendingMessages ??= []).push(message);
			return { kind: "queued", record: active };
		}
		const record = await this.resume(ctx, id, message, modelSpec, thinking);
		return { kind: "resumed", record };
	}

	async switchOnly(
		ctx: ExtensionContext,
		id: string,
		modelSpec?: string,
		thinking?: string,
	): Promise<TaskRecord | SavedTask> {
		return await this.switchModel(ctx, id, modelSpec, thinking);
	}

	stop(id: string): TaskRecord | undefined {
		const record = this.tasks.get(id);
		if (!record) return undefined;
		if (record.status === "queued") {
			record.status = "stopped";
			record.error = "Stopped by user";
			record.endedAt = Date.now();
			record.finished = true;
			this.deliver(record);
			this.renderWidget();
			return record;
		}
		if (record.status === "running") {
			record.status = "stopped";
			record.error = "Stopped by user";
			record.stopRequested = true;
			try {
				record.child?.abort?.();
			} catch {
				// Best effort.
			}
			record.stopTimer = setTimeout(() => this.forceFinish(record), 5000);
			(record.stopTimer as any).unref?.();
			this.renderWidget();
		}
		return record;
	}

	private forceFinish(record: TaskRecord): void {
		if (record.finished || record.finalized) return;
		record.endedAt = Date.now();
		try {
			record.child?.abort?.();
			record.child?.dispose?.();
		} catch {
			// Best effort.
		}
		// Report the stop, but do not reuse its slot or transcript until run() settles.
		this.deliver(record);
		this.renderWidget();
	}

	list(): TaskRecord[] {
		return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	hasLive(): boolean {
		return [...this.tasks.values()].some(
			(record) =>
				!record.finished ||
				record.status === "queued" ||
				record.status === "running",
		);
	}

	clearFinished(): void {
		for (const [id, record] of this.tasks) {
			if (record.finished && record.finalized) this.tasks.delete(id);
		}
	}

	async listAll(ctx: ExtensionContext): Promise<Array<TaskRecord | SavedTask>> {
		cleanOrphans();
		const active = this.list();
		const saved = loadSaved(ctx).filter((item) => !this.tasks.has(item.id));
		return [...active, ...saved];
	}

	async getAny(ctx: ExtensionContext, id: string): Promise<TaskRecord | SavedTask | undefined> {
		cleanOrphans();
		return this.tasks.get(id) ?? loadSaved(ctx).find((item) => item.id === id);
	}

	shutdown(): void {
		this.closed = true;
		this.stopTicker();
		try {
			this.ui?.setWidget("subagents", undefined, { placement: "belowEditor" });
		} catch {
			// Best effort.
		}
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.pending.length = 0;
		this.sent.clear();
		for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("Session closed"));
		for (const resolve of this.slotWaiters.splice(0)) resolve();
		this.active = 0;
		for (const record of this.tasks.values()) {
			if (record.stopTimer) {
				clearTimeout(record.stopTimer);
				record.stopTimer = undefined;
			}
			try {
				record.unsubscribe?.();
			} catch {
				// Best effort.
			}
			if (record.status === "queued" || record.status === "running") {
				record.status = "stopped";
				record.error = "Session closed";
				record.endedAt = Date.now();
				record.finished = true;
			}
			try {
				record.child?.abort?.();
			} catch {
				// Best effort.
			}
		}
	}
}

export default function (pi: ExtensionAPI) {
	let manager: SubagentManager | undefined;

	const getManager = (ctx: ExtensionContext): SubagentManager => {
		if (!manager) manager = new SubagentManager(pi);
		manager.setContext(ctx);
		return manager;
	};

	pi.on("session_start", () => {
		cleanOrphans();
	});

	pi.on("session_shutdown", () => {
		manager?.shutdown();
		manager = undefined;
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description: TASK_DESCRIPTION,
		promptSnippet: "Delegate tasks to subagents",
		parameters: TaskParams,
		renderCall(args: any, theme: any) {
			const count = Array.isArray(args?.tasks) ? args.tasks.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("task ")) +
					theme.fg("accent", `${count} subagent${count === 1 ? "" : "s"}`),
				0,
				0,
			);
		},
		renderResult(result: any, _options: any, theme: any) {
			const text = (result?.content ?? [])
				.filter((part: any) => part?.type === "text")
				.map((part: any) => part.text)
				.join("\n");
			return new Text(theme.fg("muted", text || "subagents started"), 0, 0);
		},
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const mgr = getManager(ctx);
			const records = await mgr.start(ctx, params.context, params.tasks);
			const lines = records.map(
				(record) => `${record.id} ${record.agent} ${record.name} started`,
			);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { tasks: records.map((record) => ({ id: record.id, name: record.name, agent: record.agent })) },
			};
		},
	});

	pi.registerTool({
		name: "wait",
		label: "Wait",
		description: WAIT_DESCRIPTION,
		promptSnippet: "Wait for subagent results",
		parameters: WaitParams,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const mgr = getManager(ctx);
			const result = await mgr.wait(signal);
			if (!result) {
				return { content: [{ type: "text", text: "No running subagents." }], details: {} };
			}
			return { content: [{ type: "text", text: formatResult(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "agent",
		label: "Agent",
		description: AGENT_DESCRIPTION,
		promptSnippet: "Message or resume a subagent",
		parameters: AgentParams,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const mgr = getManager(ctx);
			const message = params.message?.trim();
			const thinking = thinkingFor(params.thinking);
			if (!message && !params.model && !thinking) {
				return { content: [{ type: "text", text: "Provide message, model, or thinking." }], isError: true, details: {} };
			}
			if (!message) {
				const record = await mgr.switchOnly(ctx, params.id, params.model, thinking);
				return {
					content: [{ type: "text", text: `Switched subagent ${record.id} to ${modelLabel(record.modelSpec, record.thinking)}` }],
					details: { id: record.id, status: record.status, agent: record.agent, name: record.name, kind: "switched" },
				};
			}
			const outcome = await mgr.message(ctx, params.id, message, params.model, thinking);
			const text =
				outcome.kind === "steered"
					? `Message queued to running subagent ${outcome.record.id}`
					: outcome.kind === "queued"
						? `Message queued until subagent ${outcome.record.id} starts`
						: `Resumed subagent ${outcome.record.id} with a follow-up task`;
			return {
				content: [{ type: "text", text }],
				details: {
					id: outcome.record.id,
					status: outcome.record.status,
					agent: outcome.record.agent,
					name: outcome.record.name,
					kind: outcome.kind,
				},
			};
		},
	});

	pi.registerCommand("subagents", {
		description: "List, view, resume, stop or clean subagent sessions: /subagents [view|resume|stop|clean] [id] [task]",
		handler: async (args, ctx) => {
			const mgr = getManager(ctx);
			const parts = args.trim().split(/\s+/);
			const action = parts[0] || "";
			const id = parts[1];
			const rest = parts.slice(2).join(" ").trim();
			if (action === "clean") {
				if (mgr.hasLive()) {
					ctx.ui.notify("Stop active subagents before cleaning saved sessions.", "warning");
					return;
				}
				const dir = sessionDir(ctx);
				if (!existsSync(dir)) {
					ctx.ui.notify("No saved subagent sessions.", "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("Use /subagents clean in interactive mode.", "warning");
					return;
				}
				const ok = await ctx.ui.confirm(
					"Delete subagent sessions?",
					`Delete ${dir}? This cannot be undone.`,
				);
				if (!ok) return;
				rmSync(dir, { recursive: true, force: true });
				mgr.clearFinished();
				ctx.ui.notify("Deleted saved subagent sessions.", "info");
				return;
			}
			if (action === "stop" && id) {
				const record = mgr.stop(id);
				if (!record) ctx.ui.notify(`Unknown subagent: ${id}`, "warning");
				else if (record.status === "stopped") ctx.ui.notify(`Stopped ${id}`, "info");
				else ctx.ui.notify(`${id} is ${record.status}`, "info");
				return;
			}
			if (action === "view" && id) {
				const record = await mgr.getAny(ctx, id);
				if (!record?.sessionFile) {
					ctx.ui.notify(`No transcript for ${id}`, "warning");
					return;
				}
				await showTranscript(ctx, id, record);
				return;
			}
			if (action === "resume" && id) {
				if (!rest) {
					ctx.ui.notify("Usage: /subagents resume <id> <task>", "warning");
					return;
				}
				try {
					await mgr.resume(ctx, id, rest);
					ctx.ui.notify(`Resumed ${id}`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			const records = await mgr.listAll(ctx);
			if (records.length === 0) {
				ctx.ui.notify("No subagents in this session.", "info");
				return;
			}
			const labels = records.map((record) => {
				const model = modelLabel(
					"resolvedModel" in record ? record.resolvedModel ?? record.modelSpec : record.modelSpec,
					"resolvedThinking" in record ? record.resolvedThinking ?? record.thinking : record.thinking,
				);
				return `${record.id}  ${record.status.padEnd(9)}  ${record.agent.padEnd(8)}  ${record.name}  ${model}`;
			});
			const choice = await ctx.ui.select("Subagents", labels);
			if (!choice) return;
			const selected = records.find((record) => choice.startsWith(record.id));
			if (!selected) return;
			if (selected.sessionFile) {
				await showTranscript(ctx, selected.id, selected);
			} else {
				const error = "error" in selected ? selected.error : undefined;
				ctx.ui.notify(`${selected.id}: ${selected.status}${error ? ` — ${error}` : ""}`, "info");
			}
		},
	});
}
