// Optional offline integration test: requires the Pi 1.5.2+ peer packages.
// Uses only /tmp fixtures and a simulated provider; no real inference calls.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = mkdtempSync(join(tmpdir(), 'pi-subagents-sdk-smoke-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'workspace');
mkdirSync(join(agentDir, 'extensions'), { recursive: true });
mkdirSync(cwd);
mkdirSync(join(cwd, '.pi', 'agents'), { recursive: true });
writeFileSync(join(cwd, '.pi', 'agents', 'task.md'), 'UNTRUSTED_PROJECT_ROLE_MUST_NOT_LOAD');
process.env.PI_CODING_AGENT_DIR = agentDir;
const audit = join(root, 'extensions.jsonl');
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultTools: ['+codemode'], cacheWarming: { enabled: false } }));
writeFileSync(join(agentDir, 'subagents.json'), JSON.stringify({ maxConcurrent: 1, defaultModel: 'test/child:low', autoCleanOrphans: true }));
writeFileSync(join(agentDir, 'extensions', 'offline-web.ts'), `
import { appendFileSync } from 'node:fs';
import { Type } from 'typebox';
export default function (pi) {
  for (const name of ['web_search', 'fetch']) pi.registerTool({
    name, label: name, description: 'Offline test fixture', parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ event: 'web_call', id: ctx.sessionManager.getSessionId(), tool: name }) + '\\n');
      return { content: [{ type: 'text', text: 'offline:' + ctx.sessionManager.getSessionId() }], details: {} };
    }
  });
  for (const event of ['session_start', 'session_shutdown']) pi.on(event, (_event, ctx) => {
    appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ event, id: ctx.sessionManager.getSessionId(), model: ctx.model?.id, thinking: ctx.thinkingLevel, tools: pi.getAllTools().map(t => t.name) }) + '\\n');
  });
}
`);
const api = await import('@earendil-works/pi-coding-agent');
const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
const pluginPath = fileURLToPath(new URL('../index.ts', import.meta.url));
const requests = [];
const mode = process.argv[2] ?? 'wait';
let controlledChildId;
const provider = {
  baseUrl: 'https://offline.invalid', apiKey: 'offline-test-not-a-credential', api: 'openai-completions',
  models: ['mock', 'child', 'selected'].map(id => ({ id, name: `Offline ${id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 4096 })),
  streamSimple(model, context, options) {
    const stream = createAssistantMessageEventStream();
    const initial = context.messages.find(m => m.role === 'user');
    const stage = Number(JSON.stringify(initial).match(/SMOKE_LEVEL_(\d+)/)?.[1] ?? -1);
    assert.ok(stage >= 0, 'missing mock stage');
    assert.ok(!JSON.stringify(context.messages).includes('UNTRUSTED_PROJECT_ROLE_MUST_NOT_LOAD'));
    const called = name => context.messages.some(m => m.role === 'assistant' && m.content.some(c => c.type === 'toolCall' && c.name === name));
    let content, stopReason;
    const after = context.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m).includes('ROOT_AFTER_CHILD_SHUTDOWN'));
    const codemodeAfter = after >= 0 && context.messages.slice(after + 1).some(m => m.role === 'assistant' && m.content.some(c => c.type === 'toolCall' && c.name === 'codemode'));
    const control = context.messages.findLastIndex(m => m.role === 'user' && /ROOT_(SWITCH|RESUME)_SAVED/.test(JSON.stringify(m)));
    const resuming = control >= 0 && JSON.stringify(context.messages[control]).includes('ROOT_RESUME_SAVED');
    const calledControl = name => context.messages.slice(control + 1).some(m => m.role === 'assistant' && m.content.some(c => c.type === 'toolCall' && c.name === name));
    if (control >= 0 && !calledControl('agent')) {
      content = [{ type: 'toolCall', id: `control-${requests.length}`, name: 'agent', arguments: resuming ? { id: controlledChildId, message: 'continue saved child' } : { id: controlledChildId, model: 'test/selected:high' } }];
      stopReason = 'toolUse';
    } else if (resuming && !calledControl('wait')) {
      content = [{ type: 'toolCall', id: `resume-wait-${requests.length}`, name: 'wait', arguments: {} }];
      stopReason = 'toolUse';
    } else if (control >= 0) {
      content = [{ type: 'text', text: 'LEVEL_0_DONE' }];
      stopReason = 'stop';
    } else if (!called('codemode') || (after >= 0 && !codemodeAfter)) {
      content = [{ type: 'toolCall', id: `code-${stage}-${requests.length}`, name: 'codemode', arguments: { code: 'return await tools.fetch({});' } }];
      stopReason = 'toolUse';
    } else if (stage < 3 && !called('task')) {
      content = [{ type: 'toolCall', id: `task-${stage}`, name: 'task', arguments: { context: stage === 0 ? '共享上下文'.repeat(16000) : 'offline nesting test', tasks: [{ task: `SMOKE_LEVEL_${stage + 1}`, agent: stage === 0 ? 'task' : stage === 1 ? 'scout' : 'review' }] } }];
      stopReason = 'toolUse';
    } else if (stage < 3 && !called('wait') && (mode === 'wait' || stage === 0)) {
      content = [{ type: 'toolCall', id: `wait-${stage}`, name: 'wait', arguments: {} }];
      stopReason = 'toolUse';
    } else {
      const parked = mode === 'idle' && stage > 0 && stage < 3 && !JSON.stringify(context.messages).includes('Subagent results are available above.');
      content = [{ type: 'text', text: parked ? `WAITING_${stage}` : `LEVEL_${stage}_DONE` }];
      stopReason = 'stop';
    }
    requests.push({ stage, model: model.id, thinking: options?.reasoning, stopReason });
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'start', partial: { ...message, content: [] } });
    stream.push({ type: 'done', reason: stopReason, message });
    stream.end();
    return stream;
  },
};
const runtime = await api.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), refreshOnCreate: false });
runtime.registerProvider('test', provider);
const settings = api.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
const loader = new api.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noContextFiles: true, noSkills: true, noThemes: true, additionalExtensionPaths: [pluginPath], extensionFactories: [
  { name: 'codemode', factory: api.createCodemodeExtension(), builtin: true, replaceable: true },
  { name: 'tool-search', factory: api.createToolSearchExtension(), builtin: true, replaceable: true },
  { name: 'mcp', factory: api.createMcpExtension(), builtin: true, replaceable: true },
] });
await loader.reload();
assert.equal(loader.getExtensions().errors.length, 0, JSON.stringify(loader.getExtensions().errors));
const extensionErrors = [];
const { session } = await api.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel('test', 'mock'), thinkingLevel: 'high', settingsManager: settings, resourceLoader: loader });
try {
  await session.bindExtensions({ mode: 'print', onError: (error) => extensionErrors.push(error) });
  await session.prompt('SMOKE_LEVEL_0');
  assert.equal(session.getLastAssistantText(), 'LEVEL_0_DONE');
  await session.prompt('ROOT_AFTER_CHILD_SHUTDOWN');
  assert.equal(session.getLastAssistantText(), 'LEVEL_0_DONE');
  controlledChildId = session.messages.find(m => m.role === 'toolResult' && m.toolName === 'task').details.tasks[0].id;
  const childFile = session.messages.find(m => m.role === 'toolResult' && m.toolName === 'wait').details.sessionFile;
  await session.prompt('ROOT_SWITCH_SAVED');
  api.SessionManager.open(childFile, dirname(childFile), cwd).appendCustomMessageEntry('large-history', 'later output '.repeat(40000), false);
  await session.prompt('ROOT_RESUME_SAVED');
  assert.equal(session.getLastAssistantText(), 'LEVEL_0_DONE');
  assert.ok(requests.some(r => r.stage === 1 && r.model === 'selected' && r.thinking === 'high'));
  const events = readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
  const starts = events.filter(e => e.event === 'session_start');
  assert.equal(starts.length, 5, JSON.stringify(events));
  assert.equal(starts[0].model, 'mock');
  assert.equal(starts[0].thinking, 'high');
  for (const entry of starts.slice(1, 4)) { assert.equal(entry.model, 'child'); assert.equal(entry.thinking, 'low'); }
  assert.equal(starts[4].model, 'selected');
  assert.equal(starts[4].thinking, 'high');
  for (const entry of starts) for (const tool of ['web_search', 'fetch', 'codemode', 'task', 'wait', 'agent']) assert.equal(entry.tools.filter(name => name === tool).length, 1, `${tool} in ${entry.id}`);
  const webCalls = events.filter(e => e.event === 'web_call');
  assert.equal(webCalls.length, 5);
  assert.deepEqual([...new Set(webCalls.map(e => e.id))].sort(), [...new Set(starts.map(e => e.id))].sort());
  const stopped = events.filter(e => e.event === 'session_shutdown');
  assert.equal(stopped.length, 4);
  assert.deepEqual([...new Set(requests.map(r => r.stage))].sort(), [0, 1, 2, 3]);
  assert.equal(readdirSync(join(agentDir, 'subagents')).length, 3);
  if (mode === 'idle') {
    for (const stage of [1, 2]) assert.equal(requests.filter(r => r.stage === stage && r.model === 'child' && r.stopReason === 'stop').length, 2);
  }
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.jsonl') ? [join(dir, entry.name)] : []);
  for (const file of [session.sessionManager.getSessionFile(), ...files(join(agentDir, 'subagents'))]) {
    for (const entry of readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)) {
      if (entry.type === 'custom_message' && entry.customType === 'subagent-result') {
        for (const report of entry.details.results ?? [entry.details]) {
          assert.equal(report.status, 'completed');
          assert.equal(report.warnings?.length ?? 0, 0);
        }
      }
      const message = entry.message;
      if (message?.role !== 'toolResult') continue;
      assert.notEqual(message.isError, true, JSON.stringify(message));
      if (message.toolName === 'wait') {
        assert.equal(message.details.status, 'completed', JSON.stringify(message));
        assert.equal(message.details.warnings?.length ?? 0, 0);
      }
    }
  }
  assert.deepEqual(extensionErrors, []);
  console.log(JSON.stringify({ pass: true, mode, root, requests, sessions: starts.length, childShutdowns: stopped.length, paidModelRequests: 0 }, null, 2));
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
