<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import "../app.css";
  import Icon from "$lib/Icon.svelte";
  import Brand from "$lib/Brand.svelte";
  import {
    capabilities,
    capabilitiesReady,
    loadCapabilities,
  } from "$lib/capabilities";
  import { bytes } from "$lib/format";
  import { editorFor, editorHref } from "$lib/editors";
  import { failure, refresh, storage, watch, workspaces } from "$lib/session";
  import { startTheme, theme, toggleTheme } from "$lib/theme.svelte";

  let { children } = $props();

  onMount(() => {
    startTheme();
    void loadCapabilities();
    void refresh();
    const stopWatching = watch();
    return () => {
      stopWatching();
    };
  });

  const here = $derived(page.url.pathname);
  // An embedded editor owns the whole viewport: the cloud app's bar and storage strip would only take
  // height from it. Its own page carries the way back and the save state.
  const embedded = $derived(here.endsWith("/edit/pdfcraft"));
  const origin = browser ? location.origin : "";
  const share = $derived(
    $storage.quota ? Math.min(1, $storage.usage / $storage.quota) : 0,
  );
  // The editor needs a workspace to be useful: launched bare it can see no document and offers no way
  // back, so the link goes into the one that changed last (the store is newest first).
  const latest = $derived($workspaces[0]);
  const latestEditor = $derived(
    latest ? editorFor(latest.document, latest.editor) : null,
  );

  /**
   * What the warning beside "Local storage" says on hover. "Best-effort" is the storage spec's word for it
   * and says nothing to anyone; this says where the work actually lives, and what follows from that.
   */
  const browserOnly =
    "Stored in this browser: it may be cleared at any time, and nothing is copied off this machine unless you " +
    "put it in a bucket.\n" +
    "If it is cleared, a workspace you never downloaded or uploaded is gone.";
</script>

{#if !embedded}
  <a class="skip" href="#main">Skip to content</a>
  <header class="appbar">
    <a class="brand" href="{base}/">
      <Brand />
    </a>
    <nav class="chrome" aria-label="Sections">
      <span class="links">
        <a
          href="{base}/"
          aria-current={here === base || here === `${base}/`
            ? "page"
            : undefined}>Workspaces</a
        >
        <a
          href="{base}/settings"
          aria-current={here.startsWith(`${base}/settings`)
            ? "page"
            : undefined}>Settings</a
        >
        <a
          href="{base}/help"
          aria-current={here.startsWith(`${base}/help`) ? "page" : undefined}
          >Help</a
        >
        {#if $capabilitiesReady && $capabilities.central}
          <a
            href={$capabilities.central.login}
            title="Sign in through {$capabilities.central.url}">Sign in</a
          >
        {/if}
      </span>
      <button
        class="theme-toggle"
        onclick={toggleTheme}
        aria-label="Switch to {theme.current === 'dark'
          ? 'light'
          : 'dark'} theme"
        title="Switch to {theme.current === 'dark' ? 'light' : 'dark'} theme"
      >
        <Icon name={theme.current === "dark" ? "sun" : "moon"} size={16} />
      </button>
      {#if latest && latestEditor}
        <a
          class="action"
          href={editorHref(
            latestEditor,
            latest.id,
            latest.document ?? undefined,
          )}
          target="_blank"
          rel="noopener"
          title="Open {latest.name}
            {latest.document
            ? ` / ${latest.document}`
            : ''} in {latestEditor.title}"
        >
          Open in {latestEditor.title}
          <span class="where">{latest.name}</span>
          {#if latest.document}
            <span class="where doc">{latest.document}</span>
          {/if}
        </a>
      {:else}
        <a
          class="action"
          href="{base}/?new=1"
          title="Start a new workspace to open the editor in"
          >In a new workspace</a
        >
      {/if}
    </nav>
  </header>

  {#if $storage.supported === true}
    <div class="strip health">
      <span>Local storage</span>
      {#if $storage.persisted}
        <span
          class="chip ok"
          title="Granted: this origin is not evicted under storage pressure."
          >persistent</span
        >
      {:else}
        <span class="warn-note" title={browserOnly}
          ><Icon name="warn" size={13} /> may be cleared</span
        >
      {/if}
      <span class="meter"
        ><span style="width: {(share * 100).toFixed(1)}%"></span></span
      >
      <span class="amount">
        {bytes($storage.usage)} used of {bytes($storage.quota)}{$storage.quota
          ? ` (${(share * 100).toFixed(1)}%)`
          : ""}
      </span>
      {#if origin}
        <span
          class="chip mono origin"
          title="One origin is what makes both apps share this OPFS"
          >{origin}</span
        >
      {/if}
    </div>
  {/if}

  <main class="shell" id="main">
    {#if $storage.supported === false}
      <p class="banner bad">
        This browser has no Origin Private File System, or storage is blocked (a
        private window, or storage disabled by policy). Atelier Cloud keeps the
        cloudspace in OPFS, so it cannot work without it.
      </p>
    {/if}

    {#if $failure}
      <p class="banner bad">Could not read the cloudspace: {$failure}</p>
    {/if}

    {@render children()}
  </main>
{:else}
  {@render children()}
{/if}
