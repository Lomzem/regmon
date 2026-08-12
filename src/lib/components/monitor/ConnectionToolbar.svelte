<script lang="ts">
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import CircleStop from '@lucide/svelte/icons/circle-stop';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Plug from '@lucide/svelte/icons/plug';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Upload from '@lucide/svelte/icons/upload';
	import X from '@lucide/svelte/icons/x';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Select, SelectContent, SelectItem, SelectTrigger } from '$lib/components/ui/select';
	import { Switch } from '$lib/components/ui/switch';
	import { getMonitorContext } from '$lib/monitor/context';
	import { OGP_POLL_INTERVALS, UART_POLL_INTERVALS } from '$lib/monitor/persistence';
	import { unsupportedTransportMessage } from '$lib/monitor/presentation';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let intervals = $derived(view.mode === 'ogp' ? OGP_POLL_INTERVALS : UART_POLL_INTERVALS);
	let selectedPort = $derived(view.ports.find((port) => port.id === view.selectedPortId));
	let dismissedNotice = $state('');
	let dismissedError = $state('');
	let notice = $derived(unsupportedTransportMessage(view.mode, view.native, view.status));
	let errorKey = $derived(view.error ? `${view.error._tag}:${view.error.message}` : '');

	function errorDetail(): string {
		if (!view.error) return '';
		if (view.error._tag === 'RdlError' && 'line' in view.error && 'column' in view.error) {
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
	}
</script>

<Card class="py-0">
	<CardContent class="space-y-3 p-4">
		<div class="flex min-w-0 flex-wrap items-center gap-2">
			<Select
				type="single"
				value={view.mode}
				onValueChange={(mode) =>
					monitor.dispatch({ type: 'set-mode', mode: mode as 'uart' | 'ogp' })}
				disabled={view.status === 'connected' || view.status === 'connecting'}
			>
				<SelectTrigger class="w-28" aria-label="Transport mode">
					{view.mode === 'ogp' ? 'TCP OGP' : 'UART'}
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="uart">UART</SelectItem>
					<SelectItem value="ogp">TCP OGP</SelectItem>
				</SelectContent>
			</Select>

			{#if view.mode === 'uart'}
				<div class="w-full sm:w-72">
					<Select
						type="single"
						value={view.selectedPortId ?? ''}
						onValueChange={(portId) =>
							monitor.dispatch({ type: 'select-port', portId: portId || null })}
						disabled={view.status === 'unsupported' || view.status === 'connected'}
					>
						<SelectTrigger class="w-full" aria-label="Serial device">
							{selectedPort?.label ?? 'Select device'}
						</SelectTrigger>
						<SelectContent>
							{#each view.ports as port (port.id)}
								<SelectItem value={port.id}>{port.label}</SelectItem>
							{/each}
						</SelectContent>
					</Select>
				</div>
				<Button
					variant="outline"
					onclick={() => monitor.dispatch({ type: 'choose-port' })}
					disabled={view.status === 'unsupported' || view.status === 'connected'}
				>
					{#if view.native}<RefreshCw /> Refresh ports{:else}<Plus /> Add device{/if}
				</Button>
			{:else}
				<Input
					class="w-48"
					aria-label="OGP host or IP address"
					value={view.host}
					placeholder="Host or IP"
					oninput={(event) =>
						monitor.dispatch({ type: 'set-host', host: event.currentTarget.value })}
					disabled={view.status === 'connected'}
				/>
				<Input
					class="w-24"
					aria-label="OGP TCP port"
					type="number"
					min="1"
					max="65535"
					value={view.port}
					onchange={(event) =>
						monitor.dispatch({ type: 'set-port', port: Number(event.currentTarget.value) })}
					disabled={view.status === 'connected'}
				/>
				<Input
					class="w-20"
					aria-label="OGP slot, 1 to 20"
					type="number"
					min="1"
					max="20"
					value={view.slot}
					onchange={(event) =>
						monitor.dispatch({ type: 'set-slot', slot: Number(event.currentTarget.value) })}
					disabled={view.status === 'connected'}
				/>
				<label class="flex items-center gap-2 text-xs text-muted-foreground">
					<Checkbox
						checked={view.forceConnect}
						onCheckedChange={(force) => monitor.dispatch({ type: 'set-force-connect', force })}
						disabled={view.status === 'connected'}
					/>
					Force connection
				</label>
			{/if}

			<div class="w-28">
				{#if view.status === 'connected'}
					<Button variant="outline" onclick={() => monitor.dispatch({ type: 'disconnect' })}>
						<CircleStop /> Disconnect
					</Button>
				{:else}
					<Button
						onclick={() => monitor.dispatch({ type: 'connect' })}
						disabled={(view.mode === 'uart' ? !view.selectedPortId : !view.host.trim()) ||
							view.status === 'connecting' ||
							view.status === 'unsupported'}
					>
						{#if view.status === 'connecting'}<LoaderCircle class="animate-spin" /> Connecting{:else}<Plug
							/> Connect{/if}
					</Button>
				{/if}
			</div>

			{#if view.status === 'connected'}
				<div class="ml-auto flex items-center gap-2">
					<label for="poll-live" class="text-xs text-muted-foreground">Polling</label>
					<Switch
						id="poll-live"
						checked={!view.paused}
						onCheckedChange={(checked) =>
							monitor.dispatch({ type: 'set-paused', paused: !checked })}
					/>
					<Select
						type="single"
						value={String(view.intervalMs)}
						onValueChange={(value) =>
							monitor.dispatch({ type: 'set-interval', intervalMs: Number(value) })}
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
			{/if}
		</div>

		<div class="flex min-w-0 flex-wrap items-center gap-2">
			<input
				id="monitor-rdl-file"
				class="sr-only"
				type="file"
				accept=".rdl,.systemrdl,text/plain"
				onchange={loadFile}
			/>
			<label for="monitor-rdl-file" class={buttonVariants({ variant: 'outline' })}>
				<Upload /> Choose .rdl file
			</label>
			{#if view.rdlFileName}
				<div class="flex h-9 min-w-0 items-center overflow-hidden rounded-md border bg-muted/40">
					<span class="truncate px-3 text-xs text-muted-foreground">{view.rdlFileName}</span>
					{#if view.registerMap}
						<Button
							class="h-full rounded-none border-l"
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

{#if (notice && dismissedNotice !== notice.key) || (view.error && dismissedError !== errorKey)}
	<div class="fixed right-4 bottom-4 z-50 flex w-[calc(100%-2rem)] max-w-lg flex-col gap-2">
		{#if notice && dismissedNotice !== notice.key}
			<Alert class="relative pr-10" variant="destructive">
				<AlertTriangle /><AlertTitle>{notice.title}</AlertTitle><AlertDescription
					>{notice.detail}</AlertDescription
				>
				<Button
					class="absolute top-1 right-1"
					variant="ghost"
					size="icon-sm"
					onclick={() => (dismissedNotice = notice.key)}
					aria-label="Dismiss transport notice"><X /></Button
				>
			</Alert>
		{/if}
		{#if view.error && dismissedError !== errorKey}
			<Alert class="relative pr-10" variant="destructive">
				<AlertTriangle /><AlertTitle>{view.error._tag}</AlertTitle><AlertDescription
					>{errorDetail()}</AlertDescription
				>
				<Button
					class="absolute top-1 right-1"
					variant="ghost"
					size="icon-sm"
					onclick={() => (dismissedError = errorKey)}
					aria-label="Dismiss error message"><X /></Button
				>
			</Alert>
		{/if}
	</div>
{/if}
