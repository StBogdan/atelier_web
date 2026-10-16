/**
 * SigV4 presigning, in the browser.
 *
 * A workspace can be given a bucket of its own, with the user's own credential, which is never sent
 * anywhere: this module turns it into a short-lived signed URL locally, with WebCrypto, so document
 * bytes travel from this browser to the bucket and the server in the middle sees nothing. The URL is
 * a SigV4 signature carried in the query string, and `test/s3-stub.mjs` recomputes it independently,
 * which is the check that it is still right.
 *
 * The secret itself is only ever an HMAC key. [`importSecret`] is the one place it is touched, and it
 * hands back a **non-extractable** `CryptoKey`: the private half can sign and cannot be read back out
 * of the browser.
 */

export type BucketOp = "put" | "get" | "list";

/** R2 signs a URL for between one second and one week (design, Object Storage). */
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A URL that outlives the session that asked for it is a URL that leaks, so 15 minutes by default. */
export const DEFAULT_TTL_SECONDS = 15 * 60;
/** R2's object-key limit is 1024 bytes, and the workspace's prefix eats into it. */
export const MAX_KEY_BYTES = 1024;

/** The only header the signature covers. The browser sets it and cannot forge it. */
const SIGNED_HEADERS = "host";

const METHOD: Record<BucketOp, string> = {
  put: "PUT",
  get: "GET",
  list: "GET",
};
/** The AWS SDK's marker for which operation a URL is for; S3 and R2 ignore it. */
const OPERATION_ID: Record<BucketOp, string> = {
  put: "PutObject",
  get: "GetObject",
  list: "ListObjectsV2",
};

const HMAC_SHA256 = { name: "HMAC", hash: "SHA-256" } as const;

/**
 * The endpoint, split the way a signature needs it: the host is what [`SIGNED_HEADERS`] covers, and
 * whatever path the endpoint carries is part of the canonical URI.
 */
export interface Endpoint {
  scheme: string;
  /** Host, with the port when it has one. Exactly what the `Host` header will say. */
  host: string;
  /** Empty, or a path beginning with `/` and not ending with one. */
  basePath: string;
}

export function parseEndpoint(value: string): Endpoint {
  const trimmed = value.trim().replace(/\/+$/, "");
  const bad = (why: string) =>
    new Error(`the endpoint ${why}: ${JSON.stringify(value)}`);
  const separator = trimmed.indexOf("://");
  if (separator < 0)
    throw bad(
      "must be an absolute URL, like https://<account>.r2.cloudflarestorage.com",
    );
  const scheme = trimmed.slice(0, separator);
  if (scheme !== "https" && scheme !== "http")
    throw bad("must be http or https");
  const rest = trimmed.slice(separator + 3);
  if (rest.includes("?") || rest.includes("#"))
    throw bad("must not carry a query or a fragment");
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const basePath = slash < 0 ? "" : rest.slice(slash).replace(/\/+$/, "");
  if (!host || /\s/.test(host)) throw bad("has no host");
  return { scheme, host, basePath };
}

/**
 * RFC 3986 percent-encoding, which is not `encodeURIComponent`: unreserved characters stay literal, a
 * space is `%20` and never `+`, and everything else is uppercase hex. `/` stays literal in a key,
 * where it separates segments.
 */
function percentEncode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(character) || (keepSlash && byte === 0x2f))
      out += character;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Names encoded and sorted by their encoded form, values encoded, and nothing else. */
function canonicalQuery(params: [string, string][]): string {
  return params
    .map(
      ([name, value]) =>
        [percentEncode(name, false), percentEncode(value, false)] as [
          string,
          string,
        ],
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/**
 * A logical key: printable ASCII, no backslashes, no `..`, no empty segment. Spaces are allowed
 * because a document name can contain one, and the signer percent-encodes whatever it is given.
 */
export function validateKey(key: string): void {
  if (!key) throw new Error("the key is empty");
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) {
    throw new Error(
      `the key is longer than the bucket's ${MAX_KEY_BYTES} byte limit`,
    );
  }
  if (key.startsWith("/") || key.endsWith("/"))
    throw new Error("the key starts or ends with '/'");
  if (!/^[A-Za-z0-9\-_./~ ]+$/.test(key)) {
    throw new Error(
      `the key has a character outside A-Za-z0-9 - _ . ~ / and space: ${JSON.stringify(key)}`,
    );
  }
  if (
    key
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("the key has an empty or dot path segment");
  }
}

/** A prefix is a key of its own, joined with a `/` so two segments cannot be glued together. */
export function normalisePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  validateKey(trimmed);
  return `${trimmed}/`;
}

/** The key handed to the bucket for a logical key: the workspace's prefix, then the key. */
export function fullKey(prefix: string, key: string): string {
  validateKey(key);
  const joined = `${prefix}${key}`;
  if (new TextEncoder().encode(joined).length > MAX_KEY_BYTES) {
    throw new Error(
      `the key is longer than the bucket's ${MAX_KEY_BYTES} byte limit, prefix included`,
    );
  }
  return joined;
}

/** The canonical URI: `/<bucket>/<key>` under whatever path the endpoint carries. */
function pathFor(endpoint: Endpoint, bucket: string, key: string): string {
  return `${endpoint.basePath}/${percentEncode(bucket, false)}/${percentEncode(key, true)}`;
}

/**
 * The URL this would sign for, without the signature. A form shows it, so a bucket pasted into both
 * the endpoint and the bucket field is visible before anything is written.
 */
export function targetUrl(request: {
  endpoint: Endpoint;
  bucket: string;
  prefix: string;
  key: string;
}): string {
  const { endpoint, bucket } = request;
  return `${endpoint.scheme}://${endpoint.host}${pathFor(endpoint, bucket, fullKey(request.prefix, request.key))}`;
}

/**
 * The URL as far as the object's own directory: the endpoint, the bucket and any key prefix, for a
 * form that creates a workspace and so has no key to name yet.
 */
export function prefixUrl(request: {
  endpoint: Endpoint;
  bucket: string;
  prefix: string;
}): string {
  const { endpoint, bucket, prefix } = request;
  return `${endpoint.scheme}://${endpoint.host}${pathFor(endpoint, bucket, prefix)}`;
}

/**
 * The endpoint and the bucket, resolved from fields that are allowed to overlap: a dashboard hands
 * over the bucket's **full S3 URL**, so a trailing name that is the bucket — or that arrives in the
 * bucket field — is taken as the bucket, and the endpoint is left as the account host. A base path
 * that is *not* the bucket is left alone, because MinIO behind a reverse proxy has one.
 */
export function resolveBucket(
  rawEndpoint: string,
  rawBucket: string,
): { endpoint: Endpoint; bucket: string } {
  const endpoint = parseEndpoint(rawEndpoint);
  const bucket = rawBucket.trim();
  const segments = endpoint.basePath.split("/").filter(Boolean);
  const trailing = segments.at(-1) ?? "";
  if (!trailing || (bucket && trailing !== bucket)) return { endpoint, bucket };
  const basePath = `/${segments.slice(0, -1).join("/")}`.replace(/\/+$/, "");
  return { endpoint: { ...endpoint, basePath }, bucket: trailing };
}

/**
 * The URL a bucket form would sign for, resolved the way the attach path resolves it so a preview
 * cannot disagree with what gets attached. `key` names an object, which a workspace that exists can
 * do; without one the URL stops at the prefix. `null` while the fields do not yet name a bucket.
 */
export function resolveTarget(
  form: { endpoint: string; bucket: string; prefix?: string },
  key?: string,
): string | null {
  if (!form.endpoint.trim()) return null;
  try {
    const { endpoint, bucket } = resolveBucket(form.endpoint, form.bucket);
    if (!bucket) return null;
    const prefix = normalisePrefix(form.prefix ?? "");
    return key === undefined
      ? prefixUrl({ endpoint, bucket, prefix })
      : targetUrl({ endpoint, bucket, prefix, key });
  } catch {
    return null;
  }
}

/**
 * A whole bucket URL taken apart into the two things it names:
 * `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/your-bucket-name` becomes the account host and
 * `your-bucket-name`. `null` when there is no trailing name to take, and a throw on text that is not
 * a URL, so a paste handler can tell "nothing to do" from "not a bucket URL".
 */
export function splitBucket(
  url: string,
): { endpoint: string; bucket: string } | null {
  const { endpoint, bucket } = resolveBucket(url, "");
  if (!bucket) return null;
  return {
    endpoint: `${endpoint.scheme}://${endpoint.host}${endpoint.basePath}`,
    bucket,
  };
}

/** `20261012T142211Z` and `20261012`, the two stamps the credential scope needs. */
function stamps(at: Date): { date: string; day: string } {
  const iso = at.toISOString();
  const date = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return { date, day: iso.slice(0, 10).replace(/-/g, "") };
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function hmac(key: CryptoKey, message: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    HMAC_SHA256,
    key,
    new TextEncoder().encode(message) as BufferSource,
  );
  return new Uint8Array(signature);
}

/** Bytes as an HMAC key that can sign and nothing else, and cannot be exported. */
async function keyFrom(bytes: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    bytes as BufferSource,
    HMAC_SHA256,
    false,
    ["sign"],
  );
}

/**
 * The secret as a key, and the only place the raw secret is touched: it goes straight into the
 * browser's crypto and is not kept.
 *
 * Non-extractable means this code, and any other script on this origin, can use the key to sign but
 * cannot read the secret back out of it and take it elsewhere.
 */
export async function importSecret(
  secretAccessKey: string,
): Promise<CryptoKey> {
  if (!secretAccessKey) throw new Error("the secret access key is empty");
  return await keyFrom(new TextEncoder().encode(`AWS4${secretAccessKey}`));
}

/**
 * The SigV4 signing key: the secret, scoped to the day, the region and the service, each step an
 * HMAC of the last. Every value after the first is a *string*, not a key or a hash.
 */
async function signingKey(
  seed: CryptoKey,
  day: string,
  region: string,
): Promise<CryptoKey> {
  let key: CryptoKey = seed;
  for (const step of [day, region, "s3", "aws4_request"])
    key = await keyFrom(await hmac(key, step));
  return key;
}

export interface PresignRequest {
  endpoint: Endpoint;
  region: string;
  bucket: string;
  /** Joined onto `key` before signing; empty for a dedicated bucket. */
  prefix: string;
  accessKeyId: string;
  /** The `AWS4`+secret HMAC key from [`importSecret`]. */
  seed: CryptoKey;
  op: BucketOp;
  /** The logical key: `sync.remote.key`, without the prefix. Absent for an operation about the bucket
   * itself, which is what a listing is. */
  key?: string;
  /** Extra query parameters the operation needs, signed with everything else. */
  query?: [string, string][];
  ttlSeconds?: number;
  /** Pinned by the tests, which are the only caller with a reason to lie about the clock. */
  at?: Date;
}

/** Sign one operation on one key, locally: nothing here touches the bucket or the network. */
export async function presign(request: PresignRequest): Promise<string> {
  const { endpoint, region, bucket, accessKeyId, seed, op } = request;
  const ttl = request.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new Error(
      `the URL lifetime must be between 1 and ${MAX_TTL_SECONDS} seconds, not ${ttl}`,
    );
  }
  if (!accessKeyId) throw new Error("the access key id is empty");
  if (!bucket.trim()) throw new Error("the bucket name is empty");
  if (bucket.includes("/"))
    throw new Error(
      `the bucket name has a '/' in it: ${JSON.stringify(bucket)}`,
    );
  if (op !== "list" && request.key === undefined)
    throw new Error(`${op} needs a key`);

  const object =
    request.key === undefined ? null : fullKey(request.prefix, request.key);
  const { date, day } = stamps(request.at ?? new Date());
  const scope = `${day}/${region}/s3/aws4_request`;

  // The parameters a presigned request carries, before the signature. `X-Amz-Signature` joins them
  // afterwards: it cannot be part of what it signs.
  const params: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKeyId}/${scope}`],
    ["X-Amz-Date", date],
    ["X-Amz-Expires", String(ttl)],
    ["X-Amz-SignedHeaders", SIGNED_HEADERS],
    ["x-id", OPERATION_ID[op]],
    ...(request.query ?? []),
  ];
  const query = canonicalQuery(params);
  const path =
    object === null
      ? `${endpoint.basePath}/${percentEncode(bucket, false)}`
      : pathFor(endpoint, bucket, object);

  const canonicalRequest = [
    METHOD[op],
    path,
    query,
    `${SIGNED_HEADERS}:${endpoint.host}\n`,
    SIGNED_HEADERS,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const digest = hex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalRequest) as BufferSource,
      ),
    ),
  );
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest}`;
  const signature = hex(
    await hmac(await signingKey(seed, day, region), stringToSign),
  );

  return `${endpoint.scheme}://${endpoint.host}${path}?${query}&X-Amz-Signature=${signature}`;
}
