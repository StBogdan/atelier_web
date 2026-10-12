<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import Thumb from '$lib/Thumb.svelte';
	import { bytes, since } from '$lib/format';
	import { createProject, documentFileName, ensureSpace } from '$lib/contract';
	import { ensurePersistence, refresh, workspaces } from '$lib/session';

	interface Sample {
		file: string;
		name: string;
		bytes: number;
	}

	let dialog = $state<HTMLDialogElement | null>(null);
	let name = $state('');
	let busy = $state(false);
	let problem = $state<string | null>(null);
	let samples = $state<Sample[]>([]);
	let source = $state<'empty' | 'sample' | 'file'>('empty');
	let sample = $state('');
	let file = $state<File | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	const now = Date.now();

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
		source = samples.length ? 'sample' : 'empty';
		sample = samples[0]?.file ?? '';
		file = null;
		if (fileInput) fileInput.value = '';
		dialog?.showModal();
	}

	/**
	 * The field has to work on its own: the label's control is the radio, and a label ignores clicks on
	 * its own interactive descendants, so a disabled field swallowed the click and no picker appeared.
	 */
	function chooseFile(event: Event & { currentTarget: HTMLInputElement }) {
		source = 'file';
		file = event.currentTarget.files?.[0] ?? null;
	}

	async function create() {
		busy = true;
		problem = null;
		try {
			await ensurePersistence();
			let document: { name: string; bytes: Uint8Array } | null = null;
			if (source === 'sample' && sample) {
				const response = await fetch(`${base}/samples/${sample}`);
				if (!response.ok) throw new Error(`could not fetch ${sample}: ${response.status}`);
				document = { name: documentFileName(sample), bytes: new Uint8Array(await response.arrayBuffer()) };
			} else if (source === 'file') {
				if (!file) throw new Error('choose a .pcraft file');
				document = { name: documentFileName(file.name), bytes: new Uint8Array(await file.arrayBuffer()) };
			}
			await createProject(await ensureSpace(), { name, document });
			dialog?.close();
			await refresh();
		} catch (e) {
			problem = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Workspaces — Atelier Cloud</title></svelte:head>

<div class="head">
	<h1>Workspaces</h1>
	{#if $workspaces.length}
		<button class="primary" onclick={open}>New workspace</button>
	{/if}
</div>

{#if $workspaces.length === 0}
	<div class="panel empty">
		<h2>No workspaces yet</h2>
		<p class="muted">
			A workspace is a project directory in this origin's OPFS. Nothing on this page touches the network beyond this
			origin's own files, and nothing is uploaded anywhere.
		</p>
		<div class="row">
			<button class="primary" onclick={open}>New workspace</button>
			<a class="button" href="{base}/settings">Storage</a>
		</div>
		<p class="muted small">Importing a zip, and signing in to see a team's workspaces, are planned rather than here.</p>
	</div>
{/if}

{#if $workspaces.length}
	<div class="grid">
		{#each $workspaces as workspace (workspace.id)}
			<article class="panel card">
				<Thumb id={workspace.id} available={workspace.thumb} />
				<div class="body">
					<h2>{workspace.name}</h2>
					<p class="muted small">
						{workspace.document ?? 'no document yet'} · {bytes(workspace.size)} local
					</p>
					<p class="small">
						{#if workspace.dirty}
							<span class="warn">◐ uncommitted changes</span>
						{:else}
							<span class="ok">● committed</span>
							<span class="muted">· {since(workspace.updatedAt, now)}</span>
						{/if}
					</p>
					<p class="muted small">owner: you · rev {workspace.rev}</p>
					{#if workspace.broken}
						<p class="bad small">{workspace.broken}</p>
					{/if}
					<div class="row">
						<a class="button primary" href="/?project={workspace.id}" target="_blank" rel="noopener">Open</a>
						<a class="button" href="{base}/workspace/{workspace.id}">Changes</a>
					</div>
				</div>
			</article>
		{/each}
	</div>
{/if}

<dialog bind:this={dialog}>
	<form class="stack" onsubmit={(event) => event.preventDefault()}>
		<h2>New workspace</h2>
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
				<input type="radio" value="sample" bind:group={source} disabled={samples.length === 0} />
				A bundled document
				<select bind:value={sample} disabled={source !== 'sample'}>
					{#each samples as entry (entry.file)}
						<option value={entry.file}>{entry.name} ({bytes(entry.bytes)})</option>
					{/each}
				</select>
			</label>
			<label class="option">
				<input type="radio" value="file" bind:group={source} />
				A <code>.pcraft</code> file from this computer
				<input
					type="file"
					accept=".pcraft"
					bind:this={fileInput}
					onchange={chooseFile}
				/>
			</label>
		</fieldset>
		{#if problem}
			<p class="bad small">{problem}</p>
		{/if}
		<div class="row">
			<button class="primary" onclick={create} disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
			<button onclick={() => dialog?.close()} disabled={busy}>Cancel</button>
		</div>
	</form>
</dialog>

<style>
	.head {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1.25rem;
	}

	.head button {
		margin-left: auto;
	}

	.empty {
		max-width: 40rem;
	}

	.small {
		font-size: 0.86rem;
		margin: 0.15rem 0;
	}

	.card {
		display: flex;
		gap: 0.9rem;
		padding: 0.9rem;
	}

	.body {
		min-width: 0;
		flex: 1;
	}

	.body h2 {
		margin: 0 0 0.2rem;
		overflow-wrap: anywhere;
	}

	.body .row {
		margin-top: 0.6rem;
	}

	fieldset {
		border: 1px solid var(--line);
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.option {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	legend {
		color: var(--dim);
		padding: 0 0.3rem;
	}
</style>
