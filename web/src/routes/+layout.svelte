<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import "../app.css";
  import {
    capabilities,
    capabilitiesReady,
    loadCapabilities,
  } from "$lib/capabilities";
  import { bytes } from "$lib/format";
  import { failure, refresh, storage, watch, workspaces } from "$lib/session";

  let { children } = $props();

  onMount(() => {
    void loadCapabilities();
    void refresh();
    const stopWatching = watch();
    return () => {
      stopWatching();
    };
  });

  const here = $derived(page.url.pathname);
  const origin = browser ? location.origin : "";
  const share = $derived(
    $storage.quota ? Math.min(1, $storage.usage / $storage.quota) : 0,
  );
  // The editor needs a workspace to be useful: launched bare it can see no document and offers no way
  // back, so the link goes into the one that changed last (the store is newest first).
  const latest = $derived($workspaces[0]);

  /**
   * What the warning beside "Local storage" says on hover. "Best-effort" is the storage spec's word for it
   * and says nothing to anyone; this says where the work actually lives, and what follows from that.
   */
  const browserOnly =
    "Stored in this browser: it may be cleared at any time, and nothing is copied off this machine unless you " +
    "put it in a bucket.\n" +
    "A workspace you have not downloaded is a workspace you can lose.";
</script>

<header class="appbar">
  <a class="brand" href="{base}/">
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path
        d="M9 23 16 9l7 14"
        fill="none"
        stroke="#fff"
        stroke-width="2.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M12.2 18.6h7.6"
        stroke="#fff"
        stroke-width="2.2"
        stroke-linecap="round"
      />
    </svg>
    <span class="names">
      <strong>Atelier Cloud</strong>
      <small>cloudspace for PhotoCraft</small>
    </span>
  </a>
  <nav class="chrome" aria-label="Sections">
    <span class="links">
      <a
        href="{base}/"
        aria-current={here === base || here === `${base}/` ? "page" : undefined}
        >Workspaces</a
      >
      <a
        href="{base}/settings"
        aria-current={here.startsWith(`${base}/settings`) ? "page" : undefined}
        >Settings</a
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
    {#if latest}
      <a
        class="action"
        href="/?project={latest.id}"
        target="_blank"
        rel="noopener"
        title="Open {latest.name} in the editor"
      >
        Open editor
        <span class="where">{latest.name}</span>
      </a>
    {:else}
      <a
        class="action"
        href="{base}/?new=1"
        title="Start a new workspace to open the editor in">In new workspace</a
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
      <span class="warn-icon" title={browserOnly}>⚠</span>
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

<main class="shell">
  {#if $storage.supported === false}
    <p class="banner bad">
      This browser has no Origin Private File System, or storage is blocked (a
      private window, or storage disabled by policy). Atelier Cloud keeps the
      cloudspace there, so it cannot work without it.
    </p>
  {/if}

  {#if $failure}
    <p class="banner bad">Could not read the cloudspace: {$failure}</p>
  {/if}

  {@render children()}
</main>

<svelte:head>
  <title>Atelier Cloud</title>
</svelte:head>
