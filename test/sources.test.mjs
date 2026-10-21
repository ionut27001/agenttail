// Step 3: source adapters (Claude Code, Antigravity) + live tailing.
// Run: node test/sources.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

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
const SECRET = 'sk-live-SOURCESECRET1234567890';

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.mkdirSync(path.dirname(subFile), { recursive: true });
fs.mkdirSync(path.dirname(agyFile), { recursive: true });
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

const old = new Date(now - 600000);
fs.utimesSync(agyFile, old, old);

const server = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
      AGENTTAIL_NO_OPEN: '1',
    DSH_SESSIONS_ROOT: dshRoot,
    CLAUDE_PROJECTS_ROOT: claudeRoot,
    ANTIGRAVITY_ROOT: path.join(agyRoot, 'brain'),
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

  const agents = await getJson('/api/agents');
  const agyAgent = (agents.body.groups || []).flatMap((g) => g.agents).find((a) => a.source === 'antigravity' && a.id === agyConv);
  check(!!agyAgent && ['live', 'idle'].includes(agyAgent.state), 'Antigravity conversations appear in the agents overview', JSON.stringify(agyAgent));
  check(!!agyAgent && agyAgent.touched.some((t) => t.path.endsWith('notes.md')) && !!agyAgent.activity, 'Antigravity reports its last action and written files', JSON.stringify(agyAgent));
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
