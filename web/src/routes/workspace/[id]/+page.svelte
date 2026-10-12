<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import Thumb from '$lib/Thumb.svelte';
	import { bytes, objects, since } from '$lib/format';
	import {
		commit,
		discard,
		documentBytes,
		ensureSpace,
		pendingChange,
		readMeta,
		removeProject,
		rename,
		type Change,
		type Meta
	} from '$lib/contract';
	import { ensurePersistence, refresh } from '$lib/session';

	const id = $derived(page.params.id ?? '');

	let meta = $state<Meta | null>(null);
	let change = $state<Change | null>(null);
	let busy = $state<string | null>(null);
	let problem = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let renaming = $state(false);
	let newName = $state('');
	let now = $state(Date.now());

	async function load() {
		problem = null;
		const space = await ensureSpace();
		const found = await readMeta(space, id);
		meta = found;
		if (!found) {
			problem = 'this workspace has no meta.json';
			return;
		}
		newName = found.name;
		try {
			change = await pendingChange(space, id, found);
		} catch (e) {
			problem = e instanceof Error ? e.message : String(e);
		}
		now = Date.now();
	}

	onMount(() => {
		void ensurePersistence();
		void load();
		const timer = window.setInterval(() => (now = Date.now()), 20_000);
		const onFocus = () => void load();
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onFocus);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onFocus);
		};
	});

	async function run(what: string, action: () => Promise<void>) {
		busy = what;
		problem = null;
		try {
			await action();
		} catch (e) {
			problem = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
		}
	}

	const commitRevision = () =>
		run('commit', async () => {
			await commit(await ensureSpace(), id);
			await load();
			await refresh();
		});

	const discardChanges = () =>
		run('discard', async () => {
			const confirmed = window.confirm(
				`Put back the previous bytes, ${meta?.document ?? 'the document'}.prev?\n\nThe editor keeps one save back beside the document, so this undoes the last save. Download first if you are not sure.`
			);
			if (!confirmed) return;
			const outcome = await discard(await ensureSpace(), id);
			notice =
				outcome === 'revision'
					? `Discarded: the document is revision ${meta?.rev} again.`
					: `Put back the previous bytes, one save back. They are not revision ${meta?.rev}, so the document is still uncommitted: the editor's .prev holds one save, not the last commit.`;
			await load();
			await refresh();
		});

	const save = (previous: boolean) =>
		run('download', async () => {
			const found = await documentBytes(await ensureSpace(), id, previous);
			if (!found) throw new Error('there is nothing to download');
			const url = URL.createObjectURL(new Blob([found.bytes as BlobPart], { type: 'application/octet-stream' }));
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = found.name;
			anchor.style.display = 'none';
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			// The download keeps its own reference; revoking now would cancel it.
			window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
		});

	const applyRename = () =>
		run('rename', async () => {
			await rename(await ensureSpace(), id, newName);
			renaming = false;
			await load();
			await refresh();
		});

	const removeWorkspace = () =>
		run('remove', async () => {
			if (!window.confirm(`Delete “${meta?.name}” and its document? This cannot be undone.`)) return;
			await removeProject(await ensureSpace(), id);
			await refresh();
			await goto(`${base}/`);
		});
</script>

<svelte:head><title>{meta?.name ?? 'Workspace'} — Atelier Cloud</title></svelte:head>

<p class="muted small"><a href="{base}/">← All workspaces</a></p>

{#if !meta}
	<div class="panel">
		<h1>Workspace</h1>
		<p class="bad">{problem ?? 'loading…'}</p>
	</div>
{:else}
	<div class="top">
		<Thumb id={id} available={true} size={104} />
		<div class="titles">
			{#if renaming}
				<form class="row" onsubmit={(event) => event.preventDefault()}>
					<input type="text" bind:value={newName} />
					<button class="primary" onclick={applyRename} disabled={busy !== null}>Rename</button>
					<button onclick={() => (renaming = false)}>Cancel</button>
				</form>
			{:else}
				<h1>{meta.name} <button class="link" onclick={() => (renaming = true)}>rename</button></h1>
			{/if}
			<p class="muted small">
				{meta.document ?? 'no document yet'} · rev {meta.rev} · {bytes(meta.size)} · created {since(meta.createdAt, now)}
			</p>
		</div>
		<div class="row actions">
			<a class="button primary" href="/?project={id}" target="_blank" rel="noopener">Open in editor</a>
		</div>
	</div>

	{#if problem}
		<p class="banner bad">{problem}</p>
	{/if}
	{#if notice}
		<p class="banner">{notice}</p>
	{/if}

	<section class="panel changes">
		{#if change}
			<h2>
				Changes — uncommitted since rev {meta.rev}
				<span class="muted">({since(meta.updatedAt, now)})</span>
			</h2>
			<table>
				<tbody>
					<tr>
						<td class="mono">{change.document}</td>
						<td>{objects(change.difference.added.length, change.difference.changed.length)}</td>
						<td class="right">{bytes(change.difference.bytes)}</td>
					</tr>
					{#if !change.difference.added.length && !change.difference.changed.length}
						<tr>
							<td class="mono">meta.json</td>
							<td>document renamed or re-saved in place</td>
							<td class="right">—</td>
						</tr>
					{/if}
				</tbody>
			</table>
			<p class="muted small">
				ⓘ {change.difference.unchanged}
				objects are unchanged ({bytes(change.difference.unchangedBytes)}); they are not copied again.
				{#if change.difference.removed}
					{change.difference.removed} objects the new revision no longer names are left alone until a commit.
				{/if}
			</p>
			<div class="row">
				<button class="primary" onclick={commitRevision} disabled={busy !== null}>
					{busy === 'commit' ? 'Committing…' : 'Commit revision'}
				</button>
				<button onclick={() => save(false)} disabled={busy !== null}>Download document</button>
				<button class="danger" onclick={discardChanges} disabled={busy !== null}>Discard local changes…</button>
			</div>
			<p class="muted small">
				Nothing here leaves this browser yet. Committing records this revision's manifest and thumb under
				<code>projects/{id}/</code> and empties <code>outbox/{id}/</code>. Discard undoes the last save, which is the
				committed revision when there has been one save since the commit.
			</p>
		{:else}
			<h2>Changes</h2>
			<p class="ok">● Nothing uncommitted: the document matches revision {meta.rev}.</p>
			<p class="muted small">
				{#if meta.revision}
					Recorded {since(meta.sync.at, now)} · {Object.keys(meta.revision.objects).length} objects ·
					{bytes(meta.revision.size)} ·
					<span class="mono">{meta.revision.hash.slice(0, 22)}…</span>
				{/if}
			</p>
			<div class="row">
				<button onclick={() => save(false)} disabled={busy !== null}>Download document</button>
				<button onclick={() => save(true)} disabled={busy !== null || !meta.rev}>Download previous (…prev)</button>
			</div>
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
			<button class="danger" onclick={removeWorkspace} disabled={busy !== null}>Delete workspace…</button>
		</div>
	</section>
{/if}

<style>
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

	.small {
		font-size: 0.86rem;
		margin: 0.15rem 0;
	}

	button.link {
		border: none;
		padding: 0;
		font-size: 0.8rem;
		color: var(--dim);
		text-decoration: underline;
		vertical-align: middle;
	}

	.changes table {
		margin-bottom: 0.5rem;
	}

	.changes .right {
		text-align: right;
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
</style>
