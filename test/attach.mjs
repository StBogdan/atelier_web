// The attach walkthrough: give one workspace a bucket of its own, and prove the browser signs for
// it itself — driven through the app's own UI, in a real Chromium.
//
//   npm install playwright-core      # once, in this directory
//   node attach.mjs                  # starts the stub itself, then drives Chrome
//
// Needs no bucket and no account. `s3-stub.mjs` is a local S3 stand-in that verifies the SigV4
// signature of every presigned URL it is handed, and this script gives it credentials that exist
// nowhere else — in no environment, in no file. A signature it accepts is therefore proof that the
// browser signed with the credential the attach form was given, and that nothing else signed for it.
//
// Nothing has to be configured for the server: the bucket is the workspace's, and the server has no
// bucket role at all. This asserts that too, by checking that `/api/storage` is gone.
//
// It needs the app served — `cd ../server && cargo run --release`, or `./run.sh` — with `web/build`
// built. `ATELIER_ORIGIN` overrides http://127.0.0.1:3000.

import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { startStub } from './s3-stub.mjs';

const ORIGIN = process.env.ATELIER_ORIGIN || 'http://127.0.0.1:3000';
const PORT = Number(process.env.ATELIER_STUB_PORT || 9100);
const BUCKET = 'bucket-attached-to-a-workspace';
const ACCESS_KEY_ID = 'attached-access-key';
const SECRET_ACCESS_KEY = 'attached-secret-access-key';
const SAMPLE_BYTES = 179714;
const log = (...parts) => console.log(...parts);
const step = (name) => log(`\n== ${name}`);

let failures = 0;
function check(what, ok, detail = '') {
	log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The project's document bytes, read from OPFS in the page: what the editor would have written. */
async function documentBytes(page, project) {
	const bytes = await page.evaluate(async (id) => {
		const space = await (await navigator.storage.getDirectory()).getDirectoryHandle('atelier-cloud');
		const dir = await (await space.getDirectoryHandle('projects')).getDirectoryHandle(id);
		for await (const [name, handle] of dir.entries()) {
			if (handle.kind === 'file' && name.endsWith('.pcraft') && !name.endsWith('.prev')) {
				const file = await handle.getFile();
				return [...new Uint8Array(await file.arrayBuffer())];
			}
		}
		return null;
	}, project);
	return bytes ? Buffer.from(bytes) : null;
}

async function readJson(page, project, name) {
	return await page.evaluate(
		async ([id, file]) => {
			const space = await (await navigator.storage.getDirectory()).getDirectoryHandle('atelier-cloud');
			const dir = await (await space.getDirectoryHandle('projects')).getDirectoryHandle(id);
			const handle = await (await dir.getFileHandle(file)).getFile();
			return JSON.parse(await handle.text());
		},
		[project, name]
	);
}

async function panel(page, heading) {
	return await page.innerText(`.panel:has(h2:has-text("${heading}"))`);
}

async function main() {
	const stub = startStub({ port: PORT, bucket: BUCKET, accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY });
	await stub.listen();
	log(`s3 stub listening on ${stub.url} (bucket ${stub.bucket}, credentials that exist nowhere else)`);

	step('The server has no bucket role any more');
	const status = await fetch(`${ORIGIN}/api/storage`).catch(() => null);
	check(
		'/api/storage is gone, so no deployment can carry a bucket credential',
		status?.status === 404,
		status ? `/api/storage answered ${status.status}` : 'no answer at all — is Atelier web running?'
	);

	const browser = await chromium.launch({ channel: 'chrome', headless: true });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		deviceScaleFactor: 1,
		permissions: ['clipboard-read', 'clipboard-write']
	});
	const page = await context.newPage();
	const consoleLog = [];
	const requested = [];
	page.on('console', (message) => consoleLog.push(message.text()));
	page.on('pageerror', (error) => consoleLog.push(`error: ${error.message}`));
	page.on('request', (request) => {
		try {
			requested.push(new URL(request.url()).pathname);
		} catch {
			// A URL that will not parse is not a path this app asked for.
		}
	});

	step('The Help page carries the bucket setup, and the nav reaches it');
	await page.goto(`${ORIGIN}/cloud/help`, { waitUntil: 'networkidle' });
	const help = await page.innerText('.shell');
	check('Help renders the bucket walkthrough', /Setting up a bucket/.test(help), help.slice(0, 120));
	check('Help renders troubleshooting', /Troubleshooting/.test(help));
	check('Help names the endpoint an R2 bucket uses', /r2\.cloudflarestorage\.com/.test(help));
	check(
		"Help's CORS policy carries this origin, so it can be pasted as it stands",
		help.includes(`"AllowedOrigins": ["${ORIGIN}"]`),
		help.split('\n').find((line) => line.includes('AllowedOrigins')) ?? 'no policy'
	);
	await page.click('section#cors .snippet-head button');
	await page.waitForTimeout(200);
	const pasted = await page.evaluate(() => navigator.clipboard.readText());
	check(
		'and its copy button puts the whole policy on the clipboard, not a selection of it',
		pasted.startsWith(`[\n  {\n    "AllowedOrigins": ["${ORIGIN}"]`) && pasted.includes('"MaxAgeSeconds": 3600'),
		pasted.slice(0, 60).replace(/\n/g, '\\n')
	);
	check(
		'and the button says it did — it is pasted into someone else’s dashboard',
		(await page.innerText('section#cors .snippet-head button')) === 'Copied'
	);
	check(
		'the nav links to it',
		(await page.getAttribute('nav.chrome a:has-text("Help")', 'href')) === '/cloud/help',
		String(await page.getAttribute('nav.chrome a:has-text("Help")', 'href'))
	);

	step('Local storage warns about itself, without jargon');
	const health = await page.innerText('.health');
	check('the storage row uses no storage-spec jargon', !/best-effort/i.test(health), health);
	const mark = await page.getAttribute('.health .warn-icon[title]', 'title');
	check(
		'and a warning mark explains where the work lives, on hover',
		(mark ?? '').includes('Stored in this browser') && (mark ?? '').includes('nothing is copied off this machine'),
		String(mark)
	);
	check(
		'which is no longer taking a line of the page',
		!(await page.innerText('.shell')).includes('A workspace you have not downloaded is a workspace you can lose')
	);

	step('A workspace to attach a bucket to');
	await page.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=Workspaces');
	check(
		'with nothing uncommitted, the main page says nothing about it',
		!/not committed yet/.test(await page.innerText('.shell'))
	);
	await page.click('button:has-text("New workspace")');
	await page.fill('input[type=text]', 'Attached bucket');
	await page.click('button:has-text("Create")');
	await page.waitForSelector('article h2:has-text("Attached bucket")');
	const href = await page.getAttribute('article a:has-text("Open in PhotoCraft")', 'href');
	const project = new URL(href, ORIGIN).searchParams.get('project');
	check('a workspace exists with a uuid project id', Boolean(project), project ?? 'none');

	await page.goto(`${ORIGIN}/cloud/workspace/${project}`, { waitUntil: 'networkidle' });
	await page.waitForSelector('h2:text-is("Bucket")');

	const before = await panel(page, 'Bucket');
	log('   bucket panel:\n' + before.split('\n').map((line) => `     ${line}`).join('\n'));
	check('a fresh workspace has no bucket', /none attached/.test(before), before);
	check('and offers nothing to upload to', !/Upload document to bucket/.test(before), before);

	const changes = await panel(page, 'Changes');
	check('the Changes panel carries the upload too', /Upload to bucket/.test(changes), changes);
	check('with no bucket it explains itself with an info icon', /ⓘ/.test(changes), changes);
	check(
		'and the explanation under the actions is there even with nothing to do',
		/Recording a version marks the current state/.test(changes),
		changes
	);
	const cleanHeading = (await page.innerText('section.panel.changes h2')).trim();
	check(
		'the up-to-date heading keeps the same "Changes —" prefix, so nothing jumps',
		cleanHeading === 'Changes — Version up to date',
		cleanHeading
	);
	check(
		'and the button is disabled',
		await page.isDisabled('section.panel.changes button:has-text("Upload to bucket")')
	);
	const info = await page.getAttribute('section.panel.changes .info', 'title');
	check('the info icon gives the reason on hover', info?.includes('No bucket is attached') === true, String(info));
	check(
		'the record action stays in place when there is nothing to record, greyed as "Up to date"',
		await page.isDisabled('section.panel.changes button:has-text("Up to date")')
	);

	const downloadBox = await page.locator('section.panel.changes button:has-text("Download files")').boundingBox();
	const uploadBox = await page.locator('section.panel.changes button:has-text("Upload to bucket")').boundingBox();
	check(
		'"Download files" is pushed to the right end of the row',
		Boolean(downloadBox && uploadBox) && downloadBox.x > uploadBox.x + uploadBox.width,
		`download at ${downloadBox?.x}, upload ends at ${uploadBox ? uploadBox.x + uploadBox.width : '?'}`
	);

	step('A whole bucket URL pasted into the endpoint is taken apart');
	await page.evaluate((url) => {
		const input = document.querySelector('input[placeholder^="https://ACCOUNT_ID"]');
		const data = new DataTransfer();
		data.setData('text/plain', url);
		input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, `${stub.url}/${stub.bucket}`);
	await page.waitForTimeout(300);
	check(
		'the endpoint keeps only the account host',
		(await page.inputValue('label:has-text("Endpoint") input')) === stub.url,
		await page.inputValue('label:has-text("Endpoint") input')
	);
	check(
		'the bucket name moves to its own field',
		(await page.inputValue('label:has-text("Bucket") input')) === stub.bucket,
		await page.inputValue('label:has-text("Bucket") input')
	);

	step('Typed in by hand instead, the bucket is still taken from the endpoint');
	await page.fill('label:has-text("Endpoint") input', `${stub.url}/${stub.bucket}`);
	await page.fill('label:has-text("Bucket") input', '');
	await page.fill('label:has-text("Access key id") input', ACCESS_KEY_ID);
	await page.fill('input[type=password]', SECRET_ACCESS_KEY);
	const hint = await panel(page, 'Bucket');
	check(
		'the form says where it will write before anything is attached',
		/Writes to/.test(hint) && hint.includes(`${stub.url}/${stub.bucket}/${project}/`),
		hint
	);

	step('Attach the bucket, with a credential that stays in this browser');
	await page.click('button:has-text("Attach bucket")');
	await page.waitForSelector('button:has-text("Upload document to bucket")', { timeout: 15_000 });
	await page.waitForTimeout(300);

	const attached = await panel(page, 'Bucket');
	log('   bucket panel:\n' + attached.split('\n').map((line) => `     ${line}`).join('\n'));
	check('the panel names the bucket', attached.includes(stub.bucket), attached);
	check('the panel names the endpoint', attached.includes(stub.url), attached);
	check(
		'the default view keeps the access key id and the object key out of sight',
		!attached.includes(ACCESS_KEY_ID) && !attached.includes(project),
		attached
	);

	step('The edit space is where the access key id and the key live');
	await page.click('button:has-text("Edit bucket")');
	await page.waitForSelector('button:has-text("Save bucket")', { timeout: 15_000 });
	await page.waitForTimeout(200);
	const editing = await panel(page, 'Bucket');
	log('   bucket panel, editing:\n' + editing.split('\n').map((line) => `     ${line}`).join('\n'));
	check('the edit space shows the object key it writes', editing.includes(`${project}/01-rgb-layered.pcraft`), editing);
	const keyId = await page.inputValue('label:has-text("Access key id") input');
	check('the access key id is filled in and editable', keyId === ACCESS_KEY_ID, keyId);
	check(
		'and the endpoint is filled in without the bucket on the end',
		(await page.inputValue('label:has-text("Endpoint") input')) === stub.url,
		await page.inputValue('label:has-text("Endpoint") input')
	);
	const secretHint = await page.getAttribute('input[type=password]', 'placeholder');
	check('and the secret is asked for again, because it is not stored', secretHint?.includes('not stored') === true, String(secretHint));
	await page.click('button:has-text("Cancel")');
	await page.waitForSelector('button:has-text("Upload document to bucket")', { timeout: 15_000 });

	await page.click('button:has-text("Edit bucket")');
	await page.waitForSelector('button:has-text("Save bucket")', { timeout: 15_000 });
	await page.fill('input[type=password]', SECRET_ACCESS_KEY);
	await page.click('button:has-text("Save bucket")');
	await page.waitForSelector('button:has-text("Upload document to bucket")', { timeout: 15_000 });
	await page.waitForTimeout(300);
	const resaved = await panel(page, 'Bucket');
	check(
		'saving from the edit space keeps the attachment and closes the form',
		resaved.includes(stub.bucket) && !/Save bucket/.test(resaved),
		resaved
	);

	const config = await readJson(page, project, 'bucket.json');
	log(`   bucket.json: ${JSON.stringify(config)}`);
	check('the attachment is recorded in the workspace', config?.bucket === stub.bucket, JSON.stringify(config));
	check(
		'the bucket is lifted out of the endpoint rather than left in it',
		config?.endpoint === stub.url,
		`${config?.endpoint} (wanted ${stub.url})`
	);
	check(
		"the Changes panel's upload is live once a bucket is attached",
		!(await page.isDisabled('section.panel.changes button:has-text("Upload to bucket")'))
	);
	const uploadButton = 'section.panel.changes button:has-text("Upload to bucket")';
	check(
		'and highlighted, because the bucket does not have this document yet',
		((await page.getAttribute(uploadButton, 'class')) ?? '').includes('primary'),
		String(await page.getAttribute(uploadButton, 'class'))
	);
	check('the attachment records the prefix it will join', config?.prefix === '', JSON.stringify(config?.prefix));
	check(
		'a non-R2 endpoint gets no Cloudflare link, because there is no page to link to',
		(await page.locator('a:has-text("Open this bucket in Cloudflare")').count()) === 0
	);
	check(
		'the attachment has no secret field to read back',
		!Object.keys(config ?? {}).some((field) => /secret|keypair|password/i.test(field)),
		Object.keys(config ?? {}).join(',')
	);

	step('What is stored to sign with is a key, not the secret');
	const stored_key = await page.evaluate(async (id) => {
		const open = await new Promise((resolve, reject) => {
			const request = indexedDB.open('atelier-cloud-buckets', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('signing-keys');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const value = await new Promise((resolve, reject) => {
			const request = open.transaction('signing-keys', 'readonly').objectStore('signing-keys').get(id);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return {
			isCryptoKey: value instanceof CryptoKey,
			extractable: value?.extractable ?? null,
			algorithm: value?.algorithm?.name ?? null,
			usages: value?.usages ?? null
		};
	}, project);
	log(`   signing key: ${JSON.stringify(stored_key)}`);
	check('the key held in the browser is a CryptoKey, and the secret is nowhere', stored_key.isCryptoKey === true, JSON.stringify(stored_key));
	check('it cannot be exported back out of the browser', stored_key.extractable === false, String(stored_key.extractable));
	check('it is an HMAC signing key and nothing else', stored_key.algorithm === 'HMAC' && JSON.stringify(stored_key.usages) === '["sign"]', JSON.stringify(stored_key.usages));

	const original = await documentBytes(page, project);
	log(`   document: ${original.length} B, ${digest(original)}`);
	check('the document is in OPFS before the upload', original?.length === SAMPLE_BYTES, `${original?.length} B`);

	step('Upload, signed in the browser with the attached credential');
	await page.click('button:has-text("Upload document to bucket")');
	await page.waitForSelector('text=Uploaded', { timeout: 15_000 });
	await page.waitForTimeout(500);
	const uploaded = await panel(page, 'Bucket');
	log('   bucket panel:\n' + uploaded.split('\n').map((line) => `     ${line}`).join('\n'));
	check('the panel says the bucket holds this document', /holds this document/.test(uploaded), uploaded);
	check(
		'and the upload is no longer the highlighted action, since the bucket now has it',
		!((await page.getAttribute(uploadButton, 'class')) ?? '').includes('primary'),
		String(await page.getAttribute(uploadButton, 'class'))
	);

	const put = stub.operations.find((operation) => operation.method === 'PUT');
	check('the browser PUT the object to the endpoint the form was given', Boolean(put), JSON.stringify(stub.operations));
	check('the stub accepted the signature, so the browser signed with the attached credential', put?.verified === true);
	check('the signature named the attached bucket', put?.bucket === BUCKET, String(put?.bucket));
	check('the key is the project and the document', put?.key === `${project}/01-rgb-layered.pcraft`, String(put?.key));
	check('no request failed signature verification', stub.failures.length === 0, stub.failures.join('; '));

	const stored = stub.objects.get(`${project}/01-rgb-layered.pcraft`);
	check('the bucket holds the same bytes as OPFS', Boolean(stored) && digest(stored) === digest(original), `${stored?.length} B`);

	const meta = await readJson(page, project, 'meta.json');
	log(`   meta.json sync: ${JSON.stringify(meta.sync)}`);
	check('meta.json records the upload', meta.sync?.remote?.key === `${project}/01-rgb-layered.pcraft`, JSON.stringify(meta.sync));
	check('the record carries the document hash', meta.sync?.remote?.hash === digest(original), String(meta.sync?.remote?.hash));
	check('the record carries the bucket ETag, so the CORS policy exposed it', typeof meta.sync?.remote?.etag === 'string', String(meta.sync?.remote?.etag));

	step('Edit the document, so the bucket copy is no longer the document');
	await page.evaluate(async (id) => {
		const response = await fetch('/cloud/samples/02-layer-groups.pcraft');
		const other = new Uint8Array(await response.arrayBuffer());
		const space = await (await navigator.storage.getDirectory()).getDirectoryHandle('atelier-cloud');
		const dir = await (await space.getDirectoryHandle('projects')).getDirectoryHandle(id);
		for await (const [name, handle] of dir.entries()) {
			if (handle.kind === 'file' && name.endsWith('.pcraft') && !name.endsWith('.prev')) {
				const stream = await (await dir.getFileHandle(name)).createWritable();
				await stream.write(other);
				await stream.close();
			}
		}
	}, project);
	await page.reload({ waitUntil: 'networkidle' });
	await page.waitForSelector('h2:text-is("Bucket")');
	const edited = await panel(page, 'Bucket');
	check('the attachment survives a reload, without the credential being re-entered', edited.includes(stub.bucket), edited);
	check('the panel knows the bucket copy is stale', /bucket copy is behind/.test(edited), edited);

	const pendingChanges = await panel(page, 'Changes');
	check(
		'and the explanation under the actions does not vanish when there are changes to record',
		/Recording a version marks the current state/.test(pendingChanges),
		pendingChanges
	);
	check('nor does the internals wording come back', !/outbox|manifest and thumbnail/.test(pendingChanges), pendingChanges);
	check(
		'and the diff note is a count, not a narrated sentence',
		!/not copied again|no longer names/.test(pendingChanges) && /objects? (unchanged|unused)/.test(pendingChanges),
		pendingChanges
	);

	await page.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=not committed yet', { timeout: 15_000 });
	const grid = await page.innerText('.shell');
	check(
		'now that something is uncommitted, the main page says so',
		/workspace has changes that are not committed yet/.test(grid),
		grid.slice(0, 200)
	);
	check('and without the "nothing else has them" tail', !/nothing else has them/.test(grid), grid.slice(0, 200));
	await page.goto(`${ORIGIN}/cloud/workspace/${project}`, { waitUntil: 'networkidle' });
	await page.waitForSelector('section.panel.changes');
	check(
		'but a workspace page does not repeat it, since the panel speaks for itself',
		!/not committed yet/.test(await page.innerText('.shell'))
	);

	step('Download from the bucket, back into the workspace');
	page.once('dialog', (dialog) => dialog.accept());
	await page.click('button:has-text("Download from bucket")');
	await page.waitForSelector('text=Restored', { timeout: 15_000 });
	await page.waitForTimeout(500);

	const get = stub.operations.find((operation) => operation.method === 'GET');
	check('the browser GET the object', Boolean(get), JSON.stringify(stub.operations));
	check('the stub accepted the signature of the GET too', get?.verified === true);

	const after = await documentBytes(page, project);
	log(`   document: ${after.length} B, ${digest(after)}`);
	check('the document is byte-for-byte the uploaded one again', digest(after) === digest(original));

	const metaAfter = await readJson(page, project, 'meta.json');
	check('the restore left the workspace uncommitted, not silently committed', metaAfter.dirty === true, JSON.stringify(metaAfter.dirty));
	check('no request failed signature verification all the way through', stub.failures.length === 0, stub.failures.join('; '));

	step('Start a workspace from what the bucket already holds');
	const otherId = '11111111-2222-3333-4444-555555555555';
	const otherBytes = await page.evaluate(async () => {
		const response = await fetch('/cloud/samples/02-layer-groups.pcraft');
		return [...new Uint8Array(await response.arrayBuffer())];
	});
	stub.objects.set(`${otherId}/02-layer-groups.pcraft`, Buffer.from(otherBytes));
	stub.objects.set(`${otherId}/01-rgb-layered.prev.pcraft`, Buffer.from([1, 2, 3]));
	stub.objects.set('readme.txt', Buffer.from('not a document'));
	stub.objects.set('.hidden.pcraft', Buffer.from('a document nobody meant to offer'));
	stub.objects.set('notes.pcraft', Buffer.from('a document at the root'));

	await page.click('button:has-text("Choose from bucket")');
	await page.waitForSelector('table:has-text("02-layer-groups.pcraft")', { timeout: 15_000 });
	await page.waitForTimeout(300);
	const choosing = await panel(page, 'Bucket');
	log('   bucket panel, choosing:\n' + choosing.split('\n').map((line) => `     ${line}`).join('\n'));
	check('the chooser lists the other workspace in the bucket', choosing.includes(otherId), choosing);
	check('it lists a document sitting at the root too', /\(root\)/.test(choosing), choosing);
	check(
		"and marks this workspace's own document",
		new RegExp(`${project}[^\\n]*this workspace`).test(choosing),
		choosing
	);
	check('a previous version is not offered as a document to load', !/prev\.pcraft/.test(choosing), choosing);
	check('a dotfile is not offered either', !/\.hidden\.pcraft/.test(choosing), choosing);
	check(
		'any other format is, since a workspace holds any file — readme.txt is offered',
		/readme\.txt/.test(choosing),
		choosing
	);

	const listing = stub.operations.find((operation) => operation.method === 'GET' && operation.key === '');
	check('the listing is a signed request to the bucket itself', listing?.verified === true, JSON.stringify(stub.operations));

	step('Load that document into this workspace');
	page.once('dialog', (dialog) => dialog.accept());
	await page.click(`tr:has-text("${otherId}") button:has-text("Load")`);
	await page.waitForSelector(`text=Loaded ${otherId}/02-layer-groups.pcraft`, { timeout: 15_000 });
	await page.waitForTimeout(500);
	const loadedBytes = await documentBytes(page, project);
	check(
		'the chosen document is now this workspace\u2019s, byte for byte',
		Boolean(loadedBytes) && digest(loadedBytes) === digest(Buffer.from(otherBytes)),
		`${loadedBytes?.length} B`
	);
	const loadedMeta = await readJson(page, project, 'meta.json');
	check('and it arrives uncommitted, not recorded as a version', loadedMeta.dirty === true, JSON.stringify(loadedMeta.dirty));
	check(
		'the chooser closes once it has done its work',
		(await page.locator('table:has-text("02-layer-groups.pcraft")').count()) === 0
	);

	step('A download that is not there points at the chooser instead of stopping');
	const held = stub.objects.get(`${project}/01-rgb-layered.pcraft`);
	stub.objects.delete(`${project}/01-rgb-layered.pcraft`);
	page.once('dialog', (dialog) => dialog.accept());
	await page.click('button:has-text("Download from bucket")');
	await page.waitForSelector('text=lists what is there', { timeout: 15_000 });
	const missing = await page.innerText('.banner');
	check(
		'the failure says what is missing and what to do about it',
		/404 Not Found/.test(missing) && /lists what is there/.test(missing),
		missing.split('\n').find((line) => line.includes('Nothing at')) ?? missing
	);
	stub.objects.set(`${project}/01-rgb-layered.pcraft`, held);

	step('A token that may not list the bucket is told what it is missing');
	stub.flags.denyList = true;
	await page.click('button:has-text("Choose from bucket")');
	await page.waitForSelector('text=permission to list the bucket', { timeout: 15_000 });
	const refused = await panel(page, 'Bucket');
	check(
		'the refusal names the permission, not just the status',
		/403/.test(refused) && /permission to list the bucket/.test(refused),
		refused.split('\n').find((line) => line.includes('refused the listing')) ?? refused
	);
	stub.flags.denyList = false;
	await page.click('button:has-text("Close")');
	await page.waitForTimeout(200);

	step('Detach, and the credential is no longer held here');
	page.once('dialog', (dialog) => dialog.accept());
	await page.click('button:has-text("Detach bucket")');
	await page.waitForSelector('text=Detached', { timeout: 15_000 });
	await page.waitForTimeout(300);
	const detached = await panel(page, 'Bucket');
	check('the panel is back to offering a bucket', /none attached/.test(detached), detached);
	const gone = await page.evaluate(async (id) => {
		const space = await (await navigator.storage.getDirectory()).getDirectoryHandle('atelier-cloud');
		const dir = await (await space.getDirectoryHandle('projects')).getDirectoryHandle(id);
		for await (const name of dir.keys()) if (name === 'bucket.json') return false;
		return true;
	}, project);
	check('the attachment file is gone with it', gone === true);
	const stillThere = await documentBytes(page, project);
	check('and the document is untouched by detaching', stillThere !== null);

	step('A bucket attached after a workspace was started can still hand its files over');
	await page.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=Workspaces');
	await page.click('button:has-text("New workspace")');
	await page.fill('input[type=text]', 'Attached later');
	await page.click('button:has-text("Create")');
	await page.waitForSelector('article h2:has-text("Attached later")');
	const laterHref = await page.getAttribute('article:has(h2:has-text("Attached later")) a:has-text("Open in PhotoCraft")', 'href');
	const later = new URL(laterHref, ORIGIN).searchParams.get('project');
	await page.goto(`${ORIGIN}/cloud/workspace/${later}`, { waitUntil: 'networkidle' });
	await page.waitForSelector('h2:text-is("Bucket")');
	check(
		'this workspace already has a document of its own, and nothing uploaded',
		(await documentBytes(page, later)) !== null
	);

	await page.fill('label:has-text("Endpoint") input', `${stub.url}/${stub.bucket}`);
	await page.fill('label:has-text("Access key id") input', ACCESS_KEY_ID);
	await page.fill('input[type=password]', SECRET_ACCESS_KEY);
	await page.click('button:has-text("Attach bucket")');
	await page.waitForSelector('button:has-text("Download from bucket")', { timeout: 15_000 });

	await page.click('button:has-text("Download from bucket")');
	await page.waitForSelector('text=holds nothing under', { timeout: 15_000 });
	check(
		'a bucket that holds nothing for this id says so, and where to look instead',
		/holds nothing under/.test(await page.innerText('.banner'))
	);

	const seeded = Buffer.from(otherBytes);
	stub.objects.set(`${later}/02-layer-groups.pcraft`, seeded);

	page.once('dialog', (dialog) => dialog.accept());
	await page.click('button:has-text("Download from bucket")');
	await page.waitForSelector('text=Restored', { timeout: 15_000 });
	await page.waitForTimeout(500);
	const fetchedLater = await documentBytes(page, later);
	check(
		'the document the bucket holds for this workspace is fetched, without its key being known here',
		Boolean(fetchedLater) && digest(fetchedLater) === digest(seeded),
		`${fetchedLater?.length} B, wanted ${seeded.length} B`
	);
	check(
		'and it arrives uncommitted',
		(await readJson(page, later, 'meta.json')).dirty === true
	);
	check('no request failed signature verification through any of this', stub.failures.length === 0, stub.failures.join('; '));

	stub.objects.set(`${later}/99-another.pcraft`, seeded);
	await page.click('button:has-text("Download from bucket")');
	await page.waitForSelector('table:has-text("99-another.pcraft")', { timeout: 15_000 });
	check(
		'with more than one document under this id, the download asks which instead of guessing',
		(await page.locator('table tr:has-text("02-layer-groups.pcraft")').count()) === 1 &&
			(await page.innerText('.banner')).includes('Restored'),
		await page.innerText('.banner')
	);
	await page.click('button:has-text("Close")');
	await page.waitForTimeout(200);

	// Left detached, so the step below starts from the attach form.
	page.once('dialog', (dialog) => dialog.accept());
	await page.click('button:has-text("Detach bucket")');
	await page.waitForSelector('button:has-text("Attach bucket")', { timeout: 15_000 });

	step('An R2 endpoint also links to the bucket in Cloudflare');
	await page.fill(
		'label:has-text("Endpoint") input',
		'https://ACCOUNT_ID.r2.cloudflarestorage.com/your-bucket-name'
	);
	await page.fill('label:has-text("Access key id") input', 'an-access-key-id');
	await page.fill('input[type=password]', 'a-secret');
	await page.click('button:has-text("Attach bucket")');
	await page.waitForSelector('button:has-text("Upload document to bucket")', { timeout: 15_000 });
	await page.waitForTimeout(300);
	const cloudflare = await page.getAttribute('a:has-text("Open this bucket in Cloudflare")', 'href');
	check(
		'the account id and bucket name make the dashboard URL',
		cloudflare ===
			'https://dash.cloudflare.com/ACCOUNT_ID/r2/default/buckets/your-bucket-name',
		String(cloudflare)
	);
	check('and the stub endpoint got no such link', stub.failures.length === 0);

	step('A workspace can be started from a document the bucket already holds');
	stub.objects.set('seeded-workspace/start-here.pcraft', Buffer.from(otherBytes));
	const projectCount = () =>
		page.evaluate(async () => {
			const space = await (await navigator.storage.getDirectory()).getDirectoryHandle('atelier-cloud');
			const projects = await space.getDirectoryHandle('projects');
			let count = 0;
			for await (const _ of projects.keys()) count++;
			return count;
		});
	await page.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=Workspaces');
	const projectsBefore = await projectCount();

	await page.click('button:has-text("New workspace")');
	await page.fill('input[type=text]', 'Started from the bucket');
	await page.check('input[type=radio][value="bucket"]');
	await page.fill('label:has-text("Endpoint") input', `${stub.url}/${stub.bucket}`);
	await page.fill('label:has-text("Access key id") input', ACCESS_KEY_ID);
	await page.fill('input[type=password]', SECRET_ACCESS_KEY);
	await page.click('button:has-text("List documents")');
	await page.waitForSelector('label:has-text("Start from") select option:has-text("start-here.pcraft")', {
		state: 'attached',
		timeout: 15_000
	});
	check(
		'listing the bucket needs no workspace yet, so nothing was written to make the list',
		(await projectCount()) === projectsBefore,
		`${projectsBefore} projects before, ${await projectCount()} after`
	);
	check('and the list is taken from the bucket itself', stub.failures.length === 0, stub.failures.join('; '));

	await page.selectOption('label:has-text("Start from") select', 'seeded-workspace/start-here.pcraft');
	await page.click('button:has-text("Create")');
	await page.waitForSelector('article h2:has-text("Started from the bucket")');
	const startedHref = await page.getAttribute(
		'article:has(h2:has-text("Started from the bucket")) a:has-text("Open in PhotoCraft")',
		'href'
	);
	const started = new URL(startedHref, ORIGIN).searchParams.get('project');
	const startedBytes = await documentBytes(page, started);
	check(
		'the new workspace holds the document the bucket was holding',
		Boolean(startedBytes) && digest(startedBytes) === digest(Buffer.from(otherBytes)),
		`${startedBytes?.length ?? 'no document'} B, wanted ${otherBytes.length} B`
	);
	const startedConfig = await readJson(page, started, 'bucket.json');
	check(
		'and the bucket is attached to it, so its next upload has somewhere to go',
		startedConfig?.bucket === stub.bucket,
		String(startedConfig?.bucket)
	);
	check(
		'with the page saying which document and which bucket',
		/starting from seeded-workspace\/start-here\.pcraft/.test(await page.innerText('.banner.info')) &&
			/attached to/.test(await page.innerText('.banner.info')),
		await page.innerText('.banner.info')
	);

	check('the page never asked the server about a bucket', !requested.includes('/api/storage'), requested.filter((path) => path.startsWith('/api')).join(', '));

	step('The new-workspace dialog fits a narrow screen');
	await page.setViewportSize({ width: 320, height: 640 });
	await page.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=Workspaces');
	await page.click('button:has-text("New workspace")');
	await page.check('input[type=radio][value="bucket"]');
	await page.waitForTimeout(200);
	const narrow = await page.evaluate(() => {
		const dialog = document.querySelector('dialog');
		const style = getComputedStyle(dialog);
		const box = dialog.getBoundingClientRect();
		const inner = { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) };
		const outside = [...dialog.querySelectorAll('*')]
			.filter((el) => el.tagName !== 'OPTION')
			.filter((el) => {
				const r = el.getBoundingClientRect();
				return r.width > 0 && (r.right > inner.right + 0.5 || r.left < inner.left - 0.5);
			})
			.map((el) => el.tagName);
		return {
			left: Math.round(box.left),
			right: Math.round(box.right),
			outside: [...new Set(outside)],
			pageScrollWidth: document.documentElement.scrollWidth
		};
	});
	check(
		'the dialog is inside the viewport, with a gutter rather than flush to the edges',
		narrow.left >= 20 && narrow.right <= 300,
		`${narrow.left}..${narrow.right}`
	);
	check(
		'and nothing inside it is wider than the dialog, so no field is cut off',
		narrow.outside.length === 0,
		narrow.outside.join(', ')
	);
	check('and the page itself does not scroll sideways', narrow.pageScrollWidth === 320, String(narrow.pageScrollWidth));
	await page.click('button:has-text("Cancel")');
	await page.setViewportSize({ width: 1280, height: 900 });

	if (consoleLog.length) log(`\n   page console:\n${consoleLog.map((line) => `     ${line}`).join('\n')}`);
	await browser.close();
	await stub.close();

	log('');
	if (failures) {
		log(`${failures} check(s) failed`);
		process.exit(1);
	}
	log('all checks passed');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
