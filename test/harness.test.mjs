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
const { chooseOption } = require('../lib/acp-normalize');

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
