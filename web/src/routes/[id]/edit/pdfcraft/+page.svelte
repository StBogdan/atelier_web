<script lang="ts">
  /** PdfCraft, framed in a cloud page so it shares this origin and this OPFS (design, The Bridge Route). */
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import Problem from "$lib/Problem.svelte";
  import Brand from "$lib/Brand.svelte";
  import Icon from "$lib/Icon.svelte";
  import { bytes } from "$lib/format";
  import { downloadWorkspace, downloadWorkspaceFiles } from "$lib/actions";
  import { editorsFor } from "$lib/editors";
  import {
    ensureSpace,
    inspect,
    PROJECT_FILES,
    readDocument,
    readMeta,
    sanitiseDocumentName,
    saveFromEditor,
    type Meta,
    type Workspace,
  } from "$lib/contract";
  import { rememberOpened } from "$lib/recent";
  import { refresh } from "$lib/session";
  import { SPACE, type Directory } from "$lib/opfs";

  const id = $derived(page.params.id ?? "");

  let space = $state<Directory | null>(null);
  let meta = $state<Meta | null>(null);
  let workspace = $state<Workspace | null>(null);
  let frame = $state<HTMLIFrameElement | null>(null);
  let listening = $state(false);
  let ready = $state(false);
  let dirty = $state(false);
  let saving = $state(false);
  let problem = $state<unknown>(null);
  let notice = $state<string | null>(null);
  let opened = $state<string | null>(null);
  let listOpen = $state(false);
  let saveAsRequest = $state<{ name: string; bytes: Uint8Array } | null>(null);
  let saveAsName = $state("");
  let saveAsProblem = $state<string | null>(null);
  let saveAsInput = $state<HTMLInputElement | null>(null);

  const documents = $derived(workspace?.documents ?? []);
  const openable = $derived(
    documents.filter((document) =>
      editorsFor(document.name).some((editor) => editor.id === "pdfcraft"),
    ),
  );

  function post(
    message: Record<string, unknown>,
    transfer: Transferable[] = [],
  ) {
    frame?.contentWindow?.postMessage(message, location.origin, transfer);
  }

  /** Read one document from OPFS and hand it to PdfCraft, which opens it as a tab. */
  async function openDocument(name: string) {
    if (!space || !id) return;
    try {
      problem = null;
      notice = null;
      const read = await readDocument(space, id, name);
      if (!read) throw new Error(`${name} is not in this workspace`);
      const copy = read.bytes.slice();
      post(
        {
          type: "pdfcraft:open",
          name: read.name,
          bytes: copy.buffer as ArrayBuffer,
        },
        [copy.buffer as ArrayBuffer],
      );
      opened = read.name;
      // The workspace page's Open button follows the document last used here.
      rememberOpened(id, read.name);
      listOpen = false;
    } catch (e) {
      problem = e;
    }
  }

  /**
   * Take a copy out of this browser: the document named, or every document in the workspace as one
   * zip when nothing is named. The workspace page offers the same two.
   */
  async function download(name?: string) {
    if (!space) return;
    try {
      problem = null;
      // The browser's own download shelf says what happened; the bar has nothing to add.
      if (name) await downloadWorkspace(space, id, name);
      else await downloadWorkspaceFiles(space, id);
    } catch (e) {
      problem = e;
    }
  }

  async function readWorkspace() {
    if (!space || !id) return;
    meta = await readMeta(space, id);
    workspace = await inspect(space, id);
  }

  function bytesOf(data: unknown): Uint8Array | null {
    return data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data instanceof Uint8Array
        ? data
        : null;
  }

  function announce(document: string, length: number) {
    if (!("BroadcastChannel" in window)) return;
    const channel = new BroadcastChannel(SPACE);
    channel.postMessage({
      type: "document-saved",
      project: id,
      document,
      bytes: length,
      at: new Date().toISOString(),
    });
    channel.close();
  }

  async function save(name: unknown, data: unknown) {
    if (!space || !id || typeof name !== "string") return;
    const saved = bytesOf(data);
    if (!saved) return;
    saving = true;
    try {
      problem = null;
      notice = null;
      const written = await saveFromEditor(space, id, name, saved);
      announce(written, saved.length);
      await readWorkspace();
      await refresh();
      notice = `Saved ${written}`;
    } catch (e) {
      problem = e;
    } finally {
      saving = false;
    }
  }

  /**
   * Save As from the bridge. PdfCraft can only name the document it already has, so the host asks
   * for a new name, writes the bytes as a new document, and opens that copy in a new tab: later
   * saves then land in the copy rather than the original.
   */
  function askSaveAs(name: unknown, data: unknown) {
    if (typeof name !== "string") return;
    const bytes = bytesOf(data);
    if (!bytes) return;
    saveAsProblem = null;
    saveAsName = name.toLowerCase().endsWith(".pdf")
      ? `${name.slice(0, -4)} copy.pdf`
      : `${name} copy.pdf`;
    saveAsRequest = { name, bytes };
  }

  function cancelSaveAs() {
    saveAsRequest = null;
    saveAsProblem = null;
    notice = "Copy cancelled; the original was not changed.";
  }

  async function saveCopy() {
    if (!space || !id || !saveAsRequest) return;
    const safe = sanitiseDocumentName(saveAsName);
    if (!safe) {
      saveAsProblem = "Enter a name for the copy.";
      return;
    }
    const target = safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
    if (PROJECT_FILES.has(target) || target.endsWith(".prev")) {
      saveAsProblem = `${target} is not a document name.`;
      return;
    }
    if (documents.some((document) => document.name === target)) {
      saveAsProblem = `${target} already exists in this workspace.`;
      return;
    }
    saving = true;
    try {
      const written = await saveFromEditor(
        space,
        id,
        target,
        saveAsRequest.bytes,
      );
      announce(written, saveAsRequest.bytes.length);
      const copy = saveAsRequest.bytes.slice();
      post(
        {
          type: "pdfcraft:open",
          name: written,
          bytes: copy.buffer as ArrayBuffer,
        },
        [copy.buffer as ArrayBuffer],
      );
      opened = written;
      saveAsRequest = null;
      saveAsProblem = null;
      await readWorkspace();
      await refresh();
      notice = `Saved a copy as ${written}`;
    } catch (e) {
      saveAsProblem = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    const onMessage = (event: MessageEvent) => {
      // The bridge only speaks to its direct parent, on this origin. Check the same two things here.
      if (event.origin !== location.origin) return;
      if (event.source !== frame?.contentWindow) return;
      const data = event.data as {
        type?: string;
        name?: unknown;
        bytes?: unknown;
        saveAs?: unknown;
        dirty?: unknown;
        error?: unknown;
      };
      switch (data?.type) {
        case "pdfcraft:ready":
          ready = true;
          break;
        case "pdfcraft:save":
          if (data.saveAs) askSaveAs(data.name, data.bytes);
          else void save(data.name, data.bytes);
          break;
        case "pdfcraft:dirty":
          dirty = Boolean(data.dirty);
          break;
        case "pdfcraft:failed":
          problem = new Error(String(data.error ?? "PdfCraft could not start"));
          break;
      }
    };
    window.addEventListener("message", onMessage);
    listening = true;
    // A bookmarked or shared link names the document it wants; the workspace page's Open button
    // follows it even if the editor never gets that far.
    const requested = page.url.searchParams.get("document");
    if (requested) rememberOpened(id, requested);
    void (async () => {
      try {
        space = await ensureSpace();
        await readWorkspace();
      } catch (e) {
        problem = e;
      }
    })();
    return () => window.removeEventListener("message", onMessage);
  });

  // The bridge announces itself once it is listening; only then is a post guaranteed to arrive.
  // The URL names the document to open once. Later opens (Save As, the document list) must not be
  // undone by this effect re-running when `opened` changes.
  let initialOpenDone = false;
  $effect(() => {
    if (!ready || initialOpenDone) return;
    const wanted =
      page.url.searchParams.get("document") ??
      meta?.document ??
      openable[0]?.name ??
      null;
    if (!wanted) return;
    initialOpenDone = true;
    // The workspace page's Open button follows this document, whether or not the editor finishes
    // starting: the page was asked for it.
    rememberOpened(id, wanted);
    void openDocument(wanted);
  });

  $effect(() => {
    if (saveAsRequest && saveAsInput) {
      saveAsInput.focus();
      saveAsInput.select();
    }
  });

  // The dialog covers the page, so its Escape belongs to it wherever focus sits inside the parent.
  $effect(() => {
    if (!saveAsRequest) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelSaveAs();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="embed">
  <header class="bar">
    <a class="mark" href="{base}/" aria-label="Atelier Cloud"
      ><Brand size={24} names={false} /></a
    >
    <a
      class="back"
      href="{base}/{id}"
      title="Back to {meta?.name ?? 'the workspace'}"
      >← <span class="back-label">Workspace</span></a
    >
    <span class="workspace" title={meta?.name ?? undefined}
      >{meta?.name ?? "Workspace"}</span
    >
    <span class="divider" aria-hidden="true"></span>
    <!-- The document the editor has open is itself the control that opens the rest: a set-of-pages
         glyph and a chevron say there is a list behind the name. -->
    <button
      type="button"
      class="picker"
      aria-expanded={listOpen}
      onclick={() => (listOpen = !listOpen)}
      title={opened
        ? `${opened} — choose another document`
        : "Choose a document to open"}
    >
      <Icon name="documents" />
      <span class="file">{opened ?? "Choose a document"}</span>
      <svg
        class="chevron"
        viewBox="0 0 10 6"
        width="9"
        height="6"
        aria-hidden="true"
      >
        <path
          d="M1 1l4 4 4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <span class="status">
      {#if notice}
        <span class="notice">{notice}</span>
      {/if}
      <span class="state" class:dirty>
        {#if saving}
          Saving…
        {:else if dirty}
          Unsaved changes
        {/if}
      </span>
    </span>
  </header>

  {#if problem}
    <div class="problem"><Problem {problem} banner /></div>
  {/if}

  <div class="frame-row">
    {#if listOpen}
      <aside class="documents" aria-label="Documents">
        <div class="documents-head">
          <h2>Documents</h2>
          <button type="button" onclick={() => (listOpen = false)}>Close</button
          >
        </div>
        {#if openable.length}
          <button
            type="button"
            class="take-all"
            onclick={() => void download()}
            title="Download every document in this workspace as one zip"
            ><Icon name="download" /> Download all</button
          >
          <ul>
            {#each openable as document (document.name)}
              <li>
                <button
                  type="button"
                  class="open"
                  class:current={opened === document.name}
                  onclick={() => openDocument(document.name)}
                  title="Open {document.name} in PdfCraft"
                >
                  <span class="name">{document.name}</span>
                  <span class="size">{bytes(document.size)}</span>
                </button>
                <button
                  type="button"
                  class="take"
                  onclick={() => void download(document.name)}
                  title="Download {document.name} to this computer"
                  aria-label="Download {document.name}"
                >
                  <Icon name="download" size={13} />
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="muted small">
            This workspace holds no document PdfCraft can open. Open a PDF from
            this computer and save it here.
          </p>
        {/if}
      </aside>
    {/if}
    <div class="frame">
      {#if listening}
        <iframe bind:this={frame} src="/pdfcraft/?host=parent" title="PdfCraft"
        ></iframe>
      {/if}
    </div>
  </div>

  {#if saveAsRequest}
    <div class="sheet-backdrop">
      <div
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-as-title"
      >
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void saveCopy();
          }}
        >
          <h2 id="save-as-title">Save a copy</h2>
          <p class="muted small">
            {saveAsRequest.name} stays as it is. The copy opens in PdfCraft as a new
            tab.
          </p>
          <label class="field">
            <span>Name</span>
            <input
              bind:this={saveAsInput}
              bind:value={saveAsName}
              type="text"
              spellcheck="false"
            />
          </label>
          {#if saveAsProblem}
            <p class="bad small">{saveAsProblem}</p>
          {/if}
          <div class="sheet-actions">
            <button type="button" onclick={cancelSaveAs}>Cancel</button>
            <button type="submit" class="primary" disabled={saving}>
              {saving ? "Saving…" : "Save copy"}
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}
</div>

<style>
  .embed {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: #19191c;
  }

  /* The same bar as the rest of the app: chrome-coloured, one height, one set of paddings, so the
     frame around the editor reads as this product rather than an embedded viewer. */
  .bar {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    min-height: 3.25rem;
    padding: 0.35rem 1.25rem;
    background: var(--chrome);
    border-bottom: 1px solid var(--rule);
    font-size: 0.85rem;
    z-index: 10;
  }

  /* The mark sits where the app bar's does, and goes home the same way. */
  .mark {
    display: flex;
    flex: none;
    align-items: center;
  }

  .back {
    color: var(--dim);
    text-decoration: none;
    white-space: nowrap;
  }

  .back:hover,
  .back:focus-visible {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* The workspace the page belongs to, then the file it has open: named apart, so the two are not
     read as one long title. */
  .workspace {
    max-width: 22rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .divider {
    flex: none;
    width: 1px;
    height: 1.25rem;
    background: var(--hairline);
  }

  /* The open document, drawn as a control: the same border and height as the app's buttons, and the
     glyph and chevron that say a list of documents is behind the name. */
  .picker {
    display: inline-flex;
    align-items: center;
    gap: 0.45em;
    min-width: 0;
    min-height: 2rem;
    max-width: 26rem;
    padding: 0.32em 0.6em;
    border: 1px solid var(--field-line);
    border-radius: var(--radius);
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .picker:hover {
    background: var(--hover);
    border-color: var(--accent);
  }

  .picker[aria-expanded="true"] {
    background: var(--pressed);
    border-color: var(--accent);
  }

  .picker :global(svg) {
    flex: none;
    color: var(--dim);
  }

  .picker .file {
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron {
    transition: transform 150ms ease;
  }

  .picker[aria-expanded="true"] .chevron {
    transform: rotate(180deg);
  }

  /* The one thing on this bar that is about the work rather than the place: at the far end, where
     the app bar puts its own status. */
  .status {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .notice {
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state {
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state.dirty {
    color: var(--warn);
  }

  .problem {
    position: absolute;
    top: 3.25rem;
    left: 0.75rem;
    right: 0.75rem;
    z-index: 20;
  }

  .frame-row {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  /* The list is a column of the app's own kind: one tone, squared, rows divided by a hairline. The
     editor's canvas beside it is dark, so the panel keeps its own surface rather than sitting on it. */
  .documents {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 15;
    width: min(20rem, 85vw);
    overflow: auto;
    padding: 0.9rem 1rem 1.25rem;
    background: var(--panel);
    border-right: 1px solid var(--hairline);
  }

  .documents-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding-bottom: 0.6rem;
    margin-bottom: 0.6rem;
    border-bottom: 1px solid var(--hairline);
  }

  /* The same label the workspace page puts above a section. */
  .documents-head h2 {
    margin: 0 auto 0 0;
    font-size: 0.72rem;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--dim);
  }

  .documents-head button {
    display: inline-flex;
    align-items: center;
    gap: 0.3em;
    min-height: 1.75rem;
    padding: 0.15rem 0.45rem;
    border: 1px solid var(--field-line);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .documents-head button:hover {
    border-color: var(--accent);
    background: var(--hover);
  }

  /* Every document in the workspace: the collection's own action, on its own line, above the rows
     that each carry theirs. */
  .documents .take-all {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.4em;
    margin: 0 0 0.5rem;
    justify-content: flex-start;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--field-line);
    border-radius: var(--radius);
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 560;
    text-align: left;
    cursor: pointer;
  }

  .documents .take-all:hover {
    border-color: var(--accent);
    background: var(--hover);
  }

  /* Rows on the panel, divided by the same hairline as a table on the workspace page: no boxes, no
     gaps, so the list reads as one column of files. */
  .documents ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .documents ul li {
    display: flex;
    align-items: stretch;
    gap: 0.25rem;
    border-bottom: 1px solid var(--hairline);
  }

  .documents ul .open {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    padding: 0.5rem 0.35rem 0.5rem 0;
    border: 0;
    border-radius: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .documents ul .open:hover .name {
    color: var(--link);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* The document the editor has open, marked the way the app marks a state: a dot and a word, in the
     accent, rather than a filled row. */
  .documents ul .open.current .name {
    color: var(--ink);
    font-weight: 600;
  }

  /* One square target beside the row, with the file in its label, rather than a second line of text
     competing with the name. */
  .documents ul .take {
    flex: none;
    align-self: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--dim);
    cursor: pointer;
  }

  .documents ul .take:hover {
    color: var(--ink);
    border-color: var(--field-line);
    background: var(--hover);
  }

  .documents .name {
    font-family: var(--mono);
    font-size: 0.8rem;
    word-break: break-all;
  }

  .documents .size {
    color: var(--dim);
    font-size: 0.72rem;
  }

  .frame {
    position: absolute;
    inset: 0;
  }

  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #19191c;
  }

  .sheet-backdrop {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.38);
  }

  .sheet {
    width: min(24rem, calc(100vw - 2rem));
    padding: 1rem 1.15rem 1.15rem;
    border: 1px solid var(--hairline);
    border-radius: 0;
    background: var(--panel);
    color: var(--ink);
    box-shadow: var(--shadow);
  }

  .sheet form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* A section's name on the workspace page: a small tracked-out label. */
  .sheet h2 {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--dim);
  }

  .sheet p {
    margin: 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
  }

  .field input {
    width: 100%;
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--field-line);
    border-radius: var(--radius);
    background: var(--field);
    color: inherit;
    font: inherit;
  }

  .sheet-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  /* Too narrow for the whole trail: the back arrow stands for the workspace, and the picker gives
     way to the state, which is the one thing here about unsaved work. */
  @media (max-width: 40rem) {
    .bar {
      gap: 0.6rem;
      padding-inline: 0.75rem;
    }

    .divider,
    .workspace,
    .back-label,
    .notice {
      display: none;
    }

    .picker {
      max-width: 35vw;
      padding-inline: 0.45em;
    }
  }
</style>
