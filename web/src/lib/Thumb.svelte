<script lang="ts">
	/**
	 * A project's `thumb.png` out of OPFS. It cannot be an `<img src>`: OPFS has no URLs, so the
	 * bytes are read and wrapped in an object URL, and revoked again on teardown.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { ensureSpace } from '$lib/contract';
	import { directory, readBytes } from '$lib/opfs';

	let { id, available, size = 88 }: { id: string; available: boolean; size?: number } = $props();
	let url = $state<string | null>(null);

	onMount(() => {
		void (async () => {
			if (!available) return;
			try {
				const space = await ensureSpace();
				const dir = await directory(await directory(space, 'projects'), id);
				const bytes = await readBytes(dir, 'thumb.png');
				url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
			} catch {
				// A missing or unreadable preview is not an error worth showing: the card still works.
			}
		})();
	});

	onDestroy(() => {
		if (url) URL.revokeObjectURL(url);
	});
</script>

<div class="thumb" style="width: {size}px; height: {size}px">
	{#if url}
		<img src={url} alt="" />
	{:else}
		<span class="muted">no preview</span>
	{/if}
</div>

<style>
	.thumb {
		flex: none;
		border-radius: 8px;
		border: 1px solid var(--line);
		overflow: hidden;
		display: grid;
		place-items: center;
		font-size: 0.72rem;
		background: color-mix(in srgb, var(--line) 35%, transparent);
	}

	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
