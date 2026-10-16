// The workspace page's documents, end to end: Atelier web and the patched editor on one origin.
//
// What the editor-only harness (`documents.mjs`) cannot reach, because it needs the cloud app too:
//
//  - the Documents panel lists every document in a workspace, and says which one a revision describes;
//  - "Open in editor" on a row links to *that* document (`&document=`), not to the workspace's first;
//  - the editor opens it and saves back to it, leaving the workspace's other documents untouched;
//  - "Delete" removes a document and its one-save-back copy from OPFS, and nothing else.
//
//   ATELIER_WORKSPACE_ORIGIN=http://127.0.0.1:3100 node workspace.mjs
//
// It needs the full stack: Atelier web serving the built app and proxying the patched editor, both on
// one origin so they share one OPFS (`atelier_web/README.md`). It opens its own browser profile, so it
// creates its own OPFS and never touches yours.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ORIGIN = process.env.ATELIER_WORKSPACE_ORIGIN || 'http://127.0.0.1:3100';
const SAMPLES = new URL('../web/static/samples/', import.meta.url);
const NAME = 'Documents walkthrough';
let failures = 0;
const step = (s) => console.log(`\n== ${s}`);
function check(what, ok, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

const files = (page, project) => page.evaluate(async (id) => {
	const root = await navigator.storage.getDirectory();
	try {
		const dir = await (await (await root.getDirectoryHandle('atelier-cloud')).getDirectoryHandle('projects')).getDirectoryHandle(id);
		const out = {};
		for await (const [n, h] of dir.entries()) if (h.kind === 'file') out[n] = (await h.getFile()).size;
		return out;
	} catch { return null; }
}, project);

const documents = (f) => Object.keys(f ?? {}).filter((n) => n.endsWith('.pcraft') && !n.endsWith('.prev')).sort();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const cloud = await context.newPage();
const editorLog = [];

step('create a workspace from a bundled document (Atelier web)');
await cloud.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
await cloud.click('button:has-text("New workspace")');
await cloud.fill('input[type=text]', NAME);
await cloud.click('button:has-text("Create")');
await cloud.waitForSelector(`article h2:has-text("${NAME}")`);
const editorHref = await cloud.getAttribute(`article:has-text("${NAME}") a:has-text("Editor")`, 'href');
const project = new URL(editorHref, ORIGIN).searchParams.get('project');
// The card's name is the way into the workspace, so reach the page the way a reader would: click it.
const nameHref = await cloud.getAttribute(`article h2 a:has-text("${NAME}")`, 'href');
check('the workspace name links to its details page', new URL(nameHref, ORIGIN).pathname.endsWith(`/workspace/${project}`), String(nameHref));
await cloud.click(`article h2 a:has-text("${NAME}")`);
await cloud.waitForURL(/\/workspace\//, { timeout: 10_000 });
check('and clicking it lands there', /\/workspace\//.test(cloud.url()), cloud.url());
check('a workspace with one document exists', documents(await files(cloud, project)).length === 1, documents(await files(cloud, project)).join());

step('add a second document by hand, so the workspace holds two');
await cloud.evaluate(async (b64) => {
	const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	const root = await navigator.storage.getDirectory();
	const dir = await (await (await root.getDirectoryHandle('atelier-cloud')).getDirectoryHandle('projects')).getDirectoryHandle(location.pathname.split('/').pop());
	const h = await dir.getFileHandle('zz-second.pcraft', { create: true });
	const w = await h.createWritable();
	await w.write(bytes);
	await w.close();
}, readFileSync(new URL('03-psb.pcraft', SAMPLES)).toString('base64'));
await cloud.reload({ waitUntil: 'networkidle' });
await cloud.waitForSelector('.documents tbody tr', { timeout: 15_000 });
const listed = await cloud.$$eval('.documents tbody tr td.mono:first-child', (cells) => cells.map((c) => c.textContent.trim()));
check('the Documents panel lists both', listed.length === 2, listed.join());
check('one is marked as recorded, the other is not', (await cloud.textContent('.documents')).includes('not in a revision'));

step('"Open in editor" carries the document it names');
const first = listed[0];
const href = await cloud.getAttribute('.documents tbody tr:first-child a:has-text("Open")', 'href');
check('the row links to that document', href.includes(`document=${encodeURIComponent(first)}`), href);

step('the editor opens it and saves back to it (not to the other)');
const editor = await context.newPage();
editor.on('console', (m) => editorLog.push(m.text()));
await editor.goto(new URL(href, ORIGIN).href, { waitUntil: 'domcontentloaded' });
await editor.waitForFunction(() => document.getElementById('photocraft_loading') === null, null, { timeout: 120_000 });
await editor.waitForTimeout(2500);
const before = await files(cloud, project);
check('the patch opened the document the page named', editorLog.some((l) => l.includes(`opening ${first}`)), editorLog.filter((l) => l.includes('atelier-cloud')).join(' | '));
await editor.bringToFront();
await editor.click('#photocraft_canvas', { position: { x: 400, y: 400 } });
await editor.keyboard.press('Control+s');
await editor.waitForTimeout(6000);
const after = await files(cloud, project);
const untouched = Object.keys(before).filter((n) => n !== first && !n.endsWith('.prev'));
check('a save did not land on the other document', untouched.every((n) => after[n] === before[n]), JSON.stringify(after));
check('and it did land on the one that was open', after[first] !== before[first], `${before[first]} -> ${after[first]}`);

step('Rename a document from the Atelier web UI');
await cloud.reload({ waitUntil: 'networkidle' });
// Selected by the row's own `data-document`, not by its text: while a row is being renamed the
// name lives in an input's value, which `:has-text` cannot see.
const renameRow = '.documents tbody tr[data-document="zz-second.pcraft"]';
const sizeBefore = (await files(cloud, project))['zz-second.pcraft'];
await cloud.click(`${renameRow} button:has-text("Rename")`);
const nameField = `${renameRow} form input`;
await cloud.fill(nameField, 'renamed.pcraft');
await cloud.click(`${renameRow} form button:has-text("Rename")`);
await cloud.waitForTimeout(2500);
const renamed = await files(cloud, project);
check('the new name is in OPFS', Object.keys(renamed).includes('renamed.pcraft'), Object.keys(renamed).join());
check('the old name is gone', !Object.keys(renamed).includes('zz-second.pcraft'));
check('and the document came across whole', renamed['renamed.pcraft'] === sizeBefore, `${sizeBefore} -> ${renamed['renamed.pcraft']}`);
await cloud.reload({ waitUntil: 'networkidle' });
await cloud.waitForSelector('.documents tbody tr', { timeout: 15_000 });
const renamedRows = await cloud.$$eval('.documents tbody tr td.mono:first-child', (cells) => cells.map((c) => c.textContent.trim()));
check('the panel shows the new name', renamedRows.includes('renamed.pcraft'), renamedRows.join());

step('Rename the document the revision describes, with its one-save-back copy');
const recordedRow = `.documents tbody tr[data-document="${first}"]`;
await cloud.click(`${recordedRow} button:has-text("Rename")`);
await cloud.fill(`${recordedRow} form input`, 'first-renamed.pcraft');
await cloud.click(`${recordedRow} form button:has-text("Rename")`);
await cloud.waitForTimeout(2500);
const afterRecorded = await files(cloud, project);
check('the recorded document was renamed', Object.keys(afterRecorded).includes('first-renamed.pcraft'), Object.keys(afterRecorded).join());
check('its one-save-back copy came with it', Object.keys(afterRecorded).includes('first-renamed.pcraft.prev'), Object.keys(afterRecorded).join());
check('and the old name went', !Object.keys(afterRecorded).includes(first) && !Object.keys(afterRecorded).includes(`${first}.prev`));
await cloud.reload({ waitUntil: 'networkidle' });
const meta = await cloud.evaluate(async (id) => {
	const root = await navigator.storage.getDirectory();
	const dir = await (await (await root.getDirectoryHandle('atelier-cloud')).getDirectoryHandle('projects')).getDirectoryHandle(id);
	return JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text());
}, project);
check('the revision follows the new name', meta.document === 'first-renamed.pcraft', String(meta.document));

step('A name already in the workspace is refused');
const collision = '.documents tbody tr[data-document="renamed.pcraft"]';
await cloud.click(`${collision} button:has-text("Rename")`);
await cloud.fill(`${collision} form input`, 'first-renamed.pcraft');
await cloud.click(`${collision} form button:has-text("Rename")`);
await cloud.waitForTimeout(2000);
const afterCollision = await files(cloud, project);
check('nothing was written over', Object.keys(afterCollision).sort().join() === Object.keys(afterRecorded).sort().join(), Object.keys(afterCollision).join());

step('Delete a document from the Atelier web UI');
cloud.on('dialog', (d) => d.accept());
await cloud.bringToFront();
await cloud.reload({ waitUntil: 'networkidle' });
await cloud.evaluate(() => {
	window.confirm = () => true;
});
const secondRow = '.documents tbody tr[data-document="renamed.pcraft"]';
await cloud.click(`${secondRow} button:has-text("Delete")`);
await cloud.waitForTimeout(2500);
const deleted = await files(cloud, project);
check('the document is gone from OPFS', !Object.keys(deleted).includes('renamed.pcraft'), Object.keys(deleted).join());
check('the one it left behind is still there', Object.keys(deleted).includes('first-renamed.pcraft'));
await cloud.reload({ waitUntil: 'networkidle' });
await cloud.waitForSelector('.documents tbody tr', { timeout: 15_000 });
const remaining = await cloud.$$eval('.documents tbody tr td.mono:first-child', (cells) => cells.map((c) => c.textContent.trim()));
check('and the panel agrees', remaining.length === 1, remaining.join());

step('Several documents at once, and one the editor does not open');
{
	// A workspace can be started from several files, and from a format the editor reads only through its
	// own File › Open. What it holds is listed here; what the editor opens from here is `.pcraft`.
	const many = 'Many documents';
	const png = readFileSync('/tmp/atelier-test.png');
	await cloud.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await cloud.click('button:has-text("New workspace")');
	await cloud.fill('input[type=text]', many);
	await cloud.click('.option:has-text("document from this computer") input[type=radio]');
	await cloud.setInputFiles('input[type=file]', [
		new URL('01-rgb-layered.pcraft', SAMPLES).pathname,
		new URL('03-psb.pcraft', SAMPLES).pathname,
		'/tmp/atelier-test.png',
	]);
	await cloud.waitForTimeout(600);
	const chosen = await cloud.textContent('.option:has-text("documents from this computer")');
	check('the dialog counts what was chosen', /3 documents from this computer/.test(chosen ?? ''), chosen?.trim().slice(0, 90));
	check('and says a non-.pcraft is kept as it is', /saved as it is/.test(chosen ?? ''));
	await cloud.click('button:has-text("Create")');
	await cloud.waitForSelector(`article h2 a:has-text("${many}")`);
	const card = await cloud.textContent(`article:has-text("${many}")`);
	check('the card says how many it holds', /3 documents/.test(card ?? ''), card?.trim().slice(0, 80));

	const manyHref = await cloud.getAttribute(`article:has-text("${many}") a:has-text("Editor")`, 'href');
	const manyProject = new URL(manyHref, ORIGIN).searchParams.get('project');
	await cloud.goto(`${ORIGIN}/cloud/workspace/${manyProject}`, { waitUntil: 'networkidle' });
	await cloud.waitForSelector('.documents tbody tr');
	const rows = await cloud.$$eval('.documents tbody tr', (list) =>
		list.map((row) => ({ name: row.getAttribute('data-document'), open: Boolean(row.querySelector('a.button')) })),
	);
	check('all three are listed', rows.length === 3, rows.map((r) => r.name).join());
	check('every .pcraft row opens in the editor', rows.filter((r) => r.name?.endsWith('.pcraft')).every((r) => r.open), JSON.stringify(rows));
	check('the one the editor does not open offers no Open', rows.filter((r) => !r.name?.endsWith('.pcraft')).every((r) => !r.open), JSON.stringify(rows));
	const held = await files(cloud, manyProject);
	check('the PNG arrived whole', held['atelier-test.png'] === png.length, String(held['atelier-test.png']));

	await cloud.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		await root.removeEntry('atelier-cloud', { recursive: true }).catch(() => {});
	});
}

await browser.close();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
