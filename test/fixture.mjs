// Builds a throwaway dsh-like session log + workspace for tests.
// Everything lives under test/.tmp and is deleted by the test runner.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const now = Date.now();

export const NOTES_FINAL = ['# Notes', '', 'First line.', '',
  'The agent appends a longer paragraph here so the replay animation is clearly',
  'visible: it types this text in place of the previous file content, one',
  'character at a time, while the diff decorates the inserted region.', ''].join('\n');

export function ev(type, seq, data, extra = {}) {
  return { type, seq, time: now - 60000 + seq * 1000, data, ...extra };
}

export function frame(events) {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

export function buildFixture(baseDir) {
  const workspace = path.join(baseDir, 'workspace');
  const sessionsRoot = path.join(baseDir, 'sessions');
  const finishedId = 'session-11111111-2222-3333-4444-555555555555';
  const liveId = 'session-99999999-8888-7777-6666-555555555555';

  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(sessionsRoot, '--tmp-fixture-workspace--', finishedId), { recursive: true });
  fs.mkdirSync(path.join(sessionsRoot, '--tmp-fixture-workspace--', liveId), { recursive: true });

  fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'export const answer = 42;\n');
  fs.writeFileSync(path.join(workspace, 'notes.md'), NOTES_FINAL);
  fs.writeFileSync(path.join(workspace, 'gone.txt'), 'stale file\n');

  const session = (id) => ({
    type: 'session',
    version: 4,
    id,
    createdAt: now - 120000,
    cwd: workspace,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  });

  const sessionEvents = (id, target) => [
    session(id),
    ev('permission/preset', 0, { preset: 'workspace-write' }),
    ev('sandbox/mode', 1, { mode: 'workspace-write' }),
    ev('approval/policy', 2, { policy: 'ask' }),
    ev('turn/start', 3, { turn: 1 }),
    ev('step/start', 4, { turn: 1, step: 1 }),
    {
      type: 'user/message',
      seq: 5,
      time: now - 100000,
      surfaceOp: 'append',
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'Patch the answer and run the tests.' }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      seq: 6,
      time: now - 99000,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Thinking through the patch before editing.' },
            { type: 'text', text: 'I will update the constant, then run the test suite.' },
          ],
        },
        usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 8000, cacheWriteTokens: 0, totalTokens: 9240 },
      },
    },
    ev('tool/call', 7, {
      turn: 1,
      step: 1,
      callId: 'call_edit_1',
      name: 'edit',
      arguments: JSON.stringify({
        file_path: path.join(workspace, 'src', 'app.js'),
        old_string: 'export const answer = 41;',
        new_string: 'export const answer = 42;',
      }),
    }),
    ev('tool/result', 8, {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'call_edit_1',
        content: [{ type: 'text', text: 'Edited src/app.js' }],
        isError: false,
      },
      meta: { path: path.join(workspace, 'src', 'app.js'), diffs: [{ path: 'src/app.js' }] },
    }),
    ev('tool/call', 9, {
      turn: 1,
      step: 1,
      callId: 'call_pwsh_1',
      name: 'pwsh',
      arguments: JSON.stringify({
        command: 'node --test',
        description: 'run the node test runner',
        workdir: workspace,
      }),
    }),
    ev('tool/result', 10, {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'call_pwsh_1',
        content: [{ type: 'text', text: [
          ...Array.from({ length: 45 }, (_, i) => `line ${i + 1}: compiling module ${i + 1}`),
          'not ok 2 - flaky check',
          '[exit code: 1]',
        ].join('\n') }],
        isError: true,
      },
      meta: { cwd: workspace },
    }),
    {
      type: 'job/registered',
      seq: 11,
      time: now - 90000,
      data: {
        jobId: 'pwsh-test',
        owner: id,
        kind: 'pwsh',
        label: 'node --test',
        startedAt: now - 90000,
        toolCall: { callId: 'call_pwsh_1', rootCallId: 'call_pwsh_1' },
      },
    },
    {
      type: 'job/settled',
      seq: 12,
      time: now - 89000,
      data: {
        jobId: 'pwsh-test',
        owner: id,
        kind: 'pwsh',
        label: 'node --test',
        startedAt: now - 90000,
        toolCall: { callId: 'call_pwsh_1', rootCallId: 'call_pwsh_1' },
        finishedAt: now - 89000,
        status: 'completed',
        cause: 'producer',
        producerReported: true,
        detail: 'exit code: 1',
      },
    },
    ev('step/end', 13, { turn: 1, step: 1 }),
    ev('step/start', 14, { turn: 1, step: 2 }),
    {
      type: 'assistant/message',
      seq: 15,
      time: now - 70000,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Test 2 is flaky; writing a note instead of changing it.' }] },
        usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 9000, cacheWriteTokens: 0, totalTokens: 9930 },
      },
    },
    ev('tool/call', 16, {
      turn: 1,
      step: 2,
      callId: 'call_write_1',
      name: 'write',
      arguments: JSON.stringify({
        file_path: path.join(workspace, 'notes.md'),
        content: NOTES_FINAL,
      }),
    }),
    ev('tool/result', 17, {
      turn: 1,
      step: 2,
      message: {
        role: 'tool',
        toolCallId: 'call_write_1',
        content: [{ type: 'text', text: 'Updated notes.md' }],
        isError: false,
      },
      meta: { operation: 'update', path: path.join(workspace, 'notes.md'), diffs: [{ path: 'notes.md' }] },
    }),
    ev('step/end', 18, { turn: 1, step: 2 }),
    ev('step/start', 19, { turn: 1, step: 3 }),
    ev('tool/call', 20, {
      turn: 1, step: 3, callId: 'call_rm_1', name: 'pwsh',
      arguments: JSON.stringify({ command: 'Remove-Item gone.txt', description: 'drop the stale file', workdir: workspace }),
    }),
    ev('tool/result', 21, {
      turn: 1, step: 3,
      message: { role: 'tool', toolCallId: 'call_rm_1', isError: false, content: [{ type: 'text', text: 'removed gone.txt' }] },
      meta: { cwd: workspace },
    }),
    {
      type: 'job/registered', seq: 22, time: now - 85000,
      data: {
        jobId: 'pwsh-rm', owner: id, kind: 'pwsh', label: 'Remove-Item gone.txt',
        startedAt: now - 85000, toolCall: { callId: 'call_rm_1', rootCallId: 'call_rm_1' },
      },
    },
    {
      type: 'job/settled', seq: 23, time: now - 84000,
      data: {
        jobId: 'pwsh-rm', owner: id, kind: 'pwsh', label: 'Remove-Item gone.txt',
        startedAt: now - 85000, toolCall: { callId: 'call_rm_1', rootCallId: 'call_rm_1' },
        finishedAt: now - 84000, status: 'completed', cause: 'producer', producerReported: true, detail: 'exit code: 0',
      },
    },
    {
      type: 'assistant/message', seq: 24, time: now - 70000, surfaceOp: 'append',
      data: {
        turn: 1, step: 3,
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '**Bold** and _italic_ with ![shot](assets/shot.png)\n\n| File | What |\n| --- | --- |\n| a.js | first |\n| bb.js | second |\n\n```\ncode line\n```',
          }],
        },
        usage: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 100, cacheWriteTokens: 0 },
      },
    },
    ev('step/end', 25, { turn: 1, step: 3 }),
    ev('turn/end', 26, { turn: 1 }),
    {
      type: 'user/message',
      seq: 27,
      time: now - 69000,
      surfaceOp: 'append',
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-10-19T22:00:00+03:00. Browser time zone: Europe/Bucharest.' }],
        source: { kind: 'time-context' },
      },
    },
    {
      type: 'assistant/message',
      seq: 28,
      time: now - 68000,
      data: {
        turn: 1, step: 3,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: 'First part of reasoning about the patch.' }] },
        usage: null,
      },
    },
    {
      type: 'assistant/message',
      seq: 29,
      time: now - 67000,
      data: {
        turn: 1, step: 3,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Second part of reasoning about the tests.' }] },
        usage: null,
      },
    },
    {
      type: 'assistant/message',
      seq: 30,
      time: now - 66000,
      data: {
        turn: 1, step: 3,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: '   ' }] },
        usage: null,
      },
    },
    {
      type: 'session/title',
      seq: 31,
      time: now - 65000,
      data: { title: 'Automatic first-prompt title', messageSeqs: [5], source: { kind: 'fallback' } },
    },
  ];

  // Finished session: shift its events 20 minutes into the past so its state is
  // `finished` (an `idle` turn would still be recent), then backdate the file.
  const finishedEvents = sessionEvents(finishedId, finishedId).map((e) => (
    typeof e.time === 'number' ? { ...e, time: e.time - 20 * 60 * 1000 } : e
  ));
  const finishedLog = path.join(sessionsRoot, '--tmp-fixture-workspace--', finishedId, 'session.v4.jsonl.zstd');
  fs.writeFileSync(finishedLog, Buffer.concat([
    frame(finishedEvents.slice(0, 6)),
    frame(finishedEvents.slice(6, 12)),
    frame(finishedEvents.slice(12)),
  ]));
  const old = new Date(now - 600000);
  fs.utimesSync(finishedLog, old, old);

  // Live session: opening frames including an open turn/step, so it is live
  // from the log itself (not from mtime).
  const liveEvents = sessionEvents(liveId, liveId).slice(0, 6);
  const liveLog = path.join(sessionsRoot, '--tmp-fixture-workspace--', liveId, 'session.v4.jsonl.zstd');
  fs.writeFileSync(liveLog, frame(liveEvents));

  return {
    workspace,
    sessionsRoot,
    finishedId,
    liveId,
    finishedLog,
    liveLog,
    liveFirstFrames: liveEvents,
    remainingEvents: sessionEvents(liveId, liveId).slice(6),
    target: path.join(workspace, 'src', 'app.js'),
  };
}
