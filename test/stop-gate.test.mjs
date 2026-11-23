import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { done, record, start } from '../bin/qa.mjs';
import { agentRoleOf, decide, mayRecordBlock, ownsRun } from '../scripts/stop-gate-lib.mjs';

// Every git call here, in this process and in the hook it spawns, sees no global or system git configuration and one fixed
// identity, so a person's own git settings (hooks, signing, an excludes file) cannot change a result.
Object.assign(process.env, {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@example.com',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@example.com',
});

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(REPO, 'scripts', 'stop-gate.mjs');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const has =
	(...files) =>
	(f) =>
		files.includes(f);
const build = { role: 'builder', until: 'build', kind: 'story', key: 'APP-1' };

// A worktree the way a builder finds it: a committed case, its base on origin, run.json and nothing else. `ignored` false leaves
// .dev-factory/ neither ignored nor tracked, the way a real worktree often has it (info/exclude, or nothing).
function worktree(run = build, { ignored = true } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-gate-'));
	g(root, 'init', '-q', '-b', 'develop');
	g(root, 'config', 'user.email', 't@example.com');
	g(root, 'config', 'user.name', 't');
	fs.mkdirSync(path.join(root, '.factory/qa/cases/APP-1'), { recursive: true });
	fs.writeFileSync(path.join(root, '.factory/qa/cases/APP-1/login.yaml'), 'appId: x\n');
	if (ignored) fs.writeFileSync(path.join(root, '.gitignore'), '.dev-factory/\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'base');
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	fs.mkdirSync(path.join(root, '.dev-factory'), { recursive: true });
	fs.writeFileSync(path.join(root, '.dev-factory/run.json'), JSON.stringify(run));
	return root;
}

function png(root, seed) {
	const file = `${root}-shot-${seed}.png`;
	const buf = Buffer.alloc(2048, seed);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
	fs.writeFileSync(file, buf);
	return file;
}

function passingQa(root) {
	const m = start({ root, key: 'APP-1', profile: 'web' });
	record({ root, run: m.run, caseSlug: 'login', status: 'pass', assertion: 'login screen shows the arm button', screenshot: png(root, 7) });
	assert.equal(done({ root, run: m.run }).verdict, 'pass');
}

const gate = (root, env = {}, script = GATE) =>
	spawnSync(process.execPath, [script], {
		input: JSON.stringify({ cwd: root }),
		encoding: 'utf8',
		env: { ...process.env, DF_ACTIVE: '1', DF_STATE_DIR: `${root}-state`, ...env },
	});
// The same hook as a dispatched agent of a given type sends it.
const gateAs = (root, agentType, env = {}) =>
	spawnSync(process.execPath, [GATE], {
		input: JSON.stringify({ cwd: root, agent_type: agentType }),
		encoding: 'utf8',
		env: { ...process.env, DF_ACTIVE: '1', DF_STATE_DIR: `${root}-state`, ...env },
	});
const marker = (root, name) => path.join(root, '.dev-factory', name);
const exists = (root, name) => fs.existsSync(marker(root, name));

test('decide: build.done ends a build only when what backs it is in order', () => {
	assert.equal(decide({ run: build, has: has('build.done') }).finished, true, 'no facts supplied: the file alone is accepted, as before');
	assert.equal(decide({ run: build, has: has('build.done'), build: { problems: [] } }).finished, true);
	const refused = decide({ run: build, has: has('build.done'), build: { problems: ['working tree is not clean', 'no QA run at abc'] } });
	assert.equal(refused.finished, false);
	assert.match(refused.next, /build\.done is not accepted/);
	assert.match(refused.next, /working tree is not clean; no QA run at abc/);
	assert.match(refused.next, /set aside as \.dev-factory\/build\.refused/);
	assert.equal(refused.unmet, 'working tree is not clean; no QA run at abc', 'what a person reads is the problem list alone');
	assert.equal(decide({ run: build, has: has(), build: { problems: [] } }).finished, false, 'no file, no end');
});

test('decide: blocked.json and needs_debug.json still let a builder stop whatever the facts say', () => {
	const bad = { problems: ['no QA run at abc'] };
	assert.equal(decide({ run: build, has: has('blocked.json'), build: bad }).finished, true);
	assert.equal(decide({ run: build, has: has('needs_debug.json'), build: bad }).finished, true);
});

// Several agents can be bound at once, so a qa.mjs command without --worktree may not find the agent's tree: every command a nudge
// names carries the run's root.
test('every qa.mjs command a nudge names carries --worktree with the run root', () => {
	const root = '/w/APP 1';
	const runs = [
		{ role: 'reviewer', axis: 'spec' },
		{ role: 'promoter' },
		{ role: 'debugger' },
		build,
		{ ...build, kind: 'bug' },
		{ role: 'builder', until: 'ship', key: 'APP-1' },
	];
	for (const run of runs) {
		const facts = [
			{ has: has(), build: null },
			{ has: has('build.done'), build: { problems: ['no QA run at abc'] } },
		];
		for (const { has: h, build: b } of facts) {
			const { next } = decide({ run, has: h, head: 'abcdef0123456789', build: b, root });
			const mentions = next.match(/qa\.mjs[^,;.]*/g) ?? [];
			assert.ok(mentions.length > 0, `${JSON.stringify(run)}: ${next}`);
			for (const m of mentions) assert.ok(m.includes(`--worktree "${root}"`), `${JSON.stringify(run)}: ${m}`);
		}
	}
});

test('only the roles whose stop condition accepts blocked.json may be given one by the gate', () => {
	for (const run of [
		build,
		{ role: 'debugger' },
		{ role: 'researcher' },
		{ role: 'improver' },
		{ role: 'promoter' },
		{ role: 'builder', until: 'ship' },
	])
		assert.equal(mayRecordBlock(run), true, JSON.stringify(run));
	assert.equal(mayRecordBlock({ role: 'reviewer', axis: 'spec' }), false);
});

// The scheduler's wait loop sees files, not the gate's answer: a refused build.done left on disk would send the ticket to review
// while the builder is still told to work.
test('the gate refuses a build.done that no QA run backs, says why, and sets the file aside', () => {
	const root = worktree();
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	const r = gate(root);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /build\.done is not accepted/);
	assert.match(r.stderr, /no QA run at/);
	assert.match(r.stderr, /build\.refused/);
	assert.equal(exists(root, 'build.done'), false, 'no refused build.done survives the refusal');
	assert.equal(exists(root, 'build.refused'), true);
});

test('the gate accepts build.done once the tree is clean, QA passed at HEAD and the file names the commit, and leaves it in place', () => {
	const root = worktree();
	passingQa(root);
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	const r = gate(root);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(exists(root, 'build.done'), true, 'an accepted hand-off is what the scheduler waits for');
	assert.equal(exists(root, 'build.refused'), false);
});

test('a .dev-factory/ that is neither ignored nor tracked is run state, not uncommitted work', () => {
	const root = worktree(build, { ignored: false });
	passingQa(root);
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	fs.writeFileSync(marker(root, 'stop-nudges'), '1');
	const r = gate(root);
	assert.equal(r.status, 0, r.stderr);
});

test('the gate refuses a build.done with an unrelated sha or a stray uncommitted file', () => {
	const root = worktree();
	passingQa(root);
	fs.writeFileSync(marker(root, 'build.done'), '0123456789abcdef');
	assert.match(gate(root).stderr, /not the QA head/);
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
	assert.match(gate(root).stderr, /not clean/);
	assert.equal(exists(root, 'build.done'), false);
});

test('a commit carrying an agent attribution line keeps a build from being handed off while attribution is off', () => {
	const root = worktree();
	fs.writeFileSync(path.join(root, 'f.txt'), 'x');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'Change [APP-1]\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
	passingQa(root);
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	const r = gate(root);
	assert.equal(r.status, 2, 'ship would refuse this commit, so the hand-off is refused too');
	assert.match(r.stderr, /agent attribution line/);
});

test('a builder that is blocked or needs the debugger may stop without any QA run', () => {
	for (const name of ['blocked.json', 'needs_debug.json']) {
		const root = worktree();
		fs.writeFileSync(marker(root, name), '{}');
		assert.equal(gate(root).status, 0, name);
	}
});

test('when the gate gives up it records a block naming the unmet step and sets build.done aside, so the scheduler is not left waiting', () => {
	const root = worktree();
	const head = g(root, 'rev-parse', 'HEAD');
	const env = { DF_STOP_GATE_MAX: '1' };
	fs.writeFileSync(marker(root, 'build.done'), head);
	assert.equal(gate(root, env).status, 2, 'the first refusal is a nudge');
	assert.equal(exists(root, 'blocked.json'), false);
	fs.writeFileSync(marker(root, 'build.done'), head); // the builder writes it again, still unbacked
	const last = gate(root, env);
	assert.equal(last.status, 0, 'the second one gives up');
	assert.equal(exists(root, 'build.done'), false, 'a block and a refused hand-off never sit side by side');
	assert.equal(exists(root, 'build.refused'), true);
	const blocked = JSON.parse(fs.readFileSync(marker(root, 'blocked.json'), 'utf8'));
	assert.match(blocked.reason, /stop gate/);
	assert.match(blocked.reason, /no QA run at/);
	assert.doesNotMatch(blocked.reason, /write \.dev-factory\/build\.done again|blocked\.json \{/, 'the reason is for a person, not the agent');
	assert.ok(blocked.decision, 'a block always carries the decision a person has to make');
	assert.equal(gate(root, env).status, 0, 'and the next stop is allowed outright');
});

test('giving up never replaces a block someone else wrote', () => {
	const root = worktree();
	fs.writeFileSync(marker(root, 'blocked.json'), JSON.stringify({ reason: 'needs a decision', decision: 'which API?' }));
	assert.equal(gate(root, { DF_STOP_GATE_MAX: '0' }).status, 0);
	assert.equal(JSON.parse(fs.readFileSync(marker(root, 'blocked.json'), 'utf8')).reason, 'needs a decision');
});

test('a reviewer that is let go after the nudges leaves no block behind, because nothing waits on one for a reviewer', () => {
	const root = worktree({ role: 'reviewer', axis: 'spec', key: 'APP-1' });
	assert.equal(gate(root, { DF_STOP_GATE_MAX: '0' }).status, 0);
	assert.equal(fs.existsSync(marker(root, 'blocked.json')), false);
});

// The nudge cap is per phase: /dev-factory:build and :quick do not clear the counter between dispatches, so nudges a reviewer used
// must not count against the builder that comes after it.
test('a clean stop clears the nudge counter', () => {
	const root = worktree({ role: 'reviewer', axis: 'spec', key: 'APP-1' });
	fs.writeFileSync(marker(root, 'stop-nudges'), '5');
	fs.mkdirSync(marker(root, 'review'), { recursive: true });
	fs.writeFileSync(marker(root, `review/${g(root, 'rev-parse', 'HEAD')}-spec.json`), '{}');
	assert.equal(gate(root).status, 0);
	assert.equal(exists(root, 'stop-nudges'), false);
});

// ---- a check that breaks refuses, it never accepts ----

test('a build.done the gate cannot check is refused and set aside: an unparsable QA run', () => {
	const root = worktree();
	passingQa(root);
	fs.writeFileSync(marker(root, 'qa/run-2.json'), '{ not json');
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	const r = gate(root);
	assert.equal(r.status, 2, r.stderr);
	assert.match(r.stderr, /build\.done could not be checked/);
	assert.equal(exists(root, 'build.done'), false);
	assert.equal(exists(root, 'build.refused'), true);
});

test('a build.done the gate cannot check is refused: git cannot run', () => {
	const root = worktree();
	passingQa(root);
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'df-nogit-'));
	const r = gate(root, { PATH: noGit });
	assert.equal(r.status, 2, r.stderr);
	assert.match(r.stderr, /build\.done could not be checked/);
	assert.equal(exists(root, 'build.done'), false);
});

// A copy of the plugin whose bin/qa.mjs cannot even load.
function brokenPlugin() {
	const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'df-broken-plugin-'));
	for (const entry of ['scripts', 'bin', 'mcp', 'settings', 'config.json', 'plugins.json', 'package.json'])
		if (fs.existsSync(path.join(REPO, entry))) fs.cpSync(path.join(REPO, entry), path.join(copy, entry), { recursive: true });
	fs.writeFileSync(path.join(copy, 'bin', 'qa.mjs'), "throw new Error('qa.mjs failed to load');\n");
	return copy;
}

test('a qa.mjs that fails to load leaves every other role alone and refuses a build hand-off', () => {
	const copy = brokenPlugin();
	const script = path.join(copy, 'scripts', 'stop-gate.mjs');
	const env = { CLAUDE_PLUGIN_ROOT: copy };

	const reviewed = worktree({ role: 'reviewer', axis: 'spec', key: 'APP-1' });
	fs.mkdirSync(marker(reviewed, 'review'), { recursive: true });
	fs.writeFileSync(marker(reviewed, `review/${g(reviewed, 'rev-parse', 'HEAD')}-spec.json`), '{}');
	const r = gate(reviewed, env, script);
	assert.equal(r.status, 0, r.stderr);

	const built = worktree();
	passingQa(built);
	fs.writeFileSync(marker(built, 'build.done'), g(built, 'rev-parse', 'HEAD'));
	const b = gate(built, env, script);
	assert.equal(b.status, 2, b.stderr);
	assert.match(b.stderr, /build\.done could not be checked: .*qa\.mjs failed to load/);
	assert.equal(exists(built, 'build.done'), false);
});

// ---- an agent that no longer owns the run ----

test('agentRoleOf names the role of a factory agent type and nothing else', () => {
	assert.equal(agentRoleOf('dev-factory:factory-builder'), 'builder');
	assert.equal(agentRoleOf('factory-debugger'), 'debugger');
	assert.equal(agentRoleOf('dev-factory:factory-reviewer'), 'reviewer');
	assert.equal(agentRoleOf('general-purpose'), null);
	assert.equal(agentRoleOf(undefined), null);
	assert.equal(agentRoleOf(null), null);
	assert.equal(agentRoleOf('myfactory-builder'), null);
	assert.equal(agentRoleOf('dev-factory:factory-builderx'), null);
});

test('ownsRun: an agent of another factory role does not own the run, any other stop is gated as before', () => {
	assert.equal(ownsRun('dev-factory:factory-debugger', { role: 'debugger' }), true);
	assert.equal(ownsRun('dev-factory:factory-builder', { role: 'debugger' }), false);
	assert.equal(ownsRun(undefined, { role: 'debugger' }), true, 'no agent type: gated as before');
	assert.equal(ownsRun(null, { role: 'reviewer' }), true);
	assert.equal(ownsRun('general-purpose', { role: 'debugger' }), true, 'a type that is no factory agent is gated as before');
	assert.equal(ownsRun('dev-factory:factory-builder', {}), true, 'a run with no role is a builder run');
	assert.equal(ownsRun('dev-factory:factory-debugger', {}), false);
});

const debuggerRun = { role: 'debugger', key: 'APP-1', debugBefore: 0 };

test('a builder whose hand-off was taken and whose run moved on to the debugger is let go, charged nothing and given no block', () => {
	for (const env of [{}, { DF_STOP_GATE_MAX: '0' }]) {
		const root = worktree(debuggerRun);
		const r = gateAs(root, 'dev-factory:factory-builder', env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(exists(root, 'stop-nudges'), false, 'the foreign stop is not counted against the run');
		assert.equal(exists(root, 'blocked.json'), false, `no block is written for a run that is not this agent's (${JSON.stringify(env)})`);
	}
});

test('the debugger that owns the run is still held to its finish line, and a non-factory agent is gated as before', () => {
	for (const type of ['dev-factory:factory-debugger', 'general-purpose']) {
		const root = worktree(debuggerRun);
		const r = gateAs(root, type);
		assert.equal(r.status, 2, `${type}: ${r.stderr}`);
		assert.match(r.stderr, /not finished/);
		assert.equal(exists(root, 'stop-nudges'), true);
	}
});

test('giving up is unchanged for the agent that owns the run: it still gets the block that names what was unmet', () => {
	const root = worktree(debuggerRun);
	const r = gateAs(root, 'dev-factory:factory-debugger', { DF_STOP_GATE_MAX: '0' });
	assert.equal(r.status, 0, r.stderr);
	assert.match(JSON.parse(fs.readFileSync(marker(root, 'blocked.json'), 'utf8')).reason, /stop gate.*no debug round recorded/);
});

test('a builder that owns the run keeps its refused build.done set aside, and another role stopping there leaves the file alone', () => {
	const owner = worktree();
	fs.writeFileSync(marker(owner, 'build.done'), g(owner, 'rev-parse', 'HEAD'));
	const r = gateAs(owner, 'dev-factory:factory-builder');
	assert.equal(r.status, 2, r.stderr);
	assert.match(r.stderr, /build\.done is not accepted/);
	assert.equal(exists(owner, 'build.done'), false);
	assert.equal(exists(owner, 'build.refused'), true);

	const other = worktree();
	fs.writeFileSync(marker(other, 'build.done'), g(other, 'rev-parse', 'HEAD'));
	const o = gateAs(other, 'dev-factory:factory-reviewer');
	assert.equal(o.status, 0, o.stderr);
	assert.equal(exists(other, 'build.done'), true, "a hand-off that is not this agent's to refuse stays where it is");
	assert.equal(exists(other, 'build.refused'), false);
	assert.equal(exists(other, 'stop-nudges'), false);
});
