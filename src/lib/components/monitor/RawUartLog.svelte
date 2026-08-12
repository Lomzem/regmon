<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import Copy from '@lucide/svelte/icons/copy';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import { getMonitorContext } from '$lib/monitor/context';
	import { copyToClipboard } from '$lib/monitor/presentation';
	import { onDestroy } from 'svelte';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let copyStatus = $state<'idle' | 'success' | 'error'>('idle');
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copyLog(): Promise<void> {
		copyStatus = await copyToClipboard(navigator.clipboard, view.rawLog);
		if (copyResetTimer) clearTimeout(copyResetTimer);
		copyResetTimer = setTimeout(() => (copyStatus = 'idle'), 2_000);
	}

	onDestroy(() => {
		if (copyResetTimer) clearTimeout(copyResetTimer);
	});
</script>

<div class="mb-2 flex items-center justify-between gap-3">
	<p class="text-xs text-muted-foreground">
		{view.rawLog.length.toLocaleString()} characters received
	</p>
	<div class="flex items-center gap-1">
		<span
			class={[
				'mr-1 text-[11px]',
				copyStatus === 'success' && 'text-emerald-400',
				copyStatus === 'error' && 'text-destructive'
			]}
			aria-live="polite"
		>
			{copyStatus === 'success'
				? 'Copied to clipboard'
				: copyStatus === 'error'
					? 'Copy failed'
					: ''}
		</span>
		<Button variant="ghost" size="sm" onclick={copyLog} disabled={!view.rawLog}>
			{#if copyStatus === 'success'}<Check /> Copied{:else if copyStatus === 'error'}<AlertTriangle
				/> Retry{:else}<Copy /> Copy{/if}
		</Button>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => monitor.dispatch({ type: 'clear-log' })}
			disabled={!view.rawLog}><Trash2 /> Clear</Button
		>
	</div>
</div>
<pre
	class="max-h-[32rem] min-h-52 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-foreground">{view.rawLog ||
		'No transport text received.'}</pre>
