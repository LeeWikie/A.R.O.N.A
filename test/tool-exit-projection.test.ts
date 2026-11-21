import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Core } from '../src/core.js';
import { RuntimeStore, type RuntimeEvent } from '../src/runtime-store.js';
import { publicToolEvent, toolActivity } from '../src/tool-activity.js';

function fixture() {
  const db = new DatabaseSync(':memory:'); const runtime = new RuntimeStore(db);
  const core = { store: { db }, runtime, redactionValues: () => [] } as unknown as Core;
  function emit(kind: string, data: unknown, contextId = 'main', runId = 'run', publish = true) {
    runtime.event({ kind, data, contextId, runId });
    const event: RuntimeEvent = { seq: runtime.eventHead(), kind, data, contextId, runId, taskId: null, createdAt: new Date().toISOString() };
    const projected = publicToolEvent(core, event);
    if (publish) runtime.event({ contextId, runId, kind: 'public_tool', key: 'tool.public:' + event.seq, data: projected });
    return projected;
  }
  return { db, core, runtime, emit };
}
const start = { toolCallId: 'call', toolName: 'mastra_workspace_execute_command', args: { command: 'fixture-command' } };
const end = { toolCallId: 'call', result: 'Process exited with code 0; this text is not evidence', isError: false };

test('structured nonzero command exit corrects late success and survives repeated snapshot replay', () => {
  const { db, core, runtime, emit } = fixture();
  try {
    emit('tool_start', start); assert.equal(emit('tool_end', end).state, 'finished');
    const exit = emit('command_exit', { toolCallId: 'call', exitCode: 7, success: false });
    assert.equal(exit.state, 'failed'); assert.equal((exit as any).exitCode, 7); assert.equal((exit.summary as any).exitCode, 7);
    const first = toolActivity(core, 'main'); assert.equal(first[0]?.state, 'failed'); assert.equal(first[0]?.exitCode, 7);
    runtime.setSetting('context-tools:main', first);
    assert.deepEqual(toolActivity(core, 'main'), first);
    emit('command_exit', { toolCallId: 'call', exitCode: 7, success: false });
    assert.equal(toolActivity(core, 'main')[0]?.state, 'failed');
  } finally { db.close(); }
});

test('zero exit, before-end exits and duplicate evidence do not regress to running or inferred success', () => {
  for (const exitCode of [0, 9]) {
    const { db, core, emit } = fixture();
    try {
      emit('tool_start', start);
      emit('command_exit', { toolCallId: 'call', exitCode, success: exitCode === 0 });
      emit('tool_update', { toolCallId: 'call', partialResult: 'late progress' });
      const final = emit('tool_end', end);
      assert.equal(final.state, exitCode === 0 ? 'finished' : 'failed'); assert.equal((final as any).exitCode, exitCode);
      emit('command_exit', { toolCallId: 'call', exitCode: exitCode === 0 ? 4 : 0, success: exitCode !== 0 });
      assert.equal(toolActivity(core, 'main')[0]?.exitCode, exitCode, 'the first durable exit is stable under duplicate events');
    } finally { db.close(); }
  }
});

test('exit evidence is scoped by context, run and tool call; text alone never infers failure', () => {
  const { db, core, emit } = fixture();
  try {
    emit('tool_start', start); emit('tool_end', { ...end, result: 'exited with code 73' });
    emit('command_exit', { toolCallId: 'call', exitCode: 5, success: false }, 'other', 'run');
    emit('command_exit', { toolCallId: 'call', exitCode: 6, success: false }, 'main', 'other');
    emit('command_exit', { toolCallId: 'different', exitCode: 8, success: false });
    const tools = toolActivity(core, 'main'); const original = tools.find(item => item.runId === 'run' && item.toolCallId === 'call');
    assert.equal(original?.state, 'finished'); assert.equal(original?.exitCode, undefined);
  } finally { db.close(); }
});

test('raw legacy command exits and public event replay agree without exposing command output', () => {
  const { db, core, emit } = fixture();
  try {
    emit('tool_start', start, 'main', 'run', false); emit('tool_end', end, 'main', 'run', false);
    emit('command_exit', { toolCallId: 'call', exitCode: 2, success: false }, 'main', 'run', false);
    const tools = toolActivity(core, 'main');
    assert.equal(tools[0]?.state, 'failed'); assert.equal(tools[0]?.exitCode, 2);
    assert.doesNotMatch(JSON.stringify(tools), /Process exited|fixture-command/);
  } finally { db.close(); }
});

test('successful exit does not erase an explicit denial or tool execution failure', () => {
  for (const failure of [{ denied: true }, { isError: true }, { result: { error: true } }]) {
    const { db, core, emit } = fixture();
    try {
      emit('tool_start', start); emit('tool_end', { ...end, ...failure });
      emit('command_exit', { toolCallId: 'call', exitCode: 0, success: true });
      assert.equal(toolActivity(core, 'main')[0]?.state, 'denied' in failure ? 'denied' : 'failed');
    } finally { db.close(); }
  }
});

test('legacy event pages replay structured exits exactly while modern pages do not duplicate them', async () => {
  const { publicEventPage } = await import('../src/event-stream.js');
  for (const publish of [false, true]) {
    const { db, core, emit } = fixture();
    try {
      emit('tool_start', start, 'main', 'run', publish); emit('tool_end', end, 'main', 'run', publish);
      emit('command_exit', { toolCallId: 'call', exitCode: 7, success: false }, 'main', 'run', publish);
      emit('command_exit', { toolCallId: 'call', exitCode: 3, success: false }, 'other', 'run', publish);
      const tools = publicEventPage(core, 0, 'main').events.filter(event => event.kind === 'tool');
      assert.equal(tools.length, 3); const final = tools.at(-1)!;
      assert.equal((final.data as any).state, 'failed'); assert.equal((final.data as any).exitCode, 7);
      assert.equal((final.data as any).exitCode, toolActivity(core, 'main')[0]?.exitCode);
      assert.ok(tools.every(event => event.contextId === 'main'));
      if (!publish) assert.doesNotMatch(JSON.stringify(tools), /Process exited|fixture-command/);
    } finally { db.close(); }
  }
});

test('malformed legacy command exits are not projected as tool updates', async () => {
  const { projectEvent } = await import('../src/event-stream.js'); const { db, core } = fixture();
  try {
    for (const data of [{ toolCallId: 'call', exitCode: '2', success: false }, { toolCallId: 'call', exitCode: 2 }, { exitCode: 2, success: false }]) {
      assert.equal(projectEvent(core, { seq: 1, kind: 'command_exit', data, contextId: 'main', runId: 'run', taskId: null, createdAt: '' }), undefined);
    }
  } finally { db.close(); }
});

test('legacy exit-only continuation pages keep exact state and context boundaries', async () => {
  const { publicEventPage } = await import('../src/event-stream.js');
  for (const [exitCode, success, state] of [[0, true, 'finished'], [0, false, 'failed'], [8, false, 'failed']] as const) {
    const { db, core, runtime, emit } = fixture();
    try {
      emit('tool_start', start, 'main', 'run', false); emit('tool_end', end, 'main', 'run', false); const cursor = runtime.eventHead();
      emit('command_exit', { toolCallId: 'call', exitCode, success }, 'main', 'run', false);
      emit('command_exit', { toolCallId: 'call', exitCode: 9, success: false }, 'other', 'run', false);
      const page = publicEventPage(core, cursor, 'main'); assert.equal(page.events.length, 1);
      assert.equal((page.events[0]?.data as any).state, state); assert.equal((page.events[0]?.data as any).exitCode, exitCode);
      assert.equal(page.nextCursor, runtime.eventHead()); assert.doesNotMatch(JSON.stringify(page.events), /fixture-command|Process exited/);
    } finally { db.close(); }
  }
});

for (const publish of [false, true]) test(`malformed exits cannot shadow the first valid evidence, public=${publish}`, async () => {
  const { publicEventPage } = await import('../src/event-stream.js');
  for (const malformed of [{ exitCode: '7', success: false }, { exitCode: 7 }, { exitCode: 0.5, success: false }, { exitCode: null, success: false }]) {
    for (const [exitCode, success] of [[7, false], [0, false], [0, true]] as const) {
      const { db, core, emit, runtime } = fixture();
      try {
        emit('tool_start', start, 'main', 'run', publish);
        emit('command_exit', { toolCallId: 'call', ...malformed }, 'main', 'run', publish);
        emit('command_exit', { toolCallId: 'call', exitCode, success }, 'main', 'run', publish);
        const cursor = runtime.eventHead();
        emit('tool_end', end, 'main', 'run', publish);
        const final = publicEventPage(core, cursor, 'main').events.at(-1)?.data as any;
        assert.equal(final.exitCode, exitCode); assert.equal(final.state, success ? 'finished' : 'failed');
        assert.equal(final.state, toolActivity(core, 'main')[0]?.state);
        assert.equal(final.exitCode, toolActivity(core, 'main')[0]?.exitCode);
      } finally { db.close(); }
    }
  }
});

for (const publish of [false, true]) test(`terminal precedence is idempotent across duplicate ordering and one-row pages, public=${publish}`, async () => {
  const { publicEventPage } = await import('../src/event-stream.js');
  const permutations = [[0, 1, 2], [1, 0, 2], [0, 2, 1], [2, 1, 0], [2, 0, 1]];
  for (const failure of [{ denied: true }, { isError: true }, { result: { error: true } }]) {
    for (const order of permutations) {
      const { db, core, emit, runtime } = fixture();
      try {
        const evidence = [
          { kind: 'tool_end', data: { ...end, ...failure } },
          { kind: 'command_exit', data: { toolCallId: 'call', exitCode: 0, success: true } },
          { kind: 'tool_end', data: end },
        ];
        emit('tool_start', start, 'main', 'run', publish);
        for (const index of order) { const item = evidence[index]!; emit(item.kind, item.data, 'main', 'run', publish); }
        emit('tool_update', { toolCallId: 'call', partialResult: 'late progress' }, 'main', 'run', publish);
        emit('tool_start', start, 'main', 'run', publish);
        const snapshot = toolActivity(core, 'main'); const expected = 'denied' in failure ? 'denied' : 'failed';
        assert.equal(snapshot[0]?.state, expected);
        runtime.setSetting('context-tools:main', snapshot); assert.deepEqual(toolActivity(core, 'main'), snapshot);
        let cursor = 0; let last: any; let failed = false;
        for (;;) {
          const page = publicEventPage(core, cursor, 'main', 1);
          for (const item of page.events) if (item.kind === 'tool') {
            last = item.data;
            if (failed) assert.equal(last.state, expected, 'terminal severity cannot regress on a later page');
            if (last.state === expected) failed = true;
          }
          cursor = page.nextCursor; if (!page.hasMore) break;
        }
        assert.equal(last.state, snapshot[0]?.state); assert.equal(last.exitCode, snapshot[0]?.exitCode);
      } finally { db.close(); }
    }
  }
});
