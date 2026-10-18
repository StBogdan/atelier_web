<script lang="ts">
  /** PdfCraft, framed in a cloud page so it shares this origin and this OPFS (design, The Bridge Route). */
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import Problem from "$lib/Problem.svelte";
  import { bytes } from "$lib/format";
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
      listOpen = false;
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
    <a class="back" href="{base}/workspace/{id}">← Workspace</a>
    <span class="file">{meta?.name ?? ""}</span>
    <button
      type="button"
      class="documents-toggle"
      aria-expanded={listOpen}
      onclick={() => (listOpen = !listOpen)}
    >
      Documents
      <span class="count">{openable.length}</span>
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
        {:else if ready}
          PdfCraft
        {:else}
          Starting PdfCraft…
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
          <ul>
            {#each openable as document (document.name)}
              <li>
                <button
                  type="button"
                  class:current={opened === document.name}
                  onclick={() => openDocument(document.name)}
                  title="Open {document.name} in PdfCraft"
                >
                  <span class="name">{document.name}</span>
                  <span class="size">{bytes(document.size)}</span>
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

  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2.75rem;
    padding: 0.35rem 0.75rem;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    font-size: 0.85rem;
    z-index: 10;
  }

  .back {
    font-weight: 560;
    text-decoration: none;
    white-space: nowrap;
  }

  .file {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .documents-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .documents-toggle[aria-expanded="true"] {
    background: color-mix(in srgb, var(--line) 45%, transparent);
  }

  .count {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .status {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .notice {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state {
    color: var(--muted);
    white-space: nowrap;
  }

  .state.dirty {
    color: var(--warn, #a16207);
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

  .documents {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 15;
    width: min(18rem, 85vw);
    overflow: auto;
    padding: 0.75rem;
    background: var(--panel);
    border-right: 1px solid var(--line);
    box-shadow: 0 0 2.5rem rgb(0 0 0 / 0.3);
  }

  .documents-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .documents-head h2 {
    margin: 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  .documents-head button {
    padding: 0.15rem 0.45rem;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .documents ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .documents ul button {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid transparent;
    border-radius: 7px;
    background: none;
    text-align: left;
    cursor: pointer;
  }

  .documents ul button:hover,
  .documents ul button.current {
    border-color: var(--line);
    background: color-mix(in srgb, var(--line) 30%, transparent);
  }

  .documents .name {
    font-family: var(--mono, monospace);
    font-size: 0.8rem;
    word-break: break-all;
  }

  .documents .size {
    color: var(--muted);
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
    padding: 1rem;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    color: var(--ink);
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.45);
  }

  .sheet form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .sheet h2 {
    margin: 0;
    font-size: 1rem;
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
    border-radius: 7px;
    background: var(--bg);
    color: inherit;
    font: inherit;
  }

  .sheet-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  @media (max-width: 40rem) {
    .file,
    .notice {
      display: none;
    }
  }
</style>
