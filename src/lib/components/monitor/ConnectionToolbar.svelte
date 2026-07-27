<script lang="ts">
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import CircleStop from '@lucide/svelte/icons/circle-stop';
	import Plug from '@lucide/svelte/icons/plug';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { NativeSelect, NativeSelectOption } from '$lib/components/ui/native-select';
	import { Switch } from '$lib/components/ui/switch';
	import { getMonitorContext } from '$lib/monitor/context';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let selectedIndex = $derived(
		view.ports.findIndex((candidate) => candidate.port === view.selectedPort)
	);
	const intervals = [250, 500, 1000, 2000, 5000] as const;

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

	function selectPort(event: Event): void {
		const index = Number((event.currentTarget as HTMLSelectElement).value);
		monitor.dispatch({ type: 'select-port', port: view.ports[index]?.port ?? null });
	}

	function errorDetail(): string {
		if (!view.error) return '';
		if (view.error._tag === 'RdlError') {
			return `${view.error.message} at ${view.error.line}:${view.error.column}`;
		}
		return view.error.message;
	}
</script>

<Card class="border-zinc-800 bg-zinc-950/75 shadow-xl shadow-black/10">
	<CardContent class="space-y-4 p-4">
		<div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
				<div class="min-w-56 flex-1 sm:max-w-sm">
					<label for="serial-port" class="sr-only">Authorized serial port</label>
					<NativeSelect
						id="serial-port"
						class="w-full"
						value={selectedIndex < 0 ? '' : String(selectedIndex)}
						onchange={selectPort}
						disabled={view.status === 'unsupported' || view.status === 'connected'}
					>
						<NativeSelectOption value="" disabled>No authorized device</NativeSelectOption>
						{#each view.ports, index (index)}
							<NativeSelectOption value={String(index)}>{portLabel(index)}</NativeSelectOption>
						{/each}
					</NativeSelect>
				</div>
				<Button
					variant="outline"
					onclick={() => monitor.dispatch({ type: 'choose-port' })}
					disabled={view.status === 'unsupported' || view.status === 'connected'}
				>
					<Plus /> Add device
				</Button>
				{#if view.status === 'connected'}
					<Button variant="destructive" onclick={() => monitor.dispatch({ type: 'disconnect' })}>
						<CircleStop /> Disconnect
					</Button>
				{:else}
					<Button
						onclick={() => monitor.dispatch({ type: 'connect' })}
						disabled={!view.selectedPort || view.status === 'connecting'}
					>
						<Plug />
						{view.status === 'connecting' ? 'Connecting…' : 'Connect'}
					</Button>
				{/if}
				<Badge variant="outline" class="font-mono text-[10px] tracking-wider">115200 8N1</Badge>
				<Badge
					variant={view.status === 'connected'
						? 'default'
						: view.status === 'unsupported'
							? 'destructive'
							: 'secondary'}
					class="capitalize"
				>
					<span
						class={[
							'size-1.5 rounded-full',
							view.status === 'connected' ? 'bg-emerald-300' : 'bg-current'
						]}
						aria-hidden="true"
					></span>
					{view.status}
				</Badge>
			</div>

			<div
				class="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3 xl:border-t-0 xl:pt-0"
			>
				<label for="poll-live" class="text-xs font-medium text-zinc-400">Live polling</label>
				<Switch
					id="poll-live"
					checked={!view.paused}
					onCheckedChange={(checked) => monitor.dispatch({ type: 'set-paused', paused: !checked })}
					disabled={view.status !== 'connected'}
				/>
				<label for="poll-interval" class="sr-only">Polling interval</label>
				<NativeSelect
					id="poll-interval"
					size="sm"
					value={String(view.intervalMs)}
					onchange={(event) =>
						monitor.dispatch({
							type: 'set-interval',
							intervalMs: Number((event.currentTarget as HTMLSelectElement).value)
						})}
				>
					{#each intervals as interval (interval)}
						<NativeSelectOption value={String(interval)}>{interval} ms</NativeSelectOption>
					{/each}
				</NativeSelect>
				<Button
					variant="outline"
					size="sm"
					onclick={() => monitor.dispatch({ type: 'refresh' })}
					disabled={view.status !== 'connected'}
				>
					<RefreshCw class={view.polling ? 'animate-spin' : ''} /> Refresh
				</Button>
			</div>
		</div>

		<div
			class="flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-500"
			aria-live="polite"
			aria-atomic="true"
		>
			<span
				>{view.polling
					? 'RX: waiting for 256-byte snapshot'
					: view.paused
						? 'POLL: paused'
						: 'POLL: armed'}</span
			>
			<span>LAST: {view.snapshotAt ? new Date(view.snapshotAt).toLocaleTimeString() : 'never'}</span
			>
		</div>

		{#if view.status === 'unsupported'}
			<Alert variant="destructive">
				<AlertTriangle />
				<AlertTitle>Web Serial unavailable</AlertTitle>
				<AlertDescription
					>Use a Chromium-based browser on a secure origin to connect hardware.</AlertDescription
				>
			</Alert>
		{:else if view.error}
			<Alert variant="destructive">
				<AlertTriangle />
				<AlertTitle>{view.error._tag}</AlertTitle>
				<AlertDescription>{errorDetail()}</AlertDescription>
			</Alert>
		{/if}
	</CardContent>
</Card>
