<script lang="ts">
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import { getMonitorContext } from '$lib/monitor/context';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
</script>

<div class="mb-2 flex items-center justify-between gap-3">
	<p class="text-xs text-muted-foreground">
		{view.rawLog.length.toLocaleString()} characters received
	</p>
	<Button
		variant="ghost"
		size="sm"
		onclick={() => monitor.dispatch({ type: 'clear-log' })}
		disabled={!view.rawLog}><Trash2 /> Clear</Button
	>
</div>
<pre
	class="max-h-[32rem] min-h-52 overflow-auto rounded-lg border bg-background p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-chart-3">{view.rawLog ||
		'No UART text received.'}</pre>
