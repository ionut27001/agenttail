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

const { ControlManager, ControlSession } = require('../lib/control');
const {
  chooseOption, toolCallFacts, normalizeApproval, publicApproval, normalizeConfigOptions, probeCaps, modelChoices,
} = require('../lib/acp-normalize');
const { parseHarnesses, buildEnv, commandLine, describeHarness, DSH_PRESETS } = require('../lib/harness');

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

    // No reject option at all: the request is cancelled, which is a success and is audited.
    const fifth = await beginAndAsk(mgr, 'no-reject-option');
    check(fifth.approval && fifth.approval.canReject === false, 'the agent really offered no reject option');
    const cancelled = await mgr.approval(fifth.id, fifth.approval.approvalId, 'reject', 'not this');
    check(cancelled.decision === 'cancelled' && cancelled.optionId === null && cancelled.hadReason === true, 'rejecting without a reject option answers cancelled and succeeds', JSON.stringify(cancelled));
    check(fifth.session.pendingApprovals().length === 0, 'the cancelled request is closed');
    await mgr.audit.chain;
    const auditLines = fs.readFileSync(path.join(tmp, 'options-audit.log'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    check(auditLines.some((entry) => entry.action === 'reject' && entry.outcome === 'cancelled' && entry.approvalId === fifth.approval.approvalId), 'the cancellation is audited', JSON.stringify(auditLines.slice(-2)));
    await mgr.close(fifth.id);
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

  console.log('\nharness registry');
  {
    const base = path.join(tmp, 'cfg');
    const legacyRegistry = parseHarnesses({
      dshProfile: 'custom',
      dshCommand: 'dsh-bin',
      dshArgs: ['--flag'],
      dshHome: 'home-dir',
      patch: 'a.patch',
    }, base);
    const dsh = legacyRegistry.get('dsh');
    check(legacyRegistry.list.length === 1 && dsh && dsh.kind === 'dsh', 'the legacy top-level dsh keys become the dsh harness');
    check(dsh.profile === 'custom' && dsh.command === 'dsh-bin' && dsh.args[0] === '--flag', 'profile, command and args are carried over');
    check(dsh.home === path.resolve(base, 'home-dir') && dsh.patch === path.resolve(base, 'a.patch'), 'home and patch resolve against the config directory');
    check(dsh.presets.map((p) => p.id).join() === DSH_PRESETS.map((p) => p.id).join() && dsh.defaultPreset === 'workspace-write', 'dsh keeps its three presets and defaults to workspace-write');
    check(dsh.presets.find((p) => p.id === 'danger-full-access')?.danger === true, 'danger-full-access is a danger preset');
    check(legacyRegistry.defaultId === 'dsh' && legacyRegistry.get() === dsh && legacyRegistry.get('') === dsh, 'an empty harness id means the default harness');
    check(commandLine(dsh, {}) === 'dsh-bin --flag --profile custom --patch ' + path.resolve(base, 'a.patch'), 'the command line shows what will run', commandLine(dsh, {}));

    const empty = parseHarnesses({}, base);
    check(empty.list.length === 1 && empty.get('dsh').profile === 'acp' && commandLine(empty.get('dsh'), {}) === 'dsh --profile acp', 'an empty config is a plain dsh harness');
    check(commandLine(empty.get('dsh'), { AGENTTAIL_DSH_BIN: 'x-bin', AGENTTAIL_DSH_ARGS: '["--pre"]' }) === 'x-bin --pre --profile acp', 'the test-only dsh environment overrides still apply to dsh');

    const registry = parseHarnesses({
      dshProfile: 'ignored',
      defaultHarness: 'claude',
      harnesses: {
        dsh: { label: 'DeepSeek Harness', kind: 'dsh', profile: 'acp' },
        claude: {
          label: 'Claude Code',
          command: path.join('tools', 'node'),
          args: ['adapter.js', 'with space'],
          envPass: ['ANTHROPIC_API_KEY', 'not a name'],
          env: { MODE: 'x', BAD: 5 },
          log: 'claude',
          presets: [
            { id: 'default', label: 'Ask', mode: 'default' },
            { id: 'bypass', label: 'Bypass', mode: 'bypassPermissions', danger: true },
            { id: 'cfg', config: { configId: 'effort', value: 'high' } },
            { id: 'bad id!', mode: 'x' },
          ],
        },
        nocommand: { label: 'No command' },
        'bad id': { command: 'x' },
        plain: { command: 'plain-agent' },
        dangerfirst: { command: 'x', presets: [{ id: 'yolo', danger: true }, { id: 'safe' }] },
      },
    }, base);
    check(registry.list.map((h) => h.id).join() === 'dsh,claude,plain,dangerfirst', 'entries without a command or with a bad id are skipped', registry.list.map((h) => h.id).join());
    check(registry.defaultId === 'claude', 'defaultHarness picks the default');
    check(registry.get('dsh').profile === 'acp', 'legacy keys are ignored once harnesses is present');
    const claude = registry.get('claude');
    check(claude.kind === 'acp' && claude.command === path.resolve(base, path.join('tools', 'node')), 'a relative command path resolves against the config directory');
    check(claude.envPass.join() === 'ANTHROPIC_API_KEY' && claude.env.MODE === 'x' && claude.env.BAD === undefined, 'envPass keeps only valid names and env only string values');
    check(claude.presets.length === 3 && claude.presets[2].config.value === 'high' && claude.presets[1].mode === 'bypassPermissions', 'presets keep env, mode and config and drop invalid ids');
    check(claude.defaultPreset === 'default', 'the default preset is the first one that is not dangerous');
    check(registry.get('dangerfirst').defaultPreset === 'safe', 'a danger preset is never the default');
    check(registry.get('plain').presets.length === 1 && registry.get('plain').presets[0].id === 'default', 'a harness with no presets gets one "agent default"');
    check(registry.get('plain').log === null && registry.get('dsh').log === 'dsh', 'the log link is dsh for dsh and none unless configured');
    check(registry.get('nocommand') === null && registry.get('bad id') === null, 'unknown harness ids are not found');
    const shown = JSON.stringify(registry.describe({}));
    check(!/ANTHROPIC_API_KEY|envPass|"env"|"MODE"/.test(shown), 'the page-facing description has no environment');
    const described = describeHarness(claude, {});
    check(described.commandLine.endsWith('adapter.js "with space"') && described.viewable === false && described.presets[1].danger === true, 'the description has a quoted command line and the danger flag', described.commandLine);
    check(describeHarness(registry.get('dsh'), {}).viewable === true, 'only log-linked harnesses are viewable');

    // Legacy keys apply only when "harnesses" is absent; a block that yields nothing is an error, not dsh.
    const emptyBlock = parseHarnesses({ dshCommand: 'legacy-bin', harnesses: {} }, base);
    check(emptyBlock.list.length === 0 && emptyBlock.get('dsh') === null && emptyBlock.get() === null && emptyBlock.defaultId === null, 'an empty "harnesses" block does not fall back to the legacy dsh harness');
    check(/"harnesses"/.test(emptyBlock.error || '') && emptyBlock.describe({}).length === 0, 'an empty registry says why, in words, and lists nothing');
    const badBlock = parseHarnesses({ harnesses: { 'bad id': { command: 'x' }, nocommand: { label: 'n' }, wrong: 5 } }, base);
    check(badBlock.list.length === 0 && /bad id/.test(badBlock.error || '') && /nocommand/.test(badBlock.error), 'an all-invalid block names the entries that were skipped', badBlock.error);
    check(parseHarnesses({ harnesses: [] }, base).list.length === 0 && parseHarnesses({ harnesses: 'dsh' }, base).list.length === 0 && /object/.test(parseHarnesses({ harnesses: null }, base).error || ''), 'a "harnesses" value that is not an object is an empty registry with an error');
    check(parseHarnesses({ harnesses: { a: { command: 'a-cmd' } } }, base).error === null && legacyRegistry.error === null, 'a usable registry has no error');
    {
      const brokenMgr = manager({ dshCommand: process.execPath, dshArgs: [fakeAcp], harnesses: {} }, 'emptyblock');
      const none = await expectStatus(brokenMgr.begin({ cwd: workspace }), 400);
      check(none.ok && /"harnesses"/.test(none.message) && !/unknown harness/.test(none.message), 'starting a session with no usable harness returns the config error', none.message);
      check(brokenMgr.sessions.size === 0, 'and starts nothing');
    }

    const file = path.join(tmp, 'cfg-file.json');
    fs.writeFileSync(file, JSON.stringify({ workspaces: [workspace], harnesses: { a: { command: 'a-cmd' }, b: { command: 'b-cmd' } } }));
    const loaded = await new (require('../lib/control').ControlConfig)(file).load();
    check(loaded.harnesses.list.length === 2 && loaded.harnesses.defaultId === 'a', 'ControlConfig loads the registry; the first entry is the default');
    const missing = await new (require('../lib/control').ControlConfig)(path.join(tmp, 'nope.json')).load();
    check(missing.harnesses.get('dsh') && missing.workspaces.length === 0, 'a missing config file still has the dsh harness and no workspaces');
  }

  console.log('\nchild environment');
  {
    const parent = { PATH: '/bin', Path: 'C:\\win', SECRET_KEY: 'shh', ANTHROPIC_API_KEY: 'k', HOME: '/h', temp: 't', DSH_PERMISSION_MODE: 'old' };
    const registry = parseHarnesses({
      harnesses: {
        dsh: { kind: 'dsh', home: path.join(tmp, 'dshhome'), env: { EXTRA: '1' } },
        agent: { command: 'a', envPass: ['anthropic_api_key'], env: { STATIC: 's' }, presets: [{ id: 'p', env: { FROM_PRESET: 'y' } }] },
      },
    }, tmp);
    const dshEnv = buildEnv(registry.get('dsh'), registry.get('dsh').presets[1], parent);
    check(dshEnv.SECRET_KEY === 'shh' && dshEnv.DSH_PERMISSION_MODE === 'read-only' && dshEnv.DSH_HOME === path.join(tmp, 'dshhome') && dshEnv.EXTRA === '1', 'dsh keeps the whole environment and gets its preset and home');
    const agent = registry.get('agent');
    const env = buildEnv(agent, agent.presets[0], parent);
    check(env.SECRET_KEY === undefined && env.PATH === '/bin' && env.Path === 'C:\\win' && env.HOME === '/h' && env.temp === 't', 'another harness gets the base variables, matched ignoring case, and no other secrets');
    check(env.ANTHROPIC_API_KEY === 'k' && env.STATIC === 's' && env.FROM_PRESET === 'y' && env.DSH_PERMISSION_MODE === undefined, 'envPass names, static env and the preset env are added');
    check(parent.SECRET_KEY === 'shh' && Object.keys(parent).length === 7, 'the parent environment is not modified');

    process.env.AGENTTAIL_TEST_SECRET = 'shh-secret';
    process.env.AGENTTAIL_TEST_PASS = 'pass-me';
    const envFile = path.join(tmp, 'env-dsh.json');
    const envFile2 = path.join(tmp, 'env-fake.json');
    const mgr = manager({
      harnesses: {
        dsh: { kind: 'dsh', command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_ENV_FILE: envFile } },
        fake: { command: process.execPath, args: [fakeAcp], envPass: ['AGENTTAIL_TEST_PASS'], env: { FAKE_ACP_PROFILE: 'no-log', FAKE_ACP_ENV_FILE: envFile2 } },
      },
    }, 'env');
    // The fake hands out one fixed session id, so the two start one after the other.
    const a = await mgr.begin({ cwd: workspace, harness: 'dsh' });
    const clash = await expectStatus(mgr.begin({ cwd: workspace, harness: 'fake' }), 502);
    check(clash.ok && /already in use/.test(clash.message), 'a session id that is already in use is refused, not replacing the first');
    check(mgr.sessions.get(a.session.id)?.harness.id === 'dsh', 'the first session is still there after the clash');
    const seenDsh = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    await mgr.close(a.session.id);
    const b = await mgr.begin({ cwd: workspace, harness: 'fake' });
    const seenFake = JSON.parse(fs.readFileSync(envFile2, 'utf8'));
    check(seenDsh.includes('AGENTTAIL_TEST_SECRET') && seenDsh.includes('DSH_PERMISSION_MODE'), 'the real dsh child sees the whole environment');
    check(!seenFake.includes('AGENTTAIL_TEST_SECRET') && seenFake.includes('AGENTTAIL_TEST_PASS') && seenFake.includes('PATH'), 'a non-dsh child sees only the base variables and envPass', seenFake.join());
    check(!JSON.stringify(a) .includes('shh-secret') && !JSON.stringify(b).includes('pass-me'), 'no environment value reaches the session payload');
    await mgr.close(b.session.id);
    const auditText = fs.readFileSync(path.join(tmp, 'env-audit.log'), 'utf8');
    check(!auditText.includes('shh-secret') && !auditText.includes('pass-me'), 'no environment value reaches the audit log');
    check(/"harness":"fake"/.test(auditText) && /"harness":"dsh"/.test(auditText), 'the audit log names the harness of each start');
    check(/"agent":"fake-acp","agentVersion":"0.0.0","protocol":1/.test(auditText), 'the audit log records the agent name, version and protocol');
    delete process.env.AGENTTAIL_TEST_SECRET;
    delete process.env.AGENTTAIL_TEST_PASS;
  }

  console.log('\nconfig options and capabilities');
  {
    const flat = normalizeConfigOptions([
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'b', options: [{ group: 'g1', name: 'G1', options: [{ value: 'a', name: 'A' }] }, { value: 'b', name: 'B' }] },
      { id: 'effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
      { id: 'flag', type: 'boolean', currentValue: true },
      'junk', { name: 'no id' },
    ]);
    check(flat.length === 3 && flat[0].options.length === 2 && flat[0].options[0].group === 'g1' && flat[0].current === 'b', 'config options are flattened, groups kept, junk dropped');
    check(flat[2].current === true && flat[2].options.length === 0, 'a boolean option keeps its value');
    const legacyOnly = normalizeConfigOptions([], { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code' }] });
    check(legacyOnly.length === 1 && legacyOnly[0].category === 'mode' && legacyOnly[0].legacy === true && legacyOnly[0].options.length === 2, 'legacy Session Modes become one mode option');
    check(normalizeConfigOptions([{ id: 'm', category: 'mode', options: [{ value: 'x' }] }], { availableModes: [{ id: 'ask' }] }).length === 1, 'a real mode option wins over legacy modes');
    check(modelChoices(flat).models.length === 2 && modelChoices(flat).configId === 'model' && modelChoices(flat).current === 'b', 'the model is found by category');
    check(modelChoices([{ id: 'model', category: '', options: [{ value: 'only', name: 'Only' }], current: 'only' }]).configId === 'model', 'a model option is also found by its id');
    check(modelChoices([{ id: 'x', category: 'mode', options: [{ value: 'a' }] }]).models.length === 0, 'no model option means no model list');
    const caps = probeCaps({
      protocolVersion: 1,
      agentInfo: { name: 'agent', version: '1.2' },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { close: {}, resume: {} }, mcpCapabilities: { http: true } },
      authMethods: [{ id: 'login' }],
    }, { configOptions: [] });
    check(caps.prompt.image === true && caps.prompt.audio === false && caps.loadSession === true, 'prompt capabilities and loadSession are probed');
    check(caps.session.close && caps.session.resume && !caps.session.list && !caps.session.delete, 'an empty object counts as a declared session capability');
    check(caps.mcp.http === true && caps.mcp.sse === false && caps.authMethods[0] === 'login' && caps.agent.version === '1.2', 'mcp, auth methods and agent info are probed');
    const none = probeCaps({}, {});
    check(none.prompt.image === false && !none.session.close && none.config.length === 0 && none.authMethods.length === 0, 'an agent that declares nothing supports nothing');
    check(probeCaps(null, null).protocolVersion === null, 'a missing initialize result does not throw');
  }

  console.log('\nsessions on a non-dsh harness');
  {
    const mark = path.join(tmp, 'mark.txt');
    const fake = (profile, extra = {}) => ({
      label: 'Fake agent',
      command: process.execPath,
      args: [fakeAcp],
      env: { FAKE_ACP_PROFILE: `no-log,${profile}`, FAKE_ACP_MARK: mark },
      ...extra,
    });
    const marks = () => (fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8').trim().split('\n') : []);
    const mgr = manager({
      harnesses: {
        plain: fake(''),
        moded: fake('modes', {
          presets: [
            { id: 'ask', label: 'Ask', mode: 'default' },
            { id: 'plan', label: 'Plan', mode: 'plan' },
            { id: 'yolo', label: 'Bypass', mode: 'bypass', danger: true },
            { id: 'cfg', label: 'Effort', config: { configId: 'reasoning_effort', value: 'high' } },
          ],
        }),
        legacy: fake('legacy-modes', { presets: [{ id: 'code', mode: 'code' }] }),
        guarded: fake('modes,free-option', {
          presets: [
            { id: 'ask', label: 'Ask', mode: 'default' },
            { id: 'yolo', label: 'Bypass', mode: 'bypass', danger: true },
            { id: 'hi', label: 'High effort', config: { configId: 'reasoning_effort', value: 'high' }, danger: true },
          ],
        }),
        nomode: fake('', { presets: [{ id: 'plan', mode: 'plan' }] }),
        nomodel: fake('no-model,no-images,no-close'),
        crash: fake('crash-on-start'),
        dies: fake('crash-on-prompt'),
        mcp: fake('mcp-http,auth-methods,embedded-context'),
        huge: fake('oversize-line'),
        refuses: fake('prompt-error'),
      },
    }, 'sessions');

    const plain = await mgr.begin({ cwd: workspace, harness: 'plain' });
    check(plain.session.harness === 'plain' && plain.session.harnessLabel === 'Fake agent' && plain.session.preset === 'default', 'a non-dsh session reports its harness and the agent default preset');
    check(plain.session.caps?.prompt.image === true && plain.session.images === true && plain.session.caps.session.close === true, 'capabilities are in the state payload');
    check(plain.session.caps.agent.name === 'fake-acp' && plain.session.caps.config.some((o) => o.category === 'model') && plain.models.length === 2, 'the agent identity and its config options are in the caps');
    const sentStart = await mgr.startFirst(plain.session.id, { message: 'go' });
    const card = await openApproval(mgr.get(plain.session.id));
    check(card && card.origin === 'harness' && card.harness === 'plain' && card.approvalId && card.title && card.createdAt, 'a non-dsh approval keeps the fields the inbox reads', JSON.stringify(card));
    check(mgr.sessions.get(plain.session.id).pendingApprovals().length === 1 && sentStart.running === true, 'control.sessions and pendingApprovals() work for any harness');
    await mgr.approval(plain.session.id, card.approvalId, 'approve');
    await mgr.close(plain.session.id);
    check(marks().includes('close'), 'session/close is sent when the agent declared it');

    fs.rmSync(mark, { force: true });
    const nomodel = await mgr.begin({ cwd: workspace, harness: 'nomodel' });
    check(nomodel.session.models.length === 0 && nomodel.session.images === false, 'no model option and no image support: the page has nothing to show');
    const refused = await expectStatus(mgr.message(nomodel.session.id, 'look', [{ mimeType: 'image/png', data: 'AAAA' }]), 400);
    check(refused.ok && /does not accept images/.test(refused.message), 'images are refused with a generic message', refused.message);
    await mgr.close(nomodel.session.id);
    check(!marks().includes('close'), 'session/close is not sent when the agent did not declare it');

    const asking = await mgr.begin({ cwd: workspace, harness: 'moded', preset: 'plan' });
    const modeOpt = asking.session.caps.config.find((o) => o.category === 'mode');
    check(modeOpt && modeOpt.current === 'plan' && marks().includes('config:mode=plan'), 'a mode preset is applied right after session/new', JSON.stringify(modeOpt));
    const switched = await mgr.setConfig(asking.session.id, 'mode', 'plan');
    check(switched.session.caps.config.find((o) => o.id === 'mode').current === 'plan', 'the mode can be changed in the session');
    const badValue = await expectStatus(mgr.setConfig(asking.session.id, 'mode', 'nonsense'), 400);
    const badId = await expectStatus(mgr.setConfig(asking.session.id, 'nope', 'x'), 400);
    check(badValue.ok && badId.ok, 'only settings and values the agent listed are accepted');
    await mgr.close(asking.session.id);
    const cfg = await mgr.begin({ cwd: workspace, harness: 'moded', preset: 'cfg' });
    check(marks().includes('config:reasoning_effort=high') && cfg.session.preset === 'cfg', 'a config preset is applied through set_config_option');
    await mgr.close(cfg.session.id);

    // The mode picker lists every value the agent offers: a value that is a danger preset needs the same confirmation as starting in it.
    const guarded = await mgr.begin({ cwd: workspace, harness: 'guarded', preset: 'ask' });
    const modeOf = () => mgr.get(guarded.session.id).statePayload().caps.config.find((o) => o.id === 'mode').current;
    fs.rmSync(mark, { force: true });
    const sneaky = await expectStatus(mgr.setConfig(guarded.session.id, 'mode', 'bypass'), 400);
    check(sneaky.ok && /yolo requires explicit confirmation/.test(sneaky.message), 'switching a live session to a danger mode needs the confirmation', sneaky.message);
    check(modeOf() === 'default' && !marks().includes('config:mode=bypass'), 'the refused switch never reached the agent');
    const sneakyFalse = await expectStatus(mgr.setConfig(guarded.session.id, 'mode', 'bypass', 'true'), 400);
    check(sneakyFalse.ok, 'only an explicit true confirms');
    const sneakyConfig = await expectStatus(mgr.setConfig(guarded.session.id, 'reasoning_effort', 'high'), 400);
    check(sneakyConfig.ok && /hi requires explicit confirmation/.test(sneakyConfig.message), 'a danger preset set through a config value is guarded too', sneakyConfig.message);
    const safeSwitch = await mgr.setConfig(guarded.session.id, 'mode', 'plan');
    check(safeSwitch.session.caps.config.find((o) => o.id === 'mode').current === 'plan', 'a mode that is no danger preset switches without a confirmation');
    const confirmed = await mgr.setConfig(guarded.session.id, 'mode', 'bypass', true);
    check(confirmed.session.caps.config.find((o) => o.id === 'mode').current === 'bypass', 'a confirmed switch to the danger mode is applied');
    const free = await expectStatus(mgr.setConfig(guarded.session.id, 'note', 'anything at all'), 400);
    check(free.ok && /no choices/.test(free.message), 'an option with no declared choices accepts no value', free.message);
    check(!marks().some((line) => line.startsWith('config:note=')), 'nothing was sent to the agent for it');
    await mgr.close(guarded.session.id);

    const noConfirm = await expectStatus(mgr.begin({ cwd: workspace, harness: 'moded', preset: 'yolo' }), 400);
    check(noConfirm.ok && /yolo requires explicit confirmation/.test(noConfirm.message), 'a danger preset still needs the confirmation', noConfirm.message);
    const yolo = await mgr.begin({ cwd: workspace, harness: 'moded', preset: 'yolo', confirmDanger: true });
    check(yolo.session.caps.config.find((o) => o.id === 'mode').current === 'bypass', 'a confirmed danger preset is applied');
    await mgr.close(yolo.session.id);
    check((await expectStatus(mgr.begin({ cwd: workspace, harness: 'nonsense' }), 400)).ok, 'an unknown harness is refused');
    check((await expectStatus(mgr.begin({ cwd: workspace, harness: 'moded', preset: 'workspace-write' }), 400)).ok, 'a preset of another harness is refused');

    fs.rmSync(mark, { force: true });
    const legacyMode = await mgr.begin({ cwd: workspace, harness: 'legacy' });
    check(marks().includes('mode:code') && legacyMode.session.caps.config.find((o) => o.legacy)?.current === 'code', 'an agent with only Session Modes gets session/set_mode');
    await mgr.close(legacyMode.session.id);
    const noModeOffered = await expectStatus(mgr.begin({ cwd: workspace, harness: 'nomode' }), 502);
    check(noModeOffered.ok && /does not offer a mode option/.test(noModeOffered.message), 'a mode preset on an agent without modes fails to start instead of running unrestricted', noModeOffered.message);
    check(mgr.sessions.size === 0, 'a failed start leaves no session behind');

    const crashed = await expectStatus(mgr.begin({ cwd: workspace, harness: 'crash' }), 502);
    check(crashed.ok && /could not start Fake agent/.test(crashed.message), 'a harness that dies on start is reported by its label', crashed.message);
    try {
      await mgr.begin({ cwd: workspace, harness: 'crash' });
    } catch (err) {
      check(/cannot load its configuration/.test(err.details || ''), 'the start error carries the child stderr', err.details);
    }

    const dies = await mgr.begin({ cwd: workspace, harness: 'dies' });
    const dying = mgr.get(dies.session.id);
    check(dies.session.details === '', 'a healthy session has no details fold');
    await mgr.message(dies.session.id, 'hello');
    const until = Date.now() + 8000;
    while (Date.now() < until && dying.status !== 'exited') await sleep(25);
    const after = dying.statePayload();
    check(after.status === 'exited' && /Fake agent exited \(3\)/.test(after.error || ''), 'an exit is reported with the harness label', after.error);
    check(/model backend went away/.test(after.details), 'an exited session shows the child stderr in details', after.details);

    // One oversized line from the agent must end that session, not the server.
    const huge = await mgr.begin({ cwd: workspace, harness: 'huge' });
    const hugeSession = mgr.get(huge.session.id);
    await mgr.message(huge.session.id, 'hello');
    const hugeUntil = Date.now() + 10000;
    while (Date.now() < hugeUntil && hugeSession.status !== 'exited') await sleep(25);
    const hugeState = hugeSession.statePayload();
    check(hugeState.status === 'exited' && hugeState.controllable === false && hugeState.running === false, 'an oversized agent line ends the session instead of the server', JSON.stringify({ status: hugeState.status, running: hugeState.running }));
    check(/exceeded the limit/.test(hugeState.error || ''), 'and the state says why', hugeState.error);
    const again = await expectStatus(mgr.message(huge.session.id, 'again'), 409);
    check(again.ok || again.status === 404, 'the dead session takes no more input', again.message);
    const hugeExit = Date.now() + 10000;
    while (Date.now() < hugeExit && mgr.sessions.has(huge.session.id)) await sleep(25);
    check(!mgr.sessions.has(huge.session.id) && !!hugeSession.exit, 'its child is gone and the session is forgotten');

    // A failing prompt with nobody listening for errors must not throw out of the session.
    const direct0 = (await mgr.config.load()).harnesses.get('refuses');
    const lonely = new ControlSession({ cwd: workspace, harness: direct0, preset: direct0.presets[0] });
    await lonely.start();
    check(lonely.listenerCount('error') === 0, 'the session under test really has no error listener');
    lonely.send('hello');
    const lonelyUntil = Date.now() + 8000;
    while (Date.now() < lonelyUntil && lonely.running) await sleep(25);
    check(lonely.running === false && /refused the request/.test(lonely.statePayload().error || ''), 'a failed prompt is recorded on a session nobody listens to', lonely.statePayload().error);
    await lonely.close();
    const refuses = await mgr.begin({ cwd: workspace, harness: 'refuses' });
    await mgr.message(refuses.session.id, 'hello');
    await sleep(300);
    check(mgr.get(refuses.session.id).statePayload().status === 'idle' && /refused the request/.test(mgr.get(refuses.session.id).statePayload().error || ''), 'a manager session stays usable after a failed turn and shows the error');
    await mgr.close(refuses.session.id);

    const rich = await mgr.begin({ cwd: workspace, harness: 'mcp' });
    check(rich.session.caps.mcp.http === true && rich.session.caps.prompt.embeddedContext === true && rich.session.caps.authMethods[0] === 'login', 'mcp, embedded context and auth methods reach the caps');
    await mgr.close(rich.session.id);
    fs.rmSync(mark, { force: true });
    const harness = (await mgr.config.load()).harnesses.get('plain');
    const direct = new ControlSession({
      cwd: workspace,
      harness,
      preset: harness.presets[0],
      mcpServers: [{ type: 'http', name: 'hub', url: 'http://127.0.0.1:1/mcp', headers: [] }],
    });
    await direct.start();
    check(marks().some((line) => line.startsWith('new:') && line.includes('"name":"hub"')), 'caller-supplied mcpServers are passed to session/new');
    await direct.close();
  }

  console.log('\nHTTP: harness options, settings and start failures');
  {
    const serverDir = path.join(tmp, 'server');
    fs.mkdirSync(serverDir, { recursive: true });
    const controlFile = path.join(serverDir, 'control.json');
    const fakeEnv = (profile) => ({ FAKE_ACP_PROFILE: `no-log,${profile}` });
    fs.writeFileSync(controlFile, JSON.stringify({
      workspaces: [workspace],
      harnesses: {
        dsh: { kind: 'dsh', command: process.execPath, args: [fakeAcp] },
        moded: {
          label: 'Moded agent',
          command: process.execPath,
          args: [fakeAcp],
          env: fakeEnv('modes'),
          envPass: ['AGENTTAIL_TEST_PASS'],
          presets: [{ id: 'ask', label: 'Ask', mode: 'default' }, { id: 'plan', label: 'Plan', mode: 'plan' }],
        },
        guarded: {
          label: 'Guarded agent',
          command: process.execPath,
          args: [fakeAcp],
          env: fakeEnv('modes'),
          presets: [{ id: 'ask', label: 'Ask', mode: 'default' }, { id: 'yolo', label: 'Bypass', mode: 'bypass', danger: true }],
        },
        broken: { label: 'Broken agent', command: process.execPath, args: [fakeAcp], env: fakeEnv('crash-on-start') },
        dies: { label: 'Dying agent', command: process.execPath, args: [fakeAcp], env: fakeEnv('crash-on-prompt') },
        huge: { label: 'Chatty agent', command: process.execPath, args: [fakeAcp], env: fakeEnv('oversize-line') },
        refuses: { label: 'Refusing agent', command: process.execPath, args: [fakeAcp], env: fakeEnv('prompt-error') },
      },
    }));
    const { spawn } = await import('node:child_process');
    const port = 8906;
    const base = `http://127.0.0.1:${port}`;
    let out = '';
    const proc = spawn(process.execPath, ['server.js', '--allow-control', '--no-stream-mode'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        AGENTTAIL_NO_OPEN: '1',
        AGENTTAIL_CONFIG_DIR: serverDir,
        AGENTTAIL_CONTROL_FILE: controlFile,
        AGENTTAIL_CONTROL_AUDIT_FILE: path.join(serverDir, 'audit.log'),
        DSH_SESSIONS_ROOT: path.join(tmp, 'sessions'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => process.stderr.write(`  [server:err] ${d}`));
    try {
      for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* starting */ }
        await sleep(100);
      }
      const token = /#token=([A-Za-z0-9_-]{20,})/.exec(out)?.[1];
      const call = async (method, route, body) => {
        const res = await fetch(base + route, {
          method,
          headers: { Origin: base, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        return { status: res.status, data };
      };
      const options = await call('GET', '/api/control/options');
      check(options.status === 200 && options.data.harnesses.length === 7 && options.data.defaultHarness === 'dsh', 'options list every configured harness', JSON.stringify(options.data));
      const moded = options.data.harnesses.find((h) => h.id === 'moded');
      check(moded.label === 'Moded agent' && moded.commandLine.includes('fake-acp.mjs') && moded.presets.length === 2 && moded.viewable === false, 'a harness is described by label, command line and presets');
      check(!JSON.stringify(options.data).includes('FAKE_ACP_PROFILE') && !JSON.stringify(options.data).includes('AGENTTAIL_TEST_PASS'), 'options never include a harness environment');
      check(options.data.dshProfile === 'acp' && Array.isArray(options.data.presets), 'the older options fields are still there');

      const begun = await call('POST', '/api/control/session/begin', { cwd: workspace, harness: 'moded', preset: 'plan' });
      check(begun.status === 200 && begun.data.session.harness === 'moded' && begun.data.session.caps.config.find((o) => o.category === 'mode')?.current === 'plan', 'begin starts the chosen harness with its preset');
      const set = await call('POST', '/api/control/config', { id: begun.data.session.id, configId: 'mode', value: 'bypass' });
      check(set.status === 200 && set.data.session.caps.config.find((o) => o.id === 'mode').current === 'bypass', 'the config endpoint changes a setting');
      const bad = await call('POST', '/api/control/config', { id: begun.data.session.id, configId: 'mode', value: 'nonsense' });
      check(bad.status === 400, 'the config endpoint refuses a value the agent did not list', String(bad.status));
      const closed = await call('POST', '/api/control/close', { id: begun.data.session.id });
      check(closed.status === 200, 'the session closes');
      const guardedBegin = await call('POST', '/api/control/session/begin', { cwd: workspace, harness: 'guarded', preset: 'ask' });
      const unconfirmed = await call('POST', '/api/control/config', { id: guardedBegin.data.session.id, configId: 'mode', value: 'bypass' });
      check(unconfirmed.status === 400 && /requires explicit confirmation/.test(unconfirmed.data.error), 'the config endpoint will not switch to a danger mode unconfirmed', JSON.stringify(unconfirmed.data));
      await call('POST', '/api/control/close', { id: guardedBegin.data.session.id });

      const unknown = await call('POST', '/api/control/session/begin', { cwd: workspace, harness: 'nope' });
      check(unknown.status === 400, 'an unknown harness is a 400', String(unknown.status));
      const broken = await call('POST', '/api/control/session/begin', { cwd: workspace, harness: 'broken' });
      check(broken.status === 502 && /Broken agent/.test(broken.data.error) && /cannot load its configuration/.test(broken.data.details || ''), 'a harness that fails to start returns its stderr as details', JSON.stringify(broken.data));

      const dying = await call('POST', '/api/control/session/begin', { cwd: workspace, harness: 'dies' });
      await call('POST', '/api/control/message', { id: dying.data.session.id, text: 'hello' });
      await sleep(600);
      const alive = await fetch(`${base}/api/sessions`);
      check(alive.ok, 'the server survives an agent dying mid-turn with nobody watching');
      await call('POST', '/api/control/close', { id: dying.data.session.id });

      const chatty = await call('POST', '/api/control/session/begin', { cwd: workspace, harness: 'huge' });
      await call('POST', '/api/control/message', { id: chatty.data.session.id, text: 'hello' });
      await sleep(2500);
      check((await fetch(`${base}/api/sessions`)).ok, 'the server survives an agent that writes one oversized line, with nobody watching');
      const refusing = await call('POST', '/api/control/session/begin', { cwd: workspace, harness: 'refuses' });
      const refused = await call('POST', '/api/control/message', { id: refusing.data.session.id, text: 'hello' });
      await sleep(600);
      check(refused.status === 200 && (await fetch(`${base}/api/sessions`)).ok, 'the server survives a failed turn with nobody watching');
      await call('POST', '/api/control/close', { id: refusing.data.session.id });
    } finally {
      try { proc.kill(); } catch { /* ignore */ }
    }
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
