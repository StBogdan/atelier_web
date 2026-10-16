<script lang="ts">
  import { onDestroy } from "svelte";
  import { browser } from "$app/environment";
  import { base } from "$app/paths";
  import { capabilities } from "$lib/capabilities";

  /** Rendered into the policy below, so the snippet can be pasted as it stands. */
  const origin = browser ? location.origin : "http://127.0.0.1:3000";
  const cors = `[
  {
    "AllowedOrigins": ["${origin}"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]`;

  /**
   * What the copy button last did, for its own label: the policy is pasted into someone else's dashboard,
   * so copying it by hand — dragging over a block of text — is the step worth removing.
   */
  let copied = $state<"idle" | "copied" | "blocked">("idle");
  let copiedFor: number | undefined;
  let policy = $state<HTMLPreElement | null>(null);

  async function copyPolicy() {
    try {
      await navigator.clipboard.writeText(cors);
      copied = "copied";
    } catch {
      // A refused clipboard needs no explanation: the text is selected instead, so the keystroke the
      // reader already knows still works.
      const range = document.createRange();
      if (policy) range.selectNodeContents(policy);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      if (policy) selection?.addRange(range);
      copied = "blocked";
    }
    window.clearTimeout(copiedFor);
    copiedFor = window.setTimeout(() => (copied = "idle"), 4000);
  }

  onDestroy(() => window.clearTimeout(copiedFor));
</script>

<svelte:head><title>Help — Atelier Cloud</title></svelte:head>

<h1>Help</h1>
<p class="muted">
  This page is about getting your work out of the browser and back.
  <a href="{base}/help#storage">Where your work lives</a> explains what OPFS is
  and what committing does and does not do. {#if $capabilities.storage === "provisioned"}<a
      href="{base}/help#setup">Storage</a
    > says where your bytes go;{:else}<a href="{base}/help#setup"
      >Setting up a bucket</a
    > is the step-by-step walkthrough;{/if}
  <a href="{base}/help#troubleshooting">Troubleshooting</a> is the list of errors
  to check when something goes wrong.
</p>

<div class="stack">
  <section class="panel" id="storage">
    <h2>Where your work lives</h2>
    <p>
      A workspace is a directory in <strong>OPFS</strong>, the browser's
      <em>Origin Private File System</em>. It behaves like a normal filesystem,
      except that its files never appear in Finder or Explorer and only pages
      served from this exact origin can read them. It is a separate store from
      <code>localStorage</code> and IndexedDB. Atelier Cloud and the editor run on
      the same origin, so they share it.
    </p>
    <p>
      OPFS belongs to one browser profile. Another browser, another profile or
      another device has its own, empty store, and the browser can clear this
      one at any time. <a href="{base}/settings">Local storage</a> shows what is in
      the current one and can ask the browser to keep it.
    </p>
    <p>A workspace is made of three things, stored in three places:</p>
    <table>
      <tbody>
        <tr>
          <td>The document</td>
          <td>
            <code>atelier-cloud/projects/&lt;workspace&gt;/&lt;name&gt;</code>,
            in OPFS, under the name it has in this workspace whatever format it
            arrived in. The editor writes only this file and its
            <code>.prev</code> backup, and it is the only copy of your work.
          </td>
        </tr>
        <tr>
          <td>The revision</td>
          <td>
            The workspace's <code>meta.json</code>: the hash, size and time the
            document had when you recorded it, and the list of objects inside
            it. The Changes panel compares the current document against this.
          </td>
        </tr>
        <tr>
          <td>The bucket copy</td>
          <td>
            one object in your bucket, <code
              >&lt;prefix&gt;&lt;workspace&gt;/&lt;name&gt;</code
            >, under the document's own name, written only when you upload.
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      <em>Record version</em>, called <em>Commit</em> on the main page, does not
      move your work anywhere. It reads the document, saves its object list,
      hash and time into <code>meta.json</code>, refreshes the thumbnail,
      increases the revision number, and clears the pending change.
    </p>
    <p>
      What that buys you is the exact diff against the last revision, and the
      "uncommitted" state on the workspace card and here. It is not a backup,
      and it keeps no history: the cloudspace holds only the latest revision,
      and only an upload survives the browser clearing your storage.
    </p>
    <p>
      The editor writes here and goes elsewhere by different doors.
      <em>Save</em>, and <em>Save As</em>, put the document you have open back
      into this workspace, under the name it already has: that is what the file
      in the first row above is. <em>Export</em> — Export As, Save for Web, Save a
      Copy, Quick Export — sends the file to your own computer through the browser's
      download, and nothing in the workspace changes.
    </p>
    <p>
      The pending change is <code
        >atelier-cloud/outbox/&lt;workspace&gt;/pending.json</code
      >, which Atelier Cloud writes whenever a scan finds the document different
      from the recorded revision. The file holds a summary rather than your
      data: how many objects the document gained, changed and lost, with its
      hash, size and time. The Changes panel and the workspace card read their
      status from it. Recording a version empties it.
    </p>
    <p>
      <em>Upload to bucket</em> is what moves the bytes. It sends the document as
      it is right now, recorded or not, to that object, and the next upload overwrites
      it. A workspace with a bucket shows a small green cloud on its card; a workspace
      without one shows nothing.
    </p>
  </section>

  {#if $capabilities.storage === "provisioned"}
    <section class="panel" id="setup">
      <h2>Storage</h2>
      <p>
        This deployment runs the hosted profile. Storage is provisioned per
        account, and a short-lived credential is minted for the session when one
        is needed, so normally there is nothing to attach and no key to paste.
      </p>
      <p>
        A document still travels straight from this browser to that bucket, so
        no document bytes pass through the server, and the credential expires on
        its own about an hour after it is minted.
      </p>
      <p class="muted small">
        A workspace's Bucket panel also accepts a bucket of your own, which is
        the self-hosted arrangement.
      </p>
    </section>
  {:else}
    <section class="panel" id="setup">
      <h2>Setting up a bucket</h2>
      <p>
        A bucket belongs to a <em>workspace</em>, and you attach it on that
        workspace's page. The server needs no configuration: Atelier Cloud has
        no bucket code, and the credential you enter stays in this browser.
        There is nothing to set up outside the app.
      </p>

      <h3>1. Make an API token for the bucket</h3>
      <p>
        On Cloudflare R2, open <em>R2</em> ▸ <em>Manage R2 API Tokens</em> ▸
        <em>Create API token</em>, with permission
        <strong>Object Read &amp; Write</strong>, scoped to the one bucket. Copy
        the access key id and the secret access key; the secret is shown once.
        <a
          href="https://developers.cloudflare.com/r2/api/tokens/"
          target="_blank"
          rel="noopener">Cloudflare's token page ↗</a
        > shows the screens.
      </p>

      <h3>2. Let this origin through CORS</h3>
      <p>
        Your browser sends the bytes straight to the bucket, so the bucket has
        to allow this page's origin.
        <a href="{base}/help#cors">The policy to paste is below.</a> Skipping this
        step is the most common reason an upload fails.
      </p>

      <h3>3. Attach it on a workspace</h3>
      <p>
        Open a workspace, expand <em>Bucket</em>, and fill in the form. The
        panel shows the URL it will sign for as you type, so you can see a
        mistake before anything is saved.
      </p>
      <p>
        <em>New workspace</em> takes the same fields, under
        <em>Attach a bucket (optional)</em>, so a workspace can be given its
        bucket as it is made rather than opened and given one afterwards.
      </p>

      <h3>Which value goes where</h3>
      <table>
        <tbody>
          <tr>
            <td><strong>Endpoint</strong></td>
            <td>
              The bucket's <em>S3 API</em> endpoint, which is the account host
              rather than the bucket's public URL.
              <br /><code
                >https://&lt;ACCOUNT_ID&gt;.r2.cloudflarestorage.com</code
              >
              <br />You can also paste the bucket's whole URL here. Atelier
              Cloud takes the bucket name off the end and fills in the next
              field for you.
            </td>
          </tr>
          <tr>
            <td><strong>Bucket</strong></td>
            <td>
              The bucket's name, for example <code>your-bucket-name</code>. If
              you pasted a URL ending in the bucket name, it is already filled
              in here.
            </td>
          </tr>
          <tr>
            <td
              ><strong>Region</strong> <span class="muted">(optional)</span></td
            >
            <td
              ><code>auto</code> on R2, which is the default.
              <code>us-east-1</code> and an empty value also work.</td
            >
          </tr>
          <tr>
            <td
              ><strong>Key prefix</strong>
              <span class="muted">(optional)</span></td
            >
            <td>
              Leave it empty if the bucket is yours alone. Set it if the bucket
              is shared with anything else: everything this workspace writes
              goes under it, which keeps two users of one bucket apart.
            </td>
          </tr>
          <tr>
            <td
              ><strong>Access key id</strong><br /><strong
                >Secret access key</strong
              ></td
            >
            <td>
              The pair from step 1. The id is not a secret and is stored with
              the attachment; the secret is not stored anywhere.
            </td>
          </tr>
        </tbody>
      </table>

      <h3>What lands in the bucket</h3>
      <p>
        Uploads write one object per workspace, at
        <code>&lt;prefix&gt;&lt;workspace-id&gt;/&lt;document-name&gt;</code>,
        for example
        <code>atelier/8f14e45f-ceea-4a4d-9b8e-1a24a1f0d3c7/doc.pcraft</code>.
        Each upload replaces the one before it.
      </p>

      <h3>Starting a workspace from a bucket</h3>
      <p>
        A new workspace can start from a document the bucket already holds: in <em
          >New workspace</em
        >, choose
        <em>A cloud bucket</em>, fill in the fields, and <em>List documents</em>
        offers what is in the bucket. The workspace is made from the one you pick
        — it is that workspace's first version — with the bucket attached.
      </p>
      <p>
        In a workspace that is already going, use <em>Choose from bucket…</em>
        in the Bucket panel. It lists what the bucket holds, one row per document,
        and <em>Load</em> copies the one you pick into this workspace.
        <em>Download from bucket</em> does the same for the document stored under
        this workspace's own id, which is the button to use once a workspace and a
        bucket are a pair.
      </p>
      <p class="muted">
        In the workspace, neither button records a version, so the document
        arrives as an unrecorded change: the Changes panel shows it, and <em
          >Record version</em
        >
        is what turns it into one. Listing the bucket requires a token that allows
        it, and <em>Object Read &amp; Write</em> does.
      </p>
    </section>

    <section class="panel" id="cors">
      <h2>CORS on the bucket</h2>
      <p>
        Your browser talks to the bucket directly: it signs each request and
        sends the bytes itself, from a different origin than the bucket. The
        bucket therefore has to allow this page's origin. If it does not, the
        browser withholds the response and the app can only report that the
        request did not happen.
      </p>
      <p>
        On Cloudflare R2, open the bucket ▸ <em>Settings</em> ▸
        <em>CORS Policy</em>, and paste this unchanged for this address:
      </p>
      <div class="snippet">
        <div class="snippet-head">
          <span class="muted"
            >CORS policy for <code>{origin}</code> — your address, as it is here</span
          >
          <button
            type="button"
            class:ok={copied === "copied"}
            onclick={copyPolicy}
            >{copied === "copied"
              ? "Copied"
              : copied === "blocked"
                ? "Selected — press ⌘C"
                : "Copy"}</button
          >
        </div>
        <pre bind:this={policy}><code>{cors}</code></pre>
      </div>
      <p class="muted">
        <code>ETag</code> has to be exposed for the upload record to include it.
        Without it the upload still works and the record has no ETag. The origin
        has to match the address bar exactly:
        <code>localhost:3000</code> and <code>127.0.0.1:3000</code> are
        <em>different origins</em>, with different cloudspaces and different
        CORS rules, so pick one and keep using it.
      </p>
    </section>
  {/if}

  <section class="panel" id="faq">
    <h2>FAQ</h2>
    <table>
      <tbody>
        <tr>
          <td>Where is the secret kept?</td>
          <td>
            In this browser. The form imports it as a non-extractable <code
              >CryptoKey</code
            > and stores that key in IndexedDB; the app never holds the raw value
            after that. It is not sent to Atelier Cloud, which has no bucket code
            to receive it.
          </td>
        </tr>
        <tr>
          <td>Is that safe?</td>
          <td>
            This limits the risk; it does not remove it. A script running on
            this origin could still use the key to sign requests, and a copy of
            this browser's profile may be enough to use the key elsewhere. So
            attach a bucket-scoped read/write token rather than an account-wide
            one, and attach a bucket only on an origin you would trust with it.
          </td>
        </tr>
        <tr>
          <td>Does the bucket keep my revisions?</td>
          <td>
            No. It holds one object per workspace, the current document, and the
            next upload overwrites it. Revisions live in the cloudspace.
            Server-side history is planned but does not exist yet.
          </td>
        </tr>
        <tr>
          <td>What does <em>Record version</em> do?</td>
          <td>
            It saves the document as this workspace's next version: the object
            list, hash and time go into
            <code>meta.json</code>, the thumbnail is refreshed, and the pending
            change is cleared. Nothing is uploaded. You get the exact diff,
            since there would otherwise be no baseline to compare against, and
            the "uncommitted" state on the workspace card and here. It is not a
            backup and it keeps no history: the cloudspace holds only the latest
            revision, and only an upload survives the browser clearing your
            storage.
          </td>
        </tr>
        <tr>
          <td>Do I have to commit before uploading?</td>
          <td>
            No. An upload sends the document as it is on disk right now,
            recorded or not, and records the upload against that copy. Recording
            a version is what makes a revision; uploading is what copies the
            bytes off this machine.
          </td>
        </tr>
        <tr>
          <td>Can two workspaces share one bucket?</td>
          <td>
            Yes. Each writes under its own workspace id, so they will not
            collide. Set the same key prefix on both if the bucket is shared
            with other people.
          </td>
        </tr>
        <tr>
          <td>Can the editor upload to a bucket?</td>
          <td>
            No. Only the workspace page uploads. The editor writes the document
            into the cloudspace, and the workspace page is what sends it to a
            bucket.
          </td>
        </tr>
        <tr>
          <td>How do I change the bucket, or use a different key?</td>
          <td>
            Use <em>Edit bucket…</em> on the workspace page. The form reopens with
            everything filled in except the secret, which is never stored in a form
            the app can read back, so you have to enter it again.
          </td>
        </tr>
        <tr>
          <td>Why can't I hand a workspace to someone else?</td>
          <td>
            There are no accounts yet. A cloudspace belongs to this origin in
            this browser, so anything you have not uploaded or downloaded exists
            only on this machine.
          </td>
        </tr>
      </tbody>
    </table>
  </section>

  <section class="panel" id="troubleshooting">
    <h2>Troubleshooting</h2>
    <table>
      <thead>
        <tr>
          <th>What you see</th>
          <th>What it is</th>
          <th>What to do</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td
            ><code>Failed to fetch</code>, or "could not send the request at
            all"</td
          >
          <td>
            Almost always the bucket's CORS policy. The browser withholds a
            cross-origin response that the bucket has not allowed, so the error
            carries no further detail.
          </td>
          <td
            ><a href="{base}/help#cors">Add the policy above</a> to that bucket, using
            the origin from the address bar.</td
          >
        </tr>
        <tr>
          <td><code>403 SignatureDoesNotMatch</code></td>
          <td>The bucket rejected the request signature.</td>
          <td
            >Check the access key id and secret, and the region: use <code
              >auto</code
            > on R2, not a region name.</td
          >
        </tr>
        <tr>
          <td><code>403 AccessDenied</code></td>
          <td>The token is valid but is not allowed to perform this action.</td>
          <td>
            The token needs <em>Object Read &amp; Write</em> on that bucket, not
            read-only access. Listing the bucket, which
            <em>Choose from bucket…</em> does, is the permission most often missing.
          </td>
        </tr>
        <tr>
          <td><code>404</code>, or "no such bucket"</td>
          <td>Wrong bucket name, or an endpoint for a different account.</td>
          <td
            >Compare both against the bucket's page in your provider's
            dashboard.</td
          >
        </tr>
        <tr>
          <td>Upload says it worked, but the bucket looks empty</td>
          <td
            >The object is not at the root of the bucket: its key starts with
            the workspace's id.</td
          >
          <td
            >Look under <code>&lt;prefix&gt;&lt;workspace-id&gt;/</code>, and
            check you are looking at the right bucket.</td
          >
        </tr>
        <tr>
          <td>"the signing key for this workspace's bucket is gone"</td>
          <td
            >The bucket attachment is still there, but the browser's key store
            is gone, either cleared or evicted.</td
          >
          <td
            >Attach the bucket again. The document and the bucket's copy are
            both untouched.</td
          >
        </tr>
        <tr>
          <td>"The bucket copy is not this document"</td>
          <td>The document changed after the last upload.</td>
          <td
            >Upload again to update the copy, or download if you want the
            bucket's version.</td
          >
        </tr>
        <tr>
          <td>Downloaded, and the editor wrote its old copy back</td>
          <td
            >The editor had the document open and saves its own copy on the next
            save.</td
          >
          <td>Close the editor tab for that workspace, then download.</td>
        </tr>
        <tr>
          <td>Every workspace is empty, on a different address</td>
          <td
            >OPFS is keyed by origin, so a different host or scheme is a
            different cloudspace.</td
          >
          <td>
            Use one address for everything: <code>localhost</code>,
            <code>127.0.0.1</code>, <code>http://</code>
            and <code>https://</code> are four.
          </td>
        </tr>
        <tr>
          <td>Works on loopback, fails on the real hostname</td>
          <td
            >CORS rules are per origin, and the deployed origin is not the
            development one.</td
          >
          <td
            >Add the production origin to <code>AllowedOrigins</code> alongside the
            development one.</td
          >
        </tr>
        <tr>
          <td>The workspace page offers a bucket but nothing is set up</td>
          <td>That is normal: no bucket is configured until you attach one.</td>
          <td
            ><a href="{base}/help#setup">Attach a bucket</a>, or ignore it and
            keep working locally.</td
          >
        </tr>
      </tbody>
    </table>
  </section>
</div>

<style>
  h3 {
    font-size: 0.95rem;
    margin: 1.1rem 0 0.3rem;
  }

  section[id] {
    scroll-margin-top: 4rem;
  }

  pre {
    margin: 0;
    padding: 0.7rem 0.85rem;
    overflow-x: auto;
    font-size: 0.82rem;
    line-height: 1.45;
  }

  /* One block, not a chip per line: `code`'s own chip is for code inside a sentence. */
  .snippet pre code {
    background: none;
    border-radius: 0;
    padding: 0;
    font-size: inherit;
  }

  /* The one thing on this page that is pasted somewhere else, so it is a box with a title and a button
     rather than text to drag over by hand. */
  .snippet {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: color-mix(in srgb, var(--line) 35%, transparent);
    overflow: hidden;
  }

  .snippet-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.45rem 0.35rem 0.85rem;
    border-bottom: 1px solid var(--line);
    font-size: 0.82rem;
  }

  .snippet-head button {
    margin-left: auto;
    padding: 0.15em 0.6em;
    font-size: 0.8rem;
  }

  .snippet-head button.ok {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 45%, var(--field-line));
  }

  table td:first-child {
    width: 34%;
  }
</style>
