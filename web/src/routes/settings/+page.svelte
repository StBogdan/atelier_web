<script lang="ts">
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import { capabilities } from "$lib/capabilities";
  import { bytes, plural } from "$lib/format";
  import { ensureSpace } from "$lib/contract";
  import {
    directory,
    files,
    remove,
    stat,
    subdirectories,
    SPACE,
    type Directory,
  } from "$lib/opfs";
  import { refresh, storage, workspaces } from "$lib/session";

  interface Entry {
    name: string;
    size: number;
    kind: "file" | "directory";
    children?: number;
  }

  let tree = $state<Entry[]>([]);
  let busy = $state(false);
  let problem = $state<string | null>(null);

  async function children(dir: Directory): Promise<Entry[]> {
    const entries: Entry[] = [];
    for (const name of await subdirectories(dir)) {
      const nested = await directory(dir, name);
      entries.push({
        name: `${name}/`,
        size: 0,
        kind: "directory",
        children: (await files(nested)).length,
      });
    }
    for (const name of await files(dir)) {
      const info = await stat(dir, name);
      entries.push({ name, size: info?.size ?? 0, kind: "file" });
    }
    return entries.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    );
  }

  async function inspect() {
    problem = null;
    try {
      tree = await children(await ensureSpace());
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => void inspect());

  /** `tmp/` is the only thing here that is safe to drop: transient staging from a killed tab. */
  async function clearStaging() {
    busy = true;
    try {
      const staging = await directory(await ensureSpace(), "tmp", true);
      for (const name of await files(staging))
        await remove(staging, name).catch(() => {});
      await inspect();
      await refresh();
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>Settings — Atelier Cloud</title>
  <meta
    name="description"
    content="What this browser's cloudspace uses, whether the origin's storage is persistent, and how to clear what is cached here."
  />
</svelte:head>

<h1>Settings</h1>

<div class="stack">
  <section class="panel">
    <h2>Local storage</h2>
    <dl>
      <dt>Origin</dt>
      <dd class="mono">
        {typeof location === "undefined" ? "" : location.origin}
      </dd>
      <dt>Used</dt>
      <dd>{bytes($storage.usage)}</dd>
      <dt>Local storage</dt>
      <dd>
        {bytes($storage.quota)}{$storage.quota
          ? ` (${(($storage.usage / $storage.quota) * 100).toFixed(1)}% used)`
          : ""}
      </dd>
      <dt>Persistence</dt>
      <dd class:ok={$storage.persisted} class:warn={!$storage.persisted}>
        {$storage.persisted
          ? "granted: this origin is not evicted under storage pressure"
          : "best-effort: the browser may clear everything for this origin"}
      </dd>
      <dt>Bucket</dt>
      <dd>
        {#if $capabilities.storage === "provisioned"}
          Provisioned by this deployment: each account gets its own storage,
          with a credential minted for the session. A workspace shows the bucket
          its copy goes to.
        {:else}
          A bucket is attached per workspace, and signed for in this browser —
          open a workspace to attach one, or read <a href="{base}/help#setup"
            >Help</a
          >.
        {/if}
      </dd>
    </dl>
  </section>

  <section class="panel">
    <h2>Cloudspace contents</h2>
    {#if problem}
      <p class="bad small">{problem}</p>
    {:else}
      <p class="muted small">
        Everything Atelier Cloud owns is under <code>{SPACE}/</code>. The only
        thing here that is not regenerable is <code>outbox/</code>: work saved
        to <a href="{base}/help#storage">OPFS</a> and not committed yet.
      </p>
      <table>
        <tbody>
          {#each tree as entry (entry.name)}
            <tr>
              <td class="mono">{entry.name}</td>
              <td class="muted">
                {entry.kind === "directory"
                  ? plural(entry.children ?? 0, "entry", "entries")
                  : ""}
              </td>
              <td class="right"
                >{entry.kind === "file" ? bytes(entry.size) : ""}</td
              >
            </tr>
          {/each}
        </tbody>
      </table>
      {#if $workspaces.length}
        <p class="muted small">
          {$workspaces.length} workspace{$workspaces.length === 1 ? "" : "s"}, {bytes(
            $workspaces.reduce((total, workspace) => total + workspace.size, 0),
          )} of documents.
        </p>
      {/if}
    {/if}
    <div class="row">
      <button onclick={clearStaging} disabled={busy}
        >Clear <code>tmp/</code> staging</button
      >
    </div>
  </section>
</div>

<style>
  dl {
    display: grid;
    grid-template-columns: 8rem 1fr;
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

  .small {
    font-size: 0.86rem;
    margin: 0.15rem 0;
  }

  .right {
    text-align: right;
  }
</style>
