/**
 * The bucket a workspace is given.
 *
 * A workspace carries its own bucket: the user attaches one to a workspace, with their own
 * credential, and this app signs in the browser (`sigv4.ts`). The server has no bucket role at all,
 * and never sees the credential.
 *
 * The attachment is two halves in two places, deliberately:
 *
 * - what the bucket *is* — endpoint, bucket, region, prefix, access key id — is in
 *   `projects/<id>/bucket.json`, in the OPFS the contract already describes;
 * - what signs for it is a non-extractable `CryptoKey` in IndexedDB.
 *
 * A `CryptoKey` is not bytes, which is exactly why the key half lives elsewhere: OPFS cannot hold
 * one, and the secret is never written down — only ever a key the browser will use and will not
 * hand back.
 */

import { PROTOCOL } from './contract';
import { directory, readJson, remove, writeJson, type Directory } from './opfs';
import {
	DEFAULT_TTL_SECONDS,
	MAX_TTL_SECONDS,
	importSecret,
	normalisePrefix,
	parseEndpoint,
	presign,
	resolveBucket,
	type BucketOp
} from './sigv4';

export const BUCKET_FILE = 'bucket.json';

/** What the bucket *is*. Everything needed to sign, except the part that must not be written down. */
export interface BucketConfig {
	protocol: number;
	/** The endpoint as it was attached, normalised: scheme://host, plus any base path. */
	endpoint: string;
	bucket: string;
	region: string;
	/** Empty, or a validated key ending in `/`. */
	prefix: string;
	accessKeyId: string;
	urlTtlSeconds: number;
	attachedAt: string;
}

/** What the attach form collects. The secret is here and nowhere else. */
export interface BucketInput {
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	region?: string;
	prefix?: string;
	urlTtlSeconds?: number;
}

/** A bucket, and the ability to sign for it. The key is only ever held for as long as a request. */
export interface Attachment {
	config: BucketConfig;
	seed: CryptoKey;
}

const DATABASE = 'atelier-cloud-buckets';
const STORE = 'signing-keys';

async function projectDir(space: Directory, project: string): Promise<Directory> {
	return await directory(await directory(space, 'projects'), project);
}

/**
 * IndexedDB, because it is the only origin-scoped store that can hold a `CryptoKey`: structured
 * clone carries one, and a non-extractable key stays non-extractable on the way back out.
 */
function database(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('could not open the signing key store'));
	});
}

/** One store, one transaction, settled when the transaction settles rather than the request. */
function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		void database().then((db) => {
			const transaction = db.transaction(STORE, mode);
			const request = run(transaction.objectStore(STORE));
			let result: T;
			request.onsuccess = () => {
				result = request.result;
			};
			const fail = (problem: unknown) => {
				db.close();
				reject(problem instanceof Error ? problem : new Error(`the signing key store failed: ${String(problem)}`));
			};
			transaction.oncomplete = () => {
				db.close();
				resolve(result);
			};
			transaction.onerror = () => fail(transaction.error);
			transaction.onabort = () => fail(transaction.error ?? new Error('the signing key store aborted'));
		}, reject);
	});
}

/** What the bucket is, or null. Reads the file only: showing a bucket never loads its key. */
export async function readBucketConfig(space: Directory, project: string): Promise<BucketConfig | null> {
	return await readJson<BucketConfig>(await projectDir(space, project), BUCKET_FILE);
}

/**
 * The bucket and its signing key, or null when nothing is attached.
 *
 * The config is written after the key, so a `bucket.json` that exists without a key means the store
 * was cleared under it — worth a sentence, rather than a signature that mysteriously comes out wrong.
 */
export async function readAttachment(space: Directory, project: string): Promise<Attachment | null> {
	const config = await readBucketConfig(space, project);
	if (!config) return null;
	const seed = await withStore<CryptoKey | undefined>('readonly', (store) => store.get(project));
	if (!seed) {
		throw new Error(
			'This workspace is attached to a bucket, but the key that signs for it is gone from this browser ' +
				'(the profile was cleared, or the store was evicted). Attach the bucket again to sign with it.'
		);
	}
	return { config, seed };
}

/** Attach a bucket to a workspace: validate, import the key, then record it. */
export async function attachBucket(space: Directory, project: string, input: BucketInput): Promise<BucketConfig> {
	// The bucket may have arrived on the end of the endpoint: a dashboard's copy button gives the whole
	// URL, and taking it apart is our job, not the user's.
	const { endpoint, bucket } = resolveBucket(input.endpoint, input.bucket);
	if (!bucket) {
		throw new Error("the bucket name is empty — paste the bucket's URL into the endpoint, or name it here");
	}
	if (bucket.includes('/')) throw new Error(`the bucket name has a '/' in it: ${JSON.stringify(bucket)}`);
	const accessKeyId = input.accessKeyId.trim();
	if (!accessKeyId) throw new Error('the access key id is empty');
	const urlTtlSeconds = input.urlTtlSeconds ?? DEFAULT_TTL_SECONDS;
	if (!Number.isInteger(urlTtlSeconds) || urlTtlSeconds < 1 || urlTtlSeconds > MAX_TTL_SECONDS) {
		throw new Error(`the URL lifetime must be between 1 and ${MAX_TTL_SECONDS} seconds, not ${urlTtlSeconds}`);
	}
	const prefix = normalisePrefix(input.prefix ?? '');

	// Import before writing anything: a secret this browser cannot take is a bucket it cannot sign
	// for, and half an attachment is worse than none.
	const seed = await importSecret(input.secretAccessKey);
	const config: BucketConfig = {
		protocol: PROTOCOL,
		endpoint: `${endpoint.scheme}://${endpoint.host}${endpoint.basePath}`,
		bucket,
		region: (input.region ?? '').trim() || 'auto',
		prefix,
		accessKeyId,
		urlTtlSeconds,
		attachedAt: new Date().toISOString()
	};
	await withStore('readwrite', (store) => store.put(seed, project));
	await writeJson(await projectDir(space, project), BUCKET_FILE, config);
	return config;
}

/** Let go of a bucket: the file and the key both, so neither half is left behind. */
export async function detachBucket(space: Directory, project: string): Promise<void> {
	await remove(await projectDir(space, project), BUCKET_FILE).catch(() => {});
	await withStore('readwrite', (store) => store.delete(project));
}

/**
 * The bucket in Cloudflare's dashboard, when the endpoint is R2's. R2's S3 endpoint names the account in
 * its host — `<ACCOUNT_ID>.r2.cloudflarestorage.com` — which is all the dashboard URL needs besides the
 * bucket.
 *
 * `null` for anything else: MinIO, plain S3 and the stub have no equivalent page, and a link that went
 * somewhere wrong would be worse than no link.
 */
export function r2DashboardUrl(config: Pick<BucketConfig, 'endpoint' | 'bucket'>): string | null {
	let host: string;
	try {
		host = parseEndpoint(config.endpoint).host;
	} catch {
		return null;
	}
	const suffix = '.r2.cloudflarestorage.com';
	if (!host.endsWith(suffix)) return null;
	const account = host.slice(0, -suffix.length);
	if (!account || !config.bucket) return null;
	return `https://dash.cloudflare.com/${account}/r2/default/buckets/${encodeURIComponent(config.bucket)}`;
}

/** One object from a listing, as the bucket itself reports it. */
export interface BucketObject {
	/** The key as the bucket stores it, this deployment's prefix included. */
	key: string;
	/** The same key without the prefix, which is what a request signs. */
	logical: string;
	size: number;
	modified: string | null;
}

/** A document the chooser can offer. */
export interface BucketDocument {
	/** The key's first path segment, which is the workspace id when this app wrote it. Empty at the root. */
	id: string;
	name: string;
	/** The key as the bucket stores it. */
	key: string;
	/** The same key without the prefix: what a download signs. */
	logical: string;
	size: number;
	modified: string | null;
}

/** S3 answers a page at a time, and 1000 is its own default ceiling. */
const MAX_KEYS = 1000;

/** A listing is XML, and its elements are unprefixed inside the S3 namespace, so the names still match. */
function parseListing(xml: string): { keys: { key: string; size: number; modified: string | null }[]; truncated: boolean } {
	const parsed = new DOMParser().parseFromString(xml, 'application/xml');
	if (parsed.querySelector('parsererror')) throw new Error('the bucket answered with something that is not a listing');
	const keys = [...parsed.querySelectorAll('Contents')].flatMap((node) => {
		const key = node.querySelector('Key')?.textContent;
		if (!key) return [];
		return [
			{
				key,
				size: Number(node.querySelector('Size')?.textContent ?? '0'),
				modified: node.querySelector('LastModified')?.textContent ?? null
			}
		];
	});
	return { keys, truncated: parsed.querySelector('IsTruncated')?.textContent === 'true' };
}

/** A `403` from a listing is its own thing: reading and writing objects is not listing them. */
function explainListing(status: number): string {
	if (status === 403) return "\n\nThe token needs permission to list the bucket; R2's Object Read & Write has it.";
	return '';
}

/**
 * What the bucket holds.
 *
 * This is the one place the design's "never list the bucket" rule bends, and it bends because a person
 * asked: one request, made when the chooser is opened, never on a path the app depends on.
 */
export async function listObjects(attachment: Attachment): Promise<{ objects: BucketObject[]; truncated: boolean }> {
	const query: [string, string][] = [
		['list-type', '2'],
		['max-keys', String(MAX_KEYS)]
	];
	if (attachment.config.prefix) query.push(['prefix', attachment.config.prefix]);

	const response = await send(attachment, await url(attachment, 'list', { query }));
	if (!response.ok) {
		throw new BucketError(`the bucket refused the listing: ${await describe(response)}${explainListing(response.status)}`, response.status);
	}
	const { keys, truncated } = parseListing(await response.text());
	const prefix = attachment.config.prefix;
	return {
		objects: keys.map(({ key, size, modified }) => ({
			key,
			logical: prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key,
			size,
			modified
		})),
		truncated
	};
}

/** The documents in a listing, newest first: what the chooser offers, one entry per `*.pcraft`. */
export function bucketDocuments(objects: BucketObject[]): BucketDocument[] {
	const documents: BucketDocument[] = [];
	for (const object of objects) {
		const slash = object.logical.lastIndexOf('/');
		const name = slash < 0 ? object.logical : object.logical.slice(slash + 1);
		if (!name.endsWith('.pcraft') || name.endsWith('.prev.pcraft')) continue;
		documents.push({
			id: slash < 0 ? '' : object.logical.slice(0, slash),
			name,
			key: object.key,
			logical: object.logical,
			size: object.size,
			modified: object.modified
		});
	}
	return documents.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? '') || a.key.localeCompare(b.key));
}

/** A one-line reason from a failed request. An S3 error's code is a sentence; the rest is not. */
async function describe(response: Response): Promise<string> {
	const status = `${response.status} ${response.statusText}`.trim();
	const text = (await response.text().catch(() => '')).trim();
	const code = text ? /<Code>([^<]+)<\/Code>/.exec(text)?.[1] : null;
	return code ? `${status} (${code})` : status;
}

/** A status the bucket can answer with, and what it usually means. */
function explain(status: number): string {
	if (status === 403) {
		return (
			'\n\nThe bucket rejected the signature. Check the access key pair, the region (R2\'s is "auto"), and ' +
			'that the token allows object read and write — not just read.'
		);
	}
	if (status === 404) {
		return '\n\nNo such bucket or key.';
	}
	return '';
}

/**
 * A request that never completed.
 *
 * `fetch` rejects with a bare `TypeError` — "Failed to fetch" — for anything the network layer will not
 * show us, and for a cross-origin request the usual cause is the bucket's CORS policy: with no
 * `Access-Control-Allow-Origin` the browser withholds the whole response, so there is nothing to report
 * but the fact that there is nothing. It is worth spelling out, because it is the one failure no other
 * part of the app can see, and it reads like bad credentials.
 */
function unreachable(config: BucketConfig, because: unknown): Error {
	const origin = typeof location === 'undefined' ? 'this origin' : location.origin;
	const reason = because instanceof Error ? because.message : String(because);
	return new Error(
		`The browser could not send the request to ${config.endpoint} at all (${reason}).\n\n` +
			`That is almost always the bucket's CORS policy: it has to allow ${origin} with PUT, GET and HEAD, and ` +
			`expose ETag, or the browser refuses to hand us the answer. The policy to paste is in ` +
			`atelier_web/README.md, "CORS on the bucket".\n\n` +
			`If it is already set, check that this is the bucket's S3 API endpoint and not its public URL.`
	);
}

/** Sign, then send. The signature is local; only the send can fail to leave the browser. */
async function send(attachment: Attachment, signed: string, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(signed, init);
	} catch (e) {
		throw unreachable(attachment.config, e);
	}
}

/**
 * Sign one operation.
 */
async function url(
	attachment: Attachment,
	op: BucketOp,
	options: { key?: string; query?: [string, string][] } = {}
): Promise<string> {
	return await presign({
		endpoint: parseEndpoint(attachment.config.endpoint),
		region: attachment.config.region,
		bucket: attachment.config.bucket,
		prefix: attachment.config.prefix,
		accessKeyId: attachment.config.accessKeyId,
		seed: attachment.seed,
		op,
		key: options.key,
		query: options.query,
		ttlSeconds: attachment.config.urlTtlSeconds
	});
}

/**
 * A refusal the caller may want to branch on: a missing object and a missing bucket are both `404`, and
 * only one of them is worth suggesting a fix for.
 */
export class BucketError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/**
 * Upload bytes and report what the bucket said about them.
 *
 * The body is a `Uint8Array` on purpose: `fetch` sets no `Content-Type` for one, and the signature
 * covers only the host, so a header the browser added on its own would be one the bucket has no
 * reason to accept.
 */
export async function uploadObject(attachment: Attachment, key: string, bytes: Uint8Array): Promise<{ etag: string | null }> {
	const response = await send(attachment, await url(attachment, 'put', { key }), {
		method: 'PUT',
		body: bytes as BodyInit
	});
	if (!response.ok) {
		throw new BucketError(`the bucket refused the upload: ${await describe(response)}${explain(response.status)}`, response.status);
	}
	// A bucket's CORS policy has to expose ETag for the browser to read it here.
	return { etag: response.headers.get('etag') };
}

export async function downloadObject(attachment: Attachment, key: string): Promise<Uint8Array> {
	const response = await send(attachment, await url(attachment, 'get', { key }));
	if (!response.ok) {
		throw new BucketError(`the bucket refused the download: ${await describe(response)}${explain(response.status)}`, response.status);
	}
	return new Uint8Array(await response.arrayBuffer());
}
