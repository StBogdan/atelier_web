// A local stand-in for the bucket, for `attach.mjs`. It speaks just enough S3 to be signed at:
// it verifies the SigV4 signature of every presigned URL it is handed, keeps the bytes in memory,
// and serves them back, with the CORS headers a browser requires. No credentials, no network, no
// bucket — the flow it exercises is the browser's, not the provider's.
//
//   import { startStub } from './s3-stub.mjs';
//
// `objects` is a Map of key to Buffer, `operations` is a log of what was asked for, and a request
// whose signature does not verify is refused with 403 rather than stored.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const encode = (value) =>
	encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

const sign = (key, message) => createHmac('sha256', key).update(message).digest();

const escapeXml = (value) => value.replace(/[<>&]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character]);

/**
 * The SigV4 query signature, derived from scratch: `UNSIGNED-PAYLOAD`, only `host` signed, the
 * credential scope naming the key, date, region and service.
 */
function expectedSignature({ method, host, path, params, accessKeyId, secretAccessKey }) {
	const values = Object.fromEntries(params);
	const scope = values['X-Amz-Credential'].split('/').slice(1).join('/');
	const signedHeaders = values['X-Amz-SignedHeaders'];
	const canonicalQuery = params
		.filter(([name]) => name !== 'X-Amz-Signature')
		.map(([name, value]) => [encode(name), encode(value)])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`)
		.join('&');
	const canonicalHeaders = signedHeaders
		.split(';')
		.map((name) => `${name}:${name === 'host' ? host : ''}\n`)
		.join('');
	const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		values['X-Amz-Date'],
		scope,
		createHash('sha256').update(canonicalRequest).digest('hex')
	].join('\n');

	const [day, region, service, terminator] = scope.split('/');
	let key = `AWS4${secretAccessKey}`;
	for (const step of [day, region, service, terminator]) key = sign(key, step);
	return {
		signature: createHmac('sha256', key).update(stringToSign).digest('hex'),
		accessKeyId: values['X-Amz-Credential'].split('/')[0]
	};
}

export function startStub({
	port = 9000,
	bucket = 'bucket-under-test',
	accessKeyId = 'access-key-under-test',
	secretAccessKey = 'secret-under-test',
	denyList = false
} = {}) {
	const objects = new Map();
	const operations = [];
	const failures = [];
	// A flag, not a constant: a test can turn listing off mid-run to see how a refusal reads.
	const flags = { denyList };

	const cors = (origin) => ({
		'Access-Control-Allow-Origin': origin ?? '*',
		'Access-Control-Allow-Methods': 'PUT, GET, HEAD, OPTIONS',
		'Access-Control-Allow-Headers': '*',
		'Access-Control-Expose-Headers': 'ETag',
		'Access-Control-Max-Age': '600'
	});

	const server = createServer((request, response) => {
		const url = new URL(request.url, `http://${request.headers.host}`);
		const headers = cors(request.headers.origin);

		if (request.method === 'OPTIONS') {
			response.writeHead(204, headers);
			return response.end();
		}

		const params = [...url.searchParams.entries()];
		const [name, ...rest] = url.pathname.slice(1).split('/');
		const key = rest.map(decodeURIComponent).join('/');
		const expected = expectedSignature({
			method: request.method,
			host: request.headers.host,
			path: url.pathname,
			params,
			accessKeyId,
			secretAccessKey
		});

		const body = [];
		request.on('data', (chunk) => body.push(chunk));
		request.on('end', () => {
			const bytes = Buffer.concat(body);
			const given = new URL(request.url, 'http://placeholder').searchParams.get('X-Amz-Signature') ?? '';
			const verified =
				expected.accessKeyId === accessKeyId &&
				given.length === expected.signature.length &&
				timingSafeEqual(Buffer.from(given), Buffer.from(expected.signature));
			operations.push({ method: request.method, bucket: name, key, verified, bytes: bytes.length });

			if (name !== bucket) {
				response.writeHead(404, { ...headers, 'content-type': 'text/plain' });
				return response.end('no such bucket');
			}
			if (!verified) {
				failures.push(`a ${request.method} of ${key} did not verify`);
				response.writeHead(403, { ...headers, 'content-type': 'application/xml' });
				return response.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
			}

			if (request.method === 'PUT') {
				objects.set(key, bytes);
				const etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
				response.writeHead(200, { ...headers, etag });
				return response.end();
			}

			if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
				if (flags.denyList) {
					response.writeHead(403, { ...headers, 'content-type': 'application/xml' });
					return response.end('<Error><Code>AccessDenied</Code></Error>');
				}
				const prefix = url.searchParams.get('prefix') ?? '';
				const contents = [...objects.entries()]
					.filter(([objectKey]) => objectKey.startsWith(prefix))
					.map(
						([objectKey, value]) =>
							`<Contents><Key>${escapeXml(objectKey)}</Key><Size>${value.length}</Size>` +
							`<ETag>"${createHash('md5').update(value).digest('hex')}"</ETag>` +
							`<LastModified>2024-01-01T00:00:00.000Z</LastModified></Contents>`
					)
					.join('');
				response.writeHead(200, { ...headers, 'content-type': 'application/xml' });
				return response.end(
					`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`
				);
			}

			if (request.method === 'GET') {
				const stored = objects.get(key);
				if (!stored) {
					response.writeHead(404, { ...headers, 'content-type': 'application/xml' });
					return response.end('<Error><Code>NoSuchKey</Code></Error>');
				}
				response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': stored.length });
				return response.end(stored);
			}

			response.writeHead(405, headers);
			response.end();
		});
	});

	return {
		bucket,
		objects,
		operations,
		failures,
		flags,
		url: `http://127.0.0.1:${port}`,
		listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
		close: () => new Promise((resolve) => server.close(resolve))
	};
}
