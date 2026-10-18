// The workspace page's documents, end to end: Atelier web and the patched editor on one origin.
//
// What the editor-only harness (`documents.mjs`) cannot reach, because it needs the cloud app too:
//
//  - the Documents panel lists every document in a workspace as a plain file list;
//  - "Open" on a row links to *that* document (`&document=`), not to the workspace's first;
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
const editorHref = await cloud.getAttribute(`article:has-text("${NAME}") a:has-text("Open in PhotoCraft")`, 'href');
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
check(
	'and says nothing about revisions beside a file',
	!/revision|rev \d/i.test(await cloud.textContent('.documents'))
);

step('"Open" on a row carries the document it names');
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
const untouched = documents(before).filter((n) => n !== first);
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

step('Several documents at once, in several formats');
{
	// A workspace can be started from several files, whatever their formats: what it holds is listed
	// here, and the editor opens any of them from here.
	const many = 'Many documents';
	// A real PNG, made here so the harness needs nothing on disk: the editor has to be able to read it
	// for the save below to mean anything.
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAKFElEQVR4Aexa+29cVxH+zvVfgkAIgUBUBQoUqkIfpAlJEzt2Eid2HD/i9/u93vX7bceOHT/i2HHs2M07bkJIVKhaVa0KVSsEQiAQgn9lDzNzz7m+PrtONz+0u1ol0uyZO9+Zk+/MN3N3I8X7xtFr+pu56/pbuVf1t/Ou6u8cX9PfzV/V3yu4or9/4or+wYkV/cNTl/ULp5b1i4XL+senl/RLZxb1T4sW9M+LF/TLxZf0L0vm9Sslc/rVc3P616UX9etls/qN8hn9m4oZfaDigj5YOa0PVU7pw1VT+u3qSX2sZkLn1o7r43XjOr9uTJ9oGNUnG0Z0YeOIPtM0rIubh/TZlkF9rnVQl7YO6PL2fl3R3qcrO/p0dWevru2K6bruqG6IRHVjpEc3RyO6Jdqt22LduqO3S3f1deru/g7dM9ChowPtuneoTfcNteqB4VY9NNKiR0ab9ehYkx4fb9Ke5wGeAnJ4ZVOQZ46JmVgW43EoaDEP5Cs2elZscUgsm3HuAFFXAeyL6goIVuqArMZ99Vl1MqO04i7gbrDP7EtMS6dkE+4FSiv4qpPiHBPVjc/PgZlY9uCsrMw7qUu+nfkvtqvw+VYVPtuqxp+u1+DTzVp8slGLj6/V4aP1enx4tQEfrDXg/bVG/GG1Ce9dacaTlWY8vtyCR8uteLjUhgeLbdhZbMe9hQ7cvdSJ2/OduDXXhRsXu7E9G8HWTASbMz24diGK9ekY1qZiWJ3sxcpEH5bH+7E01o+FsQHMjw5ibmQIs8NDmBkaxvTgCCYHRjHRP4qx/jGM9I1juHcCg7EJDEQn0dczhVhkGtHuaUS6L6CrawZK7hiHvR93PvtJO4DVRZb9CXcw30+e/W7WVB2efzbyZe7jWXZ9QPF7TO7Gd4xDUbcrevY8vwoJvwOQZX9y+J5sChD1FfyV54ArwSY+V4bmxb3/a2VzeKP8It6smMWB87N4q3IGh6ou4HDVNI5UT+NozRRyayeRVzeB/PoJFDSM42TjGAobR3G6aRRFzSM42zKMktYhlLYNoax9EBUdA6js6EdVZz9quvpQ192L+kgMjT0xNEWjaIn1oC0WQXtvBJ193eju70JkoBPRwU7EhjrQN9yOgeE2DI60YXi0FaNjLRgbb8bERLNLH+79FN1R0V097oAcWxm7qoR8Wy1/JTyoIuUky0837t5A+BBXWcP8uTKK54OqoWgmxMh3D+BqCcZ7CFecw77Y7kwpfs4APFX+XkJFTJXcA4J9BhfVjR9gXFkTSzeeOn9WS+aB3o7ky3uAVHQPULInDouz0uJTjo9pKPIlRvnpxlPln7QDWD33gEBlUphxeSZfVlbeGsUyAd+Pv5fIz1dOOTPtHuDirLYySvs+vQfsM59F3ZBOPFX+HleEVcyhylifn90DXJz3iHEeqZ9p+DPw31VO5peVo3l3D2A1w7iiPYr2SswoLz7FlGB+Z0ksDXjK/Fl1UY9UZF9UJd89QOJGbfFpj6wUS5YvGO9JE54yf1ZWJZlZ9wDFyholfX+3c5LlS8zuT3L+V42nyt8LlGK12EgxjrkHcEzM4KK68SXOuWwmlm48df6sbJKZdQ9Qsif+/HeARwqLuiG13Q7IBNwVMOCYyF/LLzh3Jt0DXFxx59gZFz+z3gmp8vdYUa5ODlXG+vzsHuDivEeM86gbMg1/Bv67ysl3NqtJ8+4eoEjtMK5oj6K9EiMs0/CU+bPqoh6pyL6oSr57gMSN2uLTHlkplixfMN6TJjxl/qycSvI97R7AaiujtO/vdo5Kki8xuz8NeKr8vUApVouNFOOYewDHxAwuqhtf4pzLZmLpxlPnT3OsZJ79bwM70+4B/p74898BHiks6obUdjsgE3AroF0Djon89fPfAVwdUY2qwz6brZxdXZz3iJmcTMMtb7s+hd/u21zm37wTbKJdFb3Rw3imvxMsb7vuy3+/mbaJdg2rLT6/A9ioA6S6xt+DmVg6cMvbrsKLuMrKvHaN3gFJvqdtol0VdwZ1AVfS93c7RyXJl5jdnwbc8rarz5nvSiZ38fl7CRUxVbKJdg32GVxUNX6AcVVNLN245W3XgGMCP67G898BQLhCrJ6tnF1dXJ5NNcVX8M+gGOdLjHxZFXxMQf4f0teBW952DXgQJ+fv3zsTSuY2bvOCVfEcC0b72efOsc/ix6HscwbgAXHjKOaUhJ/nUUW4Ojm8simIWiYvWFycc8RMTqbhAXHjPIXfrnLh73mTFyyKqhfGlbw34pAYYZmGB8SNsy8/7gCpjoLMp6iqTFZokbhRW3zaIyvFkuULxnvShIeoiyt8iIuszGvXNM0udYHMMftk5EtW6ENRjKsoJj7lGOUVz5fEKJdj4qcXD1EXdz/+XkJFTJUkK/QR7DO4qG78AOOqmli68RB1cQOOCfxYLZlnUo98O9OSFfpQsieesTPv8gtRF9fFFXUq3zVpB7B6khX6CFeQcXk21RSf1WejWDpxz/z9IeriBhwNLs/k06qhSHnFc0xVUWJxSQp/KAf3cyiX9yfJTzce5s7+fvw9rhhV4Uv/n2AOV4uNVQ6biWUazpcO21P4xaFYRTKeCVGO5j2czD7vCeOK9ihSXmKUm2k4cw7bvvy4A6Q6rKpRkzsinMw+x3ivrLzXGuUkyw/2pQlnzmETPsRFVsvdX3mOqQtITa6SGPnhZPZZbcFYbcJVhr8TmHPY9uPvJVTEVCmczH6wz+CiuvEDjCtqYunGmXPYAo4J/FhNmWfqBPLtTIeT2e/snEV7xyza2i+ipW0OTa3zaGyZR33LJdQ2L6CmaRFVjYuobFhCRf0yyuouo7T2MkpqV1BccwVF1as4XbWKwso1nDx/FQUV68gvX0de+TUcK9vA0dJNHDm3icMl13Ho7BbeKt7GgaJtvFn0Dl4/cwOvnb6JXxXexKunbuGVk7fxixN38HLBHfys4C5eyr+Hnxy/jx/l3ceLuTt44di7THmPKbljHPZ+ijqZ/aQdwOrtyc6Ch3AH8P3k2e8GDUXKK2ems+DOe67g3s+/s6Z/APpVgFTF+FydPdlZ8ODej+8oxnOgaB7YxOduoHmZnGzC9FQjZqYaMDvdgLkL9bg0U4eF2VosXazF8lwNVuarsTpfhbVLVVhfqMTG4nlsLlVga7kC25fLcWOlDLdWSnH7Sinurp7D/bUS7Fw9iwfrZ/HwWjEebRTh8cYZPNk8g/eun8Yftwrx/vYpfPDOKXx44yQ+unkCH98swCe3CvDp7Xz8+c5xfHY3D5/fy8MX93Pxl51j+OvOUfzt3aP4+4O38Y+HR/DP3x3Gvx4dxr9//1v85/Eh/PfxQfzvyUG491N0R0V39TxSPYfMVAOy8tvcGmFZjXNlFM8/VUOZTuDKKI7ZZ/azFPeSKc4xUZ3UZ3+PmVj24KyszIP/bSDvAaO8+FmOJ+0AUZffAUZttwMyCd/DzXB+Fn7/BwAA//8Pnu/bAAAABklEQVQDAERhrrL+6kbUAAAAAElFTkSuQmCC',
		'base64'
	);
	await cloud.goto(`${ORIGIN}/cloud/`, { waitUntil: 'networkidle' });
	await cloud.click('button:has-text("New workspace")');
	await cloud.fill('input[type=text]', many);
	await cloud.click('.option:has-text("document from this computer") input[type=radio]');
	// Playwright rejects a mix of paths and buffers, so every file arrives as bytes.
	const sample = (name) => ({
		name,
		mimeType: 'application/octet-stream',
		buffer: readFileSync(new URL(name, SAMPLES)),
	});
	await cloud.setInputFiles('input[type=file]', [
		sample('01-rgb-layered.pcraft'),
		sample('03-psb.pcraft'),
		{ name: 'atelier-test.png', mimeType: 'image/png', buffer: png },
	]);
	await cloud.waitForTimeout(600);
	const chosen = await cloud.textContent('.option:has-text("documents from this computer")');
	check('the dialog counts what was chosen', /3 documents from this computer/.test(chosen ?? ''), chosen?.trim().slice(0, 90));
	check('and says a non-.pcraft is kept as it is', /saved as it is/.test(chosen ?? ''));
	await cloud.click('button:has-text("Create")');
	await cloud.waitForSelector(`article h2 a:has-text("${many}")`);
	const card = await cloud.textContent(`article:has-text("${many}")`);
	check('the card says how many it holds', /3 documents/.test(card ?? ''), card?.trim().slice(0, 80));

	const manyHref = await cloud.getAttribute(`article:has-text("${many}") a:has-text("Open in PhotoCraft")`, 'href');
	const manyProject = new URL(manyHref, ORIGIN).searchParams.get('project');
	await cloud.goto(`${ORIGIN}/cloud/workspace/${manyProject}`, { waitUntil: 'networkidle' });
	await cloud.waitForSelector('.documents tbody tr');
	const rows = await cloud.$$eval('.documents tbody tr', (list) =>
		list.map((row) => ({ name: row.getAttribute('data-document'), open: Boolean(row.querySelector('a.button, details.open-menu summary.button')) })),
	);
	check('all three are listed', rows.length === 3, rows.map((r) => r.name).join());
	check('every document offers Open, whatever its format', rows.every((r) => r.open), JSON.stringify(rows));
	const held = await files(cloud, manyProject);
	check('the PNG arrived whole', held['atelier-test.png'] === png.length, String(held['atelier-test.png']));

	// The editor is handed a name and its bytes; it decides by content what it can read, so a PNG
	// opens the same way a .pcraft does (the patch's own console says which one it took).
	const editor = await cloud.context().newPage();
	const editorLog = [];
	const downloads = [];
	editor.on('console', (message) => editorLog.push(message.text()));
	editor.on('download', (download) => downloads.push(download.suggestedFilename()));
	const pngEditors = await cloud.$$eval('.documents tbody tr[data-document="atelier-test.png"] .open-menu .menu a', (links) => links.map((a) => a.textContent?.trim()));
	check('a PNG offers both editors', pngEditors.includes('PhotoCraft') && pngEditors.includes('PdfCraft'), pngEditors.join());
	const pngHref = await cloud.getAttribute(`.documents tbody tr[data-document="atelier-test.png"] .open-menu .menu a:has-text("PhotoCraft")`, 'href');
	await editor.goto(new URL(pngHref, ORIGIN).toString(), { waitUntil: 'networkidle' });
	await editor.waitForFunction(() => document.querySelector('#photocraft_canvas') !== null, null, { timeout: 30_000 });
	await editor.waitForTimeout(8_000);
	check(
		'the editor opens the PNG from the workspace, not the .pcraft next to it',
		editorLog.some((line) => line.includes('atelier-cloud: opening atelier-test.png')),
		editorLog.filter((line) => line.includes('atelier-cloud:')).join(' | ')
	);

	// Paint on it and save: the editor can write a PNG, so the save belongs in the workspace rather
	// than in a download. The .pcraft beside it must not move.
	await editor.bringToFront();
	await editor.click('#photocraft_canvas', { position: { x: 400, y: 400 } });
	await editor.keyboard.press('Control+s');
	await editor.waitForTimeout(10_000);
	const afterEdit = await files(cloud, manyProject);
	const savedLog = editorLog.filter((line) => line.includes('atelier-cloud:')).join(' | ');
	check(
		'the save landed in the workspace, under the document it came from',
		/saved atelier-test.png/.test(savedLog),
		savedLog
	);
	check(
		'with the edited bytes on disk and the one-save-back copy beside it',
		afterEdit['atelier-test.png'] !== png.length && afterEdit['atelier-test.png.prev'] > 0,
		`${afterEdit['atelier-test.png']} B, was ${png.length} B; prev ${afterEdit['atelier-test.png.prev']} B`
	);
	check(
		'no second document was made for it',
		Object.keys(afterEdit).filter((name) => name.endsWith('.pcraft')).length === 2,
		Object.keys(afterEdit).join()
	);
	check('and the editor offered no download for it', downloads.length === 0, downloads.join());
	await editor.close();

	// An export is the other direction, and the reason it is checked at all: the editor asks for a
	// destination through the same dialog a save does, so an export answered as a save would leave the
	// reader with a file they asked for sitting in storage they cannot see, and nothing on their disk.
	// Export As is Cmd+Alt+Shift+W (Ctrl+Alt+Shift+W: egui reads either as the command key), and the
	// dialog's Export is its default button, so Enter confirms it.
	const exporting = await cloud.context().newPage();
	const exported = [];
	exporting.on('download', (download) => exported.push(download.suggestedFilename()));
	const pcraftHref = await cloud.getAttribute(`.documents tbody tr[data-document="01-rgb-layered.pcraft"] a.button`, 'href');
	await exporting.goto(new URL(pcraftHref, ORIGIN).toString(), { waitUntil: 'networkidle' });
	await exporting.waitForFunction(() => document.querySelector('#photocraft_canvas') !== null, null, { timeout: 30_000 });
	await exporting.waitForTimeout(8_000);
	await exporting.bringToFront();
	await exporting.keyboard.press('Control+Alt+Shift+W');
	await exporting.waitForTimeout(3_000);
	await exporting.keyboard.press('Enter');
	await exporting.waitForTimeout(8_000);
	const afterExport = await files(cloud, manyProject);
	check('an export downloads to the reader instead of the workspace', exported.length === 1, exported.join());
	check('and it is the format the export dialog asked for', exported[0]?.endsWith('.png'), exported.join());
	check(
		'and the workspace is untouched by it',
		JSON.stringify(afterExport) === JSON.stringify(afterEdit),
		`${Object.keys(afterEdit).join()} → ${Object.keys(afterExport).join()}`
	);
	await exporting.close();

	await cloud.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		await root.removeEntry('atelier-cloud', { recursive: true }).catch(() => {});
	});
}

await browser.close();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
