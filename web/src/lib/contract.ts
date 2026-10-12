/**
 * The OPFS contract of `atelier_web/contract/protocol.md`, protocol 1.
 *
 * This module is Atelier Cloud's side of it: it creates the space, publishes `provider.json`,
 * renders the catalog, derives each project's state from the document the editor wrote, and
 * commits a revision. The editor's side is `../../hook/atelier_web.patch`.
 *
 * Everything the UI shows is derived here from OPFS (design 3.6): nothing is remembered in
 * memory between visits, so a reload, a second tab or an evicted-then-restored store all converge
 * on the same answer.
 */

import {
	SPACE,
	directory,
	files,
	hasDirectory,
	lockName,
	opfs,
	readBytes,
	readJson,
	remove,
	stat,
	subdirectories,
	writeBytes,
	writeJson,
	withLock,
	type Directory
} from './opfs';
import { difference, isPcraft, objectSet, previewEntry, readDirectory, readEntry, type Difference, type ZipEntry } from './pcraft';

export const PROTOCOL = 1;
export const PROVIDER_NAME = 'Atelier Cloud';
export const CAPABILITIES = ['open', 'save', 'lock', 'tools'] as const;

export const PROVIDER_FILE = 'provider.json';
export const CATALOG_FILE = 'workspaces.json';
export const META_FILE = 'meta.json';
export const PENDING_FILE = 'pending.json';
export const THUMB_FILE = 'thumb.png';

/** The document name an empty project's first save lands under, when nothing suggests a better one. */
export const DEFAULT_DOCUMENT = 'doc.pcraft';

export type SyncState = 'local';

export interface Revision {
	/** `sha256:<hex>` of the committed document. */
	hash: string;
	size: number;
	/** The document's `File.lastModified` when it was committed: the cheap "did it change?" check. */
	modified: number;
	/** Every content-addressed entry of the committed document, name to size. */
	objects: Record<string, number>;
}

export interface Meta {
	protocol: number;
	id: string;
	name: string;
	role: 'owner';
	document: string | null;
	createdAt: string;
	updatedAt: string;
	rev: number;
	dirty: boolean;
	size: number;
	sync: { state: SyncState; at: string };
	revision: Revision | null;
}

export interface Workspace {
	id: string;
	name: string;
	role: 'owner';
	rev: number;
	dirty: boolean;
	/** Document bytes as they are on disk now, not as of the revision. */
	size: number;
	document: string | null;
	updatedAt: string;
	thumb: boolean;
	/** Set when the project directory is there but its metadata is not. */
	broken?: string;
}

export interface Pending {
	protocol: number;
	project: string;
	document: string;
	rev: number;
	hash: string;
	size: number;
	modified: number;
	at: string;
	added: number;
	changed: number;
	removed: number;
	bytes: number;
	unchanged: number;
	unchangedBytes: number;
}

export interface Storage {
	/** `null` until the first check: the landing page must not accuse the browser too early. */
	supported: boolean | null;
	usage: number;
	quota: number;
	persisted: boolean;
	/** `persist()` has not been asked yet for this origin, in this browser profile. */
	asked: boolean;
}

const PERSIST_KEY = 'atelier-cloud:persistence-asked';

/** `atelier-cloud/`, created and made valid if it is not there yet. */
export async function ensureSpace(): Promise<Directory> {
	const space = await directory(await opfs(), SPACE, true);
	const provider = await readJson<{ protocol?: number }>(space, PROVIDER_FILE);
	if (provider?.protocol !== PROTOCOL) {
		await writeJson(space, PROVIDER_FILE, { protocol: PROTOCOL, name: PROVIDER_NAME, capabilities: [...CAPABILITIES] });
	}
	await directory(space, 'projects', true);
	await directory(space, 'index', true);
	await directory(space, 'tmp', true);
	await sweepStaging(space);
	return space;
}

async function projectsDir(space: Directory): Promise<Directory> {
	return await directory(space, 'projects', true);
}

async function projectDir(space: Directory, project: string): Promise<Directory> {
	return await directory(await projectsDir(space), project);
}

async function outboxDir(space: Directory, project: string, create: boolean): Promise<Directory> {
	return await directory(await directory(space, 'outbox', create), project, create);
}

/** Staging files are transient (3.1): anything left behind is from a tab that did not finish. */
async function sweepStaging(space: Directory): Promise<void> {
	const staging = await directory(space, 'tmp', true);
	const cutoff = Date.now() - 60 * 60 * 1000;
	for (const name of await files(staging)) {
		const info = await stat(staging, name);
		if (info && info.modified < cutoff) await remove(staging, name).catch(() => {});
	}
}

/** The document of a project: the one `*.pcraft` in it (design 3.2, 3.7). */
export async function documentName(dir: Directory): Promise<string | null> {
	const names = (await files(dir)).filter((name) => name.endsWith('.pcraft') && !name.endsWith('.prev'));
	return names[0] ?? null;
}

export async function readMeta(space: Directory, project: string): Promise<Meta | null> {
	return await readJson<Meta>(await projectDir(space, project), META_FILE);
}

/** A project's state as the catalog shows it: no document bytes are read (design 6.2). */
export async function inspect(space: Directory, project: string): Promise<Workspace> {
	const dir = await projectDir(space, project);
	const meta = await readJson<Meta>(dir, META_FILE);
	const document = await documentName(dir);
	const info = document ? await stat(dir, document) : null;
	const size = info?.size ?? 0;
	const revision = meta?.revision ?? null;
	const dirty = revision === null ? size > 0 : info !== null && (info.size !== revision.size || info.modified !== revision.modified);
	const thumb = (await stat(dir, THUMB_FILE)) !== null;

	if (!meta) {
		return {
			id: project,
			name: project,
			role: 'owner',
			rev: 0,
			dirty,
			size,
			document,
			updatedAt: new Date(0).toISOString(),
			thumb,
			broken: 'no meta.json'
		};
	}

	// The flag is the provider's derivation, so keep it in step with the file, not with the past.
	if (meta.dirty !== dirty) await writeJson(dir, META_FILE, { ...meta, dirty });
	if (!dirty) await clearPending(space, project);

	return {
		id: project,
		name: meta.name,
		role: meta.role ?? 'owner',
		rev: meta.rev,
		dirty,
		size,
		document,
		updatedAt: meta.updatedAt,
		thumb
	};
}

/** Scan the space and rewrite the catalog cache (3.1). */
export async function scan(space: Directory): Promise<Workspace[]> {
	const projects = await projectsDir(space);
	const workspaces: Workspace[] = [];
	for (const project of await subdirectories(projects)) workspaces.push(await inspect(space, project));
	workspaces.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
	await writeJson(await directory(space, 'index', true), CATALOG_FILE, {
		protocol: PROTOCOL,
		updatedAt: new Date().toISOString(),
		workspaces: workspaces.map((workspace) => ({
			id: workspace.id,
			name: workspace.name,
			role: workspace.role,
			rev: workspace.rev,
			dirty: workspace.dirty,
			bytes: workspace.size,
			documents: workspace.document ? 1 : 0,
			document: workspace.document,
			updatedAt: workspace.updatedAt,
			thumb: workspace.thumb
		}))
	});
	return workspaces;
}

async function hash(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `sha256:${hex}`;
}

/** `doc.pcraft` for a suggested display name, keeping the extension the contract requires (3.2). */
export function documentFileName(name: string): string {
	const base = name.replace(/^[\s.]+|[\s]+$/g, '').replace(/[/\\]/g, '-') || 'document';
	const stem = base.toLowerCase().endsWith('.pcraft') ? base.slice(0, -'.pcraft'.length) : base.replace(/\.[^.]*$/, '');
	return `${stem || 'document'}.pcraft`;
}

export interface NewProject {
	name: string;
	/** The document to start from, or null for a project with no document yet. */
	document?: { name: string; bytes: Uint8Array } | null;
}

/** Create a project and commit its first revision. The provider owns project creation (3.6). */
export async function createProject(space: Directory, { name, document = null }: NewProject): Promise<Workspace> {
	const id = crypto.randomUUID();
	const dir = await directory(await projectsDir(space), id, true);
	const now = new Date().toISOString();
	const meta: Meta = {
		protocol: PROTOCOL,
		id,
		name: name.trim() || 'Untitled workspace',
		role: 'owner',
		document: null,
		createdAt: now,
		updatedAt: now,
		rev: 0,
		dirty: false,
		size: 0,
		sync: { state: 'local', at: now },
		revision: null
	};
	await writeJson(dir, META_FILE, meta);
	if (document) {
		await writeBytes(dir, document.name, document.bytes);
		await writeJson(dir, META_FILE, { ...meta, document: document.name, size: document.bytes.length, dirty: true });
		await commit(space, id);
	}
	return await inspect(space, id);
}

export interface ReadDocument {
	name: string;
	bytes: Uint8Array;
	entries: ZipEntry[];
	objects: Map<string, number>;
}

/** The document plus its parsed object set, under the shared lock the editor's save respects. */
export async function readDocument(space: Directory, project: string): Promise<ReadDocument | null> {
	const dir = await projectDir(space, project);
	const name = await documentName(dir);
	if (!name) return null;
	const bytes = await withLock(lockName(project), 'shared', async () => await readBytes(dir, name));
	if (!isPcraft(bytes)) throw new Error(`${name} is not a .pcraft document`);
	const entries = readDirectory(bytes);
	return { name, bytes, entries, objects: objectSet(entries) };
}

/** The exact change against the committed revision, and what the Changes panel renders (6.5). */
export interface Change {
	document: string;
	difference: Difference;
	hash: string;
	size: number;
	modified: number;
}

export async function pendingChange(space: Directory, project: string, meta: Meta): Promise<Change | null> {
	const read = await readDocument(space, project);
	if (!read) return null;
	const previous = meta.revision?.objects ?? {};
	const difference_ = difference(previous, read.objects, read.entries);
	const info = await stat(await projectDir(space, project), read.name);
	const change: Change = {
		document: read.name,
		difference: difference_,
		hash: await hash(read.bytes),
		size: read.bytes.length,
		modified: info?.modified ?? Date.now()
	};
	if (meta.revision && change.hash === meta.revision.hash) return null;
	await writeJson(await outboxDir(space, project, true), PENDING_FILE, {
		protocol: PROTOCOL,
		project,
		document: change.document,
		rev: meta.rev,
		hash: change.hash,
		size: change.size,
		modified: change.modified,
		at: new Date().toISOString(),
		added: difference_.added.length,
		changed: difference_.changed.length,
		removed: difference_.removed,
		bytes: difference_.bytes,
		unchanged: difference_.unchanged,
		unchangedBytes: difference_.unchangedBytes
	} satisfies Pending);
	return change;
}

async function clearPending(space: Directory, project: string): Promise<void> {
	if (!(await hasDirectory(space, 'outbox')) || !(await hasDirectory(await directory(space, 'outbox'), project))) return;
	await remove(await outboxDir(space, project, false), PENDING_FILE).catch(() => {});
}

/**
 * Commit the document as a new revision: record its object set, refresh the thumbnail, and clear
 * the pending change. In M1 the revision is recorded locally; M2 uploads the same set (5.1).
 */
export async function commit(space: Directory, project: string): Promise<Meta> {
	const dir = await projectDir(space, project);
	return await withLock(lockName(project), 'exclusive', async () => {
		const meta = (await readJson<Meta>(dir, META_FILE)) ?? null;
		if (!meta) throw new Error('this project has no meta.json');
		const name = await documentName(dir);
		if (!name) throw new Error('this project has no document to commit');
		const bytes = await readBytes(dir, name);
		const info = await stat(dir, name);
		const entries = readDirectory(bytes);
		const preview = previewEntry(entries);
		if (preview) await writeBytes(dir, THUMB_FILE, await readEntry(bytes, preview));
		const now = new Date().toISOString();
		const next: Meta = {
			...meta,
			document: name,
			updatedAt: now,
			rev: meta.rev + 1,
			dirty: false,
			size: bytes.length,
			sync: { state: 'local', at: now },
			revision: {
				hash: await hash(bytes),
				size: bytes.length,
				modified: info?.modified ?? Date.now(),
				objects: Object.fromEntries(objectSet(entries))
			}
		};
		await writeJson(dir, META_FILE, next);
		await clearPending(space, project);
		return next;
	});
}

/**
 * Put back the previous bytes, the one destructive action in the provider (6.5).
 *
 * `.prev` is the editor's, one save back (3.4, 3.6), which is the committed revision when exactly
 * one save has happened since the commit. The answer says which of the two came back, so the UI can
 * be plain about it instead of pretending: M1 has no server holding the committed bytes.
 */
export async function discard(space: Directory, project: string): Promise<'revision' | 'previous'> {
	const dir = await projectDir(space, project);
	const meta = await readJson<Meta>(dir, META_FILE);
	const outcome = await withLock(lockName(project), 'exclusive', async () => {
		const name = await documentName(dir);
		if (!name) throw new Error('this project has no document');
		const previous = await readBytes(dir, `${name}.prev`).catch(() => null);
		if (!previous) throw new Error('there are no previous bytes to restore');
		await writeBytes(dir, name, previous);
		return (await hash(previous)) === meta?.revision?.hash ? ('revision' as const) : ('previous' as const);
	});
	await clearPending(space, project);
	await inspect(space, project);
	return outcome;
}

/** The committed document's bytes, and the previous ones when there are any: the export path. */
export async function documentBytes(space: Directory, project: string, previous = false): Promise<{ name: string; bytes: Uint8Array } | null> {
	const dir = await projectDir(space, project);
	const name = await documentName(dir);
	if (!name) return null;
	const file = previous ? `${name}.prev` : name;
	const bytes = await readBytes(dir, file).catch(() => null);
	return bytes ? { name: previous ? `${name.replace(/\.pcraft$/, '')}.prev.pcraft` : name, bytes } : null;
}

export async function rename(space: Directory, project: string, name: string): Promise<void> {
	const dir = await projectDir(space, project);
	const meta = await readJson<Meta>(dir, META_FILE);
	if (!meta) return;
	await writeJson(dir, META_FILE, { ...meta, name: name.trim() || meta.name, updatedAt: new Date().toISOString() });
}

export async function removeProject(space: Directory, project: string): Promise<void> {
	await remove(await projectsDir(space), project, true);
	await remove(await directory(space, 'outbox', true), project, true).catch(() => {});
}

export async function storage(): Promise<Storage> {
	if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return { supported: false, usage: 0, quota: 0, persisted: false, asked: true };
	const estimate = await navigator.storage.estimate();
	return {
		supported: true,
		usage: estimate.usage ?? 0,
		quota: estimate.quota ?? 0,
		persisted: await navigator.storage.persisted(),
		asked: localStorage.getItem(PERSIST_KEY) === '1'
	};
}

/**
 * Ask the browser to keep this origin's storage (design 4.5). Worth doing on a first meaningful
 * visit, and only once: without it the whole cloudspace is evictable under pressure.
 */
export async function requestPersistence(): Promise<boolean> {
	localStorage.setItem(PERSIST_KEY, '1');
	if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
	return await navigator.storage.persist();
}
