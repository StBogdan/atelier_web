// The workspace-documents walkthrough: a workspace that already holds two documents, and a third
// opened in the editor from this computer.
//
// It checks what the patch promises once a workspace holds more than one document:
//
//  - `?project=…&document=…` opens that document, not the project's first one;
//  - File › Save writes the document the editor has open, and leaves every other document alone —
//    the bug this exists for: a save that went to the workspace's original document instead;
//  - both doors are in the File menu: Open… (this computer) and Open from Workspace… (the workspace);
//  - the workspace door reads the workspace's own documents and lists them;
//  - a document opened from this computer and saved lands as its own new file, and saving it again
//    writes that file rather than making another.
//
// Before the patch handed each opened document its own `atelier-cloud://` path, a save resolved
// through one page-wide binding, so the document it wrote was the workspace's original one whatever
// the editor had open.
//
//   node documents.mjs        # the patched editor must be served on :8765 (atelier_web/README.md)
//
// `ATELIER_ORIGIN` overrides http://127.0.0.1:8765. It opens its own browser profile, so it creates
// its own OPFS and never touches yours.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ORIGIN = process.env.ATELIER_ORIGIN || 'http://127.0.0.1:8765';
const SAMPLES = new URL('../web/static/samples/', import.meta.url);
const PROJECT = 'documents-walkthrough';
/** The workspace's own document — the one `meta.json` records. Deliberately first in name order, so
 * that a save resolving to "the project's document" would land on it. */
const ORIGINAL = 'aaa-original.pcraft';
/** The document the editor is sent to with `&document=`, deliberately last in name order. */
const OPENED = 'zzz-opened.pcraft';
/** Opened from this computer, and saved into the workspace as a file of its own. */
const LOCAL = '02-layer-groups.pcraft';
const mod = 'Control';

// The File menu is drawn by the editor inside its canvas, so its items are clicked by position: the
// menu bar's File title, then File › Open… and the item the patch puts right after it. The keyboard
// cannot reach File › Open at all, because the browser keeps Ctrl/Cmd+O for itself.
const FILE_MENU = { x: 52, y: 14 };
const MENU_X = 87;
const MENU_OPEN = 97;
/** The item the patch puts right after Open…, one row down. */
const MENU_OPEN_WORKSPACE = 121;

const step = (name) => console.log(`\n== ${name}`);
let failures = 0;
function check(what, ok, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

/** Every file in the seeded project: size, modified time and a fingerprint of the first bytes. */
async function project(page, project = PROJECT) {
	return await page.evaluate(async (id) => {
		const root = await navigator.storage.getDirectory();
		try {
			const dir = await (await (await root.getDirectoryHandle('atelier-cloud')).getDirectoryHandle('projects')).getDirectoryHandle(id);
			const out = {};
			for await (const [name, handle] of dir.entries()) {
				if (handle.kind !== 'file') continue;
				const file = await handle.getFile();
				const head = [...new Uint8Array(await file.slice(0, 32).arrayBuffer())].map((b) => b.toString(16).padStart(2, '0')).join('');
				out[name] = { size: file.size, modified: file.lastModified, head };
			}
			return out;
		} catch {
			return null;
		}
	}, project);
}

const documents = (files) => Object.keys(files ?? {}).filter((name) => name.endsWith('.pcraft') && !name.endsWith('.prev')).sort();

/** Read the editor's own console, which is where the patch says what it opened, listed and saved. */
function watch(page) {
	const lines = [];
	page.on('console', (message) => lines.push(message.text()));
	page.on('pageerror', (error) => lines.push(`error: ${error.message}`));
	return lines;
}

const words = (log) => log.filter((line) => line.includes('atelier-cloud:')).join(' | ');
const unchanged = (before, after, name) => before?.[name]?.size === after?.[name]?.size && before?.[name]?.head === after?.[name]?.head;

/** Seed a workspace holding two documents, the way Atelier web would have made it. */
async function seed(page, original, opened) {
	await page.evaluate(
		async ({ project, original, opened }) => {
			const encode = (text) => new TextEncoder().encode(text);
			const bytes = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
			const write = async (dir, file, data) => {
				const handle = await dir.getFileHandle(file, { create: true });
				const stream = await handle.createWritable();
				await stream.write(data);
				await stream.close();
			};
			const root = await navigator.storage.getDirectory();
			const space = await root.getDirectoryHandle('atelier-cloud', { create: true });
			await write(space, 'provider.json', encode(JSON.stringify({ protocol: 1, name: 'Atelier Cloud' })));
			await space.getDirectoryHandle('tmp', { create: true });
			const dir = await (await space.getDirectoryHandle('projects', { create: true })).getDirectoryHandle(project, { create: true });
			await write(dir, original.name, bytes(original.base64));
			await write(dir, opened.name, bytes(opened.base64));
			await write(
				dir,
				'meta.json',
				encode(
					JSON.stringify({
						protocol: 1,
						id: project,
						name: 'Documents walkthrough',
						role: 'owner',
						document: original.name,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						rev: 1,
						dirty: false,
						size: original.bytes,
						sync: { state: 'local', at: new Date().toISOString() },
						revision: null,
					}),
				),
			);
		},
		{ project: PROJECT, original, opened },
	);
}

/** Pick one item from the editor's File menu. */
async function fileMenu(page, item) {
	await page.mouse.click(FILE_MENU.x, FILE_MENU.y);
	await page.waitForTimeout(900);
	await page.mouse.click(MENU_X, item);
	await page.waitForTimeout(1200);
}

/**
 * Open a file from this computer. The web runner's picker is `rfd`'s own DOM card, whose file input
 * has to be clicked for the browser to raise a chooser — the same two paths `walkthrough.mjs` drives:
 * the browser's own chooser if clicking `Open…` raises one, else the card's input and then its Ok.
 */
async function pickLocal(page, path, click) {
	const native = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
	await click();
	let picked = await native;
	let overlay = false;
	if (!picked) {
		const input = page.locator('#rfd-input');
		await input.waitFor({ state: 'attached', timeout: 6000 }).catch(() => {});
		if (await input.count()) {
			overlay = true;
			const second = page.waitForEvent('filechooser', { timeout: 6000 });
			await input.click();
			picked = await second;
		}
	}
	if (!picked) throw new Error('File › Open… reached no picker');
	await picked.setFiles(path);
	if (overlay) await page.click('button.rfd-button:has-text("Ok")');
}

async function main() {
	const sample = (name) => ({ name, bytes: readFileSync(new URL(name, SAMPLES)) });

	const original = sample('01-rgb-layered.pcraft');
	const opened = sample('03-psb.pcraft');
	const local = sample(LOCAL);

	const browser = await chromium.launch({ channel: 'chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
	const editor = await context.newPage();
	const log = watch(editor);

	step('seed a workspace holding two documents');
	await editor.goto(`${ORIGIN}/photocraft/`, { waitUntil: 'domcontentloaded' });
	await editor.waitForFunction(() => document.getElementById('photocraft_loading') === null, null, { timeout: 120_000 });
	await seed(editor, { name: ORIGINAL, base64: original.bytes.toString('base64'), bytes: original.bytes.length }, { name: OPENED, base64: opened.bytes.toString('base64') });
	const seeded = await project(editor);
	check('the workspace holds both', documents(seeded).join() === [ORIGINAL, OPENED].sort().join(), documents(seeded).join());

	step(`open the second one by name, not the workspace's own (${OPENED})`);
	await editor.goto(`${ORIGIN}/photocraft/?project=${PROJECT}&document=${OPENED}`, { waitUntil: 'domcontentloaded' });
	await editor.waitForFunction(() => document.getElementById('photocraft_loading') === null, null, { timeout: 120_000 });
	await editor.waitForTimeout(2500);
	check('the patch opened the document it was told to', log.some((line) => line.includes(`opening ${OPENED}`)), words(log));

	step('File › Save writes that document, and nothing else');
	await editor.bringToFront();
	await editor.click('#photocraft_canvas', { position: { x: 400, y: 400 } });
	await editor.keyboard.press(`${mod}+s`);
	await editor.waitForTimeout(6000);
	const saved = await project(editor);
	check('the patch saved the open document', log.some((line) => line.includes(`saved ${OPENED}`)), words(log));
	check('a save did not land on the workspace\'s own document', !log.some((line) => line.includes(`saved ${ORIGINAL}`)), words(log));
	check(`${ORIGINAL} is untouched`, unchanged(seeded, saved, ORIGINAL), `${seeded?.[ORIGINAL]?.size} -> ${saved?.[ORIGINAL]?.size} bytes`);
	check(`${OPENED} was written`, saved?.[OPENED]?.size > 0 && !unchanged(seeded, saved, OPENED));
	check('and it kept its name', documents(saved).includes(OPENED), documents(saved).join());

	step('File › Open from Workspace…, the workspace door');
	await fileMenu(editor, MENU_OPEN_WORKSPACE);
	await editor.waitForTimeout(1500);
	check('the workspace door read the workspace and listed both documents', log.some((line) => line.includes('holds 2 document(s)')), words(log));
	await editor.screenshot({ path: '/tmp/workspace-open.png' });

	step('File › Open…, the door to this computer: it lands in the workspace as it opens');
	await pickLocal(editor, new URL(LOCAL, SAMPLES).pathname, () => fileMenu(editor, MENU_OPEN));
	await editor.waitForTimeout(8000);
	// Before any Save: what was opened is in the project, which is the whole point of importing on
	// open. Nothing below presses Save until after this check.
	const imported = await project(editor);
	check('the document is in the workspace without a Save', documents(imported).includes(LOCAL), documents(imported).join());
	check('it is there whole', imported?.[LOCAL]?.size === local.bytes.length, `${imported?.[LOCAL]?.size} vs ${local.bytes.length} bytes`);
	check('the patch said it imported it', log.some((line) => line.includes(`imported ${LOCAL}`)), words(log));

	step('File › Save then writes that same file');
	await editor.keyboard.press(`${mod}+s`);
	await editor.waitForTimeout(6000);
	const afterLocal = await project(editor);
	check('the workspace holds three documents', documents(afterLocal).length === 3, documents(afterLocal).join());
	check(`the saved one is a file of its own (${LOCAL})`, documents(afterLocal).includes(LOCAL), documents(afterLocal).join());
	// Not byte-identical: a save re-encodes the document (the sizes differ by a few hundred bytes,
	// as they do for every save here). Within a percent is the same document, re-encoded.
	const drift = Math.abs((afterLocal?.[LOCAL]?.size ?? 0) - local.bytes.length) / local.bytes.length;
	check('it holds the document that was opened, re-encoded', drift < 0.01, `${afterLocal?.[LOCAL]?.size} vs ${local.bytes.length} bytes (${(drift * 100).toFixed(2)}%)`);
	check('the patch said what it saved', log.some((line) => line.includes(`saved ${LOCAL}`)), words(log));
	check(`${ORIGINAL} is still untouched`, unchanged(seeded, afterLocal, ORIGINAL));
	check(`${OPENED} is still the save before`, unchanged(saved, afterLocal, OPENED));

	step('File › Save again: the same document, not a fourth');
	await editor.keyboard.press(`${mod}+s`);
	await editor.waitForTimeout(5000);
	const again = await project(editor);
	check('still three documents', documents(again).length === 3, documents(again).join());
	check('the same one was rewritten', (again?.[LOCAL]?.modified ?? 0) >= (afterLocal?.[LOCAL]?.modified ?? 0));
	check('and the first two are still untouched', unchanged(seeded, again, ORIGINAL) && unchanged(saved, again, OPENED));

	step('clean up the seeded workspace');
	await editor.goto(`${ORIGIN}/photocraft/`, { waitUntil: 'domcontentloaded' });
	await editor.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		await root.removeEntry('atelier-cloud', { recursive: true }).catch(() => {});
	});

	await browser.close();
	console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
