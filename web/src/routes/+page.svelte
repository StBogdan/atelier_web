<script lang="ts">
  import { onMount, tick } from "svelte";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { browser } from "$app/environment";
  import Thumb from "$lib/Thumb.svelte";
  import Icon from "$lib/Icon.svelte";
  import BucketFields from "$lib/BucketFields.svelte";
  import Problem from "$lib/Problem.svelte";
  import { ORIGIN } from "$lib/site";
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
  import { downloadWorkspaceFiles } from "$lib/actions";
  import {
    createProject,
    documentFileName,
    ensureSpace,
    removeProject,
    sanitiseDocumentName,
    takeHandoff,
    type Workspace,
  } from "$lib/contract";
  import {
    DEFAULT_EDITOR,
    EDITORS,
    editorById,
    editorFor,
    editorHref,
  } from "$lib/editors";
  import { resolveTarget } from "$lib/sigv4";
  import type { Directory } from "$lib/opfs";
  import { ensurePersistence, refresh, workspaces } from "$lib/session";

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
   * What the picker offers: the formats the chosen editor's own importer reads, which is the only
   * thing that decides whether a document can be opened. The picker's filter is a convenience; a
   * document the editor cannot read is still accepted, and it reports that itself when it is opened.
   */
  let dialog = $state<HTMLDialogElement | null>(null);
  let name = $state("");
  let busy = $state(false);
  /** Whether a drop from the landing page is being turned into a workspace on this page. */
  let starting = $state(false);
  let problem = $state<unknown>(null);
  let samples = $state<Sample[]>([]);
  let source = $state<"empty" | "sample" | "file" | "bucket">("empty");
  let editorId = $state<string>(DEFAULT_EDITOR.id);
  const selectedEditor = $derived(editorById(editorId) ?? DEFAULT_EDITOR);
  const documentAccept = $derived(selectedEditor.starts.join(","));
  const canUseSample = $derived(
    selectedEditor.id === DEFAULT_EDITOR.id && samples.length > 0,
  );
  let sample = $state("");
  /** The documents chosen from this computer, in the order they were picked. */
  let files = $state<File[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);
  /** Whether a drag carrying files is over the dialog, so the drop block can say it will take them. */
  let dragging = $state(false);
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
   * has no id and no document until it exists, so this is as far as the URL can be known.
   */
  const bucketPreview = $derived(attaching ? resolveTarget(bucketForm) : null);

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
    remembered(VIEW_KEY) === "grid" ? "grid" : "list",
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
   * Which workspaces have a bucket attached, so the row can say the copy off this machine exists. This
   * reads `bucket.json` only: knowing a bucket is attached never needs the key that signs for it.
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

  /** What the last row action failed with, when it is worth a heading rather than one coloured line. */
  let failure = $state<unknown>(null);

  /** Which workspace's row is working, so its buttons can wait rather than being pressed twice. */
  let working = $state<string | null>(null);
  /** What the last row action did, or why it could not, in the toast over the page. */
  let status = $state<string | null>(null);

  /**
   * A toast is read once and then leaves: a finished message clears itself, and one that is still
   * working stays until the row action replaces it with what happened.
   */
  $effect(() => {
    if (!status || working) return;
    const timer = setTimeout(() => (status = null), 8000);
    return () => clearTimeout(timer);
  });

  /**
   * Take the workspace away as a zip, without opening it. The editor is for changing a document; this
   * is for not losing one.
   */
  async function take(workspace: Workspace) {
    working = workspace.id;
    failure = null;
    status = `Downloading ${workspace.name}…`;
    try {
      const space = await ensureSpace();
      status = `Downloaded ${await downloadWorkspaceFiles(space, workspace.id)}.`;
    } catch (e) {
      failure = e;
      status = null;
    } finally {
      working = null;
    }
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
    source = canUseSample ? "sample" : "empty";
    sample = samples[0]?.file ?? "";
    files = [];
    dragging = false;
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
    addFiles(event.currentTarget.files);
    // The list, not the field, is what the dialog reads: emptying it lets the same file be picked
    // again, which would otherwise fire no change event at all.
    event.currentTarget.value = "";
  }

  /**
   * Take documents from anywhere that offers them — the picker or a drop — into the one list the
   * dialog creates from. A name already in the list is the same document, so it is replaced rather
   * than held twice under one name in the workspace.
   */
  function addFiles(incoming: FileList | null) {
    const added = [...(incoming ?? [])];
    if (!added.length) return;
    source = "file";
    const kept = files.filter(
      (held) => !added.some((next) => next.name === held.name),
    );
    files = [...kept, ...added];
  }

  function removeFile(index: number) {
    files = files.filter((_, at) => at !== index);
  }

  /** A drag has to be carrying files: text or a link dropped on the window is not a document. */
  function carriesFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes("Files") ?? false;
  }

  /**
   * The dialog is modal, so a drag anywhere in the window is over it, and a drop it does not claim
   * would open the file in this tab and take the dialog with it. Claiming the whole window is also
   * the simplest rule to explain: what you drop is added, wherever you let go.
   */
  function onDragOver(event: DragEvent) {
    if (!dialog?.open || !carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    dragging = true;
  }

  function onDragLeave(event: DragEvent) {
    // `dragleave` also fires moving between elements; only leaving the page ends the drag.
    if (event.relatedTarget) return;
    dragging = false;
  }

  function onDrop(event: DragEvent) {
    if (!dialog?.open || !carriesFiles(event)) return;
    event.preventDefault();
    dragging = false;
    if (!busy) addFiles(event.dataTransfer?.files ?? null);
  }

  /** A PdfCraft workspace starts empty or from a PDF, so the bundled PhotoCraft documents do not apply. */
  function chooseEditor() {
    if (editorId !== DEFAULT_EDITOR.id) source = "empty";
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
      if (source === "sample" && sample && canUseSample) {
        const response = await fetch(`${base}/samples/${sample}`);
        if (!response.ok)
          throw new Error(`could not fetch ${sample}: ${response.status}`);
        documents = [
          {
            name: documentFileName(sample, selectedEditor),
            bytes: new Uint8Array(await response.arrayBuffer()),
          },
        ];
      } else if (source === "file") {
        if (!files.length) throw new Error("choose a document");
        // Read every chosen file before anything is written, so a partly-read set cannot leave a
        // half-made workspace behind.
        documents = await Promise.all(
          files.map(async (chosen) => ({
            name: documentFileName(chosen.name, selectedEditor),
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
            name: documentFileName(chosen.name, selectedEditor),
            bytes: await downloadObject(attachment, chosen.logical),
          },
        ];
      }
      // The bucket is read before anything is written, so a bucket that cannot be reached leaves no
      // half-made workspace behind to explain.
      const created = await createProject(space, {
        name,
        editor: selectedEditor.id,
        documents,
      });
      const bucket = attaching ? await attachOrUndo(space, created.id) : null;
      dialog?.close();
      await refresh();
      if (bucket) {
        const from =
          source === "bucket" && chosen ? `, starting from ${chosen.key}` : "";
        status = `Created ${created.name}${from}, attached to ${bucket.bucket}.`;
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
   * the flag so a reload does not reopen it. This runs after mount because `replaceState` needs the
   * router, which is not ready while effects first flush.
   */
  onMount(() => {
    if (!page.url.searchParams.has("new")) return;
    open();
    // The router owns Kit's page store only once the root is mounted and started; `tick` waits for
    // that flush, so `replaceState` has something to update.
    void tick().then(() => replaceState(`${base}/`, {}));
  });

  /**
   * The landing page's drop block leaves its documents in the space's `tmp/handoff/`, because a `File`
   * cannot survive a navigation. This is where they become a workspace: named after the first
   * document, in the editor that claims it, and open before the visitor has to read anything. With
   * nothing staged — a reload, or a handoff already swept — the dialog is what this page can still
   * offer.
   */
  onMount(() => {
    if (!page.url.searchParams.has("start")) return;
    void tick().then(() => replaceState(`${base}/`, {}));
    void startFromHandoff();
  });

  /**
   * A tutorial's button links here with `?sample=<id>`. The files a post was written against are in
   * `static/blog/samples/`, listed by `index.json`, so the visitor lands in the editor with the same
   * documents open rather than being asked to find their own.
   */
  onMount(() => {
    const sample = page.url.searchParams.get("sample");
    if (!sample) return;
    void tick().then(() => replaceState(`${base}/`, {}));
    void startFromSample(sample);
  });

  async function startFromSample(id: string) {
    starting = true;
    failure = null;
    status = "Gathering the files this tutorial uses…";
    try {
      await ensurePersistence();
      const space = await ensureSpace();
      const presets: {
        id: string;
        name: string;
        editor: string;
        files: { name: string; path: string }[];
      }[] = await fetch("/blog/samples/index.json")
        .then((r) => {
          if (!r.ok) throw new Error(`the sample list answered ${r.status}`);
          return r.json();
        })
        .then((list) => list.presets ?? []);
      const preset = presets.find((candidate) => candidate.id === id);
      if (!preset) throw new Error(`there is no sample called ${id}`);
      const documents = [];
      for (const file of preset.files) {
        const response = await fetch(`/blog/samples/${file.path}`);
        if (!response.ok)
          throw new Error(`${file.name} answered ${response.status}`);
        documents.push({
          name: file.name,
          bytes: new Uint8Array(await response.arrayBuffer()),
        });
      }
      const editor = editorById(preset.editor) ?? editorFor(documents[0].name);
      status = `Starting ${preset.name}…`;
      const created = await createProject(space, {
        name: preset.name,
        editor: editor.id,
        documents,
      });
      await refresh();
      location.assign(
        editorHref(editor, created.id, created.document ?? documents[0].name),
      );
    } catch (e) {
      status = null;
      failure = e;
    } finally {
      starting = false;
    }
  }

  /** A workspace name from the document it starts with: the file's own name, without its extension. */
  function workspaceNameFor(fileName: string): string {
    return (
      sanitiseDocumentName(fileName)
        .replace(/\.[^.]+$/, "")
        .trim() || "Untitled workspace"
    );
  }

  async function startFromHandoff() {
    starting = true;
    failure = null;
    status = "Starting your workspace…";
    try {
      await ensurePersistence();
      const space = await ensureSpace();
      const documents = await takeHandoff(space);
      if (!documents.length) {
        status = null;
        open();
        return;
      }
      const first = documents[0];
      const editor = editorFor(first.name);
      status = `Starting ${first.name}…`;
      const created = await createProject(space, {
        name: workspaceNameFor(first.name),
        editor: editor.id,
        documents,
      });
      await refresh();
      location.assign(
        editorHref(editor, created.id, created.document ?? first.name),
      );
    } catch (e) {
      status = null;
      failure = e;
    } finally {
      starting = false;
    }
  }
</script>

<svelte:head>
  <title>Workspaces | Atelier Cloud</title>
  <link rel="canonical" href="{ORIGIN}/workspaces/" />
  <meta name="robots" content="noindex, follow" />
  <meta
    name="description"
    content="Open PSD, PSB and .pcraft files in PhotoCraft, an open-source photo editor that runs in the browser. Each workspace keeps its own document and revisions, and can upload to a bucket you own."
  />
</svelte:head>

<svelte:window
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
/>

<div class="head">
  <h1>
    Workspaces
    {#if $workspaces.length}<span class="count">{$workspaces.length}</span>{/if}
  </h1>
  {#if $workspaces.length}
    <div class="controls">
      <div class="segmented" role="group" aria-label="Workspace layout">
        <button
          aria-pressed={view === "list"}
          title="One row per workspace"
          onclick={() => setView("list")}>List</button
        >
        <button
          aria-pressed={view === "grid"}
          title="One card per workspace"
          onclick={() => setView("grid")}>Grid</button
        >
      </div>
      <button
        class="toggle"
        aria-pressed={thumbs}
        title={thumbs ? "Hide the preview images" : "Show the preview images"}
        onclick={toggleThumbs}>Thumbnails</button
      >
      <button class="cta" onclick={open}>New workspace</button>
    </div>
  {/if}
</div>

{#if failure}
  <Problem problem={failure} banner />
{/if}

<div class="toast" role="status">
  {#if status}
    <p class="banner info">{status}</p>
  {/if}
</div>

{#if $workspaces.length === 0}
  <div class="panel empty">
    <h2 class="hero">No workspaces yet</h2>
    <p class="muted">
      Open a PSD, PSB or .pcraft document, record a version when you want one,
      and copy it to storage you control. There is nothing to install.
    </p>
    <div class="row">
      <button class="cta" onclick={open} disabled={starting}
        >New workspace</button
      >
      <a class="button" href="{base}/settings">Local storage</a>
    </div>
    <p class="muted small">
      Importing a zip, and signing in to see a team's workspaces, are planned
      rather than here.
    </p>
  </div>
{/if}

{#if $workspaces.length}
  {#if view === "list"}
    <div class="list-head" class:no-thumb={!thumbs} aria-hidden="true">
      {#if thumbs}<span class="thumb-gap"></span>{/if}
      <span>Workspace</span>
      <span>Document</span>
      <span></span>
    </div>
  {/if}
  <div class={view === "grid" ? "grid" : "list"}>
    {#each $workspaces as workspace (workspace.id)}
      {@const editor = editorFor(workspace.document, workspace.editor)}
      <article class="panel card" class:no-thumb={!thumbs}>
        {#if thumbs}
          <div class="ident-thumb">
            <Thumb
              id={workspace.id}
              available={workspace.thumb}
              size={view === "grid" ? 88 : 44}
            />
          </div>
        {/if}
        <h2 class="ident" title={workspace.name}>
          <a class="name" href="{base}/{workspace.id}">{workspace.name}</a>
        </h2>
        <div class="facts">
          <p class="muted small">
            {workspaceDocumentLabel(workspace)} ·
            <span class="nowrap">{bytes(workspace.size)} local</span>
          </p>
          <p class="small">
            {#if workspace.dirty}
              <span class="warn">not recorded yet</span>
            {:else}
              <span class="ok">saved</span>
              <span class="muted">· {since(workspace.updatedAt, now)}</span>
            {/if}
            {#if buckets[workspace.id]}
              <span
                class="bucket"
                role="img"
                aria-label="A bucket is attached: {buckets[workspace.id]
                  .bucket}"
                title="A bucket is attached ({buckets[workspace.id]
                  .bucket}), so there is a copy off this machine."
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
              href={editorHref(
                editor,
                workspace.id,
                workspace.document ?? undefined,
              )}
              target="_blank"
              rel="noopener"
              title="Open {workspace.name} in {editor.title}"
            >
              <Icon name="edit" />
              Open in {editor.title}
            </a>
            <a class="button" href="{base}/{workspace.id}">Details</a>
          </div>
          <div class="row">
            <button
              class="action-button"
              title="Download every file in {workspace.name} as a zip"
              disabled={working !== null}
              onclick={() => take(workspace)}
            >
              <Icon name="download" />
              Download
            </button>
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
    It is early work, offered as is and with <b>no warranty of any kind</b>,
    express or implied, including merchantability and fitness for a particular
    purpose. A workspace lives in this browser and can be cleared at any time,
    so keep your own copies of anything that matters.
  </p>
  <p>
    <a
      class="button"
      href="https://github.com/StBogdan/atelier_web/issues/new"
      target="_blank"
      rel="noopener">Report an issue</a
    >
  </p>
  <div class="credits">
    <p class="credit">
      <strong>
        <a href="https://github.com/StBogdan/atelier_web">Atelier Cloud</a>
      </strong>
      <span>
        The workspace library, launcher and server. © 2026 the Atelier authors,
        MIT licensed.
      </span>
    </p>
    <p class="credit">
      <strong>
        <a href="https://github.com/storytold/photocraft">PhotoCraft</a>
      </strong>
      <span>
        The photo editor, a separate open-source project. © 2026 the ArtCraft
        Team and the PhotoCraft contributors. Its authors license it under MIT
        or Apache-2.0.
      </span>
    </p>
    <p class="credit">
      <strong>
        <a href="https://github.com/storytold/pdfcraft">PdfCraft</a>
      </strong>
      <span>
        The PDF workbench, a separate open-source project. © 2026 the ArtCraft
        Team and the PdfCraft contributors. Its authors license it under MIT or
        Apache-2.0.
      </span>
    </p>
    <p class="disclaimer">
      Atelier Cloud is independent of the ArtCraft Team and is not endorsed by
      it or affiliated with it. The PhotoCraft and PdfCraft names and wordmarks
      belong to the ArtCraft Team.
    </p>
  </div>
</footer>

<dialog bind:this={dialog}>
  <form class="stack" onsubmit={(event) => event.preventDefault()}>
    <h2>New workspace</h2>
    <label>
      Editor
      <select bind:value={editorId} onchange={chooseEditor}>
        {#each EDITORS as editor (editor.id)}
          <option value={editor.id}>{editor.title}</option>
        {/each}
      </select>
    </label>
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
          disabled={!canUseSample}
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
      <div class="option option-file">
        <label class="pick">
          <input type="radio" value="file" bind:group={source} />
          {files.length > 1
            ? `${files.length} documents from this computer`
            : "A document from this computer"}
        </label>
        <label class="drop" class:dragging>
          <input
            type="file"
            multiple
            accept={documentAccept}
            bind:this={fileInput}
            onchange={chooseFile}
            disabled={busy}
          />
          <span class="drop-title">
            {dragging
              ? "Drop to add them"
              : files.length
                ? "Add more documents"
                : "Drag documents here"}
          </span>
          <span class="muted small"
            >or click to choose them from this computer</span
          >
        </label>
        {#if files.length}
          <ul class="picked">
            {#each files as chosen, index (chosen.name)}
              <li>
                <span class="mono small">{chosen.name}</span>
                <span class="muted small">{bytes(chosen.size)}</span>
                <button
                  type="button"
                  class="remove"
                  aria-label="Remove {chosen.name}"
                  title="Remove {chosen.name}"
                  onclick={() => removeFile(index)}
                  disabled={busy}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
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
              <p class="muted small">The bucket holds no documents.</p>
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
        class="cta"
        onclick={create}
        disabled={busy ||
          (source === "bucket" && !chosen) ||
          (source === "file" && !files.length)}
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

  /* The alpha notice reads as the end of the page, not as another card competing with the work. */
  .count {
    margin-left: 0.4rem;
    font-size: 1rem;
    font-weight: 500;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }

  .notice {
    margin-top: 2.5rem;
    padding: 1.25rem 0 0;
    background: transparent;
    border: 0;
    border-top: 1px solid var(--hairline);
    border-radius: 0;
    box-shadow: none;
  }

  .notice p {
    max-width: 72ch;
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
    color: var(--link);
  }

  .notice p:last-child {
    margin-bottom: 0;
  }

  .notice .button {
    margin-top: 0.8rem;
  }

  /* The landing page's credits, in the same words and the same order: the app runs the editor and
     the PDF workbench, so it says who made them and under what licence. A name sits above its own
     description and the block takes the page's width, so a narrow viewport wraps the sentence
     instead of squeezing it into a column. */
  .credits {
    display: grid;
    gap: 0.75rem;
    margin-top: 1.8rem;
    padding-top: 1.2rem;
    border-top: 1px solid var(--hairline);
    font-size: 0.8rem;
    line-height: 1.55;
  }

  .credits p {
    max-width: none;
    margin: 0;
  }

  .credit strong {
    display: block;
    color: var(--dim);
    font-weight: 600;
  }

  .credit span {
    display: block;
    color: var(--faint);
  }

  .disclaimer {
    font-size: 0.76rem;
    color: var(--faint);
  }

  .credits a {
    color: var(--dim);
    text-decoration: none;
  }

  .credits a:hover {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 2px;
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

  /* One tone: rows, cells and the empty state sit on the page itself and are divided by a hairline.
     Nothing here floats, so the eye reads down a column of workspaces rather than across a stack of
     cards. */
  .list .card,
  .grid .card,
  .empty {
    background: none;
    border-radius: 0;
    box-shadow: none;
  }

  /* List: a table with buttons. The column names sit over the values they name, in the same tracks
     as the rows, and every row is separated by the same hairline. */
  .list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .list-head {
    display: grid;
    grid-template-columns: auto minmax(10rem, 0.9fr) minmax(12rem, 1.3fr) auto;
    column-gap: 1.25rem;
    align-items: end;
    padding: 0 0 0.5rem;
    border-bottom: 1px solid var(--hairline);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }

  .list-head.no-thumb {
    grid-template-columns: minmax(10rem, 0.9fr) minmax(12rem, 1.3fr) auto;
  }

  /* The thumbnail's own column, so the names below start where this ends. */
  .thumb-gap {
    width: 2.75rem;
  }

  .list .card {
    border: 0;
    border-bottom: 1px solid var(--hairline);
    grid-template-columns:
      auto minmax(10rem, 0.9fr) minmax(12rem, 1.3fr)
      auto;
    grid-template-areas: "thumb name facts actions";
    align-items: center;
    padding: 0.7rem 0;
    column-gap: 1.25rem;
  }

  .list .card.no-thumb {
    grid-template-columns: minmax(10rem, 0.9fr) minmax(12rem, 1.3fr) auto;
    grid-template-areas: "name facts actions";
  }

  /* The grid is cells on the page, not cards: an outline, no fill. */
  .grid .card {
    border: 1px solid var(--hairline);
  }

  /* Nothing to show yet: the same outline, at the page's own width. */
  .empty {
    border: 1px solid var(--hairline);
  }

  /* A workspace that can send a copy off this machine says so: the cloud is drawn only when a bucket is
	   attached, so a card without one is not marked by the absence of anything. The bucket is named on
	   hover. */
  .bucket {
    display: inline-flex;
    align-items: center;
    margin-left: 0.4rem;
    color: var(--ok);
  }

  /* The row's one action besides opening the workspace: an icon and its label, the same height as
     the buttons beside them. */
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

  /* What a row action did is information, not a warning: blue. */
  .banner.info {
    border-left-color: var(--accent);
    color: var(--link);
  }

  /* It floats over the page instead of joining it, so committing a card does not push everything
     below it down and pull it back up when the message goes. Only the text box takes clicks, so the
     page under the rest of the toast stays usable, and the text itself can still be selected. */
  .toast {
    position: fixed;
    left: 50%;
    bottom: 1.25rem;
    z-index: 20;
    width: min(34rem, calc(100vw - 2rem));
    transform: translateX(-50%);
    pointer-events: none;
  }

  .toast .banner {
    margin: 0;
    background: var(--panel);
    box-shadow: var(--shadow);
    pointer-events: auto;
  }

  /* The name keeps the left edge and gives way before the details do. It wraps rather than being cut
	   off, up to the four lines the grid view allows, so a long name can be read. */
  .list .ident {
    font-size: 0.98rem;
    margin: 0;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  /* The details sit in their own column, and align with the name rather than the row's other edges. */
  .list .facts {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .list .facts p {
    margin: 0;
  }

  /* A row's actions carry the same weight as each other: the row is the thing, not one of its three
     buttons. The grid keeps the solid one, where it is the only way in. */
  .list .actions .primary {
    background: transparent;
    border-color: var(--field-line);
    color: var(--ink);
  }

  .list .actions .primary:hover {
    background: var(--hover);
    border-color: var(--accent);
    filter: none;
  }

  /* The actions are the row's last column, so they line up down the page. */
  .list .actions {
    margin-top: 0;
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: center;
  }

  .list .actions .row {
    display: contents;
  }

  /* Narrower than three comfortable columns: the details drop under the name and the actions take
     their own line, so nothing is squeezed to a few characters. */
  @media (max-width: 62rem) {
    .list-head {
      display: none;
    }

    .list .card {
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-areas:
        "thumb name"
        "facts facts"
        "actions actions";
      align-items: start;
      row-gap: 0.35rem;
    }

    .list .card.no-thumb {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas:
        "name"
        "facts"
        "actions";
    }

    .list .actions {
      flex-wrap: wrap;
    }
  }

  /* The first line a visitor reads. It sits under the state, not instead of it, and below the page
     title in the hierarchy so the screen still reads as a place rather than an advert. */
  .hero {
    font-size: 1.5rem;
    line-height: 1.3;
    margin: 0.2rem 0 0.6rem;
  }

  .small {
    font-size: 0.875rem;
    margin: 0.15rem 0;
    font-variant-numeric: tabular-nums;
  }

  .nowrap {
    white-space: nowrap;
  }

  /* One grid in both views: thumbnail, name, facts and actions each own an area, so the list is a
     row and the grid is a column. */
  .card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas:
      "thumb name"
      "thumb facts"
      "thumb actions";
    align-items: start;
    column-gap: 0.9rem;
    padding: 0.9rem;
  }

  .card.no-thumb {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "name"
      "facts"
      "actions";
  }

  .ident-thumb {
    grid-area: thumb;
  }

  /* The preview is squared like the rest of the page: no card, so no rounded corners inside one. */
  .ident-thumb :global(.thumb) {
    border-radius: 0;
  }

  /* A long name wraps, up to four lines, and stops there; the full text stays in the tooltip. */
  .ident {
    grid-area: name;
    margin: 0 0 0.2rem;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    overflow: hidden;
  }

  .facts {
    grid-area: facts;
    min-width: 0;
  }

  /* The name is the way into the workspace, so it reads as a link without turning into a button:
	   the heading's own colour, underlined when the pointer or the keyboard is on it. */
  .name {
    color: inherit;
    text-decoration: none;
  }

  .name:hover,
  .name:focus-visible {
    color: var(--link);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* In the grid view the two rows stack: Editor and Details over Download. The rows are independent,
     so a longer row above cannot open a blank gap in the short row below it. */
  .actions {
    grid-area: actions;
    margin-top: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    align-items: flex-start;
    /* The row's actions read one step quieter than body text, so the workspace name keeps the eye. */
    font-size: 0.875rem;
  }

  /* The way into the editor carries the glyph of what it does, like the two actions beside and below
	   it, and sits on their line rather than a few pixels off it. */
  .actions .button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
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

  /* The file choice is the one with a target drawn around it: the radio names it, and the block below
     is what a drop lands on, so it stacks and takes the dialog's whole width. */
  .option-file {
    display: grid;
    gap: 0.5rem;
    align-items: start;
  }

  .pick {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* The drag is claimed by the dialog rather than the block, so the block says what will happen while
     the pointer is anywhere over the dialog: the result is the same wherever the drop lands. */
  .drop {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 0.15rem;
    padding: 1.5rem 1rem;
    border: 2px dashed var(--field-line);
    border-radius: var(--radius-lg);
    color: var(--dim);
    text-align: center;
    cursor: pointer;
  }

  .drop:hover,
  .drop.dragging {
    border-color: var(--accent);
    color: var(--ink);
  }

  /* The picker inside the block is what the keyboard reaches, and it is invisible; the ring belongs to
     the block around it. */
  .drop:focus-within {
    border-color: var(--accent);
    color: var(--ink);
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .drop.dragging {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .drop-title {
    font-weight: 560;
  }

  /* Out of the way but focusable: the block is the target, and the picker is what the block forwards
     a click to. */
  .drop input[type="file"] {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0;
  }

  .picked {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.3rem;
  }

  .picked li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  /* A long name gives way with an ellipsis before the facts beside it do. */
  .picked .mono {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .picked .muted {
    flex: 0 0 auto;
  }

  /* Taking one back is a small action on its row rather than a second button beside Create. A square
     box, so the cross sits on the row's centre line whatever the glyph's own metrics are. */
  .picked .remove {
    margin-left: auto;
    flex: 0 0 auto;
    width: 1.6rem;
    height: 1.6rem;
    min-height: 1.6rem;
    padding: 0;
    color: var(--dim);
  }

  legend {
    color: var(--dim);
    padding: 0 0.3rem;
  }
</style>
