<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import Thumb from "$lib/Thumb.svelte";
  import Icon from "$lib/Icon.svelte";
  import BucketFields from "$lib/BucketFields.svelte";
  import Problem from "$lib/Problem.svelte";
  import { bytes, objects, plural, since } from "$lib/format";
  import {
    downloadWorkspace,
    downloadWorkspaceFiles,
    uploadDocument,
  } from "$lib/actions";
  import {
    commit,
    discard,
    documentKind,
    ensureSpace,
    hash,
    inspect,
    objectKey,
    pendingChange,
    readMeta,
    removeDocument,
    removeProject,
    rename,
    renameDocument,
    restoreDocument,
    type Change,
    type Meta,
    type WorkspaceDocument,
  } from "$lib/contract";
  import {
    BucketError,
    attachBucket,
    bucketDocuments,
    detachBucket,
    downloadObject,
    listObjects,
    r2DashboardUrl,
    readAttachment,
    readBucketConfig,
    type Attachment,
    type BucketConfig,
    type BucketDocument,
  } from "$lib/bucket";
  import { resolveTarget } from "$lib/sigv4";
  import { editorFor, editorHref, editorsFor } from "$lib/editors";
  import { ensurePersistence, refresh } from "$lib/session";

  const id = $derived(page.params.id ?? "");

  let meta = $state<Meta | null>(null);
  /** The documents this workspace holds, from `inspect` (design, Documents). */
  let documents = $state<WorkspaceDocument[]>([]);
  /** The one the project's revision describes, which the panels act on. */
  let recordedDocument = $state<string | null>(null);
  /** The document a row is renaming, and the name it is being given. */
  let renamingDocument = $state<string | null>(null);
  let documentName = $state("");
  let change = $state<Change | null>(null);
  let bucket = $state<BucketConfig | null>(null);
  /** What the bucket panel last failed with: an error as thrown, so a `Problem` can be drawn as one. */
  let bucketProblem = $state<unknown>(null);
  /** What the attach form holds. The secret lives here until it is imported, and is cleared then. */
  let form = $state({
    endpoint: "",
    bucket: "",
    region: "auto",
    prefix: "",
    accessKeyId: "",
    secretAccessKey: "",
  });
  /** The bucket name the fields put in the field themselves, so a paste does not overwrite a typed one. */
  let filled = $state("");
  /** Attached already, and the form reopened to change it. */
  let editing = $state(false);
  /** The bucket's contents, shown when the chooser is open. `null` while the listing is on its way. */
  let choosing = $state(false);
  let choices = $state<BucketDocument[] | null>(null);
  let truncated = $state(false);
  let chooseProblem = $state<unknown>(null);
  let busy = $state<string | null>(null);
  let problem = $state<unknown>(null);
  let notice = $state<string | null>(null);
  let renaming = $state(false);
  let newName = $state("");
  let now = $state(Date.now());

  const remote = $derived(meta?.sync?.remote ?? null);
  /** The document the workspace shows: the one a revision describes, else the first it holds. */
  const shown = $derived(
    documents.find((document) => document.name === recordedDocument) ??
      documents[0] ??
      null,
  );

  /** The editor one document opens in. The workspace's recorded default decides only when none is named. */
  const editorForDocument = (document?: string) =>
    editorFor(document ?? shown?.name ?? meta?.document, meta?.editor);

  /** Where one document is opened; the workspace's shown document when none is named. */
  const editorUrl = (document?: string) =>
    editorHref(editorForDocument(document), id, document);
  /** What the header's Open action targets, named under the button so a multi-file workspace is unambiguous. */
  const openDocumentName = $derived(shown?.name ?? meta?.document ?? null);
  const primaryEditor = $derived(
    editorForDocument(openDocumentName ?? undefined),
  );
  /** The editors beside the primary one that also claim this document's format. */
  const otherEditors = $derived(
    editorsFor(openDocumentName).filter(
      (editor) => editor.id !== primaryEditor.id,
    ),
  );
  /** The bytes on disk right now, as the Changes panel already knows them. */
  const currentHash = $derived(change?.hash ?? meta?.revision?.hash ?? null);

  /**
   * Whether the bucket is missing these bytes — which is the only reason to upload, and the only reason
   * the upload is the highlighted action. Nothing uploaded yet, or a bucket copy the document has left
   * behind, both count; a bucket copy that *is* this document does not.
   */
  const uploadWanted = $derived(
    Boolean(bucket) && (!remote || remote.hash !== currentHash),
  );

  /** The attached bucket's own page in Cloudflare, when that is where it lives. */
  const dashboard = $derived(bucket ? r2DashboardUrl(bucket) : null);

  /**
   * One short line about what is not in the diff, or nothing at all when there is nothing to say. It names
   * no paths: the reader is deciding whether to record, not reading our file layout.
   */
  const diffNote = $derived.by(() => {
    if (!change || change.kind === "whole") return null;
    const parts: string[] = [];
    if (change.difference.unchanged) {
      parts.push(
        `${plural(change.difference.unchanged, "object")} unchanged (${bytes(change.difference.unchangedBytes)})`,
      );
    }
    if (change.difference.removed)
      parts.push(`${plural(change.difference.removed, "object")} unused`);
    return parts.join(" · ") || null;
  });

  /**
   * What the attach form would attach and write to, resolved exactly the way `attachBucket` resolves
   * it — so a bucket's full URL pasted into the endpoint field needs no taking apart, and the URL
   * shown here is the URL that will be signed.
   */
  const preview = $derived(
    resolveTarget(form, objectKey(id, meta?.document ?? undefined)),
  );

  async function loadBucket() {
    bucketProblem = null;
    try {
      bucket = await readBucketConfig(await ensureSpace(), id);
    } catch (e) {
      bucketProblem = e;
    }
  }

  async function load() {
    problem = null;
    const space = await ensureSpace();
    await loadBucket();
    const found = await readMeta(space, id);
    meta = found;
    if (!found) {
      problem = "this workspace has no meta.json";
      return;
    }
    newName = found.name;
    // Which documents the workspace holds is a listing of the project directory, not metadata.
    const workspace = await inspect(space, id);
    documents = workspace.documents;
    recordedDocument = workspace.document;
    try {
      change = await pendingChange(space, id, found);
    } catch (e) {
      problem = e;
    }
    now = Date.now();
  }

  onMount(() => {
    void ensurePersistence();
    void load();
    const timer = window.setInterval(() => (now = Date.now()), 20_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  });

  async function run(what: string, action: () => Promise<void>) {
    busy = what;
    problem = null;
    try {
      await action();
    } catch (e) {
      problem = e;
    } finally {
      busy = null;
    }
  }

  const commitRevision = () =>
    run("commit", async () => {
      await commit(await ensureSpace(), id);
      await load();
      await refresh();
    });

  const discardChanges = () =>
    run("discard", async () => {
      const confirmed = window.confirm(
        `Put back the previous bytes, ${meta?.document ?? "the document"}.prev?\n\nThe editor keeps one save back beside the document, so this undoes the last save. Download first if you are not sure.`,
      );
      if (!confirmed) return;
      const outcome = await discard(await ensureSpace(), id);
      notice =
        outcome === "revision"
          ? `Discarded: the document is revision ${meta?.rev} again.`
          : `Put back the previous bytes, one save back. They are not revision ${meta?.rev}, so the document is still uncommitted: the editor's .prev holds one save, not the last commit.`;
      await load();
      await refresh();
    });

  /** Save every document this workspace holds, as one zip. */
  const saveAll = () =>
    run("download", async () => {
      await downloadWorkspaceFiles(await ensureSpace(), id);
    });

  /**
   * Record a document as this workspace's revision. A workspace may hold several files and its
   * revision describes one of them, so the row is how a document other than the recorded one is
   * kept. `commit` moves the revision and the card's status onto the document it records.
   */
  const recordDocument = (document: WorkspaceDocument) =>
    run("commit", async () => {
      await commit(await ensureSpace(), id, document.name);
      await load();
      await refresh();
    });

  /** Save one document of this workspace to the computer, whichever one it is. */
  const saveDocument = (document: WorkspaceDocument) =>
    run("download", async () => {
      await downloadWorkspace(await ensureSpace(), id, document.name);
    });

  /** Open a row's name for editing, starting from the name it has. */
  function startRenamingDocument(document: WorkspaceDocument) {
    renamingDocument = document.name;
    documentName = document.name;
  }

  /**
   * Rename a document in this workspace: the file, the one-save-back copy beside it, and the record
   * the revision keeps when this was the document it describes. A name already used here is refused.
   */
  const applyDocumentRename = (document: WorkspaceDocument) =>
    run("rename", async () => {
      const name = await renameDocument(
        await ensureSpace(),
        id,
        document.name,
        documentName,
      );
      renamingDocument = null;
      notice =
        name === document.name
          ? `${document.name} was not renamed.`
          : `Renamed ${document.name} to ${name}.`;
      await load();
      await refresh();
    });

  /**
   * Delete one document from this workspace. Its one-save-back copy goes with it; the copy in the
   * bucket does not, because that may be the only one off this machine.
   */
  const deleteDocument = (document: WorkspaceDocument) =>
    run("delete", async () => {
      const confirmed = window.confirm(
        `Delete ${document.name} from this workspace?\n\nThe one-save-back copy beside it goes too. A copy in the bucket is left alone. This cannot be undone.`,
      );
      if (!confirmed) return;
      await removeDocument(await ensureSpace(), id, document.name);
      notice = `Deleted ${document.name}.`;
      await load();
      await refresh();
    });

  /**
   * Reopen the form on the bucket that is already attached. The secret is not stored in a form this
   * app can read, so it is the one field that has to be entered again — everything else is filled in.
   */
  function startEditing() {
    if (!bucket) return;
    form.endpoint = bucket.endpoint;
    form.bucket = bucket.bucket;
    form.region = bucket.region;
    form.prefix = bucket.prefix.replace(/\/$/, "");
    form.accessKeyId = bucket.accessKeyId;
    form.secretAccessKey = "";
    filled = bucket.bucket;
    choosing = false;
    editing = true;
  }

  /** Give this workspace a bucket of its own: the credential stays in this browser. Its failures belong
   * beside the form rather than in the page's banner, because the form is what would have to change.
   */
  async function attach() {
    busy = "attach";
    problem = null;
    bucketProblem = null;
    try {
      const attached = await attachBucket(await ensureSpace(), id, form);
      form.secretAccessKey = "";
      editing = false;
      notice = `Attached ${attached.bucket}. Uploads and downloads from here are signed in this browser.`;
      await loadBucket();
    } catch (e) {
      bucketProblem = e;
    } finally {
      busy = null;
    }
  }

  const detach = () =>
    run("detach", async () => {
      if (
        !window.confirm(
          `Forget the bucket attached to this workspace?\n\nThe document here and the copy in the bucket are both left alone: this only removes the credential from this browser.`,
        )
      )
        return;
      await detachBucket(await ensureSpace(), id);
      editing = false;
      choosing = false;
      notice = "Detached. This browser no longer signs for that bucket.";
      await loadBucket();
    });

  /**
   * Upload this workspace's document: the bytes go from this tab straight to the bucket, on a URL
   * signed here, so the server in the middle is not involved and never sees the credential.
   */
  const uploadToBucket = () =>
    run("upload", async () => {
      const uploaded = await uploadDocument(await ensureSpace(), id);
      notice = `Uploaded ${uploaded.name} (${bytes(uploaded.size)}) to ${uploaded.where}.`;
      await load();
      await refresh();
    });

  /**
   * List the bucket and offer what it holds, so a workspace can be started from a document already
   * there — which is the only way to load one whose workspace id is not this one.
   */
  async function openChooser() {
    choosing = true;
    choices = null;
    chooseProblem = null;
    busy = "list";
    try {
      const attachment = await readAttachment(await ensureSpace(), id);
      if (!attachment)
        throw new Error("no bucket is attached to this workspace yet");
      const listing = await listObjects(attachment);
      choices = bucketDocuments(listing.objects);
      truncated = listing.truncated;
    } catch (e) {
      chooseProblem = e;
    } finally {
      busy = null;
    }
  }

  /** Put one of the bucket's documents into this workspace: the same whole-document replace as *Download*. */
  const loadFromBucket = (document: BucketDocument) =>
    run("fetch", async () => {
      if (
        meta?.document &&
        !window.confirm(
          `Replace ${meta.document} in this workspace with ${document.key}?\n\nClose the editor on this workspace first: an editor that has it open writes its own copy back on the next save.`,
        )
      )
        return;
      const space = await ensureSpace();
      const attachment = await readAttachment(space, id);
      if (!attachment)
        throw new Error("no bucket is attached to this workspace yet");
      const fetched = await readObject(attachment, document.logical);
      await restoreDocument(space, id, fetched);
      choosing = false;
      notice = `Loaded ${document.key} from the bucket. It is uncommitted until you record a version.`;
      await load();
      await refresh();
    });

  /**
   * Which object in the bucket is this workspace's copy. After an upload it is recorded; otherwise the
   * bucket is asked, because a workspace started on one machine and given a bucket on another has a
   * document whose key only the bucket can name. When the bucket holds more than one for this
   * workspace, the person picks.
   */
  async function bucketCopyKey(attachment: Attachment): Promise<string | null> {
    if (remote?.key) return remote.key;
    const { objects } = await listObjects(attachment);
    const mine = bucketDocuments(objects).filter(
      (document) => document.id === id,
    );
    if (mine.length === 1) return mine[0].logical;
    if (mine.length > 1) {
      choices = mine;
      truncated = false;
      chooseProblem = null;
      choosing = true;
      return null;
    }
    throw new Error(
      `The bucket holds nothing under ${id}, this workspace's id. Choose from bucket… lists everything it holds.`,
    );
  }

  /** The other direction: fetch the bucket's copy and make it this workspace's document. It is a
   * whole-document replace, so it asks first, and the answer afterwards is plain about what the
   * workspace is now: uncommitted, until it is recorded.
   */
  const downloadFromBucket = () =>
    run("fetch", async () => {
      const space = await ensureSpace();
      const attachment = await readAttachment(space, id);
      if (!attachment)
        throw new Error("no bucket is attached to this workspace yet");
      const from = await bucketCopyKey(attachment);
      if (!from) return;
      if (
        meta?.document &&
        !window.confirm(
          `Replace ${meta.document} in this workspace with the copy in the bucket?\n\n` +
            `${from}\n\nClose the editor on this workspace first: an editor that has it open writes its own copy back on the next save.`,
        )
      )
        return;
      const fetched = await readObject(attachment, from);
      await restoreDocument(space, id, fetched);
      notice = `Restored ${from} (${bytes(fetched.length)}) into this workspace. It is uncommitted until you record a version.`;
      await load();
      await refresh();
    });

  /**
   * A missing object is the one refusal worth a second sentence: the fix is to look at what the bucket
   * does hold, which the chooser does.
   */
  async function readObject(
    attachment: Attachment,
    logical: string,
  ): Promise<Uint8Array> {
    try {
      return await downloadObject(attachment, logical);
    } catch (e) {
      if (e instanceof BucketError && e.status === 404) {
        throw new Error(
          `${e.message}\n\nNothing at ${logical}. Choose from bucket… lists what is there.`,
        );
      }
      throw e;
    }
  }

  const applyRename = () =>
    run("rename", async () => {
      await rename(await ensureSpace(), id, newName);
      renaming = false;
      await load();
      await refresh();
    });

  const removeWorkspace = () =>
    run("remove", async () => {
      if (
        !window.confirm(
          `Delete “${meta?.name}” and its document? This cannot be undone.`,
        )
      )
        return;
      await removeProject(await ensureSpace(), id);
      await refresh();
      await goto(`${base}/`);
    });
</script>

<svelte:head
  ><title>{meta?.name ?? "Workspace"} | Atelier Cloud</title></svelte:head
>

<p class="muted small"><a href="{base}/">← All workspaces</a></p>

{#if !meta}
  <div class="panel">
    <h1>Workspace</h1>
    <Problem problem={problem ?? "loading…"} />
  </div>
{:else}
  <div class="top">
    <Thumb {id} available={true} size={104} />
    <div class="titles">
      {#if renaming}
        <form class="row" onsubmit={(event) => event.preventDefault()}>
          <input type="text" bind:value={newName} />
          <button class="primary" onclick={applyRename} disabled={busy !== null}
            >Rename</button
          >
          <button onclick={() => (renaming = false)}>Cancel</button>
        </form>
      {:else}
        <h1>
          {meta.name}
          <button class="link" onclick={() => (renaming = true)}>rename</button>
        </h1>
      {/if}
      <p class="muted small">
        {shown?.name ?? "no document yet"} · rev {meta.rev} · {bytes(
          shown?.size ?? 0,
        )} · created {since(meta.createdAt, now)}
      </p>
    </div>
    <div class="row actions">
      <div class="split" class:split-pair={otherEditors.length > 0}>
        <a
          class="button primary open-target"
          href={editorUrl(openDocumentName ?? undefined)}
          target="_blank"
          rel="noopener"
        >
          <span class="label">
            <Icon name="edit" />
            Open in {primaryEditor.title}
          </span>
          {#if openDocumentName}
            <span class="filename" title={openDocumentName}
              >{openDocumentName}</span
            >
          {/if}
        </a>
        {#if otherEditors.length}
          <details class="open-menu split-menu">
            <summary
              class="button primary"
              title="Open in another editor"
              aria-label="Open in another editor"
            >
              <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
                <path
                  d="M1 1l4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </summary>
            <div class="menu">
              {#each otherEditors as editor (editor.id)}
                <a
                  href={editorHref(editor, id, openDocumentName ?? undefined)}
                  target="_blank"
                  rel="noopener">{editor.title}</a
                >
              {/each}
            </div>
          </details>
        {/if}
      </div>
    </div>
  </div>

  {#if problem}
    <Problem {problem} banner />
  {/if}
  {#if notice}
    <p class="banner">{notice}</p>
  {/if}

  {#snippet commitAction()}
    <button
      class:primary={Boolean(change)}
      onclick={commitRevision}
      disabled={busy !== null || !change}
    >
      <Icon name="commit" />
      {busy === "commit"
        ? "Recording…"
        : change
          ? "Record version"
          : "Up to date"}
    </button>
  {/snippet}

  {#snippet uploadAction()}
    <button
      class:primary={uploadWanted}
      onclick={uploadToBucket}
      disabled={busy !== null || !bucket || !meta?.document}
    >
      <Icon name="upload" />
      {busy === "upload" ? "Uploading…" : "Upload to bucket"}
    </button>
    {#if !bucket}
      <span class="muted small">No bucket attached</span>
    {/if}
  {/snippet}

  <section class="panel changes">
    {#if change}
      <h2>
        Changes
        <span class="chip status">uncommitted since rev {meta.rev}</span>
        <span class="muted">({since(meta.updatedAt, now)})</span>
      </h2>
      <table>
        <tbody>
          <tr>
            <td class="mono">{change.document}</td>
            <td
              >{change.kind === "whole"
                ? "whole document"
                : objects(
                    change.difference.added.length,
                    change.difference.changed.length,
                  )}</td
            >
            <td class="right"
              >{bytes(
                change.kind === "whole" ? change.size : change.difference.bytes,
              )}</td
            >
          </tr>
          {#if change.kind === "objects" && !change.difference.added.length && !change.difference.changed.length}
            <tr>
              <td class="mono">meta.json</td>
              <td>document renamed or re-saved in place</td>
              <td class="right">—</td>
            </tr>
          {/if}
        </tbody>
      </table>
      {#if diffNote}
        <p class="muted small">{diffNote}</p>
      {/if}
      <div class="row">
        {@render commitAction()}
        {@render uploadAction()}
        <button class="danger" onclick={discardChanges} disabled={busy !== null}
          ><Icon name="discard" /> Discard local changes…</button
        >
        <button class="push" onclick={saveAll} disabled={busy !== null}
          ><Icon name="download" /> Download files</button
        >
      </div>
    {:else}
      <h2>
        Changes
        <span class="chip status ok">Version up to date</span>
      </h2>
      <p class="muted small">
        {#if meta.revision}
          <span class="mono">{meta.document}</span> · Recorded {since(
            meta.sync.at,
            now,
          )} ·
          {meta.revision.kind === "whole"
            ? "whole document"
            : `${Object.keys(meta.revision.objects).length} objects`} ·
          {bytes(meta.revision.size)} ·
          <span class="mono">{meta.revision.hash.slice(0, 22)}…</span>
        {:else if documents.length}
          No recordable document here yet, so there is nothing to compare: an
          editor writes a <code>.pcraft</code> or a <code>.pdf</code> when it saves
          into this workspace.
        {/if}
      </p>
      <div class="row">
        {@render commitAction()}
        {@render uploadAction()}
        <button class="push" onclick={saveAll} disabled={busy !== null}
          ><Icon name="download" /> Download files</button
        >
      </div>
    {/if}
  </section>
  <section class="panel documents">
    <h2>
      Documents
      {#if documents.length > 1}
        <span class="muted">({documents.length})</span>
      {/if}
    </h2>
    {#if documents.length === 0}
      <p class="muted small">
        This workspace holds no documents yet. Open the editor and save one into
        it, or load one from the bucket.
      </p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>document</th>
            <th class="right">size</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each documents as document (document.name)}
            {@const editors = editorsFor(document.name)}
            <tr data-document={document.name}>
              <td class="mono">
                {#if renamingDocument === document.name}
                  <form
                    class="row"
                    onsubmit={(event) => {
                      event.preventDefault();
                      void applyDocumentRename(document);
                    }}
                  >
                    <input
                      type="text"
                      bind:value={documentName}
                      aria-label="New name for {document.name}"
                    />
                    <button
                      class="primary"
                      type="submit"
                      disabled={busy !== null}>Rename</button
                    >
                    <button
                      type="button"
                      onclick={() => (renamingDocument = null)}
                      disabled={busy !== null}>Cancel</button
                    >
                  </form>
                {:else}
                  {document.name}
                {/if}
              </td>
              <td class="right">{bytes(document.size)}</td>
              <td class="right">
                {#if editors.length > 1}
                  <details class="open-menu">
                    <summary class="button">Open</summary>
                    <div class="menu">
                      {#each editors as editor (editor.id)}
                        <a
                          href={editorHref(editor, id, document.name)}
                          target="_blank"
                          rel="noopener">{editor.title}</a
                        >
                      {/each}
                    </div>
                  </details>
                {:else}
                  <a
                    class="button"
                    href={editorUrl(document.name)}
                    target="_blank"
                    rel="noopener"
                    title="Open in {editorForDocument(document.name).title}"
                    >Open</a
                  >
                {/if}
                <button
                  onclick={() => saveDocument(document)}
                  disabled={busy !== null}>Download</button
                >
                {#if document.name !== recordedDocument && documentKind(document.name) !== "none"}
                  <button
                    onclick={() => recordDocument(document)}
                    disabled={busy !== null}
                    title="Record {document.name} as this workspace's revision"
                    ><Icon name="commit" /> Record</button
                  >
                {/if}
                <button
                  onclick={() => startRenamingDocument(document)}
                  disabled={busy !== null || renamingDocument !== null}
                  >Rename</button
                >
                <button
                  class="danger"
                  onclick={() => deleteDocument(document)}
                  disabled={busy !== null}>Delete</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  {#if change}
    <section class="panel">
      <h2>Uncommitted revision</h2>
      <dl>
        <dt>document</dt>
        <dd class="mono">{change.document}</dd>
        <dt>bytes</dt>
        <dd>{change.size} ({bytes(change.size)})</dd>
        <dt>hash</dt>
        <dd class="mono">{change.hash.slice(0, 22)}…</dd>
        <dt>modified</dt>
        <dd>{new Date(change.modified).toLocaleString()}</dd>
      </dl>
    </section>
  {/if}

  {#snippet bucketForm()}
    <form
      class="attach"
      onsubmit={(event) => {
        event.preventDefault();
        void attach();
      }}
    >
      <BucketFields
        bind:form
        bind:filled
        secretPlaceholder={editing ? "not stored — enter it again" : ""}
      />
      {#if preview}
        <p class="muted small">
          Writes to <span class="mono">{preview}</span>
        </p>
      {/if}
      <div class="row">
        <button
          class="primary"
          type="submit"
          disabled={busy !== null ||
            !preview ||
            !form.accessKeyId ||
            !form.secretAccessKey}
        >
          {busy === "attach"
            ? "Saving…"
            : editing
              ? "Save bucket"
              : "Attach bucket"}
        </button>
        {#if editing}
          <button
            type="button"
            onclick={() => (editing = false)}
            disabled={busy !== null}>Cancel</button
          >
        {:else}
          <a class="muted small" href="{base}/help#setup">How this works</a>
        {/if}
      </div>
    </form>
  {/snippet}

  <details class="panel" open>
    <summary>
      <h2>Bucket</h2>
      {#if bucket}
        <span class="muted small">
          {bucket.bucket}{bucket.prefix ? ` / ${bucket.prefix}` : ""}
          {#if !remote}· nothing uploaded yet{:else if remote.hash === currentHash}·
            holds this document{:else}· the bucket copy is behind{/if}
        </span>
      {:else}
        <span class="muted small">none attached</span>
      {/if}
    </summary>
    {#if bucketProblem}
      <Problem problem={bucketProblem} small />
    {/if}
    {#if bucket}
      {#if editing}
        {@render bucketForm()}
      {:else}
        <dl>
          <dt>bucket</dt>
          <dd class="mono">
            {bucket.bucket}{bucket.prefix ? ` / ${bucket.prefix}` : ""}
          </dd>
          <dt>endpoint</dt>
          <dd class="mono">{bucket.endpoint}</dd>
          {#if remote}
            <dt>uploaded</dt>
            <dd>
              {since(remote.at, now)} · {bytes(remote.size)} ·
              <span class="mono">{remote.hash.slice(0, 22)}…</span>
            </dd>
          {/if}
        </dl>
        {#if dashboard}
          <p class="muted small">
            <a href={dashboard} target="_blank" rel="noopener"
              >Open this bucket in Cloudflare ↗</a
            >
          </p>
        {/if}
        {#if remote && remote.hash !== currentHash}
          <p class="banner warn small">
            The bucket copy is from {since(remote.at, now)}; the document has
            changed since.
          </p>
        {/if}
        <div class="row">
          <button
            class:primary={uploadWanted}
            onclick={uploadToBucket}
            disabled={busy !== null || !meta.document}
          >
            <Icon name="upload" />
            {busy === "upload" ? "Uploading…" : "Upload document to bucket"}
          </button>
          <button onclick={downloadFromBucket} disabled={busy !== null}>
            <Icon name="download" />
            {busy === "fetch" ? "Downloading…" : "Download from bucket"}
          </button>
          <button onclick={openChooser} disabled={busy !== null}>
            {busy === "list" ? "Listing…" : "Choose from bucket…"}
          </button>
          <button onclick={startEditing} disabled={busy !== null}
            >Edit bucket…</button
          >
          <button class="danger" onclick={detach} disabled={busy !== null}
            >✕ Detach bucket…</button
          >
        </div>

        {#if choosing}
          <div class="choose">
            {#if chooseProblem}
              <Problem problem={chooseProblem} small />
            {:else if !choices}
              <p class="muted small">asking the bucket…</p>
            {:else if choices.length === 0}
              <p class="muted small">The bucket holds no documents to load.</p>
            {:else}
              <table>
                <thead>
                  <tr>
                    <th>workspace</th>
                    <th>document</th>
                    <th class="right">size</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {#each choices as choice (choice.key)}
                    <tr>
                      <td class="mono">
                        {choice.id || "(root)"}{#if choice.id === id}<span
                            class="muted"
                          >
                            · this workspace</span
                          >{/if}
                      </td>
                      <td class="mono">{choice.name}</td>
                      <td class="right">{bytes(choice.size)}</td>
                      <td class="right">
                        <button
                          onclick={() => loadFromBucket(choice)}
                          disabled={busy !== null}
                        >
                          {busy === "fetch" ? "Loading…" : "Load"}
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              {#if truncated}
                <p class="muted small">Showing the first 1000 keys.</p>
              {/if}
            {/if}
            <div class="row">
              <button
                onclick={() => (choosing = false)}
                disabled={busy !== null}>Close</button
              >
            </div>
          </div>
        {/if}
      {/if}
    {:else}
      <p class="lead">Add your own Cloudflare R2 bucket for storage.</p>
      {@render bucketForm()}
    {/if}
  </details>

  <section class="panel danger-zone">
    <h2>Workspace</h2>
    <dl>
      <dt>id</dt>
      <dd class="mono">{meta.id}</dd>
      <dt>created</dt>
      <dd>{new Date(meta.createdAt).toLocaleString()}</dd>
      <dt>role</dt>
      <dd>{meta.role}</dd>
      <dt>sync</dt>
      <dd>{meta.sync.state} · {since(meta.sync.at, now)}</dd>
    </dl>
    <div class="row">
      <button class="danger" onclick={removeWorkspace} disabled={busy !== null}
        >Delete workspace…</button
      >
    </div>
  </section>
{/if}

<style>
  /* The same compact size as the workspace cards' actions, so a button reads the same wherever it
     is pressed. `rename` keeps its own quieter treatment below. */
  button,
  .button {
    font-size: 0.875rem;
  }

  .top {
    display: flex;
    gap: 1.1rem;
    align-items: flex-start;
    margin-bottom: 1.25rem;
  }

  .titles {
    flex: 1;
    min-width: 0;
  }

  .titles h1 {
    overflow-wrap: anywhere;
  }

  .actions {
    margin-left: auto;
  }

  /* A phone puts the way into the editor under the title instead of squeezing the title to a
     column of single characters. */
  @media (max-width: 46rem) {
    .top {
      flex-wrap: wrap;
    }

    .titles {
      flex: 1 1 12rem;
    }

    .actions {
      width: 100%;
      margin-left: 0;
    }

    .open-target .filename {
      max-width: 60vw;
    }
  }

  .open-target {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    line-height: 1.2;
    text-align: left;
  }

  /* The glyph of the way into the editor, on the same line as the editor's name, as on the
	   workspace list's cards. */
  .open-target .label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .open-target .filename {
    max-width: 18rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono, monospace);
    font-size: 0.75rem;
    font-weight: 400;
    opacity: 0.85;
  }

  .small {
    font-size: 0.875rem;
    margin: 0.15rem 0;
  }

  button.link {
    border: none;
    padding: 0;
    font-size: 0.75rem;
    color: var(--dim);
    text-decoration: underline;
    vertical-align: middle;
  }

  .changes table {
    margin-bottom: 0.5rem;
  }

  .changes h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .chip.status {
    font-size: 0.75rem;
    padding: 0.05em 0.55em;
  }

  .changes .right {
    text-align: right;
  }

  .attach {
    display: grid;
    gap: 0.5rem;
    max-width: 30rem;
    margin-bottom: 0.75rem;
  }

  .lead {
    margin: 0 0 0.85rem;
  }

  /* The one action that leaves with the whole workspace, kept at the far end of the row. */
  .push {
    margin-left: auto;
  }

  details.panel > summary {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    cursor: pointer;
  }

  details.panel > summary::-webkit-details-marker {
    display: none;
  }

  details.panel > summary::before {
    content: "";
    width: 0.45rem;
    height: 0.45rem;
    margin-right: 0.15rem;
    border-right: 1.5px solid var(--dim);
    border-bottom: 1.5px solid var(--dim);
    transform: rotate(-45deg);
    transition: transform 150ms ease;
  }

  details.panel[open] > summary::before {
    transform: rotate(45deg);
  }

  details.panel > summary h2 {
    margin: 0;
  }

  .choose {
    margin-top: 0.7rem;
    border-top: 1px solid var(--line);
    padding-top: 0.6rem;
  }

  .choose .right {
    text-align: right;
  }

  table,
  dl {
    font-size: 0.875rem;
  }

  dl {
    display: grid;
    grid-template-columns: 7rem 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0 0 1rem;
  }

  dt {
    color: var(--dim);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .open-menu {
    position: relative;
    display: inline-block;
  }

  .split {
    display: inline-flex;
    align-items: stretch;
  }

  .split-pair > .button {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .split-menu {
    display: flex;
  }

  .split-menu > summary.button {
    display: flex;
    align-items: center;
    padding: 0 0.55rem;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left-color: color-mix(in srgb, var(--primary-ink) 38%, transparent);
  }

  .split-menu .menu {
    top: 100%;
    margin-top: 0.25rem;
  }

  .open-menu > summary {
    list-style: none;
    cursor: pointer;
  }

  .open-menu > summary::-webkit-details-marker {
    display: none;
  }

  .open-menu .menu {
    position: absolute;
    right: 0;
    z-index: 20;
    min-width: 10rem;
    padding: 0.25rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    box-shadow: 0 6px 18px rgb(0 0 0 / 18%);
  }

  .open-menu .menu a {
    display: block;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    white-space: nowrap;
  }

  .open-menu .menu a:hover {
    background: color-mix(in srgb, var(--line) 35%, transparent);
  }
</style>
