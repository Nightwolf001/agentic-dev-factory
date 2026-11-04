import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inferPlatform, resolvePlatform, withClientLogs } from '../scripts/mobile-platform.mjs';
import { load, merge, validate } from '../scripts/config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOBILE = path.join(ROOT, 'scripts/mobile-env.sh');

// ---- the platform ----

test('Android only when the ticket names Android and no iOS term; otherwise iOS', () => {
	assert.equal(inferPlatform('Fix the crash on the Android settings screen'), 'android');
	assert.equal(inferPlatform('Gradle sync fails when building the app'), 'android');
	assert.equal(inferPlatform('Fix the crash on the settings screen'), 'ios', 'no platform named: the default');
	assert.equal(inferPlatform('Fix the layout on iOS and Android'), 'ios', 'both named: the default');
	assert.equal(inferPlatform('Android only. Not the iPhone version.'), 'ios');
	assert.equal(inferPlatform('Android emulator shows a blank screen'), 'android');
	assert.equal(inferPlatform('The iOS simulator hangs'), 'ios');
	assert.equal(inferPlatform(''), 'ios');
	assert.equal(inferPlatform(null), 'ios');
	assert.equal(inferPlatform('Androids dream of electric sheep'), 'ios', 'a whole word');
});

test('an explicit platform wins, in order: DF_MOBILE_PLATFORM, mobile.platform, run.json; the ticket decides only without one', () => {
	const text = 'Android settings screen';
	const cfg = (platform) => merge(load(), { mobile: platform ? { platform } : {} });
	assert.deepEqual(resolvePlatform({ env: {}, cfg: cfg(), run: null, text }), { platform: 'android', source: 'ticket' });
	assert.deepEqual(
		resolvePlatform({ env: {}, cfg: cfg(), run: { platform: 'ios' }, text }),
		{ platform: 'ios', source: 'explicit' },
		'run.json beats the ticket',
	);
	assert.deepEqual(
		resolvePlatform({ env: {}, cfg: cfg('ios'), run: { platform: 'android' }, text }),
		{ platform: 'ios', source: 'explicit' },
		'the setting beats run.json',
	);
	assert.deepEqual(
		resolvePlatform({ env: { DF_MOBILE_PLATFORM: 'android' }, cfg: cfg('ios'), run: null, text: 'iOS only' }),
		{ platform: 'android', source: 'explicit' },
		'the variable beats everything',
	);
	assert.deepEqual(
		resolvePlatform({ env: { DF_MOBILE_PLATFORM: 'windows' }, cfg: cfg(), run: null }),
		{ platform: 'ios', source: 'default' },
		'an unknown value is ignored',
	);
	assert.equal(resolvePlatform({ env: {}, cfg: cfg(), run: null }).platform, 'ios');
});

test('the defaults do not set mobile.platform, or the inference would never run', () => {
	assert.equal(load().mobile.platform, undefined);
	assert.deepEqual(validate(merge(load(), { mobile: { platform: 'android' } })), []);
	assert.match(validate(merge(load(), { mobile: { platform: 'windows' } })).join('\n'), /mobile\.platform must be ios or android/);
});

test('the CLI prints the platform and records it in run.json unless it was explicit', () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'df-plat-'));
	fs.mkdirSync(path.join(wt, '.dev-factory'));
	fs.writeFileSync(path.join(wt, '.dev-factory/run.json'), JSON.stringify({ key: 'APP-1' }));
	const text = path.join(wt, 'ticket.md');
	fs.writeFileSync(text, 'The Android app crashes on start');
	const run = (...a) =>
		spawnSync(process.execPath, [path.join(ROOT, 'scripts/mobile-platform.mjs'), ...a], {
			encoding: 'utf8',
			cwd: wt,
			env: { ...process.env, DF_MOBILE_PLATFORM: '' },
		});
	assert.equal(run('resolve', '--worktree', wt, '--text-file', text).stdout.trim(), 'android');
	assert.equal(JSON.parse(fs.readFileSync(path.join(wt, '.dev-factory/run.json'), 'utf8')).platform, undefined, 'not recorded without --record');
	assert.equal(run('resolve', '--worktree', wt, '--text-file', text, '--record').stdout.trim(), 'android');
	assert.equal(JSON.parse(fs.readFileSync(path.join(wt, '.dev-factory/run.json'), 'utf8')).platform, 'android');
	assert.equal(run('resolve', '--worktree', wt).stdout.trim(), 'android', 'and the lane reads it back from run.json');
	assert.equal(run('bogus').status, 1);
});

// ---- Metro ----

test('--client-logs goes on the last command of a chain, behind -- for an npm script, and only once', () => {
	assert.equal(withClientLogs('yarn start --port 8081'), 'yarn start --port 8081 --client-logs');
	assert.equal(withClientLogs('cd app && yarn start'), 'cd app && yarn start --client-logs');
	assert.equal(withClientLogs('npm run start'), 'npm run start -- --client-logs');
	assert.equal(withClientLogs('npm start --port 8081'), 'npm start --port 8081 -- --client-logs');
	assert.equal(withClientLogs('npm run start -- --port 8081'), 'npm run start -- --port 8081 --client-logs', 'there is a -- already');
	assert.equal(withClientLogs('cd x && npm run start'), 'cd x && npm run start -- --client-logs');
	assert.equal(
		withClientLogs('npm run build && yarn start'),
		'npm run build && yarn start --client-logs',
		'the last command decides, not the first',
	);
	assert.equal(withClientLogs('yarn start --client-logs'), 'yarn start --client-logs');
	assert.equal(withClientLogs('yarn start', false), 'yarn start', 'mobile.clientLogs false leaves it alone');
	assert.equal(withClientLogs(''), '');
});

// ---- the lane, with stubs for the tools ----

function lane({ platform, mobile = {}, env = {} } = {}) {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-lane-')));
	const bin = path.join(home, 'bin');
	const wt = path.join(home, 'wt');
	fs.mkdirSync(bin);
	fs.mkdirSync(path.join(wt, 'app/ios'), { recursive: true });
	fs.mkdirSync(path.join(wt, 'app/android/app'), { recursive: true });
	fs.mkdirSync(path.join(wt, '.dev-factory'));
	fs.writeFileSync(path.join(wt, 'app/ios/Podfile.lock'), 'PODS\n');
	fs.writeFileSync(path.join(wt, 'app/android/build.gradle'), 'android {}\n');
	fs.writeFileSync(path.join(wt, '.dev-factory/env.json'), JSON.stringify({ project: 'df-app-1', mode: 'device' }));
	fs.writeFileSync(path.join(wt, '.dev-factory/run.json'), JSON.stringify({ key: 'APP-1', ...(platform ? { platform } : {}) }));
	const calls = path.join(home, 'calls.log');
	fs.writeFileSync(
		path.join(wt, 'dev-factory.config.json'),
		JSON.stringify({
			mobile: {
				appDir: 'app',
				install: null,
				pods: null,
				prepare: null,
				androidAvd: 'Pixel_API_34',
				start: `bash -c 'echo "metro $*" >> "${calls}"; sleep 60' x`,
				build: `echo "ios-build {udid} {port}" >> "${calls}"`,
				androidBuild: `echo "android-build {serial} {port}" >> "${calls}"`,
				androidReversePorts: [3000],
				...mobile,
			},
		}),
	);
	const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	const devices = path.join(home, 'adb-devices');
	stub(
		'adb',
		`echo "adb $*" >> "${calls}"
case "$1" in
  devices) echo "List of devices attached"; cat "${devices}" 2>/dev/null ;;
  -s) shift; s="$1"; shift
    case "$1 $2" in
      "emu avd") cat "${home}/avd-$s" 2>/dev/null; echo OK ;;
      "shell getprop") echo 1 ;;
      "reverse "*) : ;;
      "emu kill") : ;;
    esac ;;
esac
exit 0`,
	);
	stub(
		'emulator',
		`case "$1" in
  -list-avds) echo Pixel_API_34; echo Other_AVD ;;
  -avd) echo "emulator $*" >> "${calls}"; echo "emulator-5554 device" >> "${devices}"; echo "$2" > "${home}/avd-emulator-5554" ;;
esac
exit 0`,
	);
	stub('curl', 'case "$*" in *"/status"*) echo packager-status:running ;; *) : ;; esac; echo "curl $*" >> "' + calls + '"; exit 0');
	stub('lsof', 'exit 0');
	stub('xcodebuild', `echo "Xcode \${DF_TEST_XCODE:-15.4}"`);
	stub(
		'xcrun',
		`echo "xcrun $*" >> "${calls}"
case "$1 $2" in
  "simctl list") echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-5":[{"name":"iPhone 16","udid":"UDID-1","state":"Booted"}]}}' ;;
esac
exit 0`,
	);
	const runEnv = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		HOME: home,
		DF_STATE_DIR: path.join(home, 'state'),
		DF_MOBILE_PLATFORM: '',
		ANDROID_SDK_ROOT: path.join(home, 'sdk'),
		...env,
	};
	const run = (...a) => spawnSync('bash', [MOBILE, ...a, '--worktree', wt], { encoding: 'utf8', env: runEnv, cwd: wt, timeout: 60000 });
	const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
	const envJson = () => JSON.parse(fs.readFileSync(path.join(wt, '.dev-factory/env.json'), 'utf8'));
	return { home, wt, run, log, envJson, devices, runEnv, state: path.join(home, 'state') };
}

test('Android: boots the AVD headless, reverses the ports, builds with the serial, records the device and no pods run', () => {
	const l = lane({ platform: 'android', mobile: { pods: 'echo PODS-RAN' } });
	const r = l.run('up');
	assert.equal(r.status, 0, r.stderr);
	const calls = l.log();
	assert.match(calls, /emulator -avd Pixel_API_34 -no-window -no-audio -no-boot-anim -no-snapshot-save/);
	assert.match(calls, /adb -s emulator-5554 reverse tcp:8081 tcp:8081/);
	assert.match(calls, /adb -s emulator-5554 reverse tcp:3000 tcp:3000/, 'mobile.androidReversePorts');
	assert.match(calls, /android-build emulator-5554 8081/);
	assert.match(calls, /metro --client-logs/, 'Metro runs with --client-logs');
	assert.match(calls, /index\.bundle\?platform=android/);
	assert.doesNotMatch(calls, /ios-build|xcrun|PODS-RAN/);
	const d = l.envJson().device;
	assert.deepEqual(
		{ platform: d.platform, serial: d.serial, avd: d.avd, bootedByFactory: d.bootedByFactory, metroPort: d.metroPort },
		{ platform: 'android', serial: 'emulator-5554', avd: 'Pixel_API_34', bootedByFactory: true, metroPort: 8081 },
	);
	assert.ok(fs.existsSync(path.join(l.wt, '.dev-factory/emulator.pid')), 'the pid is kept so cleanup can stop it');
	assert.equal(l.run('down').status, 0);
});

test('Android: a running emulator of the AVD is reused, not booted, and cleanup would leave it alone', () => {
	const l = lane({ platform: 'android' });
	fs.writeFileSync(l.devices, 'emulator-5556 device\n');
	fs.writeFileSync(path.join(l.home, 'avd-emulator-5556'), 'Pixel_API_34\n');
	const r = l.run('up');
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(l.log(), /emulator -avd/);
	assert.match(l.log(), /adb -s emulator-5556 reverse/);
	assert.equal(l.envJson().device.bootedByFactory, false);
	assert.equal(l.envJson().device.serial, 'emulator-5556');
	l.run('down');
});

test('Android: DF_DEVICE_NAME picks the AVD, and with no AVD named the first one is used; a missing emulator is an error', () => {
	const l = lane({ platform: 'android', mobile: { androidAvd: null }, env: { DF_DEVICE_NAME: 'Other_AVD' } });
	assert.equal(l.run('up').status, 0);
	assert.match(l.log(), /emulator -avd Other_AVD/);
	l.run('down');
	const first = lane({ platform: 'android', mobile: { androidAvd: null } });
	assert.equal(first.run('up').status, 0);
	assert.match(first.log(), /emulator -avd Pixel_API_34/, 'the first of emulator -list-avds');
	first.run('down');
	const none = lane({ platform: 'android' });
	fs.rmSync(path.join(none.home, 'bin/emulator'));
	fs.rmSync(path.join(none.home, 'bin/adb'));
	const r = none.run('up');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /no Android virtual device|emulator not found/);
});

test('Android: the native build runs once and again only when the Android inputs change; the iOS inputs are not looked at', () => {
	const l = lane({ platform: 'android' });
	fs.writeFileSync(l.devices, 'emulator-5554 device\n');
	fs.writeFileSync(path.join(l.home, 'avd-emulator-5554'), 'Pixel_API_34\n');
	l.run('up');
	l.run('down');
	l.run('up');
	l.run('down');
	assert.equal((l.log().match(/android-build/g) ?? []).length, 1);
	fs.appendFileSync(path.join(l.wt, 'app/ios/Podfile.lock'), 'changed\n');
	l.run('up');
	l.run('down');
	assert.equal((l.log().match(/android-build/g) ?? []).length, 1, 'an iOS file does not rebuild the Android app');
	fs.appendFileSync(path.join(l.wt, 'app/android/build.gradle'), '// changed\n');
	l.run('up');
	l.run('down');
	assert.equal((l.log().match(/android-build/g) ?? []).length, 2);
});

test('iOS: the Xcode version is part of the native hash, so a newer one rebuilds', () => {
	const l = lane({ platform: 'ios' });
	assert.equal(l.run('up').status, 0, 'ios works as before');
	l.run('down');
	assert.match(l.log(), /ios-build UDID-1 8081/);
	assert.match(l.log(), /index\.bundle\?platform=ios/);
	assert.equal(l.envJson().device.platform, 'ios');
	assert.equal(l.envJson().device.udid, 'UDID-1');
	l.run('up');
	l.run('down');
	assert.equal((l.log().match(/ios-build/g) ?? []).length, 1, 'same inputs, same Xcode: no rebuild');
	const other = spawnSync('bash', [MOBILE, 'up', '--worktree', l.wt], {
		encoding: 'utf8',
		env: { ...l.runEnv, DF_TEST_XCODE: '16.0' },
		cwd: l.wt,
		timeout: 60000,
	});
	assert.equal(other.status, 0, other.stderr);
	spawnSync('bash', [MOBILE, 'down', '--worktree', l.wt], { env: l.runEnv, cwd: l.wt });
	assert.equal((l.log().match(/ios-build/g) ?? []).length, 2, 'a new Xcode rebuilds');
	assert.equal(fs.readdirSync(l.state).filter((f) => f.startsWith('native-ios-')).length, 2);
});

test('iOS: password AutoFill is turned off once per simulator, and a failing command does not stop the lane', () => {
	const l = lane({ platform: 'ios', mobile: { iosAutofillOff: 'echo "autofill-off {udid}" >> "$HOME/calls.log"' } });
	l.run('up');
	l.run('down');
	l.run('up');
	l.run('down');
	assert.equal((l.log().match(/autofill-off UDID-1/g) ?? []).length, 1, 'once');
	assert.ok(fs.existsSync(path.join(l.state, 'autofill-UDID-1.done')));
	const off = lane({ platform: 'ios' });
	off.run('up');
	off.run('down');
	assert.doesNotMatch(off.log(), /autofill/, 'unset: nothing runs');
	const bad = lane({ platform: 'ios', mobile: { iosAutofillOff: 'exit 7' } });
	const r = bad.run('up');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /mobile\.iosAutofillOff failed/);
	assert.equal(fs.existsSync(path.join(bad.state, 'autofill-UDID-1.done')), false, 'so it is tried again');
	bad.run('down');
});

test('Metro runs with --client-logs unless mobile.clientLogs is false, and the lane works against a remote environment started with --device', () => {
	const off = lane({ platform: 'ios', mobile: { clientLogs: false } });
	off.run('up');
	off.run('down');
	assert.doesNotMatch(off.log(), /client-logs/);
	const remote = lane({ platform: 'ios' });
	fs.writeFileSync(
		path.join(remote.wt, '.dev-factory/env.json'),
		JSON.stringify({ project: '', mode: 'remote', device: true, remote: { env: 'staging' } }),
	);
	assert.equal(remote.run('up').status, 0);
	remote.run('down');
	const notDevice = lane({ platform: 'ios' });
	fs.writeFileSync(path.join(notDevice.wt, '.dev-factory/env.json'), JSON.stringify({ project: '', mode: 'remote', device: false }));
	const r = notDevice.run('up');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /not in device mode/);
});

test('mobile settings are validated', () => {
	assert.deepEqual(
		validate(
			merge(load(), {
				mobile: {
					androidAvd: 'Pixel',
					androidReversePorts: [3000, 1337],
					clientLogs: false,
					iosAutofillOff: 'true',
					appId: 'com.example.app',
				},
			}),
		),
		[],
	);
	for (const bad of [{ androidAvd: '' }, { androidReversePorts: ['x'] }, { clientLogs: 'yes' }, { login: { submit: '' } }, { appId: 5 }])
		assert.match(validate(merge(load(), { mobile: bad })).join('\n'), /mobile\./, JSON.stringify(bad));
	assert.equal(load().mobile.login.userField, 'qa-login-username');
});

test('an invalid DF_MOBILE_PLATFORM stops the lane instead of being ignored', () => {
	const l = lane({ platform: 'ios', env: { DF_MOBILE_PLATFORM: 'windows' } });
	const r = l.run('up');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /DF_MOBILE_PLATFORM must be ios or android \(got 'windows'\)/);
	assert.equal(inferPlatform('The app crashes on the emulator'), 'ios', 'emulator alone does not say Android');
	assert.equal(inferPlatform('Android emulator shows a blank screen'), 'android');
});
