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
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Select, SelectContent, SelectItem, SelectTrigger } from '$lib/components/ui/select';
	import { Switch } from '$lib/components/ui/switch';
	import { getMonitorContext } from '$lib/monitor/context';
	import { OGP_POLL_INTERVALS, UART_POLL_INTERVALS } from '$lib/monitor/persistence';
	import {
		connectionStatusLabel,
		formatUpdateTime,
		unsupportedTransportMessage
	} from '$lib/monitor/presentation';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let intervals = $derived(view.mode === 'ogp' ? OGP_POLL_INTERVALS : UART_POLL_INTERVALS);
	let fileInput = $state<HTMLInputElement | null>(null);
	let dismissedNotice = $state('');
	let dismissedError = $state('');
	let slotInput = $state('1');
	let slotFocused = $state(false);
	let notice = $derived(unsupportedTransportMessage(view.mode, view.native, view.status));
	let statusLabel = $derived(connectionStatusLabel(view));
	let errorKey = $derived(view.error ? `${view.error._tag}:${view.error.message}` : '');
	let slotError = $derived(
		!/^\d+$/.test(slotInput) || Number(slotInput) < 1 || Number(slotInput) > 20
	);

	$effect(() => {
		if (!slotFocused) slotInput = String(view.slot);
	});

	function selectPort(value: string): void {
		monitor.dispatch({ type: 'select-port', portId: value || null });
	}

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
		if (fileInput) fileInput.value = '';
	}

	function updateSlot(value: string): void {
		slotInput = value;
		const slot = Number(value);
		if (/^\d+$/.test(value) && slot >= 1 && slot <= 20) {
			monitor.dispatch({ type: 'set-slot', slot });
		}
	}
</script>

<Card class="min-w-0 py-0">
	<CardContent class="space-y-4 p-4">
		<div class="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b pb-3">
			<div class="min-w-0">
				<p class="font-mono text-sm font-semibold tracking-[0.18em] text-primary">REGMON</p>
				<p class="text-[11px] text-muted-foreground">8-bit register diagnostics</p>
			</div>
			<div class="flex min-w-0 items-center gap-3 text-xs">
				<span
					class={[
						'inline-flex min-h-8 items-center gap-2 rounded-full border px-3 font-medium',
						statusLabel === 'Connected' && 'border-emerald-500/40 text-emerald-400',
						statusLabel === 'Scanning' && 'border-sky-500/40 text-sky-300',
						statusLabel === 'Connecting...' && 'border-amber-500/40 text-amber-300',
						statusLabel === 'Error' && 'border-destructive/50 text-destructive',
						statusLabel === 'Disconnected' && 'border-border text-muted-foreground'
					]}
					aria-live="polite"
				>
					<span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
					{statusLabel}
				</span>
				<span class="max-w-28 min-w-0 text-right text-muted-foreground sm:max-w-none">
					<span class="block truncate">{view.snapshotSource ?? 'No snapshot source'}</span>
					<span class="block font-mono text-[10px]">{formatUpdateTime(view.snapshotAt)}</span>
				</span>
			</div>
		</div>
		<div class="flex min-w-0 flex-wrap items-start gap-2">
			<div class="w-32">
				<label for="transport-mode" class="mb-1 block text-xs font-medium text-muted-foreground"
					>Transport</label
				>
				<Select
					type="single"
					value={view.mode}
					onValueChange={(mode) =>
						monitor.dispatch({ type: 'set-mode', mode: mode as 'uart' | 'ogp' })}
					disabled={view.status === 'connected' || view.status === 'connecting'}
				>
					<SelectTrigger id="transport-mode" class="min-h-11 w-full sm:min-h-9"
						>{view.mode === 'ogp' ? 'TCP OGP' : 'UART'}</SelectTrigger
					>
					<SelectContent>
						<SelectItem value="uart">UART</SelectItem>
						<SelectItem value="ogp">TCP OGP</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{#if view.mode === 'uart'}
				<div class="w-full sm:w-80">
					<div id="serial-device-label" class="mb-1 text-xs font-medium text-muted-foreground">
						Serial device
					</div>
					<Select
						type="single"
						value={view.selectedPortId ?? ''}
						onValueChange={selectPort}
						disabled={view.status === 'unsupported' || view.status === 'connected'}
					>
						<SelectTrigger class="min-h-11 w-full sm:min-h-9" aria-labelledby="serial-device-label">
							{view.ports.find((port) => port.id === view.selectedPortId)?.label ?? 'Select device'}
						</SelectTrigger>
						<SelectContent>
							{#each view.ports as port (port.id)}
								<SelectItem value={port.id}>{port.label}</SelectItem>
							{/each}
						</SelectContent>
					</Select>
				</div>
				<Button
					class="min-h-11 sm:mt-5 sm:min-h-9"
					variant="outline"
					onclick={() => monitor.dispatch({ type: 'choose-port' })}
					disabled={view.status === 'unsupported' || view.status === 'connected'}
				>
					{#if view.native}<RefreshCw /> Refresh ports{:else}<Plus /> Add device{/if}
				</Button>
			{:else}
				<div class="w-full sm:w-64">
					<label for="ogp-host" class="mb-1 block text-xs font-medium text-muted-foreground"
						>Frame host or IP</label
					>
					<Input
						class="min-h-11 sm:min-h-9"
						id="ogp-host"
						value={view.host}
						placeholder="192.168.1.100"
						oninput={(event) =>
							monitor.dispatch({ type: 'set-host', host: event.currentTarget.value })}
						disabled={view.status === 'connected'}
					/>
				</div>
				<div class="grid w-full grid-cols-2 items-start gap-2 sm:w-64">
					<div class="grid grid-rows-[1rem_auto_1.75rem] gap-1">
						<label for="ogp-port" class="block text-xs font-medium text-muted-foreground"
							>Port</label
						>
						<Input
							class="min-h-11 sm:min-h-9"
							id="ogp-port"
							type="number"
							min="1"
							max="65535"
							value={view.port}
							oninput={(event) =>
								monitor.dispatch({ type: 'set-port', port: Number(event.currentTarget.value) })}
							disabled={view.status === 'connected'}
						/>
						<p class="text-[10px] leading-3 text-muted-foreground">TCP service port.</p>
					</div>
					<div class="grid grid-rows-[1rem_auto_1.75rem] gap-1">
						<label for="ogp-slot" class="block text-xs font-medium text-muted-foreground"
							>Slot (1-20)</label
						>
						<Input
							class="min-h-11 sm:min-h-9"
							id="ogp-slot"
							type="number"
							min="1"
							max="20"
							value={slotInput}
							onfocus={() => (slotFocused = true)}
							onblur={() => {
								slotFocused = false;
								if (slotError) slotInput = String(view.slot);
							}}
							oninput={(event) => updateSlot(event.currentTarget.value)}
							aria-invalid={slotError}
							aria-describedby="ogp-slot-help"
							disabled={view.status === 'connected'}
						/>
						<p
							id="ogp-slot-help"
							class={[
								'text-[10px] leading-3',
								slotError ? 'text-destructive' : 'text-muted-foreground'
							]}
							aria-live="polite"
						>
							{slotError ? 'Enter 1 to 20.' : 'Frame card position.'}
						</p>
					</div>
				</div>
				<label
					class="flex min-h-11 items-center gap-2 text-xs font-medium text-muted-foreground sm:mt-5 sm:min-h-9"
				>
					<Checkbox
						checked={view.forceConnect}
						onCheckedChange={(force) => monitor.dispatch({ type: 'set-force-connect', force })}
						disabled={view.status === 'connected'}
					/>
					Force connection
				</label>
			{/if}
			<div class="w-32 sm:mt-5">
				{#if view.status === 'connected'}
					<Button
						class="min-h-11 text-muted-foreground hover:text-foreground sm:min-h-9"
						variant="outline"
						onclick={() => monitor.dispatch({ type: 'disconnect' })}
					>
						<CircleStop /> Disconnect
					</Button>
				{:else}
					<Button
						class="min-h-11 sm:min-h-9"
						onclick={() => monitor.dispatch({ type: 'connect' })}
						disabled={(view.mode === 'uart' ? !view.selectedPortId : !view.host.trim()) ||
							(view.mode === 'ogp' && slotError) ||
							view.status === 'connecting' ||
							view.status === 'unsupported'}
					>
						{#if view.status === 'connecting'}
							<LoaderCircle class="animate-spin" /> Connecting...
						{:else}
							<Plug /> Connect
						{/if}
					</Button>
				{/if}
			</div>
			{#if view.status === 'connected'}
				<div class="ml-auto flex flex-wrap items-center gap-2 sm:mt-5">
					<label for="poll-live" class="text-xs font-medium text-muted-foreground"
						>{view.mode === 'ogp' ? 'Rate-limited full scans' : 'Live polling'}</label
					>
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
							monitor.dispatch({
								type: 'set-interval',
								intervalMs: Number(value)
							})}
					>
						<SelectTrigger class="min-h-10 w-24 sm:min-h-8" size="sm" aria-label="Polling interval"
							>{view.intervalMs} ms</SelectTrigger
						>
						<SelectContent>
							{#each intervals as interval (interval)}
								<SelectItem value={String(interval)}>{interval} ms</SelectItem>
							{/each}
						</SelectContent>
					</Select>
					<Button
						class="min-h-10 sm:min-h-8"
						variant="outline"
						size="sm"
						onclick={() => monitor.dispatch({ type: 'refresh' })}
					>
						<RefreshCw class={view.polling ? 'animate-spin' : ''} /> Full refresh
					</Button>
				</div>
			{/if}
		</div>
		{#if view.status === 'connected'}
			<p class="text-[11px] leading-relaxed text-muted-foreground">
				Full refresh reads all 256 addresses. {view.mode === 'ogp'
					? 'Automatic OGP polling runs full scans at the selected rate; the Watchlist does not change scan scope.'
					: 'Automatic polling requests a complete UART register dump at the selected rate.'}
			</p>
		{/if}

		<div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
			<input
				id="rdl-file"
				bind:this={fileInput}
				class="sr-only"
				type="file"
				accept=".rdl,.systemrdl,text/plain"
				onchange={loadFile}
			/>
			<Button class="min-h-11 sm:min-h-9" variant="outline" onclick={() => fileInput?.click()}>
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

		{#if notice && dismissedNotice !== notice.key}
			<Alert class="relative pr-12" variant="destructive">
				<AlertTriangle />
				<AlertTitle>{notice.title}</AlertTitle>
				<AlertDescription>{notice.detail}</AlertDescription>
				<Button
					class="absolute top-1 right-1 size-10 sm:size-8"
					variant="ghost"
					size="icon"
					onclick={() => (dismissedNotice = notice.key)}
					aria-label="Dismiss transport notice"><X /></Button
				>
			</Alert>
		{/if}
		{#if view.error && dismissedError !== errorKey}
			<Alert class="relative pr-12" variant="destructive">
				<AlertTriangle />
				<AlertTitle>{view.error._tag}</AlertTitle>
				<AlertDescription>{errorDetail()}</AlertDescription>
				<Button
					class="absolute top-1 right-1 size-10 sm:size-8"
					variant="ghost"
					size="icon"
					onclick={() => (dismissedError = errorKey)}
					aria-label="Dismiss error message"><X /></Button
				>
			</Alert>
		{/if}
	</CardContent>
</Card>
