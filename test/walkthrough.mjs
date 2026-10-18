// The handoff walkthrough, end to end, in a real Chromium with a real OPFS: create a workspace in
// Atelier Cloud, launch the editor into it, edit, save, and watch the change appear in the Changes
// panel, then commit it, download it, discard it and reopen it.
//
//   npm install playwright-core      # once, in this directory
//   node walkthrough.mjs
//
// It drives the whole flow through the apps' own UI, so both apps must be running on one origin:
// `atelier_web/README.md` has the commands, including how to serve the patched editor at :8765 and
// point Atelier web at it. It needs Chrome installed and no other browser download.
//
// `ATELIER_ORIGIN` overrides http://127.0.0.1:3000. It opens its own browser profile, so it creates
// its own OPFS and never touches yours.

import { readFile } from 'node:fs/promises';
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

/** The entry names in a zip, read from its central directory: enough to say what a download holds. */
async function zipNames(download) {
	const bytes = await readFile(await download.path());
	const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	const count = bytes.readUInt16LE(end + 10);
	let at = bytes.readUInt32LE(end + 16);
	const names = [];
	for (let i = 0; i < count; i++) {
		const length = bytes.readUInt16LE(at + 28);
		names.push(bytes.subarray(at + 46, at + 46 + length).toString('utf8'));
		at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
	}
	return names;
}

async function main() {
	const browser = await chromium.launch({ channel: 'chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
	const provider = await context.newPage();
	const downloads = [];
	context.on('download', (download) => downloads.push(download));
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

	const openHref = await provider.getAttribute('article a:has-text("Open in PhotoCraft")', 'href');
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

	step('Atelier Cloud: nothing one save back to download yet');
	await provider.goto(`${ORIGIN}/cloud/workspace/${project}`, { waitUntil: 'networkidle' });
	await provider.waitForSelector('h2:has-text("Changes")');
	check(
		'"Download committed" is greyed out until the editor has kept a save back',
		await provider.isDisabled('section.panel.changes button:has-text("Download committed")')
	);
	check(
		'and "Download files" is still offered',
		!(await provider.isDisabled('section.panel.changes button:has-text("Download files")'))
	);

	step('Editor: launch into the project and open the document from OPFS');
	const editor = await context.newPage();
	const editorLog = [];
	editor.on('console', (message) => editorLog.push(message.text()));
	editor.on('pageerror', (error) => editorLog.push(`error: ${error.message}`));
	await editor.goto(`${ORIGIN}/photocraft/?project=${project}&cpu`, { waitUntil: 'domcontentloaded' });
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
	const panel = await provider.innerText('section.panel.changes');
	log('   panel:\n' + panel.split('\n').map((line) => `     ${line}`).join('\n'));
	check('the panel reports uncommitted changes since rev 1', /uncommitted since rev 1/.test(panel));
	check('the panel names the document', panel.includes('01-rgb-layered.pcraft'));
	check('the panel counts objects', /[0-9]+ (new|changed) object/.test(panel));
	const withPending = await opfs(provider);
	check('outbox/<id>/pending.json was written', find(withPending, `outbox/${project}/pending.json`)?.size > 0);

	step('Atelier Cloud: record the version');
	await provider.click('button:has-text("Record version")');
	await provider.waitForTimeout(1500);
	const committed = await provider.innerText('section.panel.changes');
	log('   panel:\n' + committed.split('\n').map((line) => `     ${line}`).join('\n'));
	check('the panel is clean after committing', /Version up to date/.test(committed));
	const cleanHeading = (await provider.innerText('section.panel.changes h2')).trim();
	check(
		'and it keeps the same heading prefix, so the layout does not jump',
		cleanHeading === 'Changes — Version up to date',
		cleanHeading
	);
	check('and the explanation stays under the actions', /Recording a version marks the current state/.test(committed), committed);
	check(
		'and the record button is still there, greyed as "Up to date"',
		await provider.isDisabled('button:has-text("Up to date")')
	);
	const committedTree = await opfs(provider);
	check('outbox/<id>/pending.json is gone', find(committedTree, `outbox/${project}/pending.json`) === undefined);
	const revision = find(committedTree, `projects/${project}/meta.json`);
	check('meta.json was rewritten for the revision', revision?.size > 0);

	await provider.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await provider.waitForSelector('article');
	const card = await provider.innerText('article');
	// The owner and the revision are not on the card: on a page listing one person's workspaces, "owner:
	// you · rev 2" answers nothing. They live on the workspace page — the panel checked below reports
	// against rev 2 — and in meta.json, which was just rewritten.
	check('the card shows the committed state', /committed/.test(card));
	check(
		'and the card leaves the owner and the revision to the workspace page',
		!/owner:|rev \d/.test(card),
		card.replace(/\n/g, ' · ')
	);

	step('Atelier Cloud: download every file in the workspace (the exit ramp)');
	await provider.goto(`${ORIGIN}/cloud/workspace/${project}`, { waitUntil: 'networkidle' });
	await provider.waitForSelector('h2:has-text("Changes")');
	await provider.click('button:has-text("Download files")');
	await provider.waitForTimeout(2500);
	const named = () => downloads.map((download) => download.suggestedFilename()).join(', ') || 'none';
	const archive = downloads.find((download) => download.suggestedFilename().endsWith('.zip'));
	check('the download is one zip, named after the workspace', archive?.suggestedFilename() === 'Walkthrough workspace.zip', named());
	const zipped = archive ? await zipNames(archive) : [];
	check('and the zip holds the workspace\'s document', zipped.includes('01-rgb-layered.pcraft'), zipped.join(', ') || 'none');

	await provider.click('button:has-text("Download committed")');
	await provider.waitForTimeout(1500);
	check(
		'"Download committed" hands back the copy the editor kept',
		downloads.some((download) => download.suggestedFilename() === '01-rgb-layered.prev.pcraft'),
		named()
	);

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
	const dirty = await provider.innerText('section.panel.changes');
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
		/discarded: the document is revision 2 again/i.test(told) ? /Version up to date/.test(told) : /uncommitted since rev 2/.test(told)
	);

	step('The patch speaks the contract: reopen and check the saved bytes load');
	const again = await context.newPage();
	const againLog = [];
	again.on('console', (message) => againLog.push(message.text()));
	await again.goto(`${ORIGIN}/photocraft/?project=${project}&cpu`, { waitUntil: 'domcontentloaded' });
	await again.waitForFunction(() => document.getElementById('photocraft_loading') === null, null, { timeout: 120_000 });
	await again.waitForTimeout(1500);
	const reopened = againLog.find((line) => line.includes('atelier-cloud: opening'));
	check('the committed document reopens', Boolean(reopened), reopened ?? againLog.slice(-5).join(' | '));

	step("Empty workspaces: both Open buttons reach the editor's own picker");

	// Measured on the home screen at this test's viewport (1280x860): the card is centred in the
	// canvas, the File label sits at the top left, and Open… is the second item of its menu.
	const SPLASH_OPEN = { x: 601, y: 406 };
	const FILE_MENU = { x: 52, y: 14 };
	const FILE_MENU_OPEN = { x: 87, y: 97 };
	const LOCAL_FILE = new URL('../web/static/samples/01-rgb-layered.pcraft', import.meta.url).pathname;

	/** A fresh empty workspace, and the project id its Editor link carries. */
	async function newEmptyWorkspace(name) {
		await provider.bringToFront();
		await provider.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
		await provider.click('button:has-text("New workspace")');
		await provider.fill('input[type=text]', name);
		await provider.click('label:has-text("An empty workspace")');
		await provider.click('button:has-text("Create")');
		await provider.waitForSelector(`article h2:has-text("${name}")`);
		const href = await provider.getAttribute(`article:has-text("${name}") a:has-text("Open in PhotoCraft")`, 'href');
		return new URL(href, ORIGIN).searchParams.get('project');
	}

	const freshLogs = [];

	/** The editor on that project, plus everything it logged. */
	async function editorOn(project) {
		const page = await context.newPage();
		const lines = [];
		freshLogs.push(lines);
		page.on('console', (message) => lines.push(message.text()));
		page.on('pageerror', (error) => lines.push(`error: ${error.message}`));
		await page.goto(`${ORIGIN}/photocraft/?project=${project}&cpu`, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => document.getElementById('photocraft_loading') === null, null, { timeout: 120_000 });
		await page.waitForTimeout(1500);
		return { page, lines };
	}

	/**
	 * Click something that should open a dialog, then hand the file to whichever picker appears: rfd
	 * opens the native one while the page still has transient activation, and falls back to its own
	 * overlay when it does not.
	 */
	async function importFile(page, click) {
		const native = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
		await click();
		let picked = await native;
		let overlay = false;
		if (!picked) {
			const input = page.locator('#rfd-input');
			await input.waitFor({ state: 'attached', timeout: 4000 }).catch(() => {});
			if (await input.count()) {
				overlay = true;
				const second = page.waitForEvent('filechooser', { timeout: 4000 });
				await input.click();
				picked = await second;
			}
		}
		if (picked) {
			await picked.setFiles(LOCAL_FILE);
			if (overlay) await page.click('button.rfd-button:has-text("Ok")');
			await page.waitForTimeout(2500);
		}
		return Boolean(picked);
	}

	const homeProject = await newEmptyWorkspace('Empty workspace');
	const homeTree = await opfs(provider);
	check('the empty workspace holds a catalog entry and no document', find(homeTree, `projects/${homeProject}/meta.json`)?.size > 0 && find(homeTree, `projects/${homeProject}/01-rgb-layered.pcraft`) === undefined);

	const home = await editorOn(homeProject);
	check('the patch reports a project with nothing to open', home.lines.some((line) => line.includes('no document to open')), home.lines.slice(-2).join(' | '));
	await home.page.bringToFront();
	const fromHome = await importFile(home.page, () => home.page.mouse.click(SPLASH_OPEN.x, SPLASH_OPEN.y));
	check('the Home screen Open… reaches a picker', fromHome);

	await home.page.keyboard.press(`${mod}+s`);
	await home.page.waitForTimeout(3000);
	const homeSave = home.lines.find((line) => line.includes('atelier-cloud: saved'));
	check('a document imported into an empty workspace saves into it', Boolean(homeSave), homeSave ?? home.lines.slice(-4).join(' | '));
	const filled = await opfs(home.page);
	const importedSize = find(filled, `projects/${homeProject}/01-rgb-layered.pcraft`)?.size ?? 0;
	check('the imported document is the project document now', Math.abs(importedSize - 179714) / 179714 < 0.01, `${importedSize} B (the sample is 179714; a save re-encodes it)`);

	// File ▸ Open is the local door, so it reaches the picker even when the project holds a document:
	// that is the only way a file from this computer gets in (design, Selection). Opening from the
	// workspace is the other File item.
	let picked = false;
	home.page.on('filechooser', () => {
		picked = true;
	});
	await home.page.mouse.click(FILE_MENU.x, FILE_MENU.y);
	await home.page.waitForTimeout(400);
	await home.page.mouse.click(FILE_MENU_OPEN.x, FILE_MENU_OPEN.y);
	await home.page.waitForTimeout(2500);
	const overlayAgain = await home.page.locator('#rfd-input').count();
	check('File ‣ Open opens the picker, not the project document', picked || overlayAgain > 0);
	if (overlayAgain > 0) await home.page.click('button.rfd-button:has-text("Cancel")').catch(() => {});
	else await home.page.keyboard.press('Escape').catch(() => {});

	const menuProject = await newEmptyWorkspace('Empty workspace (menu)');
	const menu = await editorOn(menuProject);

	step('Empty workspaces: the File menu Open… reaches the picker too');
	await menu.page.goto(`${ORIGIN}/photocraft/?project=${menuProject}&cpu`, { waitUntil: 'domcontentloaded' });
	await menu.page.waitForFunction(() => document.getElementById('photocraft_loading') === null, null, { timeout: 120_000 });
	await menu.page.waitForTimeout(1500);
	await menu.page.bringToFront();
	const fromMenu = await importFile(menu.page, async () => {
		await menu.page.mouse.click(FILE_MENU.x, FILE_MENU.y);
		await menu.page.waitForTimeout(400);
		await menu.page.mouse.click(FILE_MENU_OPEN.x, FILE_MENU_OPEN.y);
	});
	check('the File menu Open… reaches a picker', fromMenu);
	await menu.page.keyboard.press(`${mod}+s`);
	await menu.page.waitForTimeout(3000);
	const menuSave = menu.lines.find((line) => line.includes('atelier-cloud: saved'));
	check('its save lands in its workspace too', Boolean(menuSave), menuSave ?? menu.lines.slice(-4).join(' | '));
	const menuTree = await opfs(menu.page);
	const menuImported = find(menuTree, `projects/${menuProject}/01-rgb-layered.pcraft`)?.size ?? 0;
	check('that workspace holds the imported document', Math.abs(menuImported - 179714) / 179714 < 0.01, `${menuImported} B`);

	step("Back to Atelier Cloud, in the editor's title bar");
	// After the title bar's other controls, at this viewport: measured from that row, and the click
	// is what proves the coordinates, since the destination is checked straight after.
	const BACK = { x: 1000, y: 14 };
	await menu.page.bringToFront();
	await menu.page.mouse.click(BACK.x, BACK.y);
	await menu.page.waitForSelector('h2:has-text("Changes")', { timeout: 20_000 });
	check('clicking it lands on the workspace page', menu.page.url().includes(`/cloud/workspace/${menuProject}`), menu.page.url());
	const navEditor = await menu.page.getAttribute('nav a:has-text("Open in PhotoCraft")', 'href');
	check("the nav's Open in PhotoCraft link opens the workspace that changed last", navEditor === `/photocraft/?project=${menuProject}`, navEditor ?? 'none');

	// Nothing is injected on the way through: the link is the editor's own, and the page the front
	// door serves is the byte-for-byte one the editor server has.
	const upstream = process.env.PHOTOCRAFT_UPSTREAM || 'http://127.0.0.1:8765';
	const [proxied, direct] = await Promise.all([
		fetch(`${ORIGIN}/photocraft/`).then((response) => response.text()),
		fetch(upstream).then((response) => response.text()).catch(() => null)
	]);
	if (direct === null) log(`    (the editor's own port is not up: ${upstream})`);
	else check('the editor page comes through Atelier web unchanged', proxied === direct);

	step('Errors');
	const errors = [...console_, ...editorLog, ...againLog, ...freshLogs.flat()].filter((line) => /error|panic/i.test(line) && !/Unhandled egui viewport/.test(line));
	check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

	log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
	await browser.close();
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
