<script lang="ts">
	import Binary from '@lucide/svelte/icons/binary';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { ButtonGroup } from '$lib/components/ui/button-group';
	import { Separator } from '$lib/components/ui/separator';
	import {
		Sheet,
		SheetContent,
		SheetDescription,
		SheetHeader,
		SheetTitle
	} from '$lib/components/ui/sheet';
	import { getMonitorContext } from '$lib/monitor/context';
	import { decodeRegisterMap } from '$lib/rdl/decode';

	const monitor = getMonitorContext();
	const baseLabels = { hex: 'Hex', decimal: 'Decimal', binary: 'Binary' } as const;
	let view = $derived(monitor.view);
	let address = $derived(view.selectedAddress);
	let value = $derived(address === null ? 0 : (view.snapshot?.[address] ?? 0));
	let base = $state<'hex' | 'decimal' | 'binary'>('hex');
	let decoded = $derived(
		address === null || !view.registerMap
			? undefined
			: decodeRegisterMap(view.registerMap, address, value)
	);

	function hex(byte: number): string {
		return byte.toString(16).padStart(2, '0').toUpperCase();
	}

	function formattedValue(): string {
		if (base === 'decimal') return String(value);
		if (base === 'binary') return value.toString(2).padStart(8, '0');
		return `0x${hex(value)}`;
	}
</script>

<Sheet
	open={address !== null}
	onOpenChange={(open) => {
		if (!open) monitor.dispatch({ type: 'select-address', address: null });
	}}
>
	<SheetContent class="w-full overflow-y-auto bg-card sm:max-w-lg">
		<SheetHeader class="border-b pb-4">
			<SheetTitle class="flex items-center gap-2 font-serif">
				<Binary class="text-primary" /> Register {address === null ? '--' : `0x${hex(address)}`}
			</SheetTitle>
			<SheetDescription
				>{decoded?.register.displayName ??
					decoded?.register.name ??
					'Raw 8-bit register'}</SheetDescription
			>
		</SheetHeader>

		<div class="space-y-5 px-4 pb-6">
			<div class="flex items-center justify-between gap-4 rounded-lg border bg-muted/50 p-3">
				<div class="min-w-0">
					<p class="text-[10px] tracking-wider text-muted-foreground">{baseLabels[base]}</p>
					<p class="mt-1 font-mono text-xl text-primary">{formattedValue()}</p>
				</div>
				<ButtonGroup aria-label="Register value base">
					{#each Object.entries(baseLabels) as [option, label] (option)}
						<Button
							class="text-[11px]"
							size="sm"
							variant={base === option ? 'secondary' : 'outline'}
							onclick={() => (base = option as typeof base)}
							aria-pressed={base === option}>{label}</Button
						>
					{/each}
				</ButtonGroup>
			</div>

			{#if decoded}
				<div class="space-y-3">
					<div class="flex flex-wrap items-center gap-2">
						<h3 class="font-semibold">{decoded.register.displayName ?? decoded.register.name}</h3>
						{#if decoded.register.softwareAccess}<Badge variant="outline"
								>{decoded.register.softwareAccess}</Badge
							>{/if}
						{#if decoded.register.reset !== undefined}<Badge variant="secondary"
								>reset 0x{hex(decoded.register.reset)}</Badge
							>{/if}
					</div>
					{#if decoded.register.description}<p
							class="text-sm leading-relaxed text-muted-foreground"
						>
							{decoded.register.description}
						</p>{/if}
				</div>
				<Separator />
				<div class="space-y-2">
					<h3 class="font-mono text-xs tracking-wider text-muted-foreground">
						Decoded Fields
					</h3>
					{#each decoded.fields as field (field.field.name)}
						<div class="rounded-lg border bg-muted/40 p-3">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0">
									<p class="font-mono text-sm text-foreground">
										{field.field.displayName ?? field.field.name}
									</p>
									<p class="text-[11px] text-muted-foreground">
										bits {field.field.highBit}:{field.field.lowBit}{field.field.softwareAccess
											? ` · ${field.field.softwareAccess}`
											: ''}
									</p>
								</div>
								<div class="text-right">
									<p class="font-mono text-primary">{field.value}</p>
									{#if field.enumValue}<p class="text-xs text-chart-3">
											{field.enumValue.displayName ?? field.enumValue.name}
										</p>{/if}
								</div>
							</div>
							{#if field.field.description}<p
									class="mt-2 text-xs leading-relaxed text-muted-foreground"
								>
									{field.field.description}
								</p>{/if}
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">No fields are defined for this register.</p>
					{/each}
				</div>
			{:else}
				<div class="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
					Load a SystemRDL file to decode this address.
				</div>
			{/if}
		</div>
	</SheetContent>
</Sheet>
