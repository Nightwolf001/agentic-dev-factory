import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

const PREFLIGHT = new URL('../scripts/preflight.sh', import.meta.url).pathname;
const TICK = new URL('../scripts/tick.sh', import.meta.url).pathname;
const gate = (code) => spawnSync('bash', ['-c', `. ${PREFLIGHT}; df_preflight_gate ${code}`], { encoding: 'utf8' });

test('only exit 0 of the frontier check starts a session; every other code skips it', () => {
	assert.equal(gate(0).status, 0);
	assert.equal(gate(20).status, 20);
	assert.match(gate(20).stdout, /nothing to do/);
	for (const code of [1, 2, 3, 21, 127, 255]) {
		const r = gate(code);
		assert.equal(r.status, 1, `exit ${code} must not start a session`);
		assert.ok(r.stdout.trim().length > 0, `exit ${code} logs why`);
	}
	assert.match(gate(21).stdout, /token this machine lacks/);
});

test('tick.sh asks the gate before it can reach claude, and DF_PREFLIGHT=off is the only way around it', () => {
	const src = fs.readFileSync(TICK, 'utf8');
	assert.match(src, /\. "\$DIR\/scripts\/preflight\.sh"/);
	const gateAt = src.indexOf('df_preflight_gate');
	const claudeAt = src.indexOf('claude -p');
	assert.ok(gateAt > 0 && claudeAt > gateAt, 'the gate is consulted before claude -p');
	assert.equal(src.match(/claude -p/g).length, 1);
	assert.match(src, /DF_PREFLIGHT:-on\}" != off/);
});
