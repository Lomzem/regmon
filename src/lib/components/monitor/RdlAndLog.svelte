<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FileCode from '@lucide/svelte/icons/file-code';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Badge } from '$lib/components/ui/badge';
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
	import { Input } from '$lib/components/ui/input';
	import { getMonitorContext } from '$lib/monitor/context';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let logOpen = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	async function loadFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		monitor.dispatch({ type: 'set-rdl-source', source: await file.text() });
		input.value = '';
	}

	function forgetRdl(): void {
		monitor.dispatch({ type: 'clear-rdl' });
		if (fileInput) fileInput.value = '';
	}
</script>

<div class="grid gap-4 xl:grid-cols-2">
	<Card class="border-zinc-800 bg-zinc-950/75">
		<CardHeader>
			<div class="flex items-start justify-between gap-3">
				<div>
					<CardTitle class="flex items-center gap-2 font-mono text-sm tracking-wider uppercase"
						><FileCode class="text-cyan-400" /> SystemRDL map</CardTitle
					>
					<CardDescription>Stored locally in this browser. No file is uploaded.</CardDescription>
				</div>
				{#if view.registerMap}<Badge variant="secondary"
						>{view.registerMap.warnings.length} warnings</Badge
					>{/if}
			</div>
		</CardHeader>
		<CardContent class="space-y-3">
			{#if view.registerMap}
				<div
					class="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
				>
					<div>
						<p class="text-sm font-medium text-emerald-400">Register map loaded</p>
						<p class="text-xs text-zinc-500">
							{view.registerMap.registers.length} mapped 8-bit registers
						</p>
					</div>
					<Button variant="ghost" size="sm" onclick={forgetRdl}><Trash2 /> Forget</Button>
				</div>
			{/if}
			<label for="rdl-file" class="text-xs font-medium text-zinc-400"
				>{view.registerMap ? 'Replace local map' : 'Load a local .rdl file'}</label
			>
			<Input
				id="rdl-file"
				bind:ref={fileInput}
				type="file"
				accept=".rdl,.systemrdl,text/plain"
				onchange={loadFile}
			/>
		</CardContent>
	</Card>

	<Card class="border-zinc-800 bg-zinc-950/75">
		<Collapsible bind:open={logOpen}>
			<CardHeader>
				<div class="flex items-start justify-between gap-3">
					<div>
						<CardTitle class="font-mono text-sm tracking-wider uppercase">Raw UART log</CardTitle>
						<CardDescription
							>Bounded tail of received text · {view.rawLog.length.toLocaleString()} chars</CardDescription
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
				<CardContent>
					<pre
						class="max-h-72 min-h-32 overflow-auto rounded-lg border border-zinc-800 bg-black p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-emerald-400/80">{view.rawLog ||
							'No UART text received.'}</pre>
				</CardContent>
			</CollapsibleContent>
		</Collapsible>
	</Card>
</div>
