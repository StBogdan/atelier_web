<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { browser } from '$app/environment';
	import '../app.css';
	import { bytes } from '$lib/format';
	import { failure, guardUnload, refresh, storage, unsynced, watch } from '$lib/session';

	let { children } = $props();

	onMount(() => {
		void refresh();
		const stopWatching = watch();
		const stopGuard = guardUnload();
		return () => {
			stopWatching();
			stopGuard();
		};
	});

	const here = $derived(page.url.pathname);
	const origin = browser ? location.origin : '';
	const share = $derived($storage.quota ? Math.min(1, $storage.usage / $storage.quota) : 0);
</script>

<div class="shell">
	<header class="chrome">
		<a class="brand" href="{base}/">
			Atelier Cloud
			<small>cloudspace for PhotoCraft</small>
		</a>
		{#if origin}
			<span class="chip mono" title="One origin is what makes both apps share this OPFS">{origin}</span>
		{/if}
		<nav class="chrome">
			<a href="{base}/" aria-current={here === base || here === `${base}/` ? 'page' : undefined}>Workspaces</a>
			<a href="{base}/settings" aria-current={here.startsWith(`${base}/settings`) ? 'page' : undefined}>Settings</a>
			<a href="/">Editor</a>
		</nav>
	</header>

	{#if $storage.supported === true}
		<div class="row health">
			<span class="muted">Storage</span>
			<span class="meter"><span style="width: {(share * 100).toFixed(1)}%"></span></span>
			<span class="muted">
				{bytes($storage.usage)} used of {bytes($storage.quota)}{$storage.quota ? ` (${(share * 100).toFixed(1)}%)` : ''}
			</span>
			<span class="chip {$storage.persisted ? 'ok' : 'warn'}">{$storage.persisted ? 'persistent' : 'best-effort'}</span>
		</div>
	{/if}

	{#if $storage.supported === false}
		<p class="banner bad">
			This browser has no Origin Private File System, or storage is blocked (a private window, or storage disabled by
			policy). Atelier Cloud keeps the cloudspace there, so it cannot work without it.
		</p>
	{:else if $storage.supported === true && !$storage.persisted}
		<p class="banner warn">
			Storage here is best-effort: this browser may clear everything for this origin at any time, and there is no
			server copy of your work yet. A workspace you have not downloaded is a workspace you can lose.
		</p>
	{/if}

	{#if $failure}
		<p class="banner bad">Could not read the cloudspace: {$failure}</p>
	{:else if $unsynced > 0}
		<p class="banner">
			{$unsynced === 1 ? 'One workspace has' : `${$unsynced} workspaces have`} changes that are not committed yet: they live in
			<code>atelier-cloud/outbox/</code>, and nothing else has them.
		</p>
	{/if}

	{@render children()}
</div>

<svelte:head>
	<title>Atelier Cloud</title>
</svelte:head>

<style>
	.health {
		margin-bottom: 1rem;
		gap: 0.75rem;
	}
</style>
