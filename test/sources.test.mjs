// Step 3: source adapters (Claude Code, Antigravity) + live tailing.
// Run: node test/sources.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { frame } from './fixture.mjs';

const PORT = 8894;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = path.join(import.meta.dirname, '.tmp-sources');
const workspace = path.join(tmp, 'workspace');
const claudeRoot = path.join(tmp, 'claude');
const agyRoot = path.join(tmp, 'antigravity');
const dshRoot = path.join(tmp, 'dsh');
const project = path.join(claudeRoot, 'E--TEST');
const claudeId = '11111111-2222-3333-4444-555555555555';
const claudeFile = path.join(project, `${claudeId}.jsonl`);
const subFile = path.join(project, claudeId, 'subagents', 'agent-abc.jsonl');
const agyConv = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const agyFile = path.join(agyRoot, 'brain', agyConv, '.system_generated', 'logs', 'transcript.jsonl');
const agyPairConv = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
const agyFullConv = 'aaaaaaaa-bbbb-cccc-dddd-000000000003';
const agyLog = (conv, name = 'transcript.jsonl') => path.join(agyRoot, 'brain', conv, '.system_generated', 'logs', name);
const SECRET = 'sk-live-SOURCESECRET1234567890';

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.mkdirSync(path.dirname(subFile), { recursive: true });
fs.mkdirSync(path.dirname(agyFile), { recursive: true });
fs.mkdirSync(path.dirname(agyLog(agyPairConv)), { recursive: true });
fs.mkdirSync(path.dirname(agyLog(agyFullConv)), { recursive: true });
fs.mkdirSync(dshRoot, { recursive: true });
fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'export const answer = 42;\n');
fs.writeFileSync(path.join(workspace, 'notes.md'), '# Notes\n');
fs.writeFileSync(path.join(workspace, 'gone.txt'), 'delete me\n');

const rootsFile = path.join(tmp, 'roots.json');
fs.writeFileSync(rootsFile, JSON.stringify({ roots: [], privateRoots: [] }));
const redactFile = path.join(tmp, 'redact.json');
fs.writeFileSync(redactFile, JSON.stringify({ literals: [], patterns: [] }));

const now = Date.now();
const iso = (offset) => new Date(now - 60000 + offset * 1000).toISOString();

const claudeLines = [
  { type: 'custom-title', customTitle: 'Fix the widget', sessionId: claudeId },
  { type: 'user', message: { role: 'user', content: 'Fix the widget please.' }, cwd: workspace, sessionId: claudeId, timestamp: iso(1), uuid: 'u1' },
  {
    type: 'user', cwd: workspace, sessionId: claudeId, timestamp: iso(1.5), uuid: 'u-skill',
    message: { role: 'user', content: `Base directory for this skill: ${path.join(workspace, '.claude', 'skills', 'demo')}\n\n# Demo skill\n\nUse this skill when testing.` },
  },
  {
    type: 'assistant', cwd: workspace, sessionId: claudeId, timestamp: iso(2), uuid: 'a1',
    message: {
      id: 'msg_a1', model: 'claude-opus-5-5',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Deliberating about the widget.' },
        { type: 'text', text: 'I will delete the stale file and update the answer.' },
      ],
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 },
    },
  },
  // Claude Code writes a reply's next content block as its own line, with the
  // same message id and the same usage repeated.
  {
    type: 'assistant', cwd: workspace, sessionId: claudeId, timestamp: iso(2), uuid: 'a1b',
    message: {
      id: 'msg_a1', model: 'claude-opus-5-5',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-bash', name: 'Bash', input: { command: 'rm gone.txt', description: 'remove stale file' } },
      ],
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 },
    },
  },
  {
    type: 'user', cwd: workspace, sessionId: claudeId, timestamp: iso(3), uuid: 'u2',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-bash', content: [{ type: 'text', text: 'removed' }], is_error: false }] },
    toolUseResult: { stdout: 'removed', stderr: '', interrupted: false },
  },
  {
    type: 'assistant', cwd: workspace, sessionId: claudeId, timestamp: iso(4), uuid: 'a2',
    message: {
      id: 'msg_a2', model: 'claude-opus-5-5',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-edit', name: 'Edit', input: { file_path: path.join(workspace, 'src', 'app.js'), old_string: 'export const answer = 41;', new_string: 'export const answer = 42;' } },
      ],
      usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    },
  },
  {
    type: 'user', cwd: workspace, sessionId: claudeId, timestamp: iso(5), uuid: 'u3',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-edit', content: 'Edited app.js', is_error: false }] },
  },
  {
    type: 'assistant', cwd: workspace, sessionId: claudeId, timestamp: iso(6), uuid: 'a3',
    message: {
      id: 'msg_a3', model: 'claude-opus-5-5',
      role: 'assistant',
      content: [
        { type: 'text', text: `Token ${SECRET} should never leak.` },
        { type: 'tool_use', id: 'tool-write', name: 'Write', input: { file_path: path.join(workspace, 'notes.md'), content: '# Notes\n\nUpdated by Claude.\n' } },
      ],
      usage: { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
    },
  },
  {
    type: 'user', cwd: workspace, sessionId: claudeId, timestamp: iso(7), uuid: 'u4',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-write', content: 'Wrote notes.md', is_error: false }] },
  },
];
fs.writeFileSync(claudeFile, claudeLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// The session folder's custom-title.json is the canonical title; the transcript
// also carries an unanswered tool_use so the session shows live.
fs.mkdirSync(path.join(project, claudeId), { recursive: true });
fs.writeFileSync(
  path.join(project, claudeId, 'custom-title.json'),
  JSON.stringify({ customTitle: 'Claude fixture from file' }),
);
fs.appendFileSync(claudeFile, JSON.stringify({
  type: 'assistant', cwd: workspace, sessionId: claudeId, timestamp: iso(7.5), uuid: 'a-pending',
  message: {
    id: 'msg_pending', model: 'claude-opus-5-5',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Waiting on a long command.' },
      { type: 'tool_use', id: 'tool-pending', name: 'Bash', input: { command: 'sleep 999' } },
    ],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
}) + '\n');

const subLines = [
  { type: 'user', isSidechain: true, cwd: workspace, sessionId: claudeId, timestamp: iso(8), message: { role: 'user', content: 'subagent task' } },
  {
    type: 'assistant', isSidechain: true, cwd: workspace, sessionId: claudeId, timestamp: iso(9),
    message: {
      id: 'msg_sub', model: 'claude-haiku-4-5',
      role: 'assistant',
      content: [
        { type: 'text', text: 'subagent reporting in' },
        { type: 'tool_use', id: 'sub-read', name: 'Read', input: { file_path: path.join(workspace, 'notes.md') } },
      ],
      usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  },
  {
    type: 'user', isSidechain: true, cwd: workspace, sessionId: claudeId, timestamp: iso(10),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sub-read', content: 'notes body', is_error: false }] },
  },
];
fs.writeFileSync(subFile, subLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

const agyLines = [
  { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: iso(1), content: '<USER_REQUEST>\nInspect the widget\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>' },
  {
    step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(2), content: 'Looking at the widget now.',
    input_tokens: 100, cache_read_tokens: 50, output_tokens: 20,
    tool_calls: [{ name: 'run_command', args: { CommandLine: '"Remove-Item gone.txt"', Cwd: JSON.stringify(workspace) } }],
  },
  { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: iso(3), content: 'The command exited with code 0.\nOutput:\nremoved' },
  {
    step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(4),
    input_tokens: 200, cache_read_tokens: 60, output_tokens: 30,
    tool_calls: [{ name: 'view_file', args: { AbsolutePath: JSON.stringify(path.join(workspace, 'src', 'app.js')) } }],
  },
  { step_index: 4, source: 'MODEL', type: 'GENERIC', created_at: iso(5), content: 'export const answer = 42;' },
  {
    step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(6),
    input_tokens: 300, cache_read_tokens: 70, output_tokens: 40,
    tool_calls: [
      { name: 'replace_file_content', args: { TargetFile: JSON.stringify(path.join(workspace, 'src', 'app.js')), TargetContent: JSON.stringify('export const answer = 41;'), ReplacementContent: JSON.stringify('export const answer = 42;') } },
      { name: 'write_to_file', args: { TargetFile: JSON.stringify(path.join(workspace, 'notes.md')), CodeContent: JSON.stringify('# Notes\n\nAntigravity wrote this.\n') } },
    ],
  },
  { step_index: 6, source: 'MODEL', type: 'GENERIC', created_at: iso(7), content: 'The command exited with code 0.\nOutput:\nok' },
  { step_index: 7, source: 'SYSTEM', type: 'ERROR_MESSAGE', created_at: iso(8), error: 'API error 503' },
];
fs.writeFileSync(agyFile, agyLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// Pairing: three parallel calls (one tool the adapter never mapped), a planner
// response whose second call never gets a result, and failed, denied and
// still-running commands.
const longOutput = 'LONGBODY '.repeat(900).trim();
const agyPairLines = [
  { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: iso(1), content: '<USER_REQUEST>\nPair the results\n</USER_REQUEST>' },
  {
    step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(2),
    tool_calls: [
      { name: 'frobnicate_widget', args: { Mode: JSON.stringify('fast'), Level: 3 } },
      { name: 'run_command', args: { CommandLine: JSON.stringify('node build.js'), Cwd: JSON.stringify(workspace) } },
      { name: 'grep_search', args: { Query: JSON.stringify('answer'), SearchPath: JSON.stringify(workspace) } },
    ],
  },
  { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(3), content: 'frobnicated fine' },
  { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(3), content: 'The command exited with code 0.\nOutput:\nbuilt ok' },
  { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(3), content: 'Found 1 match: src/app.js' },
  {
    step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(4),
    tool_calls: [
      { name: 'list_dir', args: { DirectoryPath: JSON.stringify(workspace) } },
      { name: 'read_url_content', args: { Url: JSON.stringify('https://example.test/docs') } },
    ],
  },
  { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(5), content: 'src\nnotes.md' },
  {
    step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(6),
    tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify('node fail.js'), Cwd: JSON.stringify(workspace) } }],
  },
  { step_index: 9, source: 'MODEL', type: 'GENERIC', status: 'ERROR', created_at: iso(7), content: 'The command exited with code 2.', error: 'command failed' },
  {
    step_index: 10, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(8),
    tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify('node denied.js'), Cwd: JSON.stringify(workspace) } }],
  },
  { step_index: 11, source: 'MODEL', type: 'GENERIC', status: 'ERROR', created_at: iso(9), content: '', error: 'user denied permission to run command' },
  {
    step_index: 12, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(10),
    tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify('node serve.js'), Cwd: JSON.stringify(workspace) } }],
  },
  { step_index: 13, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: iso(11), content: 'listening on a port\nCommand ID: cmd-1234' },
  {
    step_index: 14, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(12),
    tool_calls: [{ name: 'command_status', args: { CommandId: JSON.stringify('cmd-1234'), WaitDurationSeconds: 5 } }],
  },
  { step_index: 15, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(13), content: 'still serving' },
];
fs.writeFileSync(agyLog(agyPairConv), agyPairLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// transcript.jsonl cuts long fields and says so; transcript_full.jsonl keeps them.
const fullEdit = { TargetFile: JSON.stringify(path.join(workspace, 'src', 'app.js')), TargetContent: JSON.stringify('export const answer = 41;'), ReplacementContent: JSON.stringify('export const answer = 42; // ' + 'long comment '.repeat(400)) };
const cutEdit = { ...fullEdit, ReplacementContent: JSON.stringify('export const answer = 42; // long comment') };
const agyFullLines = [
  { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: iso(1), content: '<USER_REQUEST>\nTruncated bodies\n</USER_REQUEST>' },
  { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(2), tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify('node big.js'), Cwd: JSON.stringify(workspace) } }, { name: 'replace_file_content', args: fullEdit }] },
  { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(3), content: 'The command exited with code 0.\nOutput:\n' + longOutput },
  { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(3), content: 'edited' },
];
const agyCutLines = agyFullLines.map((l) => {
  if (l.step_index === 1) return { ...l, tool_calls: [l.tool_calls[0], { name: 'replace_file_content', args: cutEdit }], truncated_fields: ['tool_calls'] };
  if (l.step_index === 2) return { ...l, content: l.content.slice(0, 200) + '...[truncated]', truncated_fields: ['content'] };
  return l;
});
fs.writeFileSync(agyLog(agyFullConv), agyCutLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(agyLog(agyFullConv, 'transcript_full.jsonl'), agyFullLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

const old = new Date(now - 600000);
fs.utimesSync(agyLog(agyPairConv), old, old);
fs.utimesSync(agyLog(agyFullConv), old, old);
fs.utimesSync(agyFile, old, old);

// Permission modes: how much each agent may do without asking (lib/tiers.js).
// Claude Code writes permissionMode on its prompts; the latest one counts.
const claudeBypassId = '33333333-aaaa-bbbb-cccc-000000000001';
const claudeOddId = '33333333-aaaa-bbbb-cccc-000000000002';
const claudeNoModeId = '33333333-aaaa-bbbb-cccc-000000000003';
const claudePrompt = (id, text, offset, extra = {}) => ({ type: 'user', cwd: workspace, sessionId: id, timestamp: iso(offset), message: { role: 'user', content: text }, ...extra });
const claudeReply = (id, text, offset, n) => ({ type: 'assistant', cwd: workspace, sessionId: id, timestamp: iso(offset), message: { id: `msg_perm_${id.slice(-1)}_${n}`, model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
const writeClaude = (id, lines) => {
  const file = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(file, old, old);
};
writeClaude(claudeBypassId, [
  claudePrompt(claudeBypassId, 'Start safely.', 1, { permissionMode: 'default' }),
  claudeReply(claudeBypassId, 'On it.', 2, 1),
  claudePrompt(claudeBypassId, 'Now skip the prompts.', 3, { permissionMode: 'bypassPermissions' }),
  claudeReply(claudeBypassId, 'Skipping.', 4, 2),
]);
writeClaude(claudeOddId, [
  claudePrompt(claudeOddId, 'A mode this build does not know.', 1, { permissionMode: 'futureMode' }),
  claudeReply(claudeOddId, 'Fine.', 2, 1),
]);
writeClaude(claudeNoModeId, [
  claudePrompt(claudeNoModeId, 'No mode recorded.', 1),
  claudeReply(claudeNoModeId, 'Fine.', 2, 1),
]);

// Antigravity CLI logs: one per process, naming the conversations it served and its toolPermission.
const pad2 = (n, w = 2) => String(n).padStart(w, '0');
const glog = (ms, text) => { const d = new Date(ms); return `I${pad2(d.getMonth() + 1)}${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad2(d.getMilliseconds(), 3)}000     1 x.go:1] ${text}`; };
const cliLogName = (ms) => { const d = new Date(ms); return `cli-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.log`; };
const agyFlagConv = 'aaaaaaaa-bbbb-cccc-dddd-000000000004';
const agyModeConv = 'aaaaaaaa-bbbb-cccc-dddd-000000000005';
const agyQuotedConv = 'aaaaaaaa-bbbb-cccc-dddd-000000000006';
for (const conv of [agyFlagConv, agyModeConv, agyQuotedConv]) {
  fs.mkdirSync(path.dirname(agyLog(conv)), { recursive: true });
  fs.writeFileSync(agyLog(conv), JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: iso(1), content: '<USER_REQUEST>\nA permission fixture\n</USER_REQUEST>' }) + '\n');
  fs.utimesSync(agyLog(conv), old, old);
}
fs.mkdirSync(path.join(agyRoot, 'log'), { recursive: true });
const writeCliLog = (hoursAgo, pid, toolPermission, convs, { startup = [], later = [] } = {}) => {
  const at = now - hoursAgo * 3600000;
  const lines = [
    glog(at, `Starting language server process with pid ${pid}`),
    ...startup.map((t, i) => glog(at + 10 + i, t)),
    ...(toolPermission ? [glog(at + 50, `CLI settings initialized: permissions=<nil>, toolPermission=${toolPermission}`)] : []),
    ...convs.map((c, i) => glog(at + 100 + i, `Sending user message to conversation ${c} (items=1, media=0)`)),
    ...later.map((t, i) => glog(at + 500 + i, t)),
  ];
  fs.writeFileSync(path.join(agyRoot, 'log', cliLogName(at)), lines.join('\n') + '\n');
};
// The older process asked; the newer one served the same conversation and proceeds always.
writeCliLog(5, 9001, 'request-review', [agyConv, agyPairConv], { later: ['Tool args: --dangerously-skip-permissions typed in a prompt'] });
writeCliLog(4, 9002, 'always-proceed', [agyPairConv]);
writeCliLog(3, 9003, 'request-review', [agyFlagConv], { startup: ['args: [agy --dangerously-skip-permissions]'] });
writeCliLog(2, 9004, 'request-review', [agyModeConv], { startup: ['args: [agy --mode accept-edits]'] });
writeCliLog(1, 9005, 'strict', [agyQuotedConv], { later: ['user typed --mode plan and --dangerously-skip-permissions'] });

// DeepSeek Harness: the mode is set by events in the log, and a switch is an event too.
const dshWs = path.join(dshRoot, '--tmp-perm-workspace--');
const dshSwitchId = 'session-aaaaaaaa-0000-0000-0000-000000000001';
const dshStartsBypassId = 'session-aaaaaaaa-0000-0000-0000-000000000002';
const dshAutoId = 'session-aaaaaaaa-0000-0000-0000-000000000003';
const dshCustomId = 'session-aaaaaaaa-0000-0000-0000-000000000004';
const dshSession = (id) => ({ type: 'session', version: 4, id, createdAt: now - 120000, cwd: workspace, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' });
const dshEv = (type, seq, data) => ({ type, seq, time: now - 90000 + seq * 1000, data });
const writeDsh = (id, events) => {
  fs.mkdirSync(path.join(dshWs, id), { recursive: true });
  fs.writeFileSync(path.join(dshWs, id, 'session.v4.jsonl.zstd'), frame(events));
};
writeDsh(dshSwitchId, [
  dshSession(dshSwitchId),
  dshEv('permission/preset', 0, { preset: 'workspace-write' }),
  dshEv('sandbox/mode', 1, { mode: 'workspace-write' }),
  dshEv('approval/policy', 2, { policy: 'ask' }),
  dshEv('turn/start', 3, { turn: 1 }),
  dshEv('step/start', 4, { turn: 1, step: 1 }),
  dshEv('step/end', 5, { turn: 1, step: 1 }),
  dshEv('turn/end', 6, { turn: 1 }),
  dshEv('permission/preset', 7, { preset: 'danger-full-access' }),
  dshEv('sandbox/mode', 8, { mode: 'danger-full-access' }),
  dshEv('approval/policy', 9, { policy: 'never' }),
  dshEv('turn/start', 10, { turn: 2 }),
  dshEv('step/start', 11, { turn: 2, step: 1 }),
  dshEv('step/end', 12, { turn: 2, step: 1 }),
  dshEv('turn/end', 13, { turn: 2 }),
]);
const dshLiveId = 'session-aaaaaaaa-0000-0000-0000-000000000005';
writeDsh(dshLiveId, [
  dshSession(dshLiveId),
  dshEv('permission/preset', 0, { preset: 'workspace-write' }),
  dshEv('sandbox/mode', 1, { mode: 'workspace-write' }),
  dshEv('approval/policy', 2, { policy: 'ask' }),
  dshEv('turn/start', 3, { turn: 1 }),
  dshEv('step/start', 4, { turn: 1, step: 1 }),
]);
writeDsh(dshStartsBypassId, [
  dshSession(dshStartsBypassId),
  dshEv('permission/preset', 0, { preset: 'danger-full-access' }),
  dshEv('sandbox/mode', 1, { mode: 'danger-full-access' }),
  dshEv('approval/policy', 2, { policy: 'never' }),
  dshEv('turn/start', 3, { turn: 1 }),
  dshEv('turn/end', 4, { turn: 1 }),
]);
writeDsh(dshAutoId, [
  dshSession(dshAutoId),
  dshEv('permission/preset', 0, { preset: 'auto' }),
  dshEv('sandbox/mode', 1, { mode: 'danger-full-access' }),
  dshEv('approval/policy', 2, { policy: 'ask' }),
  dshEv('turn/start', 3, { turn: 1 }),
  dshEv('turn/end', 4, { turn: 1 }),
]);
// No preset event: sandbox and policy alone set the mode, so this is where it starts, not a switch.
const dshNoPresetId = 'session-aaaaaaaa-0000-0000-0000-000000000007';
writeDsh(dshNoPresetId, [
  dshSession(dshNoPresetId),
  dshEv('sandbox/mode', 0, { mode: 'danger-full-access' }),
  dshEv('approval/policy', 1, { policy: 'never' }),
  dshEv('turn/start', 2, { turn: 1 }),
  dshEv('turn/end', 3, { turn: 1 }),
]);
// A log over the 24 MB scan limit that set bypass at its start: only the tail is read for
// the rest, so the mode must still come from the head. One frame per event, as dsh writes.
const dshBigId = 'session-aaaaaaaa-0000-0000-0000-000000000008';
{
  const crypto = await import('node:crypto');
  const filler = crypto.randomBytes(48 * 1024).toString('base64');
  const parts = [frame([dshSession(dshBigId)]), frame([dshEv('permission/preset', 0, { preset: 'danger-full-access' })]),
    frame([dshEv('sandbox/mode', 1, { mode: 'danger-full-access' })]), frame([dshEv('approval/policy', 2, { policy: 'never' })])];
  let size = parts.reduce((n, b) => n + b.length, 0);
  for (let i = 0; size < 25 * 1024 * 1024; i++) {
    // Random text does not compress, so each frame really adds its size to the file.
    const b = frame([dshEv('filler/noise', 3, { blob: filler.slice(i % 64) + i })]);
    parts.push(b);
    size += b.length;
  }
  parts.push(frame([dshEv('turn/start', 4, { turn: 1 })]), frame([dshEv('turn/end', 5, { turn: 1 })]));
  fs.mkdirSync(path.join(dshWs, dshBigId), { recursive: true });
  fs.writeFileSync(path.join(dshWs, dshBigId, 'session.v4.jsonl.zstd'), Buffer.concat(parts));
}
writeDsh(dshCustomId, [
  dshSession(dshCustomId),
  dshEv('permission/preset', 0, { preset: 'custom' }),
  dshEv('sandbox/mode', 1, { mode: 'workspace-write' }),
  dshEv('approval/policy', 2, { policy: 'never' }),
  dshEv('turn/start', 3, { turn: 1 }),
  dshEv('turn/end', 4, { turn: 1 }),
]);

const server = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
      AGENTTAIL_NO_OPEN: '1',
    DSH_SESSIONS_ROOT: dshRoot,
    CLAUDE_PROJECTS_ROOT: claudeRoot,
    ANTIGRAVITY_ROOT: path.join(agyRoot, 'brain'),
    AGENTTAIL_CLAUDE_SESSIONS_DIR: path.join(tmp, 'claude-sessions'),
    DSH_ROOTS_FILE: rootsFile,
    DSH_REDACT_FILE: redactFile,
    DSH_POLL_MS: '150',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
server.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
server.stderr.on('data', (d) => process.stderr.write('  [server:err] ' + d));

const failures = [];
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok    ${msg}`);
  else { failures.push(msg); console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`); }
};
const getJson = async (url) => {
  const res = await fetch(BASE + url);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function readSse(url, stop, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evLine = raw.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!evLine || !dataLine) continue;
        const ev = { event: evLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
        events.push(ev);
        if (stop(ev, events)) {
          controller.abort();
          return events;
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

const eventsOf = (events) => events.filter((e) => e.event === 'ev').map((e) => e.data);

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/sources')).ok) break; } catch {}
    await sleep(100);
  }

  console.log('\nsources');
  const sources = await getJson('/api/sources');
  check(sources.body.sources?.length === 3, 'three sources are listed', JSON.stringify(sources.body.sources?.map((s) => s.key)));
  check(sources.body.sources?.some((s) => s.key === 'claude') && sources.body.sources?.some((s) => s.key === 'antigravity'), 'Claude and Antigravity are selectable');

  console.log('\nClaude Code');
  const claudeSessions = await getJson('/api/sessions?source=claude');
  const claudeSession = claudeSessions.body.sessions.find((s) => s.id === claudeId);
  check(!!claudeSession, 'Claude session is listed', JSON.stringify(claudeSessions.body.sessions?.map((s) => s.id)));
  check(claudeSession?.title === 'Claude fixture from file', 'custom-title.json becomes the session title', claudeSession?.title);
  check(claudeSession?.cwd === workspace, 'cwd comes from the transcript', claudeSession?.cwd);
  check(claudeSession?.source === 'claude', 'session carries its source');
  check(claudeSession?.subagents === 1, 'subagent transcripts are counted', String(claudeSession?.subagents));
  check(claudeSession?.state === 'live' && /open tool call/.test(claudeSession?.stateDetail || ''), 'an unanswered tool_use keeps Claude live', JSON.stringify({ state: claudeSession?.state, detail: claudeSession?.stateDetail }));

  const cEvents = await readSse(
    `${BASE}/api/stream?source=claude&id=${encodeURIComponent(claudeId)}`,
    (e) => e.event === 'historyEnd',
  );
  const claudeEvs = eventsOf(cEvents);
  const cMeta = cEvents.find((e) => e.event === 'meta');
  check(cMeta?.data.prices?.apiEquivalent === true, 'Claude is priced as an API equivalent', JSON.stringify(cMeta?.data.prices));
  check(cMeta?.data.session.model === 'claude-opus-5-5' && cMeta?.data.session.provider === 'anthropic', 'the model comes from the transcript', JSON.stringify([cMeta?.data.session.model, cMeta?.data.session.provider]));
  check(cMeta?.data.session.source === 'claude', 'meta reports the source');
  check(!JSON.stringify(claudeEvs).includes(SECRET), 'redaction applies to Claude events');
  check(claudeEvs.some((e) => e.t === 'user' && e.text.includes('Fix the widget')), 'user message normalized');
  check(claudeEvs.some((e) => e.t === 'user' && e.system === true && e.systemLabel === '⌘ skill' && e.text.includes('Base directory for this skill:')), 'a loaded skill is marked as an injected system message', JSON.stringify(claudeEvs.filter((e) => e.t === 'user').map((e) => [e.system, e.systemLabel, e.text.slice(0, 40)])));
  check(claudeEvs.some((e) => e.t === 'user' && e.text.includes('Fix the widget') && e.system === false), 'a normal user message is not marked system');
  check(claudeEvs.filter((e) => e.t === 'step').length === 5, 'assistant turns (including subagent) become steps', String(claudeEvs.filter((e) => e.t === 'step').length));
  check(claudeEvs.some((e) => e.t === 'say' && (e.thinking || '').includes('Deliberating')), 'Claude thinking blocks are projected', JSON.stringify(claudeEvs.filter((e) => e.thinking).slice(0, 1)));
  const cCalls = claudeEvs.filter((e) => e.t === 'call');
  check(cCalls.some((e) => e.name === 'pwsh' && e.args.command === 'rm gone.txt'), 'Bash becomes a pwsh command');
  check(cCalls.some((e) => e.name === 'edit' && e.args.new_string.includes('42')), 'Edit carries old/new text');
  check(cCalls.some((e) => e.name === 'write' && e.args.content.includes('Updated by Claude')), 'Write carries content');
  check(claudeEvs.some((e) => e.t === 'deleted' && e.path === 'gone.txt'), 'rm marks a file deleted', JSON.stringify(claudeEvs.filter((e) => e.t === 'deleted')));
  check(claudeEvs.some((e) => e.t === 'result' && e.text.includes('removed')), 'tool_result becomes output');
  const cUsage = claudeEvs.filter((e) => e.usage).reduce((a, e) => a + e.usage.input + e.usage.output + e.usage.cacheRead + e.usage.cacheWrite, 0);
  check(cUsage === 100 + 40 + 1000 + 10 + 50 + 20 + 2000 + 30 + 10 + 3000 + 5 + 5 + 1 + 1, 'usage is mapped to token counts', String(cUsage));
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 5-minute cache write; Haiku 4.5: $1 in, $5 out.
  const cCost = claudeEvs.filter((e) => e.t === 'say' && typeof e.cost === 'number').reduce((a, e) => a + e.cost, 0);
  const wantCost = (100 * 4 + 40 * 20 + 1000 * 0.2 + 10 * 5 + 50 * 4 + 20 * 20 + 2000 * 0.2 + 30 * 4 + 10 * 20 + 3000 * 0.2 + 1 * 4 + 1 * 20 + 5 * 1 + 5 * 5) / 1e6;
  check(Math.abs(cCost - wantCost) < 1e-12, 'each reply carries its API-equivalent cost, counted once', `${cCost} vs ${wantCost}`);
  check(claudeEvs.filter((e) => e.t === 'say' && e.usage).every((e) => e.model), 'priced replies name their model');
  check(claudeEvs.filter((e) => e.t === 'turn').length === 1 && claudeEvs.filter((e) => e.t === 'turnEnd').length === 0, 'a real prompt opens a turn; injected text does not', JSON.stringify(claudeEvs.filter((e) => /^turn/.test(e.t))));
  check(claudeEvs.filter((e) => e.t === 'say' && !e.agent).every((e) => e.turn === 1), 'replies carry their turn number');
  check(claudeEvs.some((e) => e.agent && e.agent.startsWith('agent-') && e.text?.includes('subagent')), 'subagent transcript events are included', JSON.stringify(claudeEvs.filter((e) => e.agent).slice(0, 2)));

  // A quiet transcript is not idle while the turn is open: the model may be composing.
  const { createRequire } = await import('node:module');
  const claudeLib = createRequire(import.meta.url)('../lib/claude.js');
  const sig = claudeLib._turnSignal;
  check(sig({ type: 'user', message: { content: 'Please add a test' } }) === true, 'a user prompt opens the turn');
  check(sig({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }) === true, 'a tool result keeps the turn open');
  check(sig({ type: 'assistant', message: { stop_reason: 'tool_use', content: [] } }) === true, 'an assistant step that calls a tool keeps the turn open');
  check(sig({ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }) === false, 'end_turn closes the turn');
  check(sig({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hmm' }] } }) === null, 'a thinking-only line of a reply says nothing about the turn, even with end_turn on it');
  check(sig({ type: 'assistant', message: { stop_reason: 'refusal', content: [{ type: 'text', text: 'no' }] } }) === false, 'a refusal closes the turn');
  check(sig({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) === false, 'an interrupted request closes the turn');
  check(sig({ type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } }) === null && sig({ type: 'attachment' }) === null && sig({ type: 'user', isSidechain: true, message: { content: 'x' } }) === null, 'injected text, attachments and subagent lines say nothing about the turn');

  // API-equivalent prices for Claude replies.
  const pricing = createRequire(import.meta.url)('../lib/pricing.js');
  const near = (a, b) => a !== null && Math.abs(a - b) < 1e-9;
  const M = 1_000_000;
  check(near(pricing.claudeCost('claude-opus-5-5', { input_tokens: M, output_tokens: M }), 24), 'Opus 5.5 is $4 in, $20 out');
  check(near(pricing.claudeCost('claude-opus-5', { input_tokens: M, output_tokens: M }), 30), 'Opus 5 does not pick up the Opus 5.5 rate');
  check(near(pricing.claudeCost('claude-opus-5-5', { cache_read_input_tokens: M }), 0.2), 'Opus 5.5 cache reads use their own rate');
  check(near(pricing.claudeCost('claude-sonnet-4-6', { cache_read_input_tokens: M }), 0.3), 'other cache reads are 0.1x input');
  check(near(pricing.claudeCost('claude-sonnet-5-5', { cache_creation_input_tokens: 2 * M, cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M } }), 2 * 1.25 + 2 * 2), '5-minute writes are 1.25x input, 1-hour writes 2x');
  check(near(pricing.claudeCost('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 1000 }), (50_000 * 0.1 + 1000 * 0.5) / M) &&
    near(pricing.claudeCost('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 1000 }), (200_000 * 0.5 + 1000 * 2.5) / M), 'Haiku 5.5 switches rate cards above 100K prompt tokens');
  check(near(pricing.claudeCost('claude-opus-5-5', { input_tokens: M, output_tokens: M, speed: 'fast' }), 48), 'Opus 5.5 fast mode is $8 in, $40 out');
  check(near(pricing.claudeCost('claude-sonnet-5', { server_tool_use: { web_search_requests: 3 } }), 0.03), 'web searches are $10 per thousand');
  check(near(pricing.claudeCost('us.anthropic.claude-haiku-4-5-20251001-v1:0', { output_tokens: M }), 5) && near(pricing.claudeCost('claude-opus-4-1-20250805', { output_tokens: M }), 75), 'dated and cloud ids find their model');
  check(pricing.claudeCost('<synthetic>', { input_tokens: 5 }) === null && pricing.claudeCost('gpt-x', { input_tokens: 5 }) === null && pricing.claudeCost('claude-opus-55', { input_tokens: 5 }) === null, 'an unknown model has no price');

  // Turns: end_turn closes the open turn exactly once, even across repeated lines.
  const turnStream = claudeLib.open({ id: 'turns', file: path.join(tmp, 'turns.jsonl'), cwd: workspace }, { mapPath: (p) => p, redactor: { event: (e) => e, text: (t) => t }, maxEvents: 1000 });
  const ts0 = new Date().toISOString();
  for (const e of [
    { type: 'user', message: { content: 'first task' } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'mulling' }], usage: { output_tokens: 3 } } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { output_tokens: 3 } } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done again' }], usage: { output_tokens: 3 } } },
    { type: 'user', message: { content: 'second task' } },
    { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]) turnStream.processEntry({ timestamp: ts0, ...e }, null);
  const turnEvs = turnStream.events.filter((e) => /^turn/.test(e.t)).map((e) => `${e.t}:${e.turn}`).join(' ');
  check(turnEvs === 'turn:1 turnEnd:1 turn:2 turnEnd:2', 'turns open on prompts and close on end_turn or an interrupt', turnEvs);
  const firstEnd = turnStream.events.findIndex((e) => e.t === 'turnEnd');
  const answer = turnStream.events.findIndex((e) => e.t === 'say' && e.text === 'done');
  check(answer >= 0 && answer < firstEnd && turnStream.events[answer].turn === 1, 'the turn closes after the answer, not after its thinking line', JSON.stringify({ answer, firstEnd }));
  check(turnStream.events.filter((e) => e.t === 'step').length === 1 && turnStream.events.filter((e) => e.usage).length === 1, 'a reply split over lines is one step with one usage');

  // Prompts typed while a turn runs are queued_command attachments; prompts can
  // also come from somewhere other than the person.
  const feedStream = (id, entries, redactor = { event: (e) => e, text: (t) => t }) => {
    const stream = claudeLib.open({ id, file: path.join(tmp, `${id}.jsonl`), cwd: workspace }, { mapPath: (p) => p, redactor, maxEvents: 1000 });
    entries.forEach((e, i) => stream.processEntry({ timestamp: new Date(now - 60000 + i * 1000).toISOString(), ...e }, null));
    return stream;
  };
  const prompt = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
  const queued = (text, origin) => ({ type: 'attachment', attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', ...(origin ? { origin } : {}) } });
  const toolStep = (id) => ({ type: 'assistant', message: { id: `m-${id}`, model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a.txt' } }], usage: { output_tokens: 1 } } });
  const toolDone = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const endStep = (id, text, reason = 'end_turn') => ({ type: 'assistant', message: { id: `m-${id}`, model: 'claude-opus-5-5', stop_reason: reason, content: [{ type: 'text', text }], usage: { output_tokens: 1 } } });
  const userRows = (s) => s.events.filter((e) => e.t === 'user').map((e) => `${e.origin}:${e.turn ?? '-'}:${e.text.slice(0, 22)}`);
  const turnRows = (s) => s.events.filter((e) => /^turn/.test(e.t)).map((e) => `${e.t}:${e.turn}`).join(' ');
  const qs = feedStream('queued', [
    prompt('start the build'),
    toolStep('t1'),
    queued('also run the tests', { kind: 'human' }),
    queued('and lint', { kind: 'human' }),
    prompt('and lint'), // the same prompt, also written as a user entry
    toolDone('t1'),
    prompt('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>', { origin: { kind: 'task-notification' } }),
    endStep('a1', 'built, tested, linted'),
    prompt('check docs'),
    queued('check docs'), // the attachment comes after the user entry this time
    toolStep('t2'),
    queued('more', { kind: 'human' }),
    endStep('a2', 'docs fine'),
    prompt('more'), // the turn has ended; the queued prompt now starts the next one
  ]);
  const wantUsers = [
    'person:1:start the build', 'queued:1:also run the tests', 'queued:1:and lint', 'task_notification:1:<task-notification>\n<t',
    'person:2:check docs', 'queued:2:more',
  ];
  check(JSON.stringify(userRows(qs)) === JSON.stringify(wantUsers), 'queued prompts show once each, in order, with their origin', JSON.stringify(userRows(qs)));
  check(qs.events.filter((e) => e.t === 'user' && e.text === 'and lint').length === 1 && qs.events.filter((e) => e.t === 'user' && e.text === 'check docs').length === 1, 'a queued prompt also written as a user entry is not shown twice, in either order');
  const note = qs.events.find((e) => e.t === 'user' && e.origin === 'task_notification');
  check(note && note.system === true, 'a task notification is a system message with its origin');
  check(turnRows(qs) === 'turn:1 turnEnd:1 turn:2 turnEnd:2 turn:3', 'queued prompts open no turn of their own, and the one that follows a finished turn opens the next', turnRows(qs));
  check(qs.events.filter((e) => e.t === 'user' && e.origin === 'queued' && e.system).length === 0, 'a queued person prompt is not a system message');
  const os = feedStream('origins', [
    prompt('run nightly', { turnOrigin: 'scheduled' }),
    prompt('sync notes', { origin: { kind: 'peer' } }),
    prompt('via sdk', { origin: 'sdk' }),
    prompt('odd one', { origin: { kind: 'carrier-pigeon' } }),
    prompt('typed by you', { turnOrigin: 'human' }),
    prompt('plain'),
  ]);
  check(os.events.filter((e) => e.t === 'user').map((e) => e.origin).join() === 'scheduled,peer,sdk,carrier-pigeon,person,person', 'every prompt is labelled by its origin: scheduled, another agent, SDK, the raw value when unknown, the person', os.events.filter((e) => e.t === 'user').map((e) => e.origin).join());
  const sdkStream = feedStream('queued-secret', [prompt('go'), queued('mail ada.lovelace@example.com now', { kind: 'secret-origin@example.com' })], new (createRequire(import.meta.url)('../lib/redact.js').Redactor)({ configPath: redactFile }));
  check(!JSON.stringify(sdkStream.events).includes('ada.lovelace@example.com') && !JSON.stringify(sdkStream.events).includes('secret-origin@example.com'), 'a queued prompt and an unknown origin go through the redactor');

  // A compaction is not a prompt and not a turn; max_tokens ends a turn.
  const cs = feedStream('compact', [
    prompt('long task'),
    endStep('c1', 'first part done', 'tool_use'),
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 180000, postTokens: 12000 } },
    prompt('This session is being continued from a previous conversation that ran out of context. Summary: ...', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    toolStep('t3'),
    endStep('c2', 'all done'),
    prompt('Still the summary of a second compaction, with no boundary line', { isVisibleInTranscriptOnly: true }),
    prompt('next job'),
  ]);
  const compacted = cs.events.filter((e) => e.t === 'compacted');
  check(compacted.length === 2 && compacted[0].before === 180000 && compacted[0].after === 12000 && compacted[0].trigger === 'auto', 'a compaction becomes one marker with the token counts of its boundary', JSON.stringify(compacted));
  check(compacted[1] && compacted[1].before === undefined && compacted[1].after === undefined, 'a summary with no boundary still marks the compaction, without counts');
  check(!cs.events.some((e) => e.t === 'user' && /continued from a previous|second compaction/.test(e.text)), 'a compaction summary is not shown as a prompt');
  check(turnRows(cs) === 'turn:1 turnEnd:1 turn:2', 'a compaction in the middle of a session leaves the turn count unchanged', turnRows(cs));
  check(sig({ type: 'user', isCompactSummary: true, message: { content: 'summary' } }) === null && sig({ type: 'user', isVisibleInTranscriptOnly: true, message: { content: 'summary' } }) === null, 'a compaction summary says nothing about the turn');
  const mt = feedStream('maxtok', [
    prompt('write a long essay'),
    endStep('x1', 'Once upon a', 'max_tokens'),
    prompt('go on'),
    endStep('x2', 'fine', 'end_turn'),
    prompt('refuse this'),
    endStep('x3', 'no', 'refusal'),
  ]);
  const mtEnds = mt.events.filter((e) => e.t === 'turnEnd');
  check(turnRows(mt) === 'turn:1 turnEnd:1 turn:2 turnEnd:2 turn:3 turnEnd:3', 'end_turn and refusal still close their turns around a max_tokens one', turnRows(mt));
  check(mtEnds[0].reason === 'max_tokens' && mtEnds[1].reason === undefined && mtEnds[2].reason === undefined, 'only the max_tokens turn carries the cut-short reason', JSON.stringify(mtEnds.map((e) => e.reason)));
  const cut = feedStream('cut', [prompt('write more'), endStep('y1', 'cut off mid-sen', 'max_tokens')]);
  check(cut.events.at(-1).t === 'turnEnd' && cut.events.at(-1).turn === 1 && cut.turnOpen === false, 'a max_tokens reply closes its turn at once, not after 30 minutes', JSON.stringify(cut.events.map((e) => e.t)));
  const proto = feedStream('origin-proto', [prompt('hm', { origin: { kind: 'constructor' } })]);
  check(proto.events.find((e) => e.t === 'user')?.origin === 'constructor', 'an origin named like an object property is kept as its raw value', JSON.stringify(proto.events.find((e) => e.t === 'user')?.origin));
  check(sig({ type: 'assistant', message: { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'cut' }] } }) === false, 'max_tokens closes the turn for the session list, too');

  const turnDir = path.join(tmp, 'turn-meta');
  fs.mkdirSync(turnDir, { recursive: true });
  const at = new Date().toISOString();
  const writeTurn = (name, entries) => {
    const f = path.join(turnDir, `${name}.jsonl`);
    fs.writeFileSync(f, entries.map((e) => JSON.stringify({ timestamp: at, sessionId: name, cwd: workspace, ...e })).join('\n') + '\n');
    return claudeLib._readMeta(f, fs.statSync(f));
  };
  const composing = await writeTurn('composing', [
    { type: 'user', message: { role: 'user', content: 'Write the big file' } },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'text' }] } },
  ]);
  check(composing.turnOpen === true && composing.pending === 0, 'a transcript between tool calls has an open turn and no pending call', JSON.stringify({ open: composing.turnOpen, pending: composing.pending }));
  const answered = await writeTurn('answered', [
    { type: 'user', message: { role: 'user', content: 'Say hi' } },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] } },
  ]);
  check(answered.turnOpen === false, 'a transcript that ends with end_turn has a closed turn');

  const cTree = await getJson(`/api/tree?source=claude&id=${encodeURIComponent(claudeId)}`);
  const cPaths = [];
  (function walk(nodes) { for (const n of nodes || []) { cPaths.push(n.path); walk(n.children); } })(cTree.body.tree?.children);
  check(cPaths.includes('src/app.js') && cPaths.includes('notes.md'), 'Claude tree uses the transcript cwd');
  const cFile = await getJson(`/api/file?source=claude&id=${encodeURIComponent(claudeId)}&path=${encodeURIComponent('src/app.js')}`);
  check(cFile.body.content.includes('42'), 'file contents are served for Claude sessions');

  console.log('\nClaude live tail');
  const livePromise = readSse(
    `${BASE}/api/stream?source=claude&id=${encodeURIComponent(claudeId)}`,
    (e, all) => all.some((x) => x.event === 'ev' && x.data.t === 'say' && x.data.text === 'LIVE CLAUDE'),
    12000,
  );
  await sleep(900);
  fs.appendFileSync(claudeFile, JSON.stringify({
    type: 'assistant', cwd: workspace, sessionId: claudeId, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'LIVE CLAUDE' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n');
  const live = await livePromise;
  check(eventsOf(live).some((e) => e.t === 'say' && e.text === 'LIVE CLAUDE'), 'appended transcript lines stream live');

  console.log('\nAntigravity');
  const agySessions = await getJson('/api/sessions?source=antigravity');
  const agySession = agySessions.body.sessions.find((s) => s.id === agyConv);
  check(!!agySession, 'Antigravity conversation is listed', JSON.stringify(agySessions.body.sessions?.map((s) => s.id)));
  check(agySession?.title === 'Inspect the widget', 'USER_REQUEST becomes the title', agySession?.title);
  check(agySession?.cwd === workspace, 'cwd is derived from run_command', agySession?.cwd);

  const aEvents = await readSse(
    `${BASE}/api/stream?source=antigravity&id=${encodeURIComponent(agyConv)}`,
    (e) => e.event === 'historyEnd',
  );
  const agyEvs = eventsOf(aEvents);
  const aMeta = aEvents.find((e) => e.event === 'meta');
  check(aMeta?.data.prices === null, 'Antigravity has no cost estimate');
  check(agyEvs.some((e) => e.t === 'user' && e.text === 'Inspect the widget'), 'USER_INPUT is unwrapped');
  check(agyEvs.some((e) => e.t === 'say' && e.text.includes('Looking at the widget')), 'planner text becomes a message');
  const aCalls = agyEvs.filter((e) => e.t === 'call');
  check(aCalls.some((e) => e.name === 'pwsh' && e.args.command === 'Remove-Item gone.txt'), 'run_command becomes a pwsh command', JSON.stringify(aCalls.map((c) => [c.name, c.args.command])));
  check(aCalls.some((e) => e.name === 'read' && e.args.file_path.endsWith('app.js')), 'view_file becomes a read');
  check(aCalls.some((e) => e.name === 'edit' && e.args.new_string.includes('42')), 'replace_file_content becomes an edit');
  check(aCalls.some((e) => e.name === 'write' && e.args.content.includes('Antigravity wrote')), 'write_to_file becomes a write');
  check(agyEvs.some((e) => e.t === 'result' && e.text.includes('removed')), 'GENERIC output pairs with the command');
  check(agyEvs.some((e) => e.t === 'result' && e.isError), 'ERROR_MESSAGE becomes an error result');
  check(agyEvs.some((e) => e.t === 'deleted' && e.path === 'gone.txt'), 'Remove-Item marks a file deleted');
  const aTokens = agyEvs.filter((e) => e.usage).reduce((a, e) => a + e.usage.input + e.usage.output + e.usage.cacheRead, 0);
  check(aTokens > 0, 'Antigravity token usage is mapped', String(aTokens));

  const aTree = await getJson(`/api/tree?source=antigravity&id=${encodeURIComponent(agyConv)}`);
  check(aTree.body.tree?.children?.length > 0, 'Antigravity tree is built from the derived cwd');

  console.log('\nAntigravity pairing');
  const pairEvs = eventsOf(await readSse(
    `${BASE}/api/stream?source=antigravity&id=${encodeURIComponent(agyPairConv)}`,
    (e) => e.event === 'historyEnd',
  ));
  const pairCalls = pairEvs.filter((e) => e.t === 'call');
  const resultOf = (call) => pairEvs.find((e) => e.t === 'result' && e.callId === (call && call.callId));
  const callWith = (pred) => pairCalls.find(pred);
  const fro = callWith((c) => c.name === 'frobnicate_widget');
  const build = callWith((c) => c.args.command === 'node build.js');
  const grep = callWith((c) => c.name === 'grep');
  check(pairCalls.length === 9, 'every tool call of a planner response becomes a call', String(pairCalls.length));
  check(!!fro && fro.args.description === 'args: Mode, Level' && !JSON.stringify(fro.args).includes('fast'), 'an unmapped tool is a generic call that names its arguments but never shows their values', JSON.stringify(fro && fro.args));
  check(resultOf(fro)?.text === 'frobnicated fine', 'the unmapped call gets its own result', resultOf(fro)?.text);
  check(resultOf(build)?.text.includes('built ok') && !resultOf(build).isError, 'the command gets its own result', resultOf(build)?.text);
  check(!!grep && grep.args.pattern === 'answer' && resultOf(grep)?.text.includes('Found 1 match'), 'grep_search is a grep call that gets its own result', JSON.stringify(grep));
  const listDir = callWith((c) => c.name === 'list_dir');
  const webCall = callWith((c) => c.name === 'web_fetch');
  check(resultOf(listDir)?.text === 'src\nnotes.md', 'a result pairs inside its own planner response', resultOf(listDir)?.text);
  check(!!webCall && !resultOf(webCall), 'a call without a result stays open and does not take a later result');
  const failed = callWith((c) => c.args.command === 'node fail.js');
  check(resultOf(failed)?.isError === true && !resultOf(failed)?.denied && resultOf(failed).text.includes('command failed'), 'a step with status ERROR is a failed result with its error text', JSON.stringify(resultOf(failed)));
  const denied = callWith((c) => c.args.command === 'node denied.js');
  check(resultOf(denied)?.isError === true && resultOf(denied)?.denied === true && resultOf(denied).text.includes('denied permission'), 'a permission denial is labelled denied', JSON.stringify(resultOf(denied)));
  const serve = callWith((c) => c.args.command === 'node serve.js');
  check(resultOf(serve)?.running === true && !resultOf(serve).isError && resultOf(serve).text.includes('listening'), 'a RUNNING result is marked running and keeps the partial output', JSON.stringify(resultOf(serve)));
  const status = callWith((c) => c.name === 'job_output');
  check(!!status && /node serve\.js/.test(status.args.description || '') && resultOf(status)?.text === 'still serving', 'command_status is its own call and names the command it asks about', JSON.stringify(status && status.args));
  check(!resultOf(status)?.running && !resultOf(build)?.running, 'a finished result is not marked running');

  console.log('\nAntigravity full transcript');
  const fullEvs = eventsOf(await readSse(
    `${BASE}/api/stream?source=antigravity&id=${encodeURIComponent(agyFullConv)}`,
    (e) => e.event === 'historyEnd',
  ));
  const bigCall = fullEvs.find((e) => e.t === 'call' && e.args.command === 'node big.js');
  const bigResult = fullEvs.find((e) => e.t === 'result' && e.callId === bigCall?.callId);
  check(!!bigResult && bigResult.text.includes('LONGBODY') && bigResult.text.length > 4000 && !bigResult.text.includes('[truncated]'), 'a truncated result body is read from transcript_full.jsonl', String(bigResult?.text.length));
  const fullEditCall = fullEvs.find((e) => e.t === 'call' && e.name === 'edit');
  check(!!fullEditCall && fullEditCall.args.new_string.length > 4000, 'a truncated edit body is read from transcript_full.jsonl', String(fullEditCall?.args.new_string.length));

  // A full transcript that appears (or catches up) after the stream opened: switch at the line already read.
  {
    const agyLib = createRequire(import.meta.url)('../lib/antigravity.js');
    const prevCli = process.env.ANTIGRAVITY_CLI_DIR;
    process.env.ANTIGRAVITY_CLI_DIR = path.join(tmp, 'no-agy-cli');
    const lateDir = path.join(tmp, 'agy-late', '.system_generated', 'logs');
    fs.mkdirSync(lateDir, { recursive: true });
    const lateCut = path.join(lateDir, 'transcript.jsonl');
    const lateFull = path.join(lateDir, 'transcript_full.jsonl');
    const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    fs.writeFileSync(lateCut, jsonl(agyCutLines.slice(0, 2)));
    const late = agyLib.open({ id: 'agy-late', source: 'antigravity', file: lateCut, cwd: workspace }, { mapPath: (cwd, p) => p, redactor: { event: (e) => e, text: (v) => v }, maxEvents: 1000 });
    await late._poll();
    fs.appendFileSync(lateCut, jsonl(agyCutLines.slice(2)));
    fs.writeFileSync(lateFull, jsonl(agyFullLines));
    await late._poll();
    if (prevCli === undefined) delete process.env.ANTIGRAVITY_CLI_DIR;
    else process.env.ANTIGRAVITY_CLI_DIR = prevCli;
    const lateBig = late.events.find((e) => e.t === 'call' && e.args.command === 'node big.js');
    const lateResult = late.events.find((e) => e.t === 'result' && e.callId === lateBig?.callId);
    check(late.tail.file === lateFull && !!lateResult && lateResult.text.includes('LONGBODY') && !lateResult.text.includes('[truncated]'), 'a full transcript that appears after the stream opened is used from then on', String(lateResult?.text.length));
    check(late.events.filter((e) => e.t === 'user').length === 1 && late.events.filter((e) => e.t === 'call').length === 2, 'switching files repeats no line already shown', JSON.stringify(late.events.map((e) => e.t)));
  }

  const agents = await getJson('/api/agents');
  const agyAgent = (agents.body.groups || []).flatMap((g) => g.agents).find((a) => a.source === 'antigravity' && a.id === agyConv);
  check(!!agyAgent && ['live', 'idle'].includes(agyAgent.state), 'Antigravity conversations appear in the agents overview', JSON.stringify(agyAgent));
  check(!!agyAgent && agyAgent.touched.some((t) => t.path.endsWith('notes.md')) && !!agyAgent.activity, 'Antigravity reports its last action and written files', JSON.stringify(agyAgent));
  const pairAgent = (agents.body.groups || []).flatMap((g) => g.agents).find((a) => a.source === 'antigravity' && a.id === agyPairConv);
  check(pairAgent?.activity?.name === 'job_output' && /node serve\.js/.test(pairAgent.activity.label), 'the agents overview names the last tool the same way', JSON.stringify(pairAgent?.activity));

  console.log('\npermission modes');
  const tierOf = (s) => s && s.permission && s.permission.tier;
  const claudePerm = (await getJson('/api/sessions?source=claude')).body.sessions;
  const bypassSession = claudePerm.find((s) => s.id === claudeBypassId);
  check(bypassSession?.permission?.tier === 'bypass' && bypassSession.permission.currency === 'last-prompt' && JSON.stringify(bypassSession.permission.names) === '["bypassPermissions"]' && bypassSession.permission.fullAccess === false,
    'Claude Code: the latest prompt says bypassPermissions, an older one default: BYPASS, as of the last prompt', JSON.stringify(bypassSession?.permission));
  const oddSession = claudePerm.find((s) => s.id === claudeOddId);
  check(oddSession?.permission?.tier === 'neutral' && JSON.stringify(oddSession.permission.names) === '["futureMode"]' && oddSession.permission.currency === 'last-prompt',
    'Claude Code: a mode name this build does not know is neutral and keeps its name', JSON.stringify(oddSession?.permission));
  const noModeSession = claudePerm.find((s) => s.id === claudeNoModeId);
  check(tierOf(noModeSession) === 'neutral' && noModeSession.permission.currency === 'unknown' && noModeSession.permission.names.length === 0,
    'Claude Code: a transcript with no mode has no reading', JSON.stringify(noModeSession?.permission));
  check(tierOf(claudePerm.find((s) => s.id === claudeId)) === 'neutral' && claudePerm.find((s) => s.id === claudeId).permission.currency === 'unknown', 'the older fixture without a permissionMode reads as unknown');
  const bypassStream = await readSse(
    `${BASE}/api/stream?source=claude&id=${encodeURIComponent(claudeBypassId)}`,
    (e) => e.event === 'status',
  );
  check(bypassStream.find((e) => e.event === 'meta')?.data.session.permission?.tier === 'bypass'
    && bypassStream.find((e) => e.event === 'status')?.data.permission?.tier === 'bypass'
    && bypassStream.find((e) => e.event === 'status')?.data.permission?.currency === 'last-prompt',
  'Claude Code: the stream meta and status carry the same reading', JSON.stringify(bypassStream.filter((e) => e.event !== 'ev').map((e) => [e.event, e.data.permission || e.data.session?.permission])));

  const agyPerm = (await getJson('/api/sessions?source=antigravity')).body.sessions;
  const agyOf = (id) => agyPerm.find((s) => s.id === id)?.permission;
  check(agyOf(agyConv)?.tier === 'asks' && agyOf(agyConv).currency === 'process-start' && JSON.stringify(agyOf(agyConv).names) === '["request-review"]',
    'Antigravity CLI: toolPermission=request-review is asks, as of process start', JSON.stringify(agyOf(agyConv)));
  check(agyOf(agyPairConv)?.tier === 'bypass' && agyOf(agyPairConv).currency === 'process-start' && JSON.stringify(agyOf(agyPairConv).names) === '["always-proceed"]',
    'Antigravity CLI: the latest process to serve a conversation decides (always-proceed is BYPASS)', JSON.stringify(agyOf(agyPairConv)));
  check(agyOf(agyFlagConv)?.tier === 'bypass' && agyOf(agyFlagConv).names.includes('--dangerously-skip-permissions'),
    'Antigravity CLI: --dangerously-skip-permissions on the startup line is BYPASS whatever toolPermission says', JSON.stringify(agyOf(agyFlagConv)));
  check(agyOf(agyModeConv)?.tier === 'edits' && JSON.stringify(agyOf(agyModeConv).names) === '["request-review","accept-edits"]',
    'Antigravity CLI: a --mode value on the startup line counts, and the riskiest reading wins', JSON.stringify(agyOf(agyModeConv)));
  check(agyOf(agyQuotedConv)?.tier === 'asks' && JSON.stringify(agyOf(agyQuotedConv).names) === '["strict"]',
    'Antigravity CLI: flags quoted later in the log (typed text) are not read as flags', JSON.stringify(agyOf(agyQuotedConv)));
  check(agyOf(agyFullConv)?.tier === 'neutral' && agyOf(agyFullConv).currency === 'unknown' && agyOf(agyFullConv).names.length === 0,
    'Antigravity CLI: a conversation no log on disk served has no reading', JSON.stringify(agyOf(agyFullConv)));
  const agyBypassStream = await readSse(
    `${BASE}/api/stream?source=antigravity&id=${encodeURIComponent(agyPairConv)}`,
    (e) => e.event === 'status',
  );
  check(agyBypassStream.find((e) => e.event === 'meta')?.data.session.permission?.tier === 'bypass'
    && agyBypassStream.find((e) => e.event === 'status')?.data.permission?.tier === 'bypass',
  'Antigravity CLI: the stream meta and status carry the reading', JSON.stringify(agyBypassStream.filter((e) => e.event !== 'ev').map((e) => [e.event, e.data.permission || e.data.session?.permission])));

  const dshPerm = (await getJson('/api/sessions?source=dsh')).body.sessions;
  const dshOf = (id) => dshPerm.find((s) => s.id === id)?.permission;
  check(dshOf(dshSwitchId)?.tier === 'bypass' && dshOf(dshSwitchId).currency === 'exact' && dshOf(dshSwitchId).fullAccess === true && dshOf(dshSwitchId).names.includes('danger-full-access') && dshOf(dshSwitchId).names.includes('never'),
    'DeepSeek Harness: a session that switched to danger-full-access + never reads BYPASS, exact, with the full-access flag', JSON.stringify(dshOf(dshSwitchId)));
  check(dshOf(dshAutoId)?.tier === 'reviewer' && dshOf(dshAutoId).fullAccess === true, 'DeepSeek Harness: the auto review integration is a reviewer with full access', JSON.stringify(dshOf(dshAutoId)));
  check(dshOf(dshCustomId)?.tier === 'neutral' && dshOf(dshCustomId).names[0] === 'custom', 'DeepSeek Harness: an unmatched pair ("custom") is neutral and shows its name', JSON.stringify(dshOf(dshCustomId)));
  const switchStream = await readSse(
    `${BASE}/api/stream?source=dsh&id=${encodeURIComponent(dshSwitchId)}`,
    (e) => e.event === 'status',
  );
  const switchEvs = eventsOf(switchStream);
  const alerts = switchEvs.filter((e) => e.t === 'permissionAlert');
  const presetAt = switchEvs.findIndex((e) => e.t === 'preset' && e.preset === 'danger-full-access');
  check(alerts.length === 1 && alerts[0].tier === 'bypass' && alerts[0].from === 'asks' && alerts[0].currency === 'exact' && alerts[0].fullAccess === true && JSON.stringify(alerts[0].names) === '["danger-full-access","never"]' && switchEvs.indexOf(alerts[0]) > presetAt && presetAt >= 0,
    'DeepSeek Harness: a mid-session switch into the bypass tier is one alert event, right after the switch', JSON.stringify(alerts));
  check(switchStream.find((e) => e.event === 'status')?.data.permission?.tier === 'bypass', 'DeepSeek Harness: the status carries the new tier');
  // The same switch arriving while the page is watching.
  const liveFile = path.join(dshWs, dshLiveId, 'session.v4.jsonl.zstd');
  setTimeout(() => fs.appendFileSync(liveFile, frame([
    dshEv('permission/preset', 5, { preset: 'danger-full-access' }),
    dshEv('sandbox/mode', 6, { mode: 'danger-full-access' }),
    dshEv('approval/policy', 7, { policy: 'never' }),
  ])), 700);
  const liveStream = await readSse(
    `${BASE}/api/stream?source=dsh&id=${encodeURIComponent(dshLiveId)}`,
    (e) => e.event === 'ev' && e.data.t === 'permissionAlert',
  );
  const liveAlert = eventsOf(liveStream).find((e) => e.t === 'permissionAlert');
  const liveBefore = liveStream.find((e) => e.event === 'status');
  check(liveStream.find((e) => e.event === 'meta')?.data.session.permission?.tier === 'asks' && !!liveAlert && liveAlert.from === 'asks' && liveAlert.tier === 'bypass',
    'DeepSeek Harness: a switch appended while the stream is open raises the alert live, after the stream said asks', JSON.stringify([liveAlert, liveBefore && liveBefore.data.permission]));
  const startsEvs = eventsOf(await readSse(`${BASE}/api/stream?source=dsh&id=${encodeURIComponent(dshStartsBypassId)}`, (e) => e.event === 'status'));
  check(!startsEvs.some((e) => e.t === 'permissionAlert'), 'DeepSeek Harness: a session that starts in bypass was not switched, so no alert');
  const autoEvs = eventsOf(await readSse(`${BASE}/api/stream?source=dsh&id=${encodeURIComponent(dshAutoId)}`, (e) => e.event === 'status'));
  check(!autoEvs.some((e) => e.t === 'permissionAlert'), 'DeepSeek Harness: a reviewer is not a bypass, so no alert');
  const noPresetEvs = eventsOf(await readSse(`${BASE}/api/stream?source=dsh&id=${encodeURIComponent(dshNoPresetId)}`, (e) => e.event === 'status'));
  check(dshOf(dshNoPresetId)?.tier === 'bypass' && !noPresetEvs.some((e) => e.t === 'permissionAlert'),
    'DeepSeek Harness: sandbox and policy with no preset set where a session starts, so no switch alert', JSON.stringify([dshOf(dshNoPresetId), noPresetEvs.filter((e) => e.t === 'permissionAlert')]));
  check(dshOf(dshBigId)?.tier === 'bypass' && dshOf(dshBigId).fullAccess === true,
    'DeepSeek Harness: a log too big to read whole still shows the bypass its start set', JSON.stringify(dshOf(dshBigId)));

  // ANTIGRAVITY_ROOT pointed at the editor's brain, with no CLI log beside it: editor conversations.
  {
    const agyLib = createRequire(import.meta.url)('../lib/antigravity.js');
    const keep = ['ANTIGRAVITY_ROOT', 'ANTIGRAVITY_CLI_DIR', 'ANTIGRAVITY_CONFIG_FILE'].map((k) => [k, process.env[k]]);
    const editorBrain = path.join(tmp, 'agy-editor-only', 'brain');
    const conv = 'eeeeeeee-0000-0000-0000-000000000001';
    fs.mkdirSync(path.join(editorBrain, conv, '.system_generated', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(editorBrain, conv, '.system_generated', 'logs', 'transcript.jsonl'),
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: new Date().toISOString(), content: '<USER_REQUEST>\nhello\n</USER_REQUEST>' }) + '\n');
    const settingsFile = path.join(tmp, 'agy-editor-only', 'config.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ userSettings: { permissionPreset: 'AGENT_PERMISSION_PRESET_TURBO' } }));
    process.env.ANTIGRAVITY_ROOT = editorBrain;
    process.env.ANTIGRAVITY_CONFIG_FILE = settingsFile;
    delete process.env.ANTIGRAVITY_CLI_DIR;
    let listed = [];
    try { listed = await agyLib.listSessions({}); } finally {
      for (const [k, v] of keep) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    const ed = listed.find((s) => s.id === conv);
    check(!!ed && ed.promptsVisible === false && ed.permission?.tier === 'bypass' && ed.permission.currency === 'configured',
      'Antigravity: a brain folder with no CLI log beside it reads as the editor (settings, "configured as")', JSON.stringify(ed && { promptsVisible: ed.promptsVisible, permission: ed.permission }));
  }

  const agentsPerm = (await getJson('/api/agents')).body;
  const everyAgent = (agentsPerm.groups || []).flatMap((g) => g.agents);
  const agentOf = (source, id) => everyAgent.find((a) => a.source === source && a.id === id);
  check(agentOf('claude', claudeBypassId)?.permission?.tier === 'bypass' && agentOf('antigravity', agyPairConv)?.permission?.tier === 'bypass' && agentOf('dsh', dshSwitchId)?.permission?.tier === 'bypass',
    'the agents overview carries every source\'s reading', JSON.stringify(everyAgent.map((a) => [a.source, a.id.slice(-4), a.permission?.tier])));
} catch (err) {
  console.error(err);
  failures.push(String(err && err.stack || err));
} finally {
  server.kill();
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures.slice(0, 25)) console.error(' - ' + f);
  process.exit(1);
}
console.log('all source checks passed');
