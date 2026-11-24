// A TCP proxy from a port on this machine's loopback to one port of a task's container, so a client that can only reach this
// machine (an Android emulator through adb reverse, the iOS simulator) reaches that task and no other. Started and stopped by
// scripts/mobile-env.sh, one per port in mobile.androidReversePorts on a direct stack.
//
//   port-proxy.mjs --to HOST:PORT [--listen PORT] [--port-file FILE]
//        listens on 127.0.0.1 (on PORT, else a free port), writes the port it listens on to FILE once it listens, and forwards
//        every connection to HOST:PORT byte for byte (HTTP, websockets, anything over TCP). Runs until it is stopped.
import fs from 'node:fs';
import net from 'node:net';
import { isMain } from './is-main.mjs';

export function parseTarget(text) {
	const m = /^([A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(String(text ?? ''));
	if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) return null;
	return { host: m[1], port: Number(m[2]) };
}

// -> a listening net.Server; `ready` resolves with the port it listens on
export function startProxy({ to, listen = 0, host = '127.0.0.1' }) {
	const server = net.createServer((client) => {
		const upstream = net.connect(to.port, to.host);
		const close = () => {
			client.destroy();
			upstream.destroy();
		};
		client.on('error', close);
		upstream.on('error', close);
		client.pipe(upstream);
		upstream.pipe(client);
	});
	const ready = new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(listen, host, () => resolve(server.address().port));
	});
	return { server, ready };
}

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const opt = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const to = parseTarget(opt('--to'));
	if (!to) {
		console.error('usage: port-proxy.mjs --to HOST:PORT [--listen PORT] [--port-file FILE]');
		process.exit(3);
	}
	const listen = opt('--listen') ? Number(opt('--listen')) : 0;
	const { ready } = startProxy({ to, listen });
	ready.then(
		(port) => {
			const file = opt('--port-file');
			if (file) fs.writeFileSync(file, String(port));
			console.log(`port-proxy: 127.0.0.1:${port} -> ${to.host}:${to.port}`);
		},
		(e) => {
			console.error(`port-proxy: could not listen: ${e.message}`);
			process.exit(1);
		},
	);
}
