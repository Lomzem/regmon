<script lang="ts">
	import Cpu from '@lucide/svelte/icons/cpu';
	import Star from '@lucide/svelte/icons/star';
	import Upload from '@lucide/svelte/icons/upload';
	import { Button } from '$lib/components/ui/button';
	import { ButtonGroup } from '$lib/components/ui/button-group';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Separator } from '$lib/components/ui/separator';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogHeader,
		DialogTitle
	} from '$lib/components/ui/dialog';
	import { getMonitorContext } from '$lib/monitor/context';
	import { decodeRegisterMap } from '$lib/rdl/decode';

	const monitor = getMonitorContext();
	const baseLabels = { hex: 'Hex', decimal: 'Decimal', binary: 'Binary' } as const;
	let view = $derived(monitor.view);
	let address = $derived(view.selectedAddress);
	let value = $derived(address === null ? 0 : (view.snapshot?.[address] ?? 0));
	let watched = $derived(address !== null && view.watchlist.includes(address));
	let base = $state<'hex' | 'decimal' | 'binary'>('hex');
	let rdlFileInput = $state<HTMLInputElement | null>(null);
	let decoded = $derived(
		address === null || !view.registerMap
			? undefined
			: decodeRegisterMap(view.registerMap, address, value)
	);

	function hex(byte: number): string {
		return byte.toString(16).padStart(2, '0').toUpperCase();
	}

	function formatValue(rawValue: number, bitWidth: number): string {
		if (base === 'decimal') return String(rawValue);
		if (base === 'binary') {
			return rawValue
				.toString(2)
				.padStart(bitWidth, '0')
				.replace(/\B(?=(?:[01]{4})+(?![01]))/g, ' ');
		}
		return `0x${rawValue.toString(16).padStart(Math.ceil(bitWidth / 4), '0').toUpperCase()}`;
	}

	function toggleWatchlist(): void {
		if (address === null) return;
		monitor.dispatch({
			type: 'set-watchlist',
			addresses: watched
				? view.watchlist.filter((candidate) => candidate !== address)
				: [...view.watchlist, address]
		});
	}

	async function loadRdlFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		monitor.dispatch({ type: 'set-rdl-source', source: await file.text(), fileName: file.name });
		input.value = '';
	}
</script>

<Dialog
	open={address !== null}
	onOpenChange={(open) => {
		if (!open) monitor.dispatch({ type: 'select-address', address: null });
	}}
>
	<DialogContent class="max-h-[calc(100vh-2rem)] overflow-hidden sm:max-w-4xl">
		<DialogHeader
			class="border-b pb-4 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4 sm:pr-10"
		>
			<div class="space-y-2">
				<DialogTitle class="flex items-center gap-2 font-serif">
					<Cpu class="text-primary" /> Register {address === null ? '--' : `0x${hex(address)}`}
				</DialogTitle>
				<DialogDescription
					>{decoded?.register.displayName ??
						decoded?.register.name ??
						'Raw 8-bit register'}</DialogDescription
				>
			</div>
			<Button
				class="w-full sm:w-52 sm:self-stretch"
				variant={watched ? 'secondary' : 'outline'}
				onclick={toggleWatchlist}
			>
				<Star class={watched ? 'fill-current' : ''} />
				{watched ? 'Remove from Watchlist' : 'Add to Watchlist'}
			</Button>
		</DialogHeader>

		<div class="space-y-6">
			{#if decoded}
				<section class="space-y-3">
					<h2 class="font-serif text-lg font-semibold">Decoded Fields</h2>
					<ScrollArea class={decoded.fields.length > 4 ? 'h-[min(42vh,28rem)]' : ''}>
						<div class="space-y-3 pr-4">
							{#each decoded.fields as field (field.field.name)}
								<div class="rounded-lg border bg-muted/40 p-4">
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0">
											<h3 class="font-mono text-sm text-foreground">
												{field.field.displayName ?? field.field.name}
											</h3>
											<p class="text-[10px] text-muted-foreground/50">
												[{field.field.highBit}:{field.field.lowBit}]
											</p>
										</div>
										<div class="text-right">
											{#if field.enumValue}<p class="text-base font-semibold text-chart-3">
													{field.enumValue.displayName ?? field.enumValue.name}
												</p>
												<p class="font-mono text-xs text-muted-foreground">
													{formatValue(field.value, field.field.highBit - field.field.lowBit + 1)}
												</p>
											{:else}
												<p class="font-mono text-primary">
													{formatValue(field.value, field.field.highBit - field.field.lowBit + 1)}
												</p>
											{/if}
										</div>
									</div>
									{#if field.field.description}<p
											class="mt-2 text-xs leading-relaxed text-muted-foreground"
										>
											{field.field.description}
										</p>{/if}
								</div>
							{:else}
								<p class="text-sm text-muted-foreground">
									No fields are defined for this register.
								</p>
							{/each}
						</div>
					</ScrollArea>
				</section>
			{:else}
				<div class="flex items-center justify-between gap-4 rounded-lg border border-dashed p-5">
					<p class="text-sm text-muted-foreground">Load a SystemRDL file to decode this address.</p>
					<input
						bind:this={rdlFileInput}
						class="sr-only"
						type="file"
						accept=".rdl,.systemrdl,text/plain"
						onchange={loadRdlFile}
					/>
					<Button variant="outline" size="sm" onclick={() => rdlFileInput?.click()}>
						<Upload /> Choose .rdl File
					</Button>
				</div>
			{/if}

			<Separator />

			<div>
				<div
					class="flex flex-1 items-center justify-between gap-4 rounded-lg border bg-muted/50 p-3"
				>
					<p class="font-mono text-xl text-primary">{formatValue(value, 8)}</p>
					<ButtonGroup aria-label="Register value base">
						{#each Object.entries(baseLabels) as [option, label] (option)}
							<Button
								class="text-[11px]"
								size="sm"
								variant={base === option ? 'default' : 'outline'}
								onclick={() => (base = option as typeof base)}
								aria-pressed={base === option}>{label}</Button
							>
						{/each}
					</ButtonGroup>
				</div>
			</div>
		</div>
	</DialogContent>
</Dialog>
