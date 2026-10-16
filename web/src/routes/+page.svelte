<script lang="ts">
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { browser } from "$app/environment";
  import Thumb from "$lib/Thumb.svelte";
  import Icon from "$lib/Icon.svelte";
  import { bytes, since } from "$lib/format";
  import { readBucketConfig, type BucketConfig } from "$lib/bucket";
  import {
    commitAndUpload,
    downloadWorkspace,
    type CommitResult,
  } from "$lib/actions";
  import {
    createProject,
    documentFileName,
    ensureSpace,
    type Workspace,
  } from "$lib/contract";
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

  let dialog = $state<HTMLDialogElement | null>(null);
  let name = $state("");
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let samples = $state<Sample[]>([]);
  let source = $state<"empty" | "sample" | "file">("empty");
  let sample = $state("");
  let file = $state<File | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  const now = Date.now();

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
      status = line("bad", e instanceof Error ? e.message : String(e));
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
    file = null;
    if (fileInput) fileInput.value = "";
    dialog?.showModal();
  }

  /**
   * The field has to work on its own: the label's control is the radio, and a label ignores clicks on
   * its own interactive descendants, so a disabled field swallowed the click and no picker appeared.
   */
  function chooseFile(event: Event & { currentTarget: HTMLInputElement }) {
    source = "file";
    file = event.currentTarget.files?.[0] ?? null;
  }

  async function create() {
    busy = true;
    problem = null;
    try {
      await ensurePersistence();
      let document: { name: string; bytes: Uint8Array } | null = null;
      if (source === "sample" && sample) {
        const response = await fetch(`${base}/samples/${sample}`);
        if (!response.ok)
          throw new Error(`could not fetch ${sample}: ${response.status}`);
        document = {
          name: documentFileName(sample),
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      } else if (source === "file") {
        if (!file) throw new Error("choose a .pcraft file");
        document = {
          name: documentFileName(file.name),
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }
      await createProject(await ensureSpace(), { name, document });
      dialog?.close();
      await refresh();
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
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
    that are not committed yet: they live in <code>atelier-cloud/outbox/</code>.
  </p>
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
          <h2 title={workspace.name}>{workspace.name}</h2>
          <div class="facts">
            <p class="muted small">
              {workspace.document || "no document yet"} · {bytes(
                workspace.size,
              )} local
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
    >, express or implied — including merchantability, fitness for a particular
    purpose and non-infringement. A workspace lives in this browser and can be
    cleared at any time, so keep your own copies of anything that matters.
  </p>
  <p class="small muted">
    The editor is <b>PhotoCraft</b>, the ArtCraft Team's editor — copyright ©
    2026 ArtCraft Team and the PhotoCraft contributors — used under its
    <a
      href="https://github.com/storytold/photocraft/blob/main/LICENSE-MIT"
      target="_blank"
      rel="noopener">MIT</a
    >
    or
    <a
      href="https://github.com/storytold/photocraft/blob/main/LICENSE-APACHE"
      target="_blank"
      rel="noopener">Apache&nbsp;2.0</a
    >
    licence, at your option. Source code, licence texts and the full attribution list:
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
        A <code>.pcraft</code> file from this computer
        <input
          type="file"
          accept=".pcraft"
          bind:this={fileInput}
          onchange={chooseFile}
        />
      </label>
    </fieldset>
    {#if problem}
      <p class="bad small">{problem}</p>
    {/if}
    <div class="row">
      <button class="primary" onclick={create} disabled={busy}
        >{busy ? "Creating…" : "Create"}</button
      >
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
