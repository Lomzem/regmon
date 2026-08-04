<script lang="ts">
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import CircleStop from '@lucide/svelte/icons/circle-stop';
	import Plug from '@lucide/svelte/icons/plug';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Upload from '@lucide/svelte/icons/upload';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { Select, SelectContent, SelectItem, SelectTrigger } from '$lib/components/ui/select';
	import { Switch } from '$lib/components/ui/switch';
	import { getMonitorContext } from '$lib/monitor/context';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let selectedIndex = $derived(
		view.ports.findIndex((candidate) => candidate.port === view.selectedPort)
	);
	const intervals = [250, 500, 1000, 2000, 5000] as const;
	let fileInput = $state<HTMLInputElement | null>(null);

	function portLabel(index: number): string {
		const info = view.ports[index].info;
		const vendor = info.usbVendorId?.toString(16).padStart(4, '0').toUpperCase();
		const product = info.usbProductId?.toString(16).padStart(4, '0').toUpperCase();
		return vendor && product
			? `USB ${vendor}:${product}`
			: vendor
				? `USB VID ${vendor}`
				: `Authorized serial device ${index + 1}`;
	}

	function selectPort(value: string): void {
		const index = Number(value);
		monitor.dispatch({ type: 'select-port', port: view.ports[index]?.port ?? null });
	}

	function errorDetail(): string {
		if (!view.error) return '';
		if (view.error._tag === 'RdlError') {
			return `${view.error.message} at ${view.error.line}:${view.error.column}`;
		}
		return view.error.message;
	}

	async function loadFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		monitor.dispatch({ type: 'set-rdl-source', source: await file.text(), fileName: file.name });
		input.value = '';
	}

	function forgetRdl(): void {
		monitor.dispatch({ type: 'clear-rdl' });
		if (fileInput) fileInput.value = '';
	}
</script>

<Card class="py-0">
	<CardContent class="space-y-4 p-4">
		<div class="relative flex min-w-0 flex-wrap items-center gap-2 lg:pr-80">
			<div class="w-full sm:w-80">
				<Select
					type="single"
					value={selectedIndex < 0 ? '' : String(selectedIndex)}
					onValueChange={selectPort}
					disabled={view.status === 'unsupported' || view.status === 'connected'}
				>
					<SelectTrigger class="w-full" aria-label="Authorized serial port">
						{selectedIndex < 0 ? 'Select device' : portLabel(selectedIndex)}
					</SelectTrigger>
					<SelectContent>
						{#each view.ports, index (index)}
							<SelectItem value={String(index)}>{portLabel(index)}</SelectItem>
						{/each}
					</SelectContent>
				</Select>
			</div>
			<Button
				variant="outline"
				onclick={() => monitor.dispatch({ type: 'choose-port' })}
				disabled={view.status === 'unsupported' || view.status === 'connected'}
			>
				<Plus /> Add device
			</Button>
			<div class="w-28">
				{#if view.status === 'connected'}
					<Button
						class="text-muted-foreground hover:text-foreground"
						variant="outline"
						onclick={() => monitor.dispatch({ type: 'disconnect' })}
					>
						<CircleStop /> Disconnect
					</Button>
				{:else}
					<Button
						onclick={() => monitor.dispatch({ type: 'connect' })}
						disabled={!view.selectedPort || view.status === 'connecting'}
					>
						<Plug />
						Connect
					</Button>
				{/if}
			</div>
			<div
				class={[
					'ml-auto flex items-center gap-2 lg:absolute lg:top-1/2 lg:right-0 lg:-translate-y-1/2',
					view.status !== 'connected' && 'invisible'
				]}
			>
				<label for="poll-live" class="text-xs font-medium text-muted-foreground">Live polling</label>
				<Switch
					id="poll-live"
					checked={!view.paused}
					onCheckedChange={(checked) => monitor.dispatch({ type: 'set-paused', paused: !checked })}
				/>
				<Select
					type="single"
					value={String(view.intervalMs)}
					onValueChange={(value) =>
						monitor.dispatch({
							type: 'set-interval',
							intervalMs: Number(value)
						})}
				>
					<SelectTrigger class="w-24" size="sm" aria-label="Polling interval"
						>{view.intervalMs} ms</SelectTrigger
					>
					<SelectContent>
						{#each intervals as interval (interval)}
							<SelectItem value={String(interval)}>{interval} ms</SelectItem>
						{/each}
					</SelectContent>
				</Select>
				<Button variant="outline" size="sm" onclick={() => monitor.dispatch({ type: 'refresh' })}>
					<RefreshCw class={view.polling ? 'animate-spin' : ''} /> Refresh
				</Button>
			</div>
		</div>

		<div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
			<input
				id="rdl-file"
				bind:this={fileInput}
				class="sr-only"
				type="file"
				accept=".rdl,.systemrdl,text/plain"
				onchange={loadFile}
			/>
			<Button variant="outline" onclick={() => fileInput?.click()}>
				<Upload /> Choose .rdl file
			</Button>
			{#if view.rdlFileName}
				<div class="flex h-9 min-w-0 items-center overflow-hidden rounded-md border bg-muted/40">
					<span class="truncate px-3 text-xs text-muted-foreground">{view.rdlFileName}</span>
					{#if view.registerMap}
						<Button
							class="h-full rounded-none border-l text-muted-foreground hover:text-foreground"
							variant="ghost"
							size="sm"
							onclick={forgetRdl}><Trash2 /> Forget</Button
						>
					{/if}
				</div>
			{/if}
		</div>
	</CardContent>
</Card>

{#if view.status === 'unsupported'}
	<div class="fixed right-4 bottom-4 z-50 w-[calc(100%-2rem)] max-w-lg shadow-xl">
		<Alert variant="destructive">
			<AlertTriangle />
			<AlertTitle>Web Serial unavailable</AlertTitle>
			<AlertDescription>
				<span class="block">Web Serial may be unavailable because of browser settings or policy.</span>
				<span class="block">For best compatibility, use a Chromium-based browser.</span>
			</AlertDescription>
		</Alert>
	</div>
{:else if view.error}
	<div class="fixed right-4 bottom-4 z-50 w-[calc(100%-2rem)] max-w-lg shadow-xl">
		<Alert variant="destructive">
			<AlertTriangle />
			<AlertTitle>{view.error._tag}</AlertTitle>
			<AlertDescription>{errorDetail()}</AlertDescription>
		</Alert>
	</div>
{/if}
