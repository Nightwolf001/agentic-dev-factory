import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { evaluate, evaluateEdit, hitsTrackerHost } from '../scripts/guard-lib.mjs';
import { LIMITS, braceExpand, candidates, globMatch, protectedPlace, triesTakeover, unquote } from '../scripts/guard-paths.mjs';

const HOME = '/Users/dev';
const STATE = `${HOME}/.dev-factory`;
const base = { role: 'builder', branch: 'task/APP-1-x', home: HOME, stateDir: STATE, cwd: '/work/app', env: {} };
const run = (c, extra = {}) => evaluate(c, { ...base, ...extra });
const denied = (c, extra) => assert.equal(run(c, extra).deny, true, `should be refused: ${c}`);
const allowed = (c, extra) => assert.equal(run(c, extra).deny, false, `should be allowed: ${c} (${run(c, extra).reason ?? ''})`);

// ---- A3: machine state, shell profiles, the installed plugin ----

test('a run cannot write the machine state folder, however the path is spelled', () => {
	for (const c of [
		'echo x > ~/.dev-factory/paused.app',
		`echo x >> ${STATE}/settings.json`,
		'rm -rf ~/.dev-factory',
		'rm $HOME/.dev-factory/frontier.json',
		'rm ${HOME}/.dev-factory/frontier.json',
		'cp /tmp/x "$HOME/.dev-factory/settings.json"',
		'mv /tmp/x ~/.DEV-factory/settings.json',
		'touch ~/.dev-factory/../.dev-factory/a',
		'touch $DF_STATE_DIR/ports.lock',
		'tee ~/.dev-factory/x < /tmp/y',
		'tee ${DF_STATE_DIR}/x < /tmp/y',
		'cp /tmp/x --target-directory=~/.dev-factory',
		'install -m 600 /tmp/x ~/.dev-factory/.env.local',
		'cp x ~/.{dev-factory,other}/y',
		'cat x 2>~/.dev-factory/err',
		'git -C ~/.dev-factory checkout .',
	])
		denied(c);
});

test('relative paths count after a cd, including a cd inside a subshell', () => {
	denied('cd ~/.dev-factory && rm -rf .');
	denied('cd ~/.dev-factory && touch ./settings.json');
	denied('cd ~/.dev-factory; echo x > ./a');
	denied('(cd $HOME/.dev-factory && rm ./frontier.json)');
	denied('cd ~ && cd .dev-factory && rm -f ./settings.json');
	denied('cd ~/work/../.dev-factory && touch ./a');
	denied('rm ../.dev-factory/x', { cwd: `${HOME}/repo` });
	denied('echo x > settings.json', { cwd: STATE });
	denied('rm settings.json', { cwd: STATE });
	allowed('cd /work/app && rm -rf build');
	allowed('rm settings.json', { cwd: '/work/app' });
	allowed('cd ~/.dev-factory && cd /work/app && rm -rf build');
});

test('reading machine state is fine; changing it is not', () => {
	allowed('ls ~/.dev-factory');
	allowed('cat ~/.dev-factory/last-pass.json | head -c 400');
	allowed('ls ~/.dev-factory/ports.lock');
	allowed('grep -c error ~/.dev-factory/logs/tick.log');
	allowed('git -C ~/.dev-factory status');
	allowed('cd ~/.dev-factory && ls');
	allowed('cat ~/.zshrc | wc -l');
	allowed('head -5 ~/.zshrc');
	denied('echo "export X=1" >> ~/.zshrc');
	denied('cat ~/.zshrc 2>/tmp/x > ~/.zshrc');
	denied('sed -i s/a/b/ ~/.zshrc');
	denied('tee -a ~/.bashrc < /tmp/x');
	denied('cp /tmp/x ~/.zprofile');
	denied('mv ~/.bash_profile /tmp/');
	denied('printf x > ~/.profile');
	denied('echo x > ~/.ZSHRC');
	denied('echo x | tee ~/.zshenv');
	denied('rm ~/.config/fish/config.fish');
	denied('find ~/.dev-factory -delete');
	denied('find ~ -name x -fprint ~/.zshrc');
});

test('the installed plugin is read-only to a run, but its scripts still run', () => {
	const cache = `${HOME}/.claude/plugins/cache/mk/dev-factory/1.0.0`;
	denied(`echo x >> ${cache}/scripts/guard-lib.mjs`);
	denied(`rm -rf ${cache}`);
	denied(`cp /tmp/x ${cache}/hooks/hooks.json`);
	denied(`sed -i s/a/b/ ${cache}/config.json`);
	denied('cp /tmp/x ~/.claude/plugins/installed_plugins.json');
	allowed(`cat ${cache}/README.md | head`);
	allowed(`node "${cache}/scripts/config.mjs" get tasks.source`);
	allowed(`node ${cache}/bin/qa.mjs status`);
	allowed(`bash ${cache}/scripts/cleanup.sh`);
	denied(`node ${cache}/scripts/config.mjs get tasks.source > ${cache}/out`);
	denied(`node ${cache}/scripts/x.mjs ${cache}/config.json`, {});
	allowed(`${STATE}/bin/dev-factory qa status`);
	denied(`${STATE}/bin/other qa status`);
	denied(`${STATE}/bin/dev-factory qa status > ${STATE}/x`);
});

test('the scheduler’s own passes keep their state, profiles and the plugin stay protected', () => {
	allowed('echo x > ~/.dev-factory/frontier.json', { role: undefined });
	denied('echo x >> ~/.zshrc', { role: undefined });
	denied('rm -rf ~/.claude/plugins/cache', { role: undefined });
});

test('a symlink inside the worktree that points at machine state is refused by the shell guard', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-guard-'));
	const state = path.join(dir, 'state');
	fs.mkdirSync(state);
	fs.symlinkSync(state, path.join(dir, 'link'));
	const c = { ...base, stateDir: fs.realpathSync(state), cwd: dir };
	assert.equal(evaluate('echo x > link/frontier.json', c).deny, true);
	assert.equal(evaluate('echo x > other/frontier.json', c).deny, false);
});

// ---- edit guard ----

test('the edit guard refuses machine state, profiles, the plugin cache, any dev-factory.config.json and the QA file', () => {
	const e = (filePath, extra = {}) =>
		evaluateEdit({ filePath, root: '/work/app', active: true, run: { role: 'builder', key: 'APP-1' }, home: HOME, stateDir: STATE, ...extra });
	for (const f of [
		`${STATE}/settings.json`,
		`${HOME}/.zshrc`,
		`${HOME}/.ZSHRC`,
		`${HOME}/.bash_profile`,
		`${HOME}/.claude/plugins/cache/x/y/config.json`,
		`${HOME}/.claude/settings.json`,
		`${HOME}/.claude/settings.local.json`,
		`${HOME}/.claude.json`,
		'dev-factory.config.json',
		'packages/api/dev-factory.config.json',
		'/work/app/deep/er/DEV-FACTORY.CONFIG.JSON',
		'dev-factory.qa.yaml',
		'.claude/settings.json',
		'packages/a/.claude/settings.local.json',
		'/work/app/../../Users/dev/.dev-factory/x',
	])
		assert.equal(e(f).deny, true, f);
	assert.equal(e('src/index.ts').deny, false);
	assert.equal(e('docs/dev-factory.qa.yaml.md').deny, false);
	assert.equal(e('packages/a/dev-factory.qa.yaml').deny, false, 'only the one at the root is the QA file');
	for (const role of ['reviewer', 'promoter', 'researcher', 'improver'])
		assert.equal(e('packages/api/dev-factory.config.json', { run: { role, key: 'APP-1', factoryPrefix: '' } }).deny, true, role);
	assert.equal(e(`${STATE}/x`, { run: null }).deny, false, 'the scheduler session keeps its state');
	assert.equal(e(`${HOME}/.zshrc`, { run: null }).deny, true, 'but a profile is nobody’s to edit in a pass');
	assert.equal(e(`${HOME}/.zshrc`, { active: false }).deny, false, 'outside a factory run nothing here applies');
});

test('the edit guard follows symlinks to the real file', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-edit-'));
	const state = path.join(dir, 'state');
	const work = path.join(dir, 'work');
	fs.mkdirSync(state);
	fs.mkdirSync(work);
	fs.writeFileSync(path.join(state, 'settings.json'), '{}');
	fs.symlinkSync(path.join(state, 'settings.json'), path.join(work, 'notes.md'));
	fs.symlinkSync(state, path.join(work, 'sub'));
	const e = (filePath) =>
		evaluateEdit({ filePath, root: work, active: true, run: { role: 'builder', key: 'APP-1' }, home: dir, stateDir: fs.realpathSync(state) });
	assert.equal(e('notes.md').deny, true, 'a link to a file');
	assert.equal(e('sub/new-file.json').deny, true, 'a new file in a linked folder');
	assert.equal(e('src/a.ts').deny, false);
});

// ---- A2: takeover is the owner's alone ----

test('an agent cannot set the takeover toggle, however the name is written', () => {
	for (const c of [
		'DF_TAKEOVER=1 node cleanup.mjs',
		'export DF_TAKEOVER=1',
		'DF_TAKE""OVER=1 node cleanup.mjs',
		"DF_TAKE''OVER=1 node cleanup.mjs",
		'DF_TAKE\\OVER=1 node cleanup.mjs',
		'env DF_TAKE"OVER"=1 node x.mjs',
		'export DF_TAKE{OVER,}=1',
		'export {DF_TAKEOVER,X}=1',
		'df_takeover=1 node x.mjs',
		"$'DF_TAKE\\x4fVER'=1 node x.mjs",
		'node cleanup.mjs --takeover',
		'node cleanup.mjs --TAKEOVER',
		'dev-factory cleanup --takeover',
		'a=DF_TAKE; b=OVER; export "$a$b"=1',
		'a=DF_TAKEOVER; export ${!a}=1',
		'declare -n r=DF_TAKEOVER; r=1',
		'printf -v DF_TAKEOVER 1',
		'env "$name=1" node cleanup.mjs',
		'export $name=1',
		'echo $(echo DF_TAKEOVER)',
	])
		denied(c);
	allowed('DF_TAKEOVER=1 node x.mjs', { takeover: true });
	for (const role of ['reviewer', 'debugger', 'researcher', 'improver', 'promoter']) denied('export DF_TAKEOVER=1', { role });
	allowed('git status && echo done');
	allowed('echo take over the world');
	assert.equal(triesTakeover('ls'), false);
	assert.equal(triesTakeover('git commit -m "takeover docs"'), false);
});

test('brace lists and quoting are expanded the way the shell does', () => {
	assert.deepEqual(braceExpand('a{b,c}d').sort(), ['abd', 'acd']);
	assert.deepEqual(braceExpand('{a,b}{1,2}').sort(), ['a1', 'a2', 'b1', 'b2']);
	assert.deepEqual(braceExpand('${HOME}/x'), ['${HOME}/x'], 'a variable is not a list');
	assert.deepEqual(braceExpand('{solo}'), ['{solo}']);
	assert.throws(() => braceExpand('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}'), /too many/);
	assert.equal(unquote(`a"b c"'d e'\\f`), 'ab cd ef');
	assert.equal(unquote("$'\\x2eenv'"), '.env');
	assert.equal(unquote('"a\\"b"'), 'a"b');
	assert.ok(candidates('--file=~/.zshrc', { HOME }).includes(`${HOME}/.zshrc`), 'attached option value');
	assert.ok(candidates('-o$HOME/.zshrc', { HOME }).includes(`${HOME}/.zshrc`), 'attached short option');
	assert.ok(candidates('2>>~/.zshrc', { HOME }).includes(`${HOME}/.zshrc`), 'redirection target');
	assert.equal(protectedPlace(`${STATE}/a`, { home: HOME, stateDir: STATE }), 'state');
	assert.equal(protectedPlace(`${HOME}/.zshrc`, { home: HOME, stateDir: STATE }), 'profile');
	assert.equal(
		protectedPlace(`${HOME}/projects/.zshrc`, { home: HOME, stateDir: STATE }),
		null,
		'a project’s own file of that name is not the login shell’s',
	);
	assert.equal(protectedPlace(`${HOME}/projects/app`, { home: HOME, stateDir: STATE }), null);
	assert.equal(protectedPlace(`${HOME}/.dev-factory-notes/a`, { home: HOME, stateDir: STATE }), null, 'a folder that merely starts with the name');
});

// ---- A4: the guard cannot be hung or slipped past by input shape ----

test('globs match in linear time and never backtrack', () => {
	assert.equal(globMatch('.env.loca?', '.env.local'), true);
	assert.equal(globMatch('.en[v]*', '.env.local'), true);
	assert.equal(globMatch('.env.[!l]*', '.env.local'), false);
	assert.equal(globMatch('.ENV*', '.env.production'), true, 'case-insensitive');
	assert.equal(globMatch('*a*a*a*a*a*a*b', 'a'.repeat(5000)), false);
	const t = Date.now();
	globMatch('*'.repeat(100).replace(/\*/g, '*a'), 'a'.repeat(4000) + 'b');
	assert.ok(Date.now() - t < 500, 'a hostile pattern does not hang');
	assert.throws(() => globMatch('a'.repeat(LIMITS.glob + 1), 'a'), /glob/);
});

test('env files are caught by case, glob, quoting and brace lists; examples are not', () => {
	for (const c of [
		'cat .env',
		'cat .ENV',
		'cat .Env.Local',
		'cat .env.loca?',
		'cat .env.l*',
		'cat .en[v].local',
		'cat .e*',
		'cat ".en""v"',
		'cat .en\\v',
		'cat .env{,.local}',
		'cat {.env,x}',
		"cat $'.\\x65nv'",
		'grep TOKEN apps/web/.env.production',
		'source .env',
		'cp .env /tmp/x',
		'cat -- .env',
		'tar cf x.tar --exclude=a .env.local',
	])
		denied(c);
	for (const c of ['cat .env.example', 'cat .envrc', 'ls *', 'cat ?env', 'cat environment.ts', 'echo environment', 'cat .eslintrc']) allowed(c);
});

test('find cannot write files, and sort, uniq and less are not readers of machine files', () => {
	denied('find . -fls out.txt');
	denied('find . -fprint out.txt');
	denied('find . -fprintf out.txt %p');
	denied('find . -fprint0 out.txt');
	allowed('find . -name "*.ts" -exec wc -l {} +');
	denied('sort -o ~/.zshrc /tmp/x');
	denied('uniq /tmp/x ~/.zshrc');
	denied('less ~/.zshrc');
	denied('sort ~/.dev-factory/x');
});

test('a command too large, too wide or too slow to judge is refused, never let through', () => {
	const huge = run('echo ' + 'a'.repeat(LIMITS.command + 1));
	assert.equal(huge.deny, true);
	assert.match(huge.reason, /cannot be judged/);
	assert.match(run(Array.from({ length: LIMITS.segments + 5 }, (_, i) => `echo ${i}`).join('; ')).reason, /cannot be judged/);
	assert.match(run('cat ' + '{a,b}'.repeat(10)).reason, /cannot be judged|expands/);
	assert.match(run('cat .env.' + '[a-z]'.repeat(100) + '*').reason, /cannot be judged|env files/);
	const t = Date.now();
	run('echo ' + 'http '.repeat(8000));
	run('x=1 '.repeat(8000) + 'ls');
	run('a ' + '"b" '.repeat(8000));
	assert.ok(Date.now() - t < 3000, 'large hostile inputs finish');
});

test('the guard refuses when it fails, not allows', () => {
	const bad = {
		toString() {
			throw new Error('boom');
		},
	};
	assert.equal(evaluate(bad, base).deny, true);
});

// ---- A5: the tracker host rule applies to any command ----

test('any program reaching a tracker host is refused for a factory agent', () => {
	for (const c of [
		'curl https://acme.atlassian.net/rest/api/3/issue/X-1',
		'wget https://acme.atlassian.net/x',
		'node -e "fetch(\'https://api.notion.com/v1/pages\')"',
		'node fetch.mjs https://acme.atlassian.net/x',
		'python3 -c "import urllib.request as u; u.urlopen(\'https://api.notion.com/v1/users\')"',
		'python3 get.py acme.atlassian.net',
		'git clone https://acme.atlassian.net/scm/x/y.git',
		'git remote add t https://acme.atlassian.net/x.git',
		'gh api https://api.notion.com/v1/users',
		'gh api --hostname acme.atlassian.net /x',
		'https https://www.notion.so/page',
		'ssh git@acme.atlassian.net',
		'nc acme.atlassian.net 443',
		'curl "https://ACME.ATLASSIAN.NET/x"',
		'curl https://user:pw@api.notion.com/x',
		'curl https://api.notion.co""m/x',
		'echo go | xargs curl https://api.notion.com/x',
		'bash -c "curl https://api.notion.com/x"',
		'git commit -m "$(curl https://api.notion.com/x)"',
		'gh pr comment 1 --body "$(wget -qO- https://acme.atlassian.net/x)"',
	])
		denied(c);
	allowed('curl http://localhost:3000/health');
	allowed('curl https://registry.npmjs.org/left-pad');
	allowed('git clone https://github.com/acme/app.git');
	allowed('curl https://notexample.net/x');
	allowed('curl https://myatlassian.net.evil.example/x'.replace('myatlassian.net', 'x'));
});

test('text that merely mentions a tracker host is not reaching it', () => {
	allowed('grep -rn "atlassian.net" src/');
	allowed('rg api.notion.com docs');
	allowed('echo "see https://acme.atlassian.net/browse/X-1"');
	allowed('cat docs/notion.so.md');
	allowed('git log --grep=atlassian.net');
	allowed('git diff -- docs/api.notion.com.md');
	allowed('git commit -m "Fix: retry on https://acme.atlassian.net/rest/api timeouts"');
	allowed('git commit -m"mention api.notion.com"');
	allowed('git commit --message="mention api.notion.com"');
	allowed('git commit -am "link https://acme.atlassian.net/browse/X-1"');
	allowed('gh pr create --title "Fix" --body "Jira: https://acme.atlassian.net/browse/X-1"');
	allowed('gh pr comment 12 --body "see https://api.notion.com/v1/docs"');
	allowed('gh pr edit 12 -b "see https://acme.atlassian.net/browse/X-1"');
	denied('git push https://acme.atlassian.net/x.git HEAD');
	denied('echo https://acme.atlassian.net/x > hosts.txt');
});

test('hosts beyond the built-in ones come from the settings, boundary-checked', () => {
	const inv = (seg) => {
		const tokens = seg.split(/\s+/);
		return { cmd: tokens[0], args: tokens.slice(1), tokens, head: tokens[0] };
	};
	const hosts = ['jira.internal.example'];
	assert.equal(hitsTrackerHost(inv('curl https://jira.internal.example/rest'), { trackerHosts: hosts }), true);
	assert.equal(hitsTrackerHost(inv('curl https://x.jira.internal.example/rest'), { trackerHosts: hosts }), true, 'a subdomain');
	assert.equal(hitsTrackerHost(inv('curl https://xjira.internal.example/rest'), { trackerHosts: hosts }), false);
	assert.equal(
		hitsTrackerHost(inv('curl https://jira.internal.example.evil.test/rest'), { trackerHosts: hosts }),
		false,
		'a longer name is another host',
	);
	assert.equal(hitsTrackerHost(inv('curl https://jira.internal.example/rest'), {}), false, 'not listed, not a tracker');
	assert.equal(
		hitsTrackerHost(inv('curl https://jira.internal.example/rest'), { trackerHosts: ['https://jira.internal.example/'] }),
		true,
		'a URL is reduced to its host',
	);
	denied('curl https://jira.internal.example/rest', { trackerHosts: hosts });
});

test('the scheduler may still send QA screenshots to a Notion upload URL, and nothing else to a tracker', () => {
	const id = '0123456789abcdef0123456789abcdef';
	const upload = `curl -sS -X POST -F "file=@.dev-factory/evidence/APP-1/run-1/shot.png;type=image/png" https://api.notion.com/v1/file_uploads/${id}/send`;
	assert.equal(evaluate(upload, { ...base, role: undefined }).deny, false);
	assert.equal(evaluate(upload, base).deny, true, 'a factory agent never reaches the tracker');
	assert.equal(evaluate('curl https://api.notion.com/v1/pages', { ...base, role: undefined }).deny, true);
	assert.equal(evaluate('node -e "x"  https://api.notion.com/v1/pages', { ...base, role: undefined }).deny, true);
});
