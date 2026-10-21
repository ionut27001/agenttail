// Harness registry, approval normaliser and control-session unit tests.
// No server and no browser: the control manager is driven directly against
// test/fake-acp.mjs.  Run: node test/harness.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(__dirname, '.tmp-harness');
const workspace = path.join(tmp, 'workspace');
const fakeAcp = path.join(__dirname, 'fake-acp.mjs');

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
process.env.DSH_SESSIONS_ROOT = path.join(tmp, 'sessions');

const { ControlManager } = require('../lib/control');
const { chooseOption, toolCallFacts, normalizeApproval, publicApproval } = require('../lib/acp-normalize');

const failures = [];
function check(cond, msg, extra) {
  if (cond) console.log(`  ok    ${msg}`);
  else {
    failures.push(msg);
    console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`);
  }
}

const managers = [];
function manager(config, name = 'control') {
  const configPath = path.join(tmp, `${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ workspaces: [workspace], ...config }));
  const mgr = new ControlManager({ configPath, auditPath: path.join(tmp, `${name}-audit.log`) });
  managers.push(mgr);
  return mgr;
}

/** Wait until the session has an approval open. */
async function openApproval(session, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [approval] = session.pendingApprovals();
    if (approval) return approval;
    await sleep(25);
  }
  return null;
}

async function expectStatus(promise, status) {
  try {
    await promise;
    return { ok: false, status: null, message: 'did not throw' };
  } catch (err) {
    return { ok: err.status === status, status: err.status, message: String(err.message) };
  }
}

// The legacy dsh keys point the dsh harness at the fake child.  dsh keeps the
// whole environment, so FAKE_ACP_PROFILE set here reaches it.
const legacy = { dshCommand: process.execPath, dshArgs: [fakeAcp], dshProfile: 'acp' };

async function beginAndAsk(mgr, profile) {
  process.env.FAKE_ACP_PROFILE = profile;
  const begun = await mgr.begin({ cwd: workspace, preset: 'workspace-write' });
  const id = begun.session.id;
  await mgr.startFirst(id, { message: 'run the fake command' });
  const session = mgr.get(id);
  const approval = await openApproval(session);
  return { id, session, approval };
}

try {
  console.log('\noption choice by kind');
  const allowFirst = [
    { optionId: 'a', kind: 'allow_always' },
    { optionId: 'b', kind: 'allow_once' },
    { optionId: 'c', kind: 'reject_once' },
  ];
  check(chooseOption(allowFirst, 'approve')?.optionId === 'b', 'approve picks allow_once even when allow_always is listed first');
  check(chooseOption([{ optionId: 'a', kind: 'allow_always' }, { optionId: 'c', kind: 'reject_once' }], 'approve') === null, 'approve never falls back to allow_always');
  check(chooseOption([{ optionId: 'x', kind: 'reject_always' }, { optionId: 'y', kind: 'reject_once' }], 'reject')?.optionId === 'y', 'reject prefers reject_once over a listed reject_always');
  check(chooseOption([{ optionId: 'x', kind: 'reject_always' }, { optionId: 'a', kind: 'allow_once' }], 'reject')?.optionId === 'x', 'reject uses reject_always only when it is all there is');
  check(chooseOption([{ optionId: 'a', kind: 'allow_once' }], 'reject') === null, 'reject with no reject option picks nothing');
  check(chooseOption([{ optionId: 'a', kind: 'ALLOW_ONCE' }], 'approve') === null, 'kinds are matched exactly');

  console.log('\napprove and reject through a session');
  {
    const mgr = manager(legacy, 'options');
    const first = await beginAndAsk(mgr, 'allow-always-first');
    check(first.approval && first.approval.options[0].kind === 'allow_always', 'the agent really listed allow_always first');
    const done = await mgr.approval(first.id, first.approval.approvalId, 'approve');
    check(done.optionId === 'allow-once', 'Approve sent allow_once, not the allow_always listed first', done.optionId);
    await mgr.close(first.id);

    const second = await beginAndAsk(mgr, 'only-allow-always');
    const refused = await expectStatus(mgr.approval(second.id, second.approval.approvalId, 'approve'), 409);
    check(refused.ok && /allow-once/.test(refused.message), 'Approve is refused with a clear message when only allow_always exists', refused.message);
    check(second.session.pendingApprovals().length === 1, 'the refused approval stays open so it can still be rejected');
    const rejected = await mgr.approval(second.id, second.approval.approvalId, 'reject', 'no thanks');
    check(rejected.optionId === 'reject-once', 'Reject picks reject_once', rejected.optionId);
    await mgr.close(second.id);

    const third = await beginAndAsk(mgr, 'reject-always-first');
    const r3 = await mgr.approval(third.id, third.approval.approvalId, 'reject');
    check(r3.optionId === 'reject-once', 'Reject prefers reject_once when reject_always is listed first', r3.optionId);
    await mgr.close(third.id);

    const fourth = await beginAndAsk(mgr, 'reject-always-only');
    const r4 = await mgr.approval(fourth.id, fourth.approval.approvalId, 'reject');
    check(r4.optionId === 'reject-always', 'Reject uses reject_always when it is the only reject option', r4.optionId);
    await mgr.close(fourth.id);
  }

  console.log('\napproval normaliser');
  {
    const diff = toolCallFacts({
      toolCallId: 't1',
      title: 'Edit a file',
      kind: 'edit',
      locations: [{ path: 'a.txt', line: 2 }, { nope: true }],
      content: [
        { type: 'content', content: { type: 'text', text: 'explanation' } },
        { type: 'diff', path: 'a.txt', oldText: 'one', newText: 'two' },
        { type: 'diff', path: 'new.txt', oldText: null, newText: 'fresh' },
      ],
    });
    check(diff.diff?.path === 'a.txt' && diff.diff.oldText === 'one' && diff.diff.newText === 'two', 'a diff content block becomes the approval diff');
    check(diff.diffs.length === 2 && diff.diffs[1].isNew === true && diff.diffs[1].oldText === '', 'every diff is kept and a new file is marked');
    check(diff.locations.length === 1 && diff.locations[0].line === 2, 'locations are kept, malformed ones dropped');
    check(diff.content === 'explanation' && diff.command === null && diff.rawInput === null, 'text content is kept and nothing is invented');
    const fromRaw = toolCallFacts({ toolCallId: 't2', title: 'x', kind: 'edit', rawInput: { file_path: 'b.txt', old_string: 'x', new_string: 'y' } });
    check(fromRaw.diff?.path === 'b.txt' && fromRaw.diff.newText === 'y' && fromRaw.locations[0]?.path === 'b.txt', 'a diff from rawInput old/new strings still works and gives a location');
    const both = toolCallFacts({ toolCallId: 't3', rawInput: { old_string: 'raw' }, content: [{ type: 'diff', path: 'c', oldText: 'a', newText: 'b' }] });
    check(both.diffs.length === 1 && both.diff.path === 'c', 'content diffs win over rawInput strings');
    const argv = toolCallFacts({ toolCallId: 't4', rawInput: { command: ['git', 'status'] } });
    check(argv.command === 'git status', 'an argv array command is shown as one line');
    const big = toolCallFacts({ toolCallId: 't5', content: [{ type: 'diff', path: 'big', oldText: '', newText: 'x'.repeat(30000) }] });
    check(big.truncated === true && big.diff.newText.length < 30000, 'an oversized diff is cut and flagged');
    const approval = normalizeApproval({ harness: 'h', requestId: 7, toolCall: { toolCallId: 't1', title: 'T' }, options: allowFirst });
    check(approval.origin === 'harness' && approval.harness === 'h' && approval.approvalId === '7', 'normalised approvals carry origin and harness');
    const shown = publicApproval(approval);
    check(shown.canApprove === true && shown.canReject === true && shown.kind === shown.toolKind, 'the public approval says what can be decided');
    check(publicApproval(normalizeApproval({ requestId: 1, toolCall: {}, options: [{ optionId: 'a', kind: 'allow_always' }] })).canApprove === false, 'no allow_once means it cannot be approved');
  }

  console.log('\napproval cards from the wire');
  {
    const mgr = manager(legacy, 'cards');
    const only = await beginAndAsk(mgr, 'diff-only');
    check(only.approval?.diff?.newText === 'new line' && only.approval.command === null && only.approval.rawInput === null, 'a diff-only tool call gives a card with the diff', JSON.stringify(only.approval));
    check(only.approval?.locations?.[0]?.path === 'docs/README.md' && only.approval.title === 'Update README' && only.approval.toolKind === 'edit', 'the diff-only card has the path, the title and the tool kind');
    await mgr.approval(only.id, only.approval.approvalId, 'approve');
    await mgr.close(only.id);

    const inline = await beginAndAsk(mgr, 'diff-inline');
    check(inline.approval?.diffs?.length === 2 && inline.approval.diffs[1].isNew === true, 'a request that carries its own content shows every diff', JSON.stringify(inline.approval));
    await mgr.approval(inline.id, inline.approval.approvalId, 'reject');
    await mgr.close(inline.id);

    const lying = await beginAndAsk(mgr, 'deceptive-title');
    check(lying.approval?.command === 'rm -rf build' && lying.approval.title === 'Read a file', 'the raw command is on the card next to a harmless title', JSON.stringify(lying.approval));
    await mgr.approval(lying.id, lying.approval.approvalId, 'reject');
    await mgr.close(lying.id);
  }
} finally {
  delete process.env.FAKE_ACP_PROFILE;
  for (const mgr of managers) await mgr.dispose().catch(() => {});
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ }
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('\nall harness checks passed');
