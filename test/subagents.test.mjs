import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText + "\nexport { SubagentManager, TaskTree, loadAgents, resolveAgent, SUBAGENT_PREAMBLE, parseFrontmatter, formatResult, agentListLabel };\n";
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};
async function until(predicate) {
    for (let n = 0; n < 100; n++) {
        if (predicate()) return;
        await delay(2);
    }
    assert.fail("condition did not become true");
}

// No Pi installation, API keys, model calls, or persistent user files are needed.
// Stub the public Pi API, while executing the actual plugin classes/functions.
async function fixture(t, options = {}) {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
    writeFileSync(join(root, "subagents.json"), JSON.stringify({ maxConcurrent: options.maxConcurrent ?? 2, ...options.config }));
    const sessions = new Map();
    const children = [];
    const behaviors = [];
    const parentEntries = [];
    const durable = [];
    const wakeups = [];
    const hooks = [];
    const rootHandlers = new Map();
    const tools = [];
    const commands = new Map();
    const stopTimers = [];
    let sendsFail = false;
    let nextFile = 0;
    class Session {
        constructor(file) {
            this.file = file;
            this.messages = [];
            this.entries = [];
            this.id = `child-${nextFile}`;
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify({ type: "session", id: this.id, timestamp: new Date().toISOString() }) + "\n");
            sessions.set(file, this);
        }
        getSessionFile() { return this.file; }
        getSessionId() { return this.id; }
        getBranch() { return this.entries; }
        appendCustomEntry(customType, data) {
            const entry = { type: "custom", customType, data };
            this.entries.push(entry);
            appendFileSync(this.file, JSON.stringify(entry) + "\n");
        }
        static create(_cwd, dir) { return new Session(join(dir, `${++nextFile}.jsonl`)); }
        static open(file) { return sessions.get(file); }
    }
    const ctx = {
        cwd: root,
        hasUI: false,
        isProjectTrusted: () => options.trusted ?? false,
        model: { provider: "test", id: "model" },
        thinkingLevel: "high",
        sessionManager: {
            getSessionId: () => "parent",
            getSessionFile: () => join(root, "parent.jsonl"),
            getBranch: () => parentEntries,
        },
        modelRegistry: {
            find: (provider, id) => options.unavailableModels?.includes(`${provider}/${id}`) ? undefined : ({ provider, id }),
            getRegisteredProviderIds: () => [],
        },
        ui: { setWidget() {}, notify() {} },
    };
    writeFileSync(ctx.sessionManager.getSessionFile(), "");
    const pi = {
        on: (name, handler) => { hooks.push(name); rootHandlers.set(name, handler); },
        registerTool: (tool) => tools.push(tool),
        registerCommand(name, command) { commands.set(name, command); },
        sendMessage(message, sendOptions) {
            if (sendsFail) throw new Error("send failed");
            if (sendOptions.triggerTurn === false) durable.push(message);
            else wakeups.push(message);
        },
    };
    const fakePi = {
        getAgentDir: () => root,
        SessionManager: Session,
        SettingsManager: { create: (_cwd, _agentDir, settingsOptions) => ({ settingsOptions }) },
        createCodemodeExtension: () => () => {},
        createMcpExtension: () => () => {},
        createToolSearchExtension: () => () => {},
        DefaultResourceLoader: class {
            constructor(options) { this.options = options; this.tools = []; this.hooks = new Map(); }
            async reload() {
                const extension = { tools: new Map() };
                const api = {
                    ...pi,
                    on: (name, handler) => this.hooks.set(name, handler),
                    registerTool: (tool) => { this.tools.push(tool); extension.tools.set(tool.name, { definition: tool }); },
                    registerCommand() {},
                    sendMessage: (message, sendOptions) => {
                        this.child.reports.push(message);
                        this.child.sessionManager.entries.push({ type: "custom_message", ...message });
                        if (sendOptions.triggerTurn) this.child.backgroundTurns++;
                    },
                };
                for (const input of this.options.extensionFactories ?? []) input.factory?.(api);
                const discovered = { path: "installed-subagents", tools: new Map([["task", { definition: tools[0] }]]) };
                const web = { path: "web-tools", tools: new Map(["web_search", "fetch", "codemode"].map((name) => [name, { definition: { name } }])) };
                this.loaded = this.options.extensionsOverride?.({ extensions: [discovered, web, extension], errors: [], runtime: {} });
            }
        },
        ModelRuntime: { create: async () => ({}) },
        createAgentSession: async ({ sessionManager, model, thinkingLevel, resourceLoader, tools: selectedTools }) => {
            const behavior = behaviors.shift() ?? {};
            const listeners = new Set();
            const child = {
                messages: sessionManager.messages,
                model,
                thinkingLevel,
                sessionManager,
                resourceOptions: resourceLoader.options,
                selectedTools,
                reports: [],
                backgroundTurns: 0,
                turns: 0,
                extensionRunner: { emit: async (event) => resourceLoader.hooks.get(event.type)?.(event, child.ctx) },
                callTool: async (name, params, signal) => {
                    const tool = resourceLoader.tools.find((item) => item.name === name);
                    assert.ok(tool, `missing child tool: ${name}`);
                    return tool.execute("child-call", params, signal, undefined, child.ctx);
                },
                getAllTools: () => (resourceLoader.loaded?.extensions ?? []).flatMap((extension) => [...extension.tools.values()].map((tool) => tool.definition)),
                getToolDefinition: (name) => (resourceLoader.loaded?.extensions ?? []).flatMap((extension) => [...extension.tools.values()]).find((tool) => tool.definition.name === name)?.definition,
                subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
                bindExtensions: async () => resourceLoader.hooks.get("session_start")?.({ type: "session_start" }, child.ctx),
                dispose() { this.disposed = true; },
                abort() { this.aborted = true; },
                async setModel(next) { this.model = next; },
                setThinkingLevel(next) { this.thinkingLevel = next; },
                async steer(text) { this.steered = text; },
                async prompt(text) {
                    this.promptText = text;
                    this.turns++;
                    this.messages.push({ role: "user", content: text });
                    if (behavior.run) await behavior.run(this, text);
                    if (behavior.gate) await behavior.gate.promise;
                    if (behavior.throw) throw new Error(behavior.throw);
                    if (behavior.noResponse) return;
                    if (behavior.compact) this.messages.length = 0;
                    const message = {
                        role: "assistant",
                        stopReason: behavior.stopReason ?? "stop",
                        errorMessage: behavior.error,
                        content: [{ type: "text", text: typeof behavior.text === "function" ? behavior.text(this) : behavior.text ?? "answer" }],
                    };
                    this.messages.push(message);
                    for (const listener of listeners) listener({ type: "message_end", message });
                },
            };
            child.ctx = { ...ctx, sessionManager, model, thinkingLevel, ui: { setWidget() {}, notify() {} } };
            resourceLoader.child = child;
            children.push(child);
            return { session: child };
        },
    };
    for (const name of ["AssistantMessageComponent", "BashExecutionComponent", "BranchSummaryMessageComponent", "CompactionSummaryMessageComponent", "CustomMessageComponent", "ToolExecutionComponent", "UserMessageComponent"]) fakePi[name] = class {};
    fakePi.getMarkdownTheme = () => ({});
    const fakeTui = { matchesKey: () => false, truncateToWidth: (x) => x, visibleWidth: (x) => x.length };
    for (const name of ["Box", "Container", "Spacer", "Text"]) fakeTui[name] = class {};
    const type = Object.fromEntries(["Object", "String", "Array", "Optional"].map((name) => [name, (...args) => ({ type: name, args })]));
    const modules = {
        "@earendil-works/pi-coding-agent": fakePi,
        "@earendil-works/pi-ai": { StringEnum: (values) => values },
        "@earendil-works/pi-tui": fakeTui,
        typebox: { Type: type },
    };
    const context = vm.createContext({
        console,
        Buffer,
        setInterval,
        clearInterval,
        setTimeout(callback, ms) {
            if (ms === 5000) {
                const timer = { callback, unref() {} };
                stopTimers.push(timer);
                return timer;
            }
            return setTimeout(callback, ms);
        },
        clearTimeout(timer) { if (!stopTimers.includes(timer)) clearTimeout(timer); },
    });
    const module = new vm.SourceTextModule(js, {
        context,
        identifier: new URL("../index.ts", import.meta.url).href,
        initializeImportMeta(meta) { meta.url = new URL("../index.ts", import.meta.url).href; },
    });
    await module.link(async (specifier) => {
        const exports = modules[specifier] ?? await import(specifier);
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    module.namespace.default(pi);
    const manager = new module.namespace.SubagentManager(pi);
    manager.setContext(ctx);
    t.after(() => {
        manager.shutdown();
        rootHandlers.get("session_shutdown")?.();
        for (const behavior of behaviors) behavior.gate?.resolve();
        rmSync(root, { recursive: true, force: true });
    });
    return {
        root, manager, ctx, children, behaviors, durable, wakeups, hooks, tools, commands, stopTimers,
        exports: module.namespace,
        failSends() { sendsFail = true; },
        clearQueue() { wakeups.length = 0; },
        boundary() {
            for (const message of durable.splice(0)) {
                parentEntries.push({ type: "custom_message", ...message });
            }
        },
        parentEntries,
        start(tasks) { return manager.start(ctx, "shared context", tasks); },
    };
}

test("tool schemas/descriptions stay byte-identical; only the original two hooks", async (t) => {
    const contract = source.slice(source.indexOf("const TASK_DESCRIPTION"), source.indexOf("const PI_TOOLS"));
    assert.equal(createHash("sha256").update(contract).digest("hex"), "be22467f497f4432a73876d61dcd9bcaa2f701b5c986f5e523924f4e9bde6417");
    const f = await fixture(t);
    assert.deepEqual(f.hooks, ["session_start", "session_shutdown"]);
    assert.deepEqual(f.tools.map((tool) => tool.name), ["task", "wait", "agent"]);
});

test("queue clearing cannot discard the report, and wait recovers an unacknowledged handoff", async (t) => {
    const f = await fixture(t);
    const [record] = await f.start([{ task: "report" }]);
    await until(() => record.finished);
    await delay(80);
    assert.equal(f.durable.length, 1);
    assert.equal(f.wakeups.length, 1);
    f.clearQueue(); // Mirrors Pi's clearQueue: follow-ups go, context-only messages remain.
    assert.equal((await f.manager.wait()).text, "answer");
    f.boundary();
    assert.match(f.parentEntries[0].content, /answer/);
    assert.equal(await f.manager.wait(), undefined);
});

test("persisted reports are acknowledged and are not returned twice", async (t) => {
    const f = await fixture(t);
    const [record] = await f.start([{ task: "report" }]);
    await until(() => record.finished);
    await delay(80);
    f.boundary();
    assert.equal(await f.manager.wait(), undefined);
    assert.equal(f.parentEntries.length, 1);
});

test("synchronous send failure leaves the result recoverable", async (t) => {
    const f = await fixture(t);
    f.failSends();
    const [record] = await f.start([{ task: "report" }]);
    await until(() => record.finished);
    await delay(80);
    assert.equal((await f.manager.wait()).text, "answer");
});

test("a completed report does not wait for an unrelated running child", async (t) => {
    const f = await fixture(t);
    const gate = deferred();
    f.behaviors.push({ gate }, { text: "fast answer" });
    const records = await f.start([{ task: "slow" }, { task: "fast" }]);
    await until(() => records[1].finished);
    await delay(80);
    assert.equal(records[0].finished, false);
    assert.match(f.durable[0].content, /fast answer/);
    gate.resolve();
    await until(() => records[0].finished);
});

test("separate runs of the same child have distinct delivery acknowledgements", async (t) => {
    const f = await fixture(t);
    const [first] = await f.start([{ task: "first" }]);
    await until(() => first.finished);
    await delay(80);
    f.boundary();
    const firstId = f.parentEntries[0].details.deliveryId;
    const second = await f.manager.resume(f.ctx, first.id, "second");
    await until(() => second.finished);
    await delay(80);
    assert.notEqual(f.durable[0].details.deliveryId, firstId);
    assert.equal((await f.manager.wait()).text, "answer");
});

test("more waiters than results all settle, without duplicate deliveries", async (t) => {
    const f = await fixture(t);
    const gate = deferred();
    f.behaviors.push({ gate });
    const [record] = await f.start([{ task: "one result" }]);
    await until(() => f.children.length === 1);
    const first = f.manager.wait();
    const second = f.manager.wait();
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.id, record.id);
    assert.equal(b, undefined);
    assert.equal(f.durable.length, 0);
});

test("aborting wait does not consume another waiter's result", async (t) => {
    const f = await fixture(t);
    const gate = deferred();
    f.behaviors.push({ gate });
    await f.start([{ task: "one result" }]);
    const controller = new AbortController();
    const cancelled = f.manager.wait(controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /aborted/);
    const next = f.manager.wait();
    gate.resolve();
    assert.equal((await next).text, "answer");
});

test("stopped child cannot resume or release its slot before cleanup finishes", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    const gate = deferred();
    f.behaviors.push({ gate });
    const [record] = await f.start([{ task: "slow cleanup" }]);
    await until(() => f.children[0]?.promptText);
    f.manager.stop(record.id);
    await assert.rejects(f.manager.resume(f.ctx, record.id, "too early"), /still running or stopping/);
    f.stopTimers[0].callback(); // Simulate the stop timeout, without sleeping five seconds.
    assert.equal(record.finished, false);
    await assert.rejects(f.manager.resume(f.ctx, record.id, "still too early"), /still running or stopping/);
    const [queued] = await f.start([{ task: "must wait for its slot" }]);
    await delay(10);
    assert.equal(f.children.length, 1);
    assert.equal((await f.manager.wait()).status, "stopped");
    gate.resolve();
    await until(() => queued.finished);
    assert.equal(f.children.length, 2);
    assert.equal(record.finished, true);
});

for (const stopReason of ["error", "aborted", "length"]) {
    test(`resumed ${stopReason} cannot recycle a previous successful answer`, async (t) => {
        const f = await fixture(t);
        f.behaviors.push({ text: "old answer" });
        const [first] = await f.start([{ task: "first" }]);
        await until(() => first.finished);
        await f.manager.wait();
        f.behaviors.push({ text: "", stopReason, error: "new failure" });
        const second = await f.manager.resume(f.ctx, first.id, "failing follow-up");
        await until(() => second.finished);
        const result = await f.manager.wait();
        assert.equal(result.status, stopReason === "aborted" ? "stopped" : "failed");
        assert.equal(result.text, "");
        assert.equal(result.error, "new failure");
    });
}

test("partial failure text is retained with its error", async (t) => {
    const f = await fixture(t);
    f.behaviors.push({ text: "partial answer", stopReason: "error", error: "network failed" });
    const [record] = await f.start([{ task: "partial" }]);
    await until(() => record.finished);
    const result = await f.manager.wait();
    assert.equal(result.status, "failed");
    const rendered = f.exports.formatResult(result);
    assert.match(rendered, /network failed/);
    assert.match(rendered, /partial answer/);
});

test("missing new assistant response fails instead of selecting old history", async (t) => {
    const f = await fixture(t);
    const [first] = await f.start([{ task: "first" }]);
    await until(() => first.finished);
    await f.manager.wait();
    f.behaviors.push({ noResponse: true });
    const second = await f.manager.resume(f.ctx, first.id, "missing response");
    await until(() => second.finished);
    const result = await f.manager.wait();
    assert.equal(result.status, "failed");
    assert.equal(result.text, "");
});

test("new model effort overrides inherited effort on switch and resume", async (t) => {
    const f = await fixture(t);
    const [record] = await f.start([{ task: "first", thinking: "high" }]);
    await until(() => record.finished);
    await f.manager.wait();
    const switched = await f.manager.switchOnly(f.ctx, record.id, "test/new:low");
    assert.equal(switched.thinking, "low");
    const resumed = await f.manager.resume(f.ctx, record.id, "second", "test/new:medium");
    assert.equal(resumed.thinking, "medium");
    await until(() => resumed.finished);
});

test("solutionSpace reaches the child prompt without changing the tool contract", async (t) => {
    const f = await fixture(t);
    const [record] = await f.start([{ task: "fix", solutionSpace: "only change queue logic" }]);
    await until(() => record.finished);
    assert.match(f.children[0].promptText, /# Solution space\nonly change queue logic/);
});

test("history compaction cannot hide a new run's answer", async (t) => {
    const f = await fixture(t);
    const [first] = await f.start([{ task: "first" }]);
    await until(() => first.finished);
    await f.manager.wait();
    f.behaviors.push({ compact: true, text: "new compacted answer" });
    const second = await f.manager.resume(f.ctx, first.id, "second");
    await until(() => second.finished);
    assert.equal((await f.manager.wait()).text, "new compacted answer");
});

test("custom agent model effort is respected without an explicit thinking override", async (t) => {
    const f = await fixture(t);
    mkdirSync(join(f.root, "agents"));
    writeFileSync(join(f.root, "agents", "fast.md"), "---\nmodel: test/model:low\n---\nDo the task.");
    const [record] = await f.start([{ task: "first", agent: "fast" }]);
    await until(() => record.finished);
    assert.equal(f.children[0].thinkingLevel, "low");
});

test("small result batches acknowledge each constituent report", async (t) => {
    const f = await fixture(t);
    f.behaviors.push({ text: "first" }, { text: "second" });
    const records = await f.start([{ task: "first" }, { task: "second" }]);
    await until(() => records.every((record) => record.finished));
    await delay(80);
    assert.equal(f.durable.length, 1);
    assert.equal(f.durable[0].details.results.length, 2);
    f.boundary();
    assert.equal(await f.manager.wait(), undefined);
});

test("wait before auto-flush does not send a duplicate report", async (t) => {
    const f = await fixture(t);
    const [record] = await f.start([{ task: "report" }]);
    await until(() => record.finished);
    assert.equal((await f.manager.wait()).text, "answer");
    await delay(80);
    assert.equal(f.durable.length, 0);
    assert.equal(f.wakeups.length, 0);
});

test("stopping a queued child never creates its session", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    const gate = deferred();
    f.behaviors.push({ gate });
    const [running, queued] = await f.start([{ task: "running" }, { task: "queued" }]);
    await until(() => f.children[0]?.promptText);
    f.manager.stop(queued.id);
    assert.equal((await f.manager.wait()).status, "stopped");
    gate.resolve();
    await until(() => running.finished);
    await delay(10);
    assert.equal(f.children.length, 1);
});

test("a throwing child is failed and releases capacity for queued work", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    f.behaviors.push({ throw: "prompt failed" }, { text: "next succeeded" });
    const records = await f.start([{ task: "fails" }, { task: "next" }]);
    await until(() => records.every((record) => record.finished));
    assert.equal(records[0].status, "failed");
    assert.match(records[0].error, /prompt failed/);
    assert.equal(records[1].status, "completed");
});

test("empty assistant output is failed, not a success-shaped placeholder", async (t) => {
    const f = await fixture(t);
    f.behaviors.push({ text: "" });
    const [record] = await f.start([{ task: "empty answer" }]);
    await until(() => record.finished);
    assert.equal((await f.manager.wait()).status, "failed");
});

test("global default model is used for built-in roles and legacy aliases", async (t) => {
    const f = await fixture(t, { config: { defaultModel: "test/flash" } });
    const records = await f.start(["task", "scout", "review", "general", "worker"].map((agent) => ({ task: "report", agent })));
    await until(() => records.every((record) => record.finished));
    assert.equal(f.children.length, 5);
    for (const child of f.children) assert.equal(child.model.id, "flash");
    for (const record of records) {
        assert.equal(record.modelSpec, "test/flash");
        assert.equal(record.resolvedModel, "test/flash");
    }
});

test("per-call model beats both the agent-specific and global default models", async (t) => {
    const f = await fixture(t, { config: { defaultModel: "test/global" } });
    mkdirSync(join(f.root, "agents"));
    writeFileSync(join(f.root, "agents", "special.md"), "---\nmodel: test/special\n---\nDo the task.");
    const [record] = await f.start([{ task: "report", agent: "special", model: "test/explicit" }]);
    await until(() => record.finished);
    assert.equal(f.children[0].model.id, "explicit");
    assert.equal(record.resolvedModel, "test/explicit");
});

test("agent-specific model beats the global default model", async (t) => {
    const f = await fixture(t, { config: { defaultModel: "test/global" } });
    mkdirSync(join(f.root, "agents"));
    writeFileSync(join(f.root, "agents", "special.md"), "---\nmodel: test/special\n---\nDo the task.");
    const [record] = await f.start([{ task: "report", agent: "special" }]);
    await until(() => record.finished);
    assert.equal(f.children[0].model.id, "special");
    assert.equal(record.resolvedModel, "test/special");
});

test("without a default or more specific model the parent's active model is inherited", async (t) => {
    const f = await fixture(t);
    const [record] = await f.start([{ task: "report" }]);
    await until(() => record.finished);
    assert.equal(f.children[0].model.id, "model");
    assert.equal(record.resolvedModel, "test/model");
});

for (const defaultModel of [null, "", "   "]) {
    test(`an unset default (${JSON.stringify(defaultModel)}) preserves parent inheritance`, async (t) => {
        const f = await fixture(t, { config: { defaultModel } });
        const [record] = await f.start([{ task: "report" }]);
        await until(() => record.finished);
        assert.equal(f.children[0].model.id, "model");
    });
}

test("global default thinking suffix is respected unless explicitly overridden", async (t) => {
    const f = await fixture(t, { config: { defaultModel: " test/flash:low " } });
    const records = await f.start([{ task: "low" }, { task: "high", thinking: "high" }]);
    await until(() => records.every((record) => record.finished));
    assert.equal(f.children[0].model.id, "flash");
    assert.equal(f.children[0].thinkingLevel, "low");
    assert.equal(f.children[1].thinkingLevel, "high");
    assert.equal(records[0].resolvedThinking, "low");
});

test("agent-specific thinking takes precedence over the global model's thinking suffix", async (t) => {
    const f = await fixture(t, { config: { defaultModel: "test/flash:low" } });
    mkdirSync(join(f.root, "agents"));
    writeFileSync(join(f.root, "agents", "careful.md"), "---\nthinking: high\n---\nDo the task.");
    const [record] = await f.start([{ task: "report", agent: "careful" }]);
    await until(() => record.finished);
    assert.equal(f.children[0].model.id, "flash");
    assert.equal(f.children[0].thinkingLevel, "high");
});

test("an unavailable default fails batch preflight without spawning or falling back", async (t) => {
    const f = await fixture(t, { config: { defaultModel: "test/missing" }, unavailableModels: ["test/missing"] });
    await assert.rejects(f.start([{ task: "explicit", model: "test/explicit" }, { task: "default" }]), /Model not available: test\/missing/);
    assert.equal(f.children.length, 0);
    assert.equal(f.manager.list().length, 0);
});

test("malformed configured default is rejected before spawning", async (t) => {
    const f = await fixture(t, { config: { defaultModel: "no-provider" } });
    await assert.rejects(f.start([{ task: "report" }]), /Model must be provider\/id/);
    assert.equal(f.children.length, 0);
});

test("non-string configured default gives an actionable configuration error", async (t) => {
    const f = await fixture(t, { config: { defaultModel: 42 } });
    await assert.rejects(f.start([{ task: "report" }]), /Invalid defaultModel in subagents.json/);
    assert.equal(f.children.length, 0);
});

test("an unused invalid default does not block an explicit model", async (t) => {
    const f = await fixture(t, { config: { defaultModel: 42 } });
    const [record] = await f.start([{ task: "report", model: "test/explicit" }]);
    await until(() => record.finished);
    assert.equal(f.children[0].model.id, "explicit");
});

test("resuming preserves the saved model rather than replacing it with the global default", async (t) => {
    const f = await fixture(t, { config: { defaultModel: "test/global" } });
    const [first] = await f.start([{ task: "first", model: "test/saved" }]);
    await until(() => first.finished);
    await f.manager.wait();
    const second = await f.manager.resume(f.ctx, first.id, "second");
    await until(() => second.finished);
    assert.equal(f.children[1].model.id, "saved");
    const third = await f.manager.resume(f.ctx, first.id, "third", "test/override");
    await until(() => third.finished);
    assert.equal(f.children[2].model.id, "override");
});

test("resuming a legacy child with no saved model uses the global default", async (t) => {
    const f = await fixture(t, { config: { defaultModel: "test/global:low" } });
    const [first] = await f.start([{ task: "first" }]);
    await until(() => first.finished);
    await f.manager.wait();
    const entries = readFileSync(first.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === "omp-subagent") delete entry.data.model;
    }
    writeFileSync(first.sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const second = await f.manager.resume(f.ctx, first.id, "second");
    await until(() => second.finished);
    assert.equal(f.children[1].model.id, "global");
    assert.equal(f.children[1].thinkingLevel, "low");
});

test("a global default does not change the parent's model selection", async (t) => {
    const f = await fixture(t, { config: { defaultModel: "test/flash" } });
    const parentModel = f.ctx.model;
    const [record] = await f.start([{ task: "report" }]);
    await until(() => record.finished);
    assert.equal(f.ctx.model, parentModel);
    assert.equal(f.ctx.model.id, "model");
});

test("subagent list colors each status without styling the selection id", async (t) => {
    const f = await fixture(t);
    const colors = { running: "accent", queued: "warning", completed: "success", failed: "error", stopped: "muted", saved: "dim" };
    for (const [status, expectedColor] of Object.entries(colors)) {
        const calls = [];
        const theme = { fg(color, text) { calls.push({ color, text }); return `\u001b[36m${text}\u001b[39m`; } };
        const record = { id: "agent-123", agent: "scout", name: "test", status, modelSpec: "test/model", thinking: "high" };
        const label = f.exports.agentListLabel(record, theme);
        assert.equal(calls[0].color, expectedColor);
        assert.equal(calls[0].text, status.padEnd(9));
        assert.ok(label.startsWith(record.id));
        const plain = label.replace(/\u001b\[[0-9;]*m/g, "");
        assert.equal(plain, `${record.id}  ${status.padEnd(9)}  scout     test  test/model:high`);
    }
});

test("colored labels keep the resolved runtime model and saved-session fallback", async (t) => {
    const f = await fixture(t);
    const theme = { fg(_color, text) { return text; } };
    const live = { id: "agent-live", agent: "task", name: "live", status: "running", modelSpec: "test/old", resolvedModel: "test/new", thinking: "low", resolvedThinking: "high" };
    assert.ok(f.exports.agentListLabel(live, theme).endsWith("test/new:high"));
    const saved = { id: "agent-saved", agent: "scout", name: "saved", status: "saved" };
    assert.ok(f.exports.agentListLabel(saved, theme).endsWith("inherit:inherit"));
});

test("only three built-in roles remain; general and worker are compatibility aliases", async (t) => {
    const f = await fixture(t);
    const agents = f.exports.loadAgents(f.ctx);
    assert.deepEqual(Object.keys(agents).sort(), ["review", "scout", "task"]);
    for (const name of [undefined, "task", "general", "worker"]) {
        assert.equal(f.exports.resolveAgent(agents, name).name, "task");
    }
});

test("approved role prompts use only the single shared introduction", async (t) => {
    const f = await fixture(t);
    const intro = "你是受主 Agent 委派的子 Agent。根据收到的任务工作。";
    const agents = f.exports.loadAgents(f.ctx);
    assert.equal(f.exports.SUBAGENT_PREAMBLE, intro);
    assert.ok(agents.task.prompt.includes("你是一名专注的通用执行者，负责完成明确委派的任务。"));
    for (const [name, role] of Object.entries(agents)) {
        assert.equal(role.prompt.split("\n\n")[0], intro);
        assert.equal(role.prompt.split(intro).length, 2);
        assert.equal(role.tools, undefined);
        assert.equal(role.prompt.split("\n- ").length - 1, name === "scout" ? 4 : 5);
    }
    assert.match(agents.scout.prompt, /委派的任务也必须保持只读/);
    assert.match(agents.review.prompt, /缺少测试不等于存在功能错误/);
});

test("all roles load configured extensions and builtins without a tool allowlist", async (t) => {
    const f = await fixture(t, { trusted: false });
    const records = await f.start(["task", "scout", "review"].map((agent) => ({ agent, task: "inspect" })));
    await until(() => records.every((record) => record.finished));
    for (const child of f.children) {
        assert.equal(child.selectedTools, undefined);
        assert.equal(child.resourceOptions.noExtensions, undefined);
        assert.equal(child.resourceOptions.settingsManager.settingsOptions.projectTrusted, false);
        assert.deepEqual(Array.from(child.resourceOptions.extensionFactories.filter((input) => input.builtin).map((input) => input.name)), ["codemode", "tool-search", "mcp"]);
        assert.ok(child.resourceOptions.systemPrompt.startsWith(f.exports.SUBAGENT_PREAMBLE));
        assert.ok(child.promptText.includes("shared context\n\n# Assignment\ninspect"));
        for (const name of ["web_search", "fetch", "codemode", "task", "wait", "agent"]) {
            assert.equal(child.getAllTools().filter((tool) => tool.name === name).length, 1);
        }
    }
});

test("custom general overrides the legacy alias and retains its own prompt and tool selection", async (t) => {
    const f = await fixture(t);
    mkdirSync(join(f.root, "agents"));
    writeFileSync(join(f.root, "agents", "general.md"), "---\ntools: read, web_search, fetch\n---\nMy custom instructions.");
    const [record] = await f.start([{ agent: "general", task: "inspect" }]);
    await until(() => record.finished);
    assert.equal(record.agent, "general");
    assert.equal(f.children[0].resourceOptions.systemPrompt, "My custom instructions.");
    assert.deepEqual(Array.from(f.children[0].selectedTools), ["read", "web_search", "fetch"]);
});

test("a legacy saved general child resumes through the task compatibility alias", async (t) => {
    const f = await fixture(t);
    const [first] = await f.start([{ task: "first" }]);
    await until(() => first.finished);
    await f.manager.wait();
    const entries = readFileSync(first.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
    for (const entry of entries) if (entry.customType === "omp-subagent") entry.data.agent = "general";
    writeFileSync(first.sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const resumed = await f.manager.resume(f.ctx, first.id, "continue");
    await until(() => resumed.finished);
    assert.equal(resumed.status, "completed");
    assert.equal(f.children[1].resourceOptions.systemPrompt, f.exports.loadAgents(f.ctx).task.prompt);
});

test("nested waits lend slots and permit more than two levels with a budget of one", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1, config: { defaultModel: "test/flash:high" } });
    const results = [];
    for (let level = 1; level <= 5; level++) {
        f.behaviors.push({
            text: `level-${level}`,
            async run(child) {
                assert.ok(f.manager.tree.active <= 1);
                if (level === 5) return;
                await child.callTool("task", { context: "nested", tasks: [{ task: `level ${level + 1}` }] });
                const response = await child.callTool("wait", {});
                results.push(response);
            },
        });
    }
    const [record] = await f.start([{ task: "level 1" }]);
    await until(() => record.finished);
    assert.equal(record.status, "completed", record.error);
    assert.equal(f.children.length, 5);
    assert.equal(results.length, 4);
    assert.equal(f.manager.tree.active, 0);
    assert.equal(f.manager.tree.queue.length, 0);
    for (const child of f.children) {
        assert.equal(child.model.id, "flash");
        assert.equal(child.thinkingLevel, "high");
        assert.equal(child.backgroundTurns, 0);
        assert.equal(child.disposed, true);
    }
});

test("parallel nested waits do not reclaim the parent's sole slot before all waits settle", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    f.behaviors.push({ async run(child) {
        await child.callTool("task", { context: "nested", tasks: [{ task: "leaf A" }, { task: "leaf B" }] });
        const results = await Promise.all([child.callTool("wait", {}), child.callTool("wait", {})]);
        assert.equal(results.length, 2);
    } }, { text: "A" }, { text: "B" });
    const [record] = await f.start([{ task: "parent" }]);
    await until(() => record.finished);
    assert.equal(record.status, "completed", record.error);
    assert.equal(f.children.length, 3);
    assert.equal(f.manager.tree.active, 0);
});

test("idle delegating agents are kept alive and receive descendant results before completing", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    f.behaviors.push({
        text: (child) => child.turns === 1 ? "waiting" : "final parent answer",
        async run(child) {
            if (child.turns === 1) await child.callTool("task", { context: "nested", tasks: [{ task: "leaf" }] });
            else assert.equal(child.reports[0].details.text, "leaf answer");
        },
    }, { text: "leaf answer" });
    const [record] = await f.start([{ task: "parent" }]);
    await until(() => record.finished);
    assert.equal(record.status, "completed", record.error);
    assert.equal(record.result, "final parent answer");
    assert.equal(f.children[0].turns, 2);
    assert.equal(f.children[0].backgroundTurns, 0);
    assert.equal((await f.manager.wait()).text, "final parent answer");
    assert.equal(await f.manager.wait(), undefined);
});

test("siblings share the same tree budget instead of multiplying concurrency", async (t) => {
    const f = await fixture(t, { maxConcurrent: 2 });
    let leaves = 0;
    const parent = {
        async run(child) {
            if (child.turns !== 1) return;
            for (let n = 0; n < 2; n++) f.behaviors.push({ async run() {
                leaves++;
                assert.ok(f.manager.tree.active <= 2);
                await delay(5);
            } });
            await child.callTool("task", { context: "nested", tasks: [{ task: "leaf A" }, { task: "leaf B" }] });
            await child.callTool("wait", {});
            await child.callTool("wait", {});
        },
    };
    f.behaviors.push(parent, parent);
    const records = await f.start([{ task: "parent A" }, { task: "parent B" }]);
    await until(() => records.every((record) => record.finished));
    assert.equal(leaves, 4);
    assert.ok(records.every((record) => record.status === "completed"));
    assert.equal(f.manager.tree.active, 0);
});

test("stopping an ancestor aborts its descendants and waits for their cleanup", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    const gate = deferred();
    f.behaviors.push({ async run(child) {
        await child.callTool("task", { context: "nested", tasks: [{ task: "blocked leaf" }] });
        await child.callTool("wait", {});
    } }, { gate });
    const [record] = await f.start([{ task: "parent" }]);
    await until(() => f.children.length === 2 && f.children[1].promptText);
    f.manager.stop(record.id);
    await until(() => f.children[1].aborted);
    assert.equal(record.finished, false);
    await assert.rejects(f.manager.resume(f.ctx, record.id, "too early"), /still running or stopping/);
    gate.resolve();
    await until(() => record.finished);
    assert.equal(record.status, "stopped");
    assert.equal(f.manager.tree.active, 0);
    assert.equal(f.children[1].disposed, true);
});

test("tree rows retain parent-child structure both live and after restoring saved sessions", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    f.behaviors.push({ async run(child) {
        if (child.turns === 1) await child.callTool("task", { context: "nested", tasks: [{ task: "nested scout", agent: "scout" }] });
    } }, { text: "scout findings" });
    const [record] = await f.start([{ task: "parent" }]);
    await until(() => record.finished);
    const live = f.manager.treeRows(f.ctx);
    assert.equal(live.length, 2);
    assert.equal(live[0].record.id, record.id);
    assert.equal(live[0].prefix, "");
    assert.equal(live[1].record.agent, "scout");
    assert.equal(live[1].prefix, "└─ ");
    const restored = new f.exports.SubagentManager({ sendMessage() {} });
    const saved = restored.treeRows(f.ctx);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].record.id, record.id);
    assert.equal(saved[1].prefix, "└─ ");
    assert.equal(saved[1].record.status, "saved");
    restored.shutdown();
});

test("picker selection still works on indented and colored descendant labels", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    const notices = [];
    f.ctx.ui.theme = { fg(_color, text) { return text ? `\u001b[36m${text}\u001b[39m` : ""; } };
    f.ctx.ui.notify = (text) => notices.push(text);
    f.behaviors.push({ async run(child) {
        if (child.turns === 1) await child.callTool("task", { context: "nested", tasks: [{ task: "nested", agent: "scout" }] });
    } }, {});
    const task = f.tools.find((tool) => tool.name === "task");
    await task.execute("root-call", { context: "shared", tasks: [{ task: "parent" }] }, undefined, undefined, f.ctx);
    await until(() => f.children.length === 2 && f.children.every((child) => child.disposed));
    f.ctx.ui.select = async (_title, labels) => {
        assert.equal(labels.length, 2);
        assert.ok(labels[1].includes("└─ "));
        assert.ok(labels[1].includes("scout"));
        return labels[1];
    };
    await f.commands.get("subagents").handler("", f.ctx);
    assert.equal(notices.length, 1);
});

for (const stopReason of ["aborted", "error", "length"]) {
    test(`a parent ending with ${stopReason} cancels descendants instead of pumping another turn`, async (t) => {
        const f = await fixture(t, { maxConcurrent: 1 });
        f.behaviors.push({ stopReason, async run(child) {
            await child.callTool("task", { context: "nested", tasks: [{ task: "must not start" }] });
        } });
        const [record] = await f.start([{ task: "parent" }]);
        await until(() => record.finished);
        assert.equal(record.status, stopReason === "aborted" ? "stopped" : "failed");
        assert.equal(f.children.length, 1);
        assert.equal(f.children[0].turns, 1);
        assert.equal(f.manager.tree.active, 0);
        assert.equal(f.manager.tree.queue.length, 0);
    });
}

test("an aborted nested wait does not block cleanup trying to reacquire a busy slot", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    const gate = deferred();
    const controller = new AbortController();
    f.behaviors.push({ async run(child) {
        await child.callTool("task", { context: "nested", tasks: [{ task: "blocked leaf" }] });
        await child.callTool("wait", {}, controller.signal);
    } }, { gate });
    const [record] = await f.start([{ task: "parent" }]);
    await until(() => f.children.length === 2 && f.children[1].promptText);
    controller.abort();
    await until(() => f.children[1].aborted);
    gate.resolve();
    await until(() => record.finished);
    assert.equal(f.manager.tree.active, 0);
    assert.equal(f.manager.tree.queue.length, 0);
});

test("saved tree rendering ignores cyclic session ids", async (t) => {
    const f = await fixture(t);
    const [record] = await f.start([{ task: "parent" }]);
    await until(() => record.finished);
    const entries = readFileSync(record.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
    entries[0].id = "parent";
    writeFileSync(record.sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const restored = new f.exports.SubagentManager({ sendMessage() {} });
    assert.equal(restored.treeRows(f.ctx).length, 1);
    restored.shutdown();
});

test("active widget renders the same descendant tree rather than independent rows", async (t) => {
    const f = await fixture(t, { maxConcurrent: 1 });
    const gate = deferred();
    let latest;
    f.ctx.ui.setWidget = (_name, content) => { if (content) latest = content; };
    f.behaviors.push({ async run(child) {
        await child.callTool("task", { context: "nested", tasks: [{ task: "nested", agent: "scout" }] });
        await child.callTool("wait", {});
    } }, { gate });
    const [record] = await f.start([{ task: "parent" }]);
    await until(() => f.children.length === 2 && f.children[1].promptText);
    assert.ok(latest.some((line) => line.startsWith("└─ ") && line.includes("scout")));
    const descendant = f.manager.treeRows(f.ctx)[1].record;
    assert.equal((await f.manager.getAny(f.ctx, descendant.id)).id, descendant.id);
    assert.equal(f.manager.stop(descendant.id).status, "stopped");
    gate.resolve();
    await until(() => record.finished);
});

test("custom agent frontmatter supports Windows line endings", async (t) => {
    const f = await fixture(t);
    const parsed = f.exports.parseFrontmatter("---\r\nname: windows\r\ntools: [read, bash]\r\n---\r\nReview only.\r\n");
    assert.equal(parsed.data.name, "windows");
    assert.equal(parsed.body, "Review only.\n");
});
