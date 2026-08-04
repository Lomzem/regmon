<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger
	} from '$lib/components/ui/collapsible';
	import { getMonitorContext } from '$lib/monitor/context';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let logOpen = $state(false);
</script>

<Card class="py-0">
	<Collapsible bind:open={logOpen}>
		<CardHeader class="p-4">
			<div class="flex items-start justify-between gap-3">
				<div>
					<CardTitle class="font-serif text-sm font-semibold tracking-wider"
						>Raw UART Log</CardTitle
					>
					<CardDescription
						>Bounded tail of received text, {view.rawLog.length.toLocaleString()} chars</CardDescription
					>
				</div>
				<div class="flex gap-1">
					<Button
						variant="ghost"
						size="sm"
						onclick={() => monitor.dispatch({ type: 'clear-log' })}
						disabled={!view.rawLog}><Trash2 /> Clear</Button
					>
					<CollapsibleTrigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="outline"
								size="icon-sm"
								aria-label={logOpen ? 'Collapse raw log' : 'Expand raw log'}
							>
								<ChevronDown
									class={logOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
								/>
							</Button>
						{/snippet}
					</CollapsibleTrigger>
				</div>
			</div>
		</CardHeader>
		<CollapsibleContent>
			<CardContent class="px-4 pb-4">
				<pre
					class="max-h-72 min-h-32 overflow-auto rounded-lg border bg-background p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-chart-3">{view.rawLog ||
						'No UART text received.'}</pre>
			</CardContent>
		</CollapsibleContent>
	</Collapsible>
</Card>
