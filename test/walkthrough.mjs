// The handoff walkthrough, end to end, in a real Chromium with a real OPFS: create a workspace in
// Atelier Cloud, launch the editor into it, edit, save, and watch the change appear in the Changes
// panel, then commit it, download it, discard it and reopen it.
//
//   npm install playwright-core      # once, in this directory
//   node walkthrough.mjs
//
// It drives the whole flow through the apps' own UI, so both apps must be running on one origin:
// `atelier_web/README.md` has the commands, including how to serve the patched editor at :8765 and
// point the front door at it. It needs Chrome installed and no other browser download.
//
// `ATELIER_ORIGIN` overrides http://127.0.0.1:3000. It opens its own browser profile, so it creates
// its own OPFS and never touches yours.

import { chromium } from 'playwright-core';

const ORIGIN = process.env.ATELIER_ORIGIN || 'http://127.0.0.1:3000';
const log = (...parts) => console.log(...parts);
const step = (name) => log(`\n== ${name}`);

let failures = 0;
function check(what, ok, detail = '') {
	log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

async function opfs(page) {
	return await page.evaluate(async () => {
		const walk = async (dir, prefix) => {
			const out = [];
			for await (const [name, handle] of dir.entries()) {
				const path = `${prefix}${name}`;
				if (handle.kind === 'directory') {
					out.push({ path: `${path}/`, kind: 'directory' });
					out.push(...(await walk(handle, `${path}/`)));
				} else {
					const file = await handle.getFile();
					out.push({ path, kind: 'file', size: file.size, modified: file.lastModified });
				}
			}
			return out;
		};
		const root = await navigator.storage.getDirectory();
		try {
			const space = await root.getDirectoryHandle('atelier-cloud');
			return await walk(space, '');
		} catch {
			return null;
		}
	});
}

const find = (entries, path) => entries?.find((entry) => entry.path === path);

/** Everything under `atelier-cloud/tmp/`: the write staging the patch cleans up after itself. */
const staging = (entries) => (entries ?? []).filter((entry) => entry.path.startsWith('tmp/') && entry.kind === 'file').map((entry) => entry.path);

async function main() {
	const browser = await chromium.launch({ channel: 'chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
	const provider = await context.newPage();
	const downloads = [];
	context.on('download', (download) => downloads.push(download.suggestedFilename()));
	const console_ = [];
	provider.on('console', (message) => console_.push(`[provider] ${message.text()}`));
	provider.on('pageerror', (error) => console_.push(`[provider:error] ${error.message}`));

	step('Atelier Cloud: create a workspace from a bundled document');
	await provider.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await provider.waitForSelector('text=Workspaces');
	await provider.click('button:has-text("New workspace")');
	await provider.fill('input[type=text]', 'Walkthrough workspace');
	await provider.click('button:has-text("Create")');
	await provider.waitForSelector('article h2:has-text("Walkthrough workspace")');

	const openHref = await provider.getAttribute('article a:has-text("Open")', 'href');
	const project = new URL(openHref, ORIGIN).searchParams.get('project');
	check('a workspace exists with a uuid project id', Boolean(project), project ?? 'none');

	const before = await opfs(provider);
	log('   cloudspace:\n' + (before ?? []).map((entry) => `     ${entry.path}${entry.kind === 'file' ? ` ${entry.size} B` : ''}`).join('\n'));
	const document = find(before, `projects/${project}/01-rgb-layered.pcraft`);
	check('projects/<id>/<name>.pcraft is committed', document?.size === 179714, `${document?.size} B`);
	check('projects/<id>/thumb.png was extracted', find(before, `projects/${project}/thumb.png`)?.size > 0);
	check('projects/<id>/meta.json', find(before, `projects/${project}/meta.json`)?.size > 0);
	check('provider.json', find(before, 'provider.json')?.size > 0);
	check('index/workspaces.json', find(before, 'index/workspaces.json')?.size > 0);
	check('nothing in tmp/', staging(before).length === 0, staging(before).join(', '));

	step('Editor: launch into the project and open the document from OPFS');
	const editor = await context.newPage();
	const editorLog = [];
	editor.on('console', (message) => editorLog.push(message.text()));
	editor.on('pageerror', (error) => editorLog.push(`error: ${error.message}`));
	await editor.goto(`${ORIGIN}/?project=${project}&cpu`, { waitUntil: 'domcontentloaded' });
	await editor.waitForFunction(() => document.getElementById('photocraft_loading') === null, null, { timeout: 120_000 });
	await editor.waitForTimeout(1500);

	const opened = editorLog.find((line) => line.includes('atelier-cloud: opening'));
	check('the patch opened the project document', Boolean(opened), opened ?? editorLog.slice(-5).join(' | '));

	step('Edit');
	// Ctrl, not Meta: the shortcut table says "Cmd maps to ⌘ on macOS and Ctrl elsewhere", and
	// headless Chrome reports a platform the app reads as not-macOS. Both are sent, harmlessly.
	const mod = 'Control';
	await editor.bringToFront();
	await editor.click('#photocraft_canvas', { position: { x: 400, y: 400 } });
	await editor.keyboard.press(`${mod}+0`); // View › Fit on Screen
	await editor.waitForTimeout(600);
	await editor.mouse.move(400, 380);
	await editor.mouse.down();
	for (let i = 1; i <= 20; i++) await editor.mouse.move(400 + i * 14, 380 + i * 9);
	await editor.mouse.up();
	await editor.waitForTimeout(800);

	step('Save (File › Save)');
	await editor.keyboard.press(`${mod}+s`);
	await editor.waitForTimeout(3000);
	const saved = editorLog.find((line) => line.includes('atelier-cloud: saved'));
	check('the patch wrote the document back into OPFS', Boolean(saved), saved ?? editorLog.slice(-5).join(' | '));

	const after = await opfs(editor);
	const documentAfter = find(after, `projects/${project}/01-rgb-layered.pcraft`);
	const previous = find(after, `projects/${project}/01-rgb-layered.pcraft.prev`);
	check('.prev holds the previous revision', previous?.size === 179714, `${previous?.size} B`);
	check('the document changed', documentAfter?.size !== 179714, `${documentAfter?.size} B`);
	check('the document was modified', documentAfter?.modified !== document?.modified);
	check('tmp/ is empty again', staging(after).length === 0, staging(after).join(', '));

	step('Atelier Cloud: the change is recorded in the Changes panel');
	await provider.bringToFront();
	await provider.goto(`${ORIGIN}/cloud/workspace/${project}`, { waitUntil: 'networkidle' });
	await provider.waitForSelector('h2:has-text("Changes")');
	const panel = await provider.innerText('section.panel');
	log('   panel:\n' + panel.split('\n').map((line) => `     ${line}`).join('\n'));
	check('the panel reports uncommitted changes since rev 1', /uncommitted since rev 1/.test(panel));
	check('the panel names the document', panel.includes('01-rgb-layered.pcraft'));
	check('the panel counts objects', /[0-9]+ (new|changed) object/.test(panel));
	const withPending = await opfs(provider);
	check('outbox/<id>/pending.json was written', find(withPending, `outbox/${project}/pending.json`)?.size > 0);

	step('Atelier Cloud: commit the revision');
	await provider.click('button:has-text("Commit revision")');
	await provider.waitForTimeout(1500);
	const committed = await provider.innerText('section.panel');
	log('   panel:\n' + committed.split('\n').map((line) => `     ${line}`).join('\n'));
	check('the panel is clean after committing', /Nothing uncommitted/.test(committed));
	const committedTree = await opfs(provider);
	check('outbox/<id>/pending.json is gone', find(committedTree, `outbox/${project}/pending.json`) === undefined);
	const revision = find(committedTree, `projects/${project}/meta.json`);
	check('meta.json was rewritten for the revision', revision?.size > 0);

	await provider.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await provider.waitForSelector('article');
	const card = await provider.innerText('article');
	check('the card shows rev 2', /rev 2/.test(card), card.replace(/\n/g, ' · '));
	check('the card shows committed state', /committed/.test(card));

	step('Atelier Cloud: download the committed document (the exit ramp)');
	await provider.goto(`${ORIGIN}/cloud/workspace/${project}`, { waitUntil: 'networkidle' });
	await provider.waitForSelector('h2:has-text("Changes")');
	await provider.click('button:has-text("Download document")');
	await provider.waitForTimeout(2500);
	check('the download is the document', downloads.includes('01-rgb-layered.pcraft'), downloads.join(', ') || 'none');

	step('Atelier Cloud: discard puts the committed bytes back');
	const committedBytes = (await opfs(provider)).find((entry) => entry.path === `projects/${project}/01-rgb-layered.pcraft`);
	await provider.evaluate(async () => {
		// Edit the document behind the editor's back, the way a save from a second tab would: the
		// provider must notice from the file alone, with nothing telling it.
		const root = await navigator.storage.getDirectory();
		const space = await root.getDirectoryHandle('atelier-cloud');
		const projects = await space.getDirectoryHandle('projects');
		const dir = await projects.getDirectoryHandle(location.pathname.split('/').pop());
		const document_ = (await dir.getFileHandle('01-rgb-layered.pcraft')).getFile();
		const handle = await dir.getFileHandle('01-rgb-layered.pcraft', { create: true });
		const stream = await handle.createWritable();
		const bytes = new Uint8Array(await (await document_).arrayBuffer());
		bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
		await stream.write(bytes);
		await stream.close();
	});
	await provider.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await provider.waitForTimeout(300);
	await provider.reload({ waitUntil: 'networkidle' });
	await provider.waitForSelector('h2:has-text("Changes")');
	const dirty = await provider.innerText('section.panel');
	check('a change made outside the browser UI is noticed', /uncommitted since rev 2/.test(dirty));

	const previousBytes = (await opfs(provider)).find((entry) => entry.path === `projects/${project}/01-rgb-layered.pcraft.prev`);
	provider.on('dialog', (dialog) => dialog.accept());
	await provider.click('button:has-text("Discard local changes")');
	await provider.waitForTimeout(1500);
	const restored = (await opfs(provider)).find((entry) => entry.path === `projects/${project}/01-rgb-layered.pcraft`);
	check('discard puts the previous bytes back', restored?.size === previousBytes?.size, `${restored?.size} B vs .prev ${previousBytes?.size} B`);
	const told = await provider.innerText('body');
	check(
		'discard says what came back',
		/discarded: the document is revision 2 again/i.test(told) || /they are not revision 2/i.test(told),
		told.split('\n').find((line) => /Put back the previous bytes|Discarded/.test(line)) ?? 'nothing'
	);
	check(
		'the panel agrees with what was restored',
		/discarded: the document is revision 2 again/i.test(told) ? /Nothing uncommitted/.test(told) : /uncommitted since rev 2/.test(told)
	);

	step('The patch speaks the contract: reopen and check the saved bytes load');
	const again = await context.newPage();
	const againLog = [];
	again.on('console', (message) => againLog.push(message.text()));
	await again.goto(`${ORIGIN}/?project=${project}&cpu`, { waitUntil: 'domcontentloaded' });
	await again.waitForFunction(() => document.getElementById('photocraft_loading') === null, null, { timeout: 120_000 });
	await again.waitForTimeout(1500);
	const reopened = againLog.find((line) => line.includes('atelier-cloud: opening'));
	check('the committed document reopens', Boolean(reopened), reopened ?? againLog.slice(-5).join(' | '));

	step('Errors');
	const errors = [...console_, ...editorLog, ...againLog].filter((line) => /error|panic/i.test(line) && !/Unhandled egui viewport/.test(line));
	check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

	log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
	await browser.close();
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
