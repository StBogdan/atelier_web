<script lang="ts">
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { browser } from "$app/environment";
  import Thumb from "$lib/Thumb.svelte";
  import Icon from "$lib/Icon.svelte";
  import BucketFields from "$lib/BucketFields.svelte";
  import Problem from "$lib/Problem.svelte";
  import { bytes, since } from "$lib/format";
  import {
    attachBucket,
    bucketDocuments,
    detachBucket,
    downloadObject,
    listObjects,
    readBucketConfig,
    signingFor,
    type BucketConfig,
    type BucketDocument,
  } from "$lib/bucket";
  import {
    commitAndUpload,
    downloadWorkspace,
    type CommitResult,
  } from "$lib/actions";
  import {
    createProject,
    documentFileName,
    ensureSpace,
    isPcraftName,
    removeProject,
    type Workspace,
  } from "$lib/contract";
  import { normalisePrefix, prefixUrl, resolveBucket } from "$lib/sigv4";
  import type { Directory } from "$lib/opfs";
  import {
    ensurePersistence,
    refresh,
    unsynced,
    workspaces,
  } from "$lib/session";

  interface Sample {
    file: string;
    name: string;
    bytes: number;
  }

  /** What a card says the workspace holds: the one document it names, or how many there are. */
  function workspaceDocumentLabel(workspace: Workspace): string {
    if (!workspace.documents.length) return "no document yet";
    if (workspace.documents.length === 1)
      return workspace.document ?? workspace.documents[0].name;
    return `${workspace.documents.length} documents`;
  }

  /**
   * What the picker offers: the formats the editor's own importer reads, which is the only thing that
   * decides whether a document can be opened. The picker's filter is a convenience — a document the
   * editor cannot read is still accepted, and it reports that itself when it is opened.
   */
  const DOCUMENT_EXTENSIONS = [
    ".pcraft",
    ".psd",
    ".psb",
    ".psdt",
    ".png",
    ".jpg",
    ".jpeg",
    ".tif",
    ".tiff",
    ".webp",
    ".gif",
    ".bmp",
    ".tga",
    ".ico",
    ".qoi",
    ".exr",
    ".hdr",
    ".svg",
    ".svgz",
    ".ora",
    ".kra",
    ".krz",
    ".pdn",
    ".dng",
    ".cr2",
    ".cr3",
    ".nef",
    ".arw",
    ".raf",
  ].join(",");

  let dialog = $state<HTMLDialogElement | null>(null);
  let name = $state("");
  let busy = $state(false);
  let problem = $state<unknown>(null);
  let samples = $state<Sample[]>([]);
  let source = $state<"empty" | "sample" | "file" | "bucket">("empty");
  let sample = $state("");
  /** The documents chosen from this computer, in the order they were picked. */
  let files = $state<File[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);
  /**
   * The dialog's optional bucket. These are the same fields the workspace page's *Bucket* panel takes, so
   * a workspace can be given its bucket as it is made rather than opened and given one afterwards — and
   * a workspace can be *started* from one, which is the same bucket read the other way round.
   */
  let withBucket = $state(false);
  let bucketForm = $state({
    endpoint: "",
    bucket: "",
    region: "auto",
    prefix: "",
    accessKeyId: "",
    secretAccessKey: "",
  });
  /** The bucket name the fields put in the field themselves, so a paste does not overwrite a typed one. */
  let bucketFilled = $state("");
  /** What the bucket holds, once it has been listed, and which of them to start from. `null` until asked. */
  let bucketList = $state<BucketDocument[] | null>(null);
  let bucketChoice = $state("");
  let listing = $state(false);
  let listProblem = $state<unknown>(null);
  /** The fields a listing was taken from, as one string. */
  let listedFor = $state("");
  const now = Date.now();

  /** Whether this creation attaches a bucket: asked for on its own, or because the document comes from one. */
  const attaching = $derived(withBucket || source === "bucket");

  /**
   * A source that needs a bucket cannot outlive the section that holds its fields: shut the section and the
   * creation goes back to being an ordinary one, rather than attaching a bucket from a form nobody can see.
   * It reads the element rather than `withBucket`, because `bind:open`'s own listener may not have run yet.
   */
  function onBucketToggle(
    event: Event & { currentTarget: HTMLDetailsElement },
  ) {
    if (!event.currentTarget.open && source === "bucket") source = "empty";
  }

  /**
   * A listing belongs to the fields that produced it: change the account, the bucket, the prefix or the key,
   * and what was listed is a list of something else. So the listing is only ever *shown* while the fields
   * still name the bucket it came from, and an edit simply puts the list away.
   */
  const bucketFields = $derived(
    [
      bucketForm.endpoint,
      bucketForm.bucket,
      bucketForm.region,
      bucketForm.prefix,
      bucketForm.accessKeyId,
    ].join("\n"),
  );
  const documents = $derived(
    bucketList !== null && listedFor === bucketFields ? bucketList : null,
  );
  /** The document to start from: the one chosen, or the bucket's most recent when none has been. */
  const chosen = $derived(
    documents?.find((document) => document.key === bucketChoice) ??
      documents?.[0] ??
      null,
  );

  /**
   * What the bucket option would sign for, or null while the fields do not yet name one. The workspace
   * has no id and no document until it exists, so this is as far as the URL can be known — and it is
   * resolved the way `attachBucket` resolves it, so the two cannot disagree.
   */
  const bucketPreview = $derived.by(() => {
    if (!attaching || !bucketForm.endpoint.trim()) return null;
    try {
      const { endpoint, bucket } = resolveBucket(
        bucketForm.endpoint,
        bucketForm.bucket,
      );
      if (!bucket) return null;
      return prefixUrl({
        endpoint,
        bucket,
        prefix: normalisePrefix(bucketForm.prefix),
      });
    } catch {
      return null;
    }
  });

  /**
   * How the list is drawn — a card each or a row each, and whether previews are shown. Both are the
   * reader's choice rather than the data's, so they are remembered per browser (`localStorage`), the
   * same way the storage-permission question is.
   */
  const VIEW_KEY = "atelier-cloud:workspace-view";
  const THUMBS_KEY = "atelier-cloud:workspace-thumbnails";
  const remembered = (key: string) =>
    browser ? localStorage.getItem(key) : null;

  let view = $state<"grid" | "list">(
    remembered(VIEW_KEY) === "list" ? "list" : "grid",
  );
  let thumbs = $state(remembered(THUMBS_KEY) !== "0");

  function remember(key: string, value: string) {
    if (browser) localStorage.setItem(key, value);
  }

  function setView(next: "grid" | "list") {
    view = next;
    remember(VIEW_KEY, next);
  }

  function toggleThumbs() {
    thumbs = !thumbs;
    remember(THUMBS_KEY, thumbs ? "1" : "0");
  }

  /**
   * Which workspaces have a bucket attached, so the row's action can say what it will do: the commit is
   * the same either way, but only one of them has somewhere to upload to. This reads `bucket.json` only —
   * knowing a bucket is attached never needs the key that signs for it.
   */
  let buckets = $state<Record<string, BucketConfig>>({});

  $effect(() => {
    const list = $workspaces;
    void (async () => {
      try {
        const space = await ensureSpace();
        const found: Record<string, BucketConfig> = {};
        for (const workspace of list) {
          const config = await readBucketConfig(space, workspace.id);
          if (config) found[workspace.id] = config;
        }
        buckets = found;
      } catch {
        buckets = {};
      }
    })();
  });

  /**
   * What the keep action says it will do. It is one button either way — the commit — but only a
   * workspace with a bucket has anywhere to send it, and only a workspace with changes has anything
   * to send.
   */
  function keepTip(workspace: Workspace): string {
    if (!workspace.dirty) return `${workspace.name} has no changes to commit`;
    const bucket = buckets[workspace.id];
    return bucket
      ? `Commit ${workspace.name} and upload it to ${bucket.bucket}`
      : `Record ${workspace.name} as a version here. No bucket is attached, so there is nowhere to upload it.`;
  }

  /** What the last row action failed with, when it is worth a heading rather than one coloured line. */
  let failure = $state<unknown>(null);

  /** Which workspace's row is working, so its buttons can wait rather than being pressed twice. */
  let working = $state<string | null>(null);
  /** What the last row action did, or why it could not, in the page's own banner. */
  /**
   * The page's own status line: what the last row action did, or why it could not. It is built from
   * parts rather than a string, so the bits worth reading at a glance — a document, a destination —
   * can be weighted, and so an informational line reads blue rather than as another warning.
   */
  type Status = {
    kind: "info" | "bad";
    parts: { text: string; strong?: boolean }[];
  };
  let status = $state<Status | null>(null);

  /** A status line from a sentence, with `{ strong: … }` where a bit is worth reading closely. */
  function line(
    kind: Status["kind"],
    ...parts: (string | { strong: string })[]
  ): Status {
    return {
      kind,
      parts: parts.map((part) =>
        typeof part === "string"
          ? { text: part }
          : { text: part.strong, strong: true },
      ),
    };
  }

  /**
   * Keep the workspace (a revision, then its bucket copy) or take it away (the document), without
   * opening it. The editor is for changing a document; this is for not losing one.
   */
  async function act(workspace: Workspace, what: "keep" | "take") {
    working = workspace.id;
    failure = null;
    status =
      what === "keep"
        ? line(
            "info",
            "Committing ",
            { strong: workspace.name },
            " and uploading it…",
          )
        : line("info", "Downloading ", { strong: workspace.name }, "…");
    try {
      const space = await ensureSpace();
      if (what === "take") {
        status = line(
          "info",
          "Downloaded ",
          { strong: await downloadWorkspace(space, workspace.id) },
          ".",
        );
        return;
      }
      const result = await commitAndUpload(space, workspace.id);
      await refresh();
      status = describe(workspace.name, result);
    } catch (e) {
      failure = e;
      status = null;
    } finally {
      working = null;
    }
  }

  function describe(name: string, result: CommitResult): Status {
    if (result.committed && result.uploaded) {
      return line(
        "info",
        "Committed ",
        { strong: name },
        ` at rev ${result.rev}, and uploaded `,
        { strong: result.uploaded.name },
        ` (${bytes(result.uploaded.size)}) to `,
        { strong: result.uploaded.where },
        ".",
      );
    }
    if (result.committed) {
      return line(
        "info",
        "Committed ",
        { strong: name },
        ` at rev ${result.rev}.`,
      );
    }
    if (result.uploaded) {
      return line(
        "info",
        "Nothing new to commit: uploaded ",
        { strong: result.uploaded.name },
        ` (${bytes(result.uploaded.size)}) to `,
        { strong: result.uploaded.where },
        ".",
      );
    }
    return line("info", { strong: name }, ` is already at rev ${result.rev}.`);
  }

  onMount(() => {
    void (async () => {
      try {
        const response = await fetch(`${base}/samples/index.json`);
        if (!response.ok) return;
        const index = (await response.json()) as { samples?: Sample[] };
        samples = index.samples ?? [];
      } catch {
        // Without the bundled documents the dialog still offers an empty workspace.
      }
    })();
  });

  function open() {
    problem = null;
    name = `Workspace ${$workspaces.length + 1}`;
    source = samples.length ? "sample" : "empty";
    sample = samples[0]?.file ?? "";
    files = [];
    if (fileInput) fileInput.value = "";
    withBucket = false;
    bucketForm = {
      endpoint: "",
      bucket: "",
      region: "auto",
      prefix: "",
      accessKeyId: "",
      secretAccessKey: "",
    };
    bucketFilled = "";
    bucketList = null;
    bucketChoice = "";
    listProblem = null;
    listedFor = "";
    dialog?.showModal();
  }

  /**
   * The field has to work on its own: the label's control is the radio, and a label ignores clicks on
   * its own interactive descendants, so a disabled field swallowed the click and no picker appeared.
   */
  function chooseFile(event: Event & { currentTarget: HTMLInputElement }) {
    source = "file";
    files = [...(event.currentTarget.files ?? [])];
  }

  /**
   * List the bucket the fields name, so a workspace can be started from a document already in it. This
   * signs with the fields alone — nothing is attached anywhere yet, because there is no workspace yet.
   */
  async function listBucket() {
    listing = true;
    listProblem = null;
    bucketList = null;
    listedFor = "";
    try {
      const attachment = await signingFor(bucketForm);
      const { objects } = await listObjects(attachment);
      bucketList = bucketDocuments(objects);
      listedFor = bucketFields;
      bucketChoice = bucketList[0]?.key ?? "";
    } catch (e) {
      listProblem = e;
    } finally {
      listing = false;
    }
  }

  async function create() {
    busy = true;
    problem = null;
    try {
      await ensurePersistence();
      const space = await ensureSpace();
      let documents: { name: string; bytes: Uint8Array }[] = [];
      if (source === "sample" && sample) {
        const response = await fetch(`${base}/samples/${sample}`);
        if (!response.ok)
          throw new Error(`could not fetch ${sample}: ${response.status}`);
        documents = [
          {
            name: documentFileName(sample),
            bytes: new Uint8Array(await response.arrayBuffer()),
          },
        ];
      } else if (source === "file") {
        if (!files.length) throw new Error("choose a document");
        // Read every chosen file before anything is written, so a partly-read set cannot leave a
        // half-made workspace behind.
        documents = await Promise.all(
          files.map(async (chosen) => ({
            name: documentFileName(chosen.name),
            bytes: new Uint8Array(await chosen.arrayBuffer()),
          })),
        );
      } else if (source === "bucket") {
        if (!chosen)
          throw new Error(
            "list the bucket and choose a document to start from",
          );
        const attachment = await signingFor(bucketForm);
        documents = [
          {
            name: documentFileName(chosen.name),
            bytes: await downloadObject(attachment, chosen.logical),
          },
        ];
      }
      // The bucket is read before anything is written, so a bucket that cannot be reached leaves no
      // half-made workspace behind to explain.
      const created = await createProject(space, { name, documents });
      const bucket = attaching ? await attachOrUndo(space, created.id) : null;
      dialog?.close();
      await refresh();
      if (bucket) {
        const from =
          source === "bucket" && chosen ? `, starting from ${chosen.key}` : "";
        status = line(
          "info",
          "Created ",
          { strong: created.name },
          from,
          ", attached to ",
          { strong: bucket.bucket },
          ".",
        );
      }
    } catch (e) {
      problem = e;
      // A creation that was undone has already touched the catalog, so the grid re-reads either way.
      await refresh();
    } finally {
      busy = false;
    }
  }

  /**
   * Attach the bucket the dialog collected, or leave nothing behind at all. A workspace made for a bucket
   * that could not be attached is not what was asked for, and keeping it would put a second one behind
   * the next click on *Create*; the message belongs in the dialog, which is what has to change.
   */
  async function attachOrUndo(
    space: Directory,
    id: string,
  ): Promise<BucketConfig> {
    try {
      const attached = await attachBucket(space, id, bucketForm);
      bucketForm.secretAccessKey = "";
      return attached;
    } catch (e) {
      await detachBucket(space, id).catch(() => {});
      await removeProject(space, id).catch(() => {});
      throw e;
    }
  }

  /**
   * The header's *In new workspace* action links here with `?new`, because the editor cannot be
   * opened until a workspace exists to open it into: bring up the dialog that creates one, then drop
   * the flag so a reload does not reopen it.
   */
  $effect(() => {
    if (!page.url.searchParams.has("new")) return;
    open();
    void replaceState(`${base}/`, {});
  });
</script>

<svelte:head><title>Workspaces — Atelier Cloud</title></svelte:head>

<div class="head">
  <h1>Workspaces</h1>
  {#if $workspaces.length}
    <div class="controls">
      <div class="segmented" role="group" aria-label="Workspace layout">
        <button
          aria-pressed={view === "grid"}
          title="One card per workspace"
          onclick={() => setView("grid")}>Grid</button
        >
        <button
          aria-pressed={view === "list"}
          title="One row per workspace"
          onclick={() => setView("list")}>List</button
        >
      </div>
      <button
        class="toggle"
        aria-pressed={thumbs}
        title={thumbs ? "Hide the preview images" : "Show the preview images"}
        onclick={toggleThumbs}>Thumbnails</button
      >
      <button class="primary" onclick={open}>New workspace</button>
    </div>
  {/if}
</div>

{#if $unsynced > 0}
  <p class="banner">
    {$unsynced === 1 ? "One workspace has" : `${$unsynced} workspaces have`} changes
    that are not committed yet.
  </p>
{/if}

{#if failure}
  <Problem problem={failure} banner />
{/if}

{#if status}
  <p
    class="banner"
    class:info={status.kind === "info"}
    class:bad={status.kind === "bad"}
  >
    {#each status.parts as part}{#if part.strong}<strong>{part.text}</strong
        >{:else}{part.text}{/if}{/each}
  </p>
{/if}

{#if $workspaces.length === 0}
  <div class="panel empty">
    <h2>No workspaces yet</h2>
    <p class="muted">
      A workspace is a project directory in this origin's OPFS. Nothing on this
      page touches the network beyond this origin's own files, and nothing is
      uploaded anywhere.
    </p>
    <div class="row">
      <button class="primary" onclick={open}>New workspace</button>
      <a class="button" href="{base}/settings">Local storage</a>
    </div>
    <p class="muted small">
      Importing a zip, and signing in to see a team's workspaces, are planned
      rather than here.
    </p>
  </div>
{/if}

{#if $workspaces.length}
  <div class={view === "grid" ? "grid" : "list"}>
    {#each $workspaces as workspace (workspace.id)}
      <article class="panel card">
        {#if thumbs}
          <Thumb
            id={workspace.id}
            available={workspace.thumb}
            size={view === "grid" ? 88 : 44}
          />
        {/if}
        <div class="body">
          <h2 title={workspace.name}>
            <a class="name" href="{base}/workspace/{workspace.id}"
              >{workspace.name}</a
            >
          </h2>
          <div class="facts">
            <p class="muted small">
              {workspaceDocumentLabel(workspace)} · {bytes(workspace.size)} local
            </p>
            <p class="small">
              {#if workspace.dirty}
                <span class="warn">◐ uncommitted changes</span>
              {:else}
                <span class="ok">● committed</span>
                <span class="muted">· {since(workspace.updatedAt, now)}</span>
              {/if}
              {#if buckets[workspace.id]}
                <span
                  class="bucket"
                  role="img"
                  aria-label="A bucket is attached: {buckets[workspace.id]
                    .bucket}"
                  title="A bucket is attached ({buckets[workspace.id]
                    .bucket}), so a commit can also be copied off this machine."
                >
                  <Icon name="bucket" size={16} />
                </span>
              {/if}
            </p>
            {#if workspace.broken}
              <p class="bad small">{workspace.broken}</p>
            {/if}
          </div>
          <div class="actions">
            <div class="row">
              <a
                class="button primary"
                href="/?project={workspace.id}"
                target="_blank"
                rel="noopener"
              >
                <Icon name="edit" />
                Editor
              </a>
              <a class="button" href="{base}/workspace/{workspace.id}"
                >Details</a
              >
            </div>
            <div class="row">
              {#if buckets[workspace.id]}
                <button
                  class="action-button"
                  class:primary={workspace.dirty}
                  title={keepTip(workspace)}
                  disabled={working !== null || !workspace.dirty}
                  onclick={() => act(workspace, "keep")}
                >
                  <Icon name="upload" />
                  Commit &amp; upload
                </button>
              {:else}
                <button
                  class="action-button"
                  class:primary={workspace.dirty}
                  title={keepTip(workspace)}
                  disabled={working !== null || !workspace.dirty}
                  onclick={() => act(workspace, "keep")}
                >
                  <Icon name="commit" />
                  Commit
                </button>
              {/if}
              <button
                class="action-button"
                title="Download {workspace.name} to this computer"
                disabled={working !== null}
                onclick={() => act(workspace, "take")}
              >
                <Icon name="download" />
                Download
              </button>
            </div>
          </div>
        </div>
      </article>
    {/each}
  </div>
{/if}

<footer class="panel notice">
  <p class="lead">
    <span class="chip alpha">Alpha</span>
    <strong>Atelier Cloud is alpha software</strong>
  </p>
  <p class="small muted">
    It is early, unfinished work, offered as is and with <b
      >no warranty of any kind</b
    >, express or implied — including merchantability and fitness for a
    particular purpose. A workspace lives in this browser and can be cleared at
    any time, so keep your own copies of anything that matters.
  </p>
  <p class="small muted">
    The editor is <b>PhotoCraft</b>, the ArtCraft Team's editor — copyright ©
    2026 ArtCraft Team and the PhotoCraft contributors. Source code, licence
    texts and the full attribution list:
    <a
      href="https://github.com/storytold/photocraft"
      target="_blank"
      rel="noopener">github.com/storytold/photocraft</a
    >.
  </p>
</footer>

<dialog bind:this={dialog}>
  <form class="stack" onsubmit={(event) => event.preventDefault()}>
    <h2>New workspace</h2>
    <label>
      Name
      <input type="text" bind:value={name} />
    </label>
    <fieldset>
      <legend>Start from</legend>
      <label class="option">
        <input type="radio" value="empty" bind:group={source} />
        An empty workspace: create the document locally
      </label>
      <label class="option">
        <input
          type="radio"
          value="sample"
          bind:group={source}
          disabled={samples.length === 0}
        />
        A bundled document
        <select bind:value={sample} disabled={source !== "sample"}>
          {#each samples as entry (entry.file)}
            <option value={entry.file}
              >{entry.name} ({bytes(entry.bytes)})</option
            >
          {/each}
        </select>
      </label>
      <label class="option">
        <input type="radio" value="file" bind:group={source} />
        {files.length > 1
          ? `${files.length} documents from this computer`
          : "A document from this computer"}
        <input
          type="file"
          multiple
          accept={DOCUMENT_EXTENSIONS}
          bind:this={fileInput}
          onchange={chooseFile}
        />
        {#if files.length}
          <span class="muted small"
            >{files.map((chosen) => chosen.name).join(", ")}{files.some(
              (chosen) => !isPcraftName(chosen.name),
            )
              ? " — saved as it is"
              : ""}</span
          >
        {/if}
      </label>
      <label class="option">
        <input
          type="radio"
          value="bucket"
          bind:group={source}
          onchange={() => (withBucket = true)}
        />
        A cloud bucket
      </label>
    </fieldset>
    <details
      class="bucket-option"
      bind:open={withBucket}
      ontoggle={onBucketToggle}
    >
      <summary>Attach a bucket (optional)</summary>
      {#if withBucket}
        <div class="fields">
          <BucketFields bind:form={bucketForm} bind:filled={bucketFilled} />
          {#if source === "bucket"}
            <div class="row">
              <button type="button" onclick={listBucket} disabled={listing}>
                {listing ? "Listing…" : "List documents"}
              </button>
            </div>
            {#if listProblem}
              <Problem problem={listProblem} small />
            {:else if documents?.length === 0}
              <p class="muted small">
                The bucket holds no <code>.pcraft</code> documents.
              </p>
            {:else if documents}
              <label>
                Start from
                <select bind:value={bucketChoice}>
                  {#each documents as document (document.key)}
                    <option value={document.key}
                      >{document.key} ({bytes(document.size)})</option
                    >
                  {/each}
                </select>
              </label>
            {:else}
              <p class="muted small">
                List the bucket to choose the document to start from.
              </p>
            {/if}
          {/if}
          {#if bucketPreview}
            <p class="muted small">
              Writes under <span class="mono">{bucketPreview}</span>
            </p>
          {/if}
          <p class="muted small">
            The credential stays in this browser, and the bytes go from here
            straight to the bucket.
            <a href="{base}/help#setup">How this works</a>
          </p>
        </div>
      {/if}
    </details>
    {#if problem}
      <Problem {problem} small />
    {/if}
    <div class="row">
      <button
        class="primary"
        onclick={create}
        disabled={busy || (source === "bucket" && !chosen)}
      >
        {busy ? "Creating…" : "Create"}
      </button>
      <button onclick={() => dialog?.close()} disabled={busy}>Cancel</button>
    </div>
  </form>
</dialog>

<style>
  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .notice {
    margin-top: 1.5rem;
  }

  .notice .lead {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0 0 0.5rem;
  }

  .notice .chip.alpha {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 45%, var(--line));
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .notice a {
    color: var(--accent);
  }

  .notice p:last-child {
    margin-bottom: 0;
  }

  .controls {
    margin-left: auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  /* A toolbar: labels stay on one line, and the row wraps rather than squeezing them. */
  .controls button {
    white-space: nowrap;
  }

  /* Grid ⇄ list, as a segmented pair, and the previews as a button that stays pressed. */
  .segmented {
    display: flex;
    border: 1px solid var(--field-line);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .segmented button {
    border: 0;
    border-radius: 0;
    padding: 0.32rem 0.7rem;
    font-size: 0.82rem;
    color: var(--dim);
  }

  .segmented button + button {
    border-left: 1px solid var(--field-line);
  }

  .toggle {
    font-size: 0.82rem;
    padding: 0.32rem 0.7rem;
    color: var(--dim);
  }

  .segmented button[aria-pressed="true"],
  .toggle[aria-pressed="true"] {
    background: var(--pressed);
    color: var(--ink);
  }

  /* List: the same card, laid out as one row per workspace, the details against the right edge. */
  .list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .list .card {
    align-items: center;
    padding: 0.5rem 0.9rem;
  }

  .list .body {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    min-width: 0;
  }

  /* The name keeps the left edge, and gives way (ellipsis) before the details do. */
  /* A workspace that can send a copy off this machine says so: the cloud is drawn only when a bucket is
	   attached, so a card without one is not marked by the absence of anything. The bucket is named on
	   hover. */
  .bucket {
    display: inline-flex;
    align-items: center;
    margin-left: 0.4rem;
    color: var(--ok);
  }

  /* The row's two icon actions: an icon and its label, the same height as the buttons beside them. */
  .action-button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--dim);
    white-space: nowrap;
  }

  .action-button:hover:not(:disabled) {
    color: var(--ink);
  }

  /* The one action that protects work: solid, so it reads as the thing to press when the badge
     beside it says there is something to commit. */
  .action-button.primary {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--primary-ink);
    padding: 0.15rem 0.55rem;
  }

  .action-button.primary:hover:not(:disabled) {
    color: var(--primary-ink);
    filter: brightness(1.08);
  }

  /* What a row action did is information, not a warning: blue, with the document and destination
	   standing out from the sentence around them. A failure keeps the banner's own red. */
  .banner.info {
    border-left-color: var(--accent);
    color: var(--accent);
  }

  /* The name keeps the left edge and gives way before the details do. It wraps rather than being cut
	   off, up to the four lines the base rule allows, so a long name can be read. */
  .list .body h2 {
    font-size: 0.98rem;
    margin: 0;
    min-width: 8rem;
  }

  /* The facts and the actions hold the right edge, in that order. */
  .list .facts {
    margin-left: auto;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: flex-end;
    gap: 0.1rem 0.85rem;
  }

  .list .facts p,
  .list .body .actions {
    margin: 0;
  }

  /* The actions never shrink — the facts give way instead — and they stay a tidy 2 by 2. */
  .list .body .actions {
    flex: 0 0 auto;
  }

  /* Narrow: the details drop under the name rather than squeezing it to nothing. */
  @media (max-width: 46rem) {
    .list .body {
      flex-wrap: wrap;
    }

    .list .facts {
      margin-left: 0;
      justify-content: flex-start;
    }
  }

  .empty {
    max-width: 40rem;
  }

  .small {
    font-size: 0.86rem;
    margin: 0.15rem 0;
  }

  .card {
    display: flex;
    gap: 0.9rem;
    padding: 0.9rem;
  }

  .body {
    min-width: 0;
    flex: 1;
  }

  /* A long name wraps, up to four lines, and stops there; the full text stays in the tooltip. */
  .body h2 {
    margin: 0 0 0.2rem;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    overflow: hidden;
  }

  /* The name is the way into the workspace, so it reads as a link without turning into a button:
	   the heading's own colour, underlined when the pointer or the keyboard is on it. */
  .name {
    color: inherit;
    text-decoration: none;
  }

  .name:hover,
  .name:focus-visible {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* Editor and Details over Commit and Download: two rows, so the card's actions are not one long
	   ribbon of buttons, and the card's own line-up does not become a grid of columns. The rows are
	   independent — each is only as wide as its own buttons — so a longer row below cannot open a blank
	   gap in the short row above it. */
  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    align-items: flex-start;
  }

  /* The way into the editor carries the glyph of what it does, like the two actions beside and below
	   it, and sits on their line rather than a few pixels off it. */
  .actions .button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .body .actions {
    margin-top: 0.6rem;
  }

  fieldset {
    border: 1px solid var(--line);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* The dialog's optional bucket, shaped like the fieldset above it, and shut until it is wanted.
	   Not `.bucket`: that name is the card's cloud icon, down in the list. */
  .bucket-option {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.5rem 0.6rem 0.6rem;
  }

  .bucket-option > summary {
    cursor: pointer;
    color: var(--dim);
  }

  .bucket-option .fields {
    display: grid;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  /* The one field the dialog brings itself — which document to start from — dressed like the ones the
	   bucket form brings: the caption above its control, quiet, small. */
  .bucket-option .fields > label {
    display: grid;
    gap: 0.15rem;
    font-size: 0.86rem;
    color: var(--dim);
  }

  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  legend {
    color: var(--dim);
    padding: 0 0.3rem;
  }
</style>
