// notion-upload.mjs --file <evidence image> --url <upload_url> [--header "Name: value" ...]
// Prints {ok, status, id, uploadStatus, error} and exits 1 when the upload failed. See notion-upload-lib.mjs.
import { isMain } from './is-main.mjs';
import { upload } from './notion-upload-lib.mjs';

async function main(argv) {
	const opts = { headers: [] };
	for (let i = 0; i < argv.length; i += 2) {
		const k = argv[i];
		if (k === '--file') opts.file = argv[i + 1];
		else if (k === '--url') opts.url = argv[i + 1];
		else if (k === '--header') opts.headers.push(argv[i + 1]);
		else throw new Error(`unknown argument ${k}`);
	}
	const result = await upload(opts);
	console.log(JSON.stringify(result));
	process.exit(result.ok ? 0 : 1);
}

if (isMain(import.meta.url)) {
	main(process.argv.slice(2)).catch((e) => {
		console.log(JSON.stringify({ ok: false, error: e.message }));
		process.exit(1);
	});
}
