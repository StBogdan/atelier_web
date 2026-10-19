<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { browser } from "$app/environment";
  import { base } from "$app/paths";
  import { capabilities } from "$lib/capabilities";

  /**
   * Rendered into the policy below, so the snippet can be pasted as it stands. It starts as a
   * placeholder because the page is prerendered, where there is no origin to read; the browser puts
   * the real one in on mount.
   */
  let origin = $state("https://your-cloud-host");
  onMount(() => {
    origin = location.origin;
  });
  const cors = $derived(`[
  {
    "AllowedOrigins": ["${origin}"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]`);

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

  // `onDestroy` also runs on the server, after the prerendered page is rendered, where there is no
  // `window` to clear a timer on.
  onDestroy(() => {
    if (browser) window.clearTimeout(copiedFor);
  });

  /**
   * The FAQ as data, so the table and the FAQPage structured data cannot say different things. The
   * answers carry the inline tags the prose needs; the schema takes their text.
   */
  const faq = [
    {
      q: "Where is the secret kept?",
      a: "In this browser. The form imports it as a non-extractable <code>CryptoKey</code> and stores that key in IndexedDB; the app never holds the raw value after that. It is not sent to Atelier Cloud, which has no bucket code to receive it.",
    },
    {
      q: "Is that safe?",
      a: "This limits the risk; it does not remove it. A script running on this origin could still use the key to sign requests, and a copy of this browser's profile may be enough to use the key elsewhere. So attach a bucket-scoped read/write token rather than an account-wide one, and attach a bucket only on an origin you would trust with it.",
    },
    {
      q: "Does the bucket keep my revisions?",
      a: "No. It holds one object per document you upload, and the next upload of that document overwrites it. Revisions live in the cloudspace. Server-side history is planned but does not exist yet.",
    },
    {
      q: "What does <em>Record version</em> do?",
      a: "It saves the document as this workspace's next version: the object list, hash and time go into <code>meta.json</code>, the thumbnail is refreshed, and the pending change is cleared. Nothing is uploaded. The Changes panel then has a baseline, so it can show the exact diff, and the workspace card drops its uncommitted state. It is not a backup and it keeps no history: the cloudspace holds only the latest revision, and only an upload survives the browser clearing your storage.",
    },
    {
      q: "Do I have to commit before uploading?",
      a: "No. An upload sends the document as it is on disk right now, recorded or not, and records the upload against that copy. Recording a version is what makes a revision; uploading is what copies the bytes off this machine.",
    },
    {
      q: "Can two workspaces share one bucket?",
      a: "Yes. Each writes under its own workspace id, so they will not collide. Set the same key prefix on both if the bucket is shared with other people.",
    },
    {
      q: "Can the editor upload to a bucket?",
      a: "No. Only the workspace page uploads. The editor writes the document into the cloudspace, and the workspace page is what sends it to a bucket.",
    },
    {
      q: "How do I change the bucket, or use a different key?",
      a: "Use <em>Edit bucket…</em> on the workspace page. The form reopens with everything filled in except the secret, which is never stored in a form the app can read back, so you have to enter it again.",
    },
    {
      q: "Why can't I hand a workspace to someone else?",
      a: "There are no accounts yet. A cloudspace belongs to this origin in this browser, so anything you have not uploaded or downloaded exists only on this machine.",
    },
  ];

  const plain = (html: string) => html.replace(/<[^>]+>/g, "");

  /** The sections the page is made of, in the order they appear, for the contents list. */
  const sections = $derived(
    $capabilities.storage === "provisioned"
      ? [
          ["storage", "Where your work lives"],
          ["setup", "Storage"],
          ["faq", "FAQ"],
          ["troubleshooting", "Troubleshooting"],
        ]
      : [
          ["storage", "Where your work lives"],
          ["setup", "Setting up a bucket"],
          ["cors", "CORS on the bucket"],
          ["faq", "FAQ"],
          ["troubleshooting", "Troubleshooting"],
        ],
  );

  /** Which section the reader is in, so the contents list says where they are. */
  let here = $state("storage");
  /** The contents list is open on a wide screen, where it has a column of its own. */
  let tocOpen = $state(true);

  onMount(() => {
    tocOpen = matchMedia("(min-width: 64rem)").matches;
    const headings = [...document.querySelectorAll("main section[id]")];
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = headings.find((heading) => visible.has(heading.id));
        if (first) here = first.id;
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    for (const heading of headings) observer.observe(heading);
    return () => observer.disconnect();
  });

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: plain(item.q),
      acceptedAnswer: { "@type": "Answer", text: plain(item.a) },
    })),
  };
</script>

<svelte:head>
  <title>Help | Atelier Cloud</title>
  <meta
    name="description"
    content="Where your work lives in the browser, what committing does, how to attach a bucket and set its CORS policy, and what each upload error means."
  />
  {@html `<script type="application/ld+json">${JSON.stringify(faqSchema).replace(/</g, "\\u003c")}</script>`}
</svelte:head>

<h1>Help</h1>
<p class="intro">
  Where your work lives, how to send it to your own bucket, and what the upload
  errors mean.
</p>

<div class="docs">
  <aside class="toc">
    <details bind:open={tocOpen}>
      <summary>On this page</summary>
      <nav aria-label="On this page">
        {#each sections as [id, title] (id)}
          <a
            href="{base}/help#{id}"
            aria-current={here === id ? "true" : undefined}>{title}</a
          >
        {/each}
      </nav>
    </details>
  </aside>

  <div class="stack">
    <section class="panel" id="storage">
      <h2>Where your work lives</h2>
      <p>
        A workspace is a directory in <strong>OPFS</strong>, the browser's
        <em>Origin Private File System</em>. It behaves like a normal
        filesystem, except that its files never appear in Finder or Explorer and
        only pages served from this exact origin can read them. It is a separate
        store from
        <code>localStorage</code> and IndexedDB. Atelier Cloud and the editor run
        on the same origin, so they share it.
      </p>
      <p>
        OPFS belongs to one browser profile. Another browser, another profile or
        another device has its own, empty store, and the browser can clear this
        one at any time. <a href="{base}/settings">Local storage</a> shows what is
        in the current one and can ask the browser to keep it.
      </p>
      <p>A workspace is made of three things, stored in three places:</p>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="table-scroll"
        role="region"
        aria-label="Workspace contents"
        tabindex="0"
      >
        <table>
          <tbody>
            <tr>
              <td>The document</td>
              <td>
                <code
                  >atelier-cloud/projects/&lt;workspace&gt;/&lt;name&gt;</code
                >, in OPFS, under the name it has in this workspace, whatever
                format it arrived in. The editor writes only this file and its
                <code>.prev</code> backup, and it is the only copy of your work.
              </td>
            </tr>
            <tr>
              <td>The revision</td>
              <td>
                The workspace's <code>meta.json</code>: the hash, size and time
                the document had when you recorded it, and the list of objects
                inside it. The Changes panel compares the current document
                against this.
              </td>
            </tr>
            <tr>
              <td>The bucket copy</td>
              <td>
                One object in your bucket, <code
                  >&lt;prefix&gt;&lt;workspace&gt;/&lt;name&gt;</code
                >, under the document's own name, written only when you upload.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <em>Record version</em>, called <em>Commit</em> on the main page, does
        not move your work anywhere. It reads the document, saves its object
        list, hash and time into <code>meta.json</code>, refreshes the
        thumbnail, increases the revision number, and clears the pending change.
      </p>
      <p>
        That gives you the exact diff against the last revision, and the
        "uncommitted" state on the workspace card and here. It is not a backup,
        and it keeps no history: the cloudspace holds only the latest revision,
        and only an upload survives the browser clearing your storage.
      </p>
      <p>
        The editor writes to this workspace and exports elsewhere through
        separate commands. <em>Save</em> and <em>Save As</em> put the document
        you have open back into this workspace under its current name. That is
        the file in the first row above. <em>Export</em> (Export As, Save for Web,
        Save a Copy, Quick Export) sends the file to your own computer through the
        browser's download, and nothing in the workspace changes.
      </p>
      <p>
        The pending change is <code
          >atelier-cloud/outbox/&lt;workspace&gt;/pending.json</code
        >, which Atelier Cloud writes whenever a scan finds the document
        different from the recorded revision. The file holds a summary rather
        than your data: how many objects the document gained, changed and lost,
        with its hash, size and time. The Changes panel and the workspace card
        read their status from it. Recording a version empties it.
      </p>
      <p>
        <em>Upload to bucket</em> is what moves the bytes. It sends the document as
        it is right now, recorded or not, to that object, and the next upload overwrites
        it. A workspace with a bucket shows a small green cloud on its card.
      </p>
    </section>

    {#if $capabilities.storage === "provisioned"}
      <section class="panel" id="setup">
        <h2>Storage</h2>
        <p>
          This deployment runs the hosted profile. Storage is provisioned per
          account, and a short-lived credential is minted for the session when
          one is needed, so normally there is nothing to attach and no key to
          paste.
        </p>
        <p>
          A document still travels straight from this browser to that bucket, so
          no document bytes pass through the server, and the credential expires
          on its own about an hour after it is minted.
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

        <ol class="steps">
          <li>
            <h3>Make an API token for the bucket</h3>
            <p>
              On Cloudflare R2, open <em>R2</em>, then
              <em>Manage R2 API Tokens</em>, then <em>Create API token</em>,
              with permission <strong>Object Read &amp; Write</strong>, scoped
              to the one bucket. Copy the access key id and the secret access
              key; the secret is shown once.
              <a
                href="https://developers.cloudflare.com/r2/api/tokens/"
                target="_blank"
                rel="noopener">Cloudflare's token page ↗</a
              > shows where these settings are.
            </p>
          </li>
          <li>
            <h3>Let this origin through CORS</h3>
            <p>
              Your browser sends the bytes straight to the bucket, so the bucket
              has to allow this page's origin.
              <a href="{base}/help#cors">The policy to paste is below.</a> Skipping
              this step is the most common reason an upload fails.
            </p>
          </li>
          <li>
            <h3>Attach it on a workspace</h3>
            <p>
              Open a workspace, expand <em>Bucket</em>, and fill in the form.
              The panel shows the URL it will sign for as you type, so you can
              see a mistake before anything is saved.
            </p>
            <p>
              <em>New workspace</em> takes the same fields, under
              <em>Attach a bucket (optional)</em>, so you can attach the bucket
              while you create the workspace.
            </p>
          </li>
        </ol>

        <h3>Which value goes where</h3>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="table-scroll"
          role="region"
          aria-label="Bucket field values"
          tabindex="0"
        >
          <table>
            <tbody>
              <tr>
                <td><strong>Endpoint</strong></td>
                <td>
                  The bucket's <em>S3 API</em> endpoint, which is the account
                  host rather than the bucket's public URL.
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
                  The bucket's name, for example <code>your-bucket-name</code>.
                  If you pasted a URL ending in the bucket name, it is already
                  filled in here.
                </td>
              </tr>
              <tr>
                <td
                  ><strong>Region</strong>
                  <span class="muted">(optional)</span></td
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
                  Leave it empty if the bucket is yours alone. Set it if the
                  bucket is shared with anything else: everything this workspace
                  writes goes under it, which keeps two users of one bucket
                  apart.
                </td>
              </tr>
              <tr>
                <td
                  ><strong>Access key id</strong><br /><strong
                    >Secret access key</strong
                  ></td
                >
                <td>
                  The pair from step 1. The id is not a secret and is stored
                  with the attachment; the secret is not stored anywhere.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>What lands in the bucket</h3>
        <p>
          Uploads write one object per document, at
          <code>&lt;prefix&gt;&lt;workspace-id&gt;/&lt;document-name&gt;</code>,
          for example
          <code>atelier/8f14e45f-ceea-4a4d-9b8e-1a24a1f0d3c7/doc.pcraft</code>.
          Each upload of the same document replaces its earlier object.
        </p>

        <h3>Starting a workspace from a bucket</h3>
        <p>
          A new workspace can start from a document the bucket already holds: in <em
            >New workspace</em
          >, choose
          <em>A cloud bucket</em>, fill in the fields, and
          <em>List documents</em>
          offers what is in the bucket. The workspace is made from the one you pick,
          with the bucket attached, and that document becomes the workspace's first
          version.
        </p>
        <p>
          In a workspace that is already going, use <em>Choose from bucket…</em>
          in the Bucket panel. It lists what the bucket holds, one row per document,
          and <em>Load</em> copies the one you pick into this workspace.
          <em>Download from bucket</em> does the same for the document stored under
          this workspace's own id, which is the button to use once a workspace and
          a bucket are a pair.
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
          On Cloudflare R2, open the bucket, then <em>Settings</em>, then
          <em>CORS Policy</em>, and paste this unchanged for this address:
        </p>
        <div class="snippet">
          <div class="snippet-head">
            <span class="muted"
              >CORS policy for <code>{origin}</code>, the address this page is
              served from</span
            >
            <button
              type="button"
              class:ok={copied === "copied"}
              onclick={copyPolicy}
              >{copied === "copied"
                ? "Copied"
                : copied === "blocked"
                  ? "Selected, press ⌘C"
                  : "Copy"}</button
            >
          </div>
          <pre bind:this={policy}><code>{cors}</code></pre>
        </div>
        <p class="muted">
          <code>ETag</code> has to be exposed for the upload record to include
          it. Without it the upload still works and the record has no ETag. The
          origin has to match the address bar exactly:
          <code>localhost:3000</code> and <code>127.0.0.1:3000</code> are
          <em>different origins</em>, with different cloudspaces and different
          CORS rules, so pick one and keep using it.
        </p>
      </section>
    {/if}

    <section class="panel" id="faq">
      <h2>FAQ</h2>
      <div class="qa-list">
        {#each faq as item}
          <details class="qa">
            <summary>{@html item.q}</summary>
            <div class="answer">{@html item.a}</div>
          </details>
        {/each}
      </div>
    </section>

    <section class="panel" id="troubleshooting">
      <h2>Troubleshooting</h2>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="table-scroll"
        role="region"
        aria-label="Troubleshooting errors"
        tabindex="0"
      >
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
                cross-origin response that the bucket has not allowed, so the
                error carries no further detail.
              </td>
              <td
                ><a href="{base}/help#cors">Add the policy above</a> to that bucket,
                using the origin from the address bar.</td
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
              <td
                >The token is valid but is not allowed to perform this action.</td
              >
              <td>
                The token needs <em>Object Read &amp; Write</em> on that bucket,
                not read-only access. Listing the bucket, which
                <em>Choose from bucket…</em> does, is the permission most often missing.
              </td>
            </tr>
            <tr>
              <td><code>404</code>, or "no such bucket"</td>
              <td>Wrong bucket name, or an endpoint for a different account.</td
              >
              <td
                >Compare both against the bucket's page in your provider's
                dashboard.</td
              >
            </tr>
            <tr>
              <td>Upload says it worked, but the bucket looks empty</td>
              <td
                >The object is not at the root of the bucket: its key starts
                with the workspace's id.</td
              >
              <td
                >Look under <code>&lt;prefix&gt;&lt;workspace-id&gt;/</code>,
                and check you are looking at the right bucket.</td
              >
            </tr>
            <tr>
              <td>"the signing key for this workspace's bucket is gone"</td>
              <td
                >The bucket attachment is still there, but the browser's key
                store is gone, either cleared or evicted.</td
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
                >The editor had the document open and saves its own copy on the
                next save.</td
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
                >Add the production origin to <code>AllowedOrigins</code> alongside
                the development one.</td
              >
            </tr>
            <tr>
              <td>The workspace page offers a bucket but nothing is set up</td>
              <td
                >That is normal: no bucket is configured until you attach one.</td
              >
              <td
                ><a href="{base}/help#setup">Attach a bucket</a>, or ignore it
                and keep working locally.</td
              >
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</div>

<style>
  .intro {
    max-width: 62ch;
    margin: 0.4rem 0 1.6rem;
    color: var(--dim);
    font-size: 1.02rem;
  }

  /* One column on a phone, the contents list in its own sticky column on a wide screen. */
  .docs {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1.25rem;
    align-items: start;
  }

  /* A grid item refuses to shrink below its content unless it is told it may. The tables inside
     scroll on their own, so the column needs no floor at all. */
  .docs > .stack,
  .toc {
    min-width: 0;
  }

  @media (min-width: 64rem) {
    .docs {
      grid-template-columns: 14rem minmax(0, 1fr);
      gap: 2rem;
    }

    .toc {
      position: sticky;
      top: 1rem;
    }
  }

  .toc details {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 0.55rem 0.7rem 0.65rem;
  }

  .toc summary {
    position: relative;
    cursor: pointer;
    list-style: none;
    padding-right: 1.2rem;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
  }

  .toc summary::-webkit-details-marker {
    display: none;
  }

  .toc summary::after {
    content: "";
    position: absolute;
    right: 0.2rem;
    top: 0.45rem;
    width: 0.4rem;
    height: 0.4rem;
    border-right: 1.5px solid var(--dim);
    border-bottom: 1.5px solid var(--dim);
    transform: rotate(45deg);
    transition: transform 150ms ease;
  }

  .toc details[open] summary::after {
    transform: rotate(-135deg);
  }

  .toc nav {
    display: flex;
    flex-direction: column;
    margin-top: 0.45rem;
  }

  .toc a {
    color: var(--dim);
    text-decoration: none;
    font-size: 0.9rem;
    padding: 0.3rem 0.5rem;
    border-left: 2px solid transparent;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .toc a:hover {
    background: var(--hover);
    color: var(--ink);
  }

  /* The section the reader is in, marked the way the app bar marks the page. */
  .toc a[aria-current="true"] {
    background: var(--hover);
    border-left-color: var(--accent);
    color: var(--ink);
    font-weight: 600;
  }

  /* Prose keeps a readable measure; tables and snippets keep the column's full width. */
  .panel p,
  .panel li,
  .panel h3 {
    max-width: 68ch;
  }

  h3 {
    font-size: 0.95rem;
    margin: 1.1rem 0 0.3rem;
  }

  section[id] {
    scroll-margin-top: 1rem;
  }

  /* The bucket walkthrough, as three numbered steps rather than three headings that pretend to be
     a list. */
  .steps {
    list-style: none;
    counter-reset: step;
    padding: 0;
    margin: 1.2rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .steps > li {
    counter-increment: step;
    position: relative;
    padding-left: 2.4rem;
  }

  .steps > li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: -0.15rem;
    display: grid;
    place-items: center;
    width: 1.65rem;
    height: 1.65rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--ink);
    font-size: 0.82rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .steps h3 {
    margin: 0 0 0.25rem;
    font-size: 1rem;
  }

  .steps p {
    margin: 0 0 0.5rem;
  }

  .steps p:last-child {
    margin-bottom: 0;
  }

  /* Questions open in place: the question is the thing a reader scans for. */
  .qa {
    border-bottom: 1px solid var(--line);
  }

  .qa:last-child {
    border-bottom: 0;
  }

  .qa summary {
    position: relative;
    cursor: pointer;
    list-style: none;
    padding: 0.7rem 1.6rem 0.7rem 0;
    font-weight: 600;
  }

  .qa summary::-webkit-details-marker {
    display: none;
  }

  .qa summary::after {
    content: "";
    position: absolute;
    right: 0.35rem;
    top: 1.05rem;
    width: 0.45rem;
    height: 0.45rem;
    border-right: 1.5px solid var(--dim);
    border-bottom: 1.5px solid var(--dim);
    transform: rotate(45deg);
    transition: transform 150ms ease;
  }

  .qa[open] summary::after {
    transform: rotate(-135deg);
  }

  .qa .answer {
    padding: 0 0 0.85rem;
    max-width: 68ch;
  }

  .qa .answer :global(p) {
    margin: 0 0 0.5rem;
  }

  .qa .answer :global(p:last-child) {
    margin-bottom: 0;
  }

  pre {
    margin: 0;
    padding: 0.7rem 0.85rem;
    overflow-x: auto;
    font-size: 0.82rem;
    line-height: 1.45;
  }

  /* A wide table scrolls inside its own box instead of widening the page. */
  .table-scroll {
    overflow-x: auto;
  }

  .table-scroll:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  td,
  th {
    overflow-wrap: anywhere;
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

  /* A phone has no room for labels beside their values. */
  @media (max-width: 30rem) {
    table td:first-child {
      width: auto;
    }
  }
</style>
