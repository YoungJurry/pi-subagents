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
}).outputText + "\nexport { SubagentManager, parseFrontmatter, formatResult };\n";
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
    writeFileSync(join(root, "subagents.json"), JSON.stringify({ maxConcurrent: options.maxConcurrent ?? 2 }));
    const sessions = new Map();
    const children = [];
    const behaviors = [];
    const parentEntries = [];
    const durable = [];
    const wakeups = [];
    const hooks = [];
    const tools = [];
    const stopTimers = [];
    let sendsFail = false;
    let nextFile = 0;
    class Session {
        constructor(file) {
            this.file = file;
            this.messages = [];
            this.entries = [];
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify({ type: "session", id: "child", timestamp: new Date().toISOString() }) + "\n");
            sessions.set(file, this);
        }
        getSessionFile() { return this.file; }
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
        model: { provider: "test", id: "model" },
        thinkingLevel: "high",
        sessionManager: {
            getSessionId: () => "parent",
            getSessionFile: () => join(root, "parent.jsonl"),
            getBranch: () => parentEntries,
        },
        modelRegistry: {
            find: (provider, id) => ({ provider, id }),
            getRegisteredProviderIds: () => [],
        },
        ui: { setWidget() {}, notify() {} },
    };
    writeFileSync(ctx.sessionManager.getSessionFile(), "");
    const pi = {
        on: (name) => hooks.push(name),
        registerTool: (tool) => tools.push(tool),
        registerCommand() {},
        sendMessage(message, sendOptions) {
            if (sendsFail) throw new Error("send failed");
            if (sendOptions.triggerTurn === false) durable.push(message);
            else wakeups.push(message);
        },
    };
    const fakePi = {
        getAgentDir: () => root,
        SessionManager: Session,
        SettingsManager: { create: () => ({}) },
        DefaultResourceLoader: class { async reload() {} },
        ModelRuntime: { create: async () => ({}) },
        createAgentSession: async ({ sessionManager, model, thinkingLevel }) => {
            const behavior = behaviors.shift() ?? {};
            const listeners = new Set();
            const child = {
                messages: sessionManager.messages,
                model,
                thinkingLevel,
                sessionManager,
                getAllTools: () => [],
                subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
                bindExtensions: async () => {},
                dispose() { this.disposed = true; },
                abort() { this.aborted = true; },
                async setModel(next) { this.model = next; },
                setThinkingLevel(next) { this.thinkingLevel = next; },
                async steer(text) { this.steered = text; },
                async prompt(text) {
                    this.promptText = text;
                    this.messages.push({ role: "user", content: text });
                    if (behavior.gate) await behavior.gate.promise;
                    if (behavior.throw) throw new Error(behavior.throw);
                    if (behavior.noResponse) return;
                    if (behavior.compact) this.messages.length = 0;
                    const message = {
                        role: "assistant",
                        stopReason: behavior.stopReason ?? "stop",
                        errorMessage: behavior.error,
                        content: [{ type: "text", text: behavior.text ?? "answer" }],
                    };
                    this.messages.push(message);
                    for (const listener of listeners) listener({ type: "message_end", message });
                },
            };
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
        for (const behavior of behaviors) behavior.gate?.resolve();
        rmSync(root, { recursive: true, force: true });
    });
    return {
        root, manager, ctx, children, behaviors, durable, wakeups, hooks, tools, stopTimers,
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

test("custom agent frontmatter supports Windows line endings", async (t) => {
    const f = await fixture(t);
    const parsed = f.exports.parseFrontmatter("---\r\nname: windows\r\ntools: [read, bash]\r\n---\r\nReview only.\r\n");
    assert.equal(parsed.data.name, "windows");
    assert.equal(parsed.body, "Review only.\n");
});
