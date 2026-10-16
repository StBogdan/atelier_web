<script lang="ts">
  /**
   * The fields that name a bucket and the key that signs for it, shared by the workspace page's *Bucket*
   * panel and the New workspace dialog, so the two forms cannot drift apart.
   *
   * The caller owns the form object, the button that submits it, and the line that says where the bytes
   * would land — a workspace that exists knows its object key and one that does not, does not. This owns
   * the fields and the paste that fills two of them.
   */
  import type { BucketInput } from "./bucket";
  import { splitBucket } from "./sigv4";

  let {
    form = $bindable(),
    filled = $bindable(""),
    secretPlaceholder = "",
  }: {
    form: BucketInput;
    filled?: string;
    secretPlaceholder?: string;
  } = $props();

  /**
   * A dashboard's copy button hands over the bucket's whole URL, so a paste into Endpoint is taken
   * apart: the account host stays, and the bucket name moves to its own field where it can be seen.
   * Only on paste — an endpoint typed by hand must not be dismembered as it is typed.
   */
  function acceptPastedBucket(event: ClipboardEvent) {
    const text = event.clipboardData?.getData("text") ?? "";
    let split: { endpoint: string; bucket: string } | null = null;
    try {
      split = splitBucket(text);
    } catch {
      return;
    }
    if (!split) return;
    event.preventDefault();
    form.endpoint = split.endpoint;
    // Only if this field is empty, or still holds what this handler put there.
    if (!form.bucket || form.bucket === filled) {
      filled = split.bucket;
      form.bucket = split.bucket;
    }
  }
</script>

<label
  >Endpoint<input
    type="text"
    bind:value={form.endpoint}
    onpaste={acceptPastedBucket}
    placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com/your-bucket-name"
  /></label
>
<label
  >Bucket<input
    type="text"
    bind:value={form.bucket}
    placeholder="your-bucket-name"
  /></label
>
<label
  >Region <span class="opt">optional</span><input
    type="text"
    bind:value={form.region}
  /></label
>
<label
  >Key prefix <span class="opt">optional</span><input
    type="text"
    bind:value={form.prefix}
    placeholder="for a bucket you share"
  /></label
>
<hr />
<label>Access key id<input type="text" bind:value={form.accessKeyId} /></label>
<label>
  Secret access key
  <input
    type="password"
    bind:value={form.secretAccessKey}
    autocomplete="new-password"
    placeholder={secretPlaceholder}
  />
</label>
<p class="muted small">
  <a
    href="https://developers.cloudflare.com/r2/api/tokens/"
    target="_blank"
    rel="noopener">Create an R2 API token ↗</a
  >
  — Object Read &amp; Write, limited to this bucket.
</p>

<style>
  label {
    display: grid;
    gap: 0.15rem;
    font-size: 0.86rem;
    color: var(--dim);
  }

  .opt {
    color: var(--dim);
    font-weight: 400;
    font-size: 0.78rem;
  }

  hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 0.35rem 0;
    width: 100%;
  }
</style>
