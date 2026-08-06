<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import { getMonitorContext } from '$lib/monitor/context';
	import { onDestroy } from 'svelte';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let copied = $state(false);
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copyLog(): Promise<void> {
		await navigator.clipboard.writeText(view.rawLog);
		copied = true;
		if (copyResetTimer) clearTimeout(copyResetTimer);
		copyResetTimer = setTimeout(() => (copied = false), 1_500);
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
		<Button variant="ghost" size="sm" onclick={copyLog} disabled={!view.rawLog}>
			{#if copied}<Check /> Copied{:else}<Copy /> Copy{/if}
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
		'No UART text received.'}</pre>
