<script lang="ts">
	import Binary from '@lucide/svelte/icons/binary';
	import { Badge } from '$lib/components/ui/badge';
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
	let view = $derived(monitor.view);
	let address = $derived(view.selectedAddress);
	let value = $derived(address === null ? 0 : (view.snapshot?.[address] ?? 0));
	let decoded = $derived(
		address === null || !view.registerMap
			? undefined
			: decodeRegisterMap(view.registerMap, address, value)
	);

	function hex(byte: number): string {
		return byte.toString(16).padStart(2, '0').toUpperCase();
	}
</script>

<Sheet
	open={address !== null}
	onOpenChange={(open) => {
		if (!open) monitor.dispatch({ type: 'select-address', address: null });
	}}
>
	<SheetContent class="w-full overflow-y-auto border-zinc-800 bg-zinc-950 sm:max-w-lg">
		<SheetHeader class="border-b border-zinc-800 pb-4">
			<SheetTitle class="flex items-center gap-2 font-mono">
				<Binary class="text-cyan-400" /> Register {address === null ? '--' : `0x${hex(address)}`}
			</SheetTitle>
			<SheetDescription
				>{decoded?.register.displayName ??
					decoded?.register.name ??
					'Raw 8-bit register'}</SheetDescription
			>
		</SheetHeader>

		<div class="space-y-5 px-4 pb-6">
			<div class="grid grid-cols-3 gap-2">
				<div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
					<p class="text-[10px] tracking-wider text-zinc-500 uppercase">Hex</p>
					<p class="mt-1 font-mono text-xl text-cyan-300">0x{hex(value)}</p>
				</div>
				<div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
					<p class="text-[10px] tracking-wider text-zinc-500 uppercase">Decimal</p>
					<p class="mt-1 font-mono text-xl">{value}</p>
				</div>
				<div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
					<p class="text-[10px] tracking-wider text-zinc-500 uppercase">Binary</p>
					<p class="mt-1 font-mono text-xs leading-7">{value.toString(2).padStart(8, '0')}</p>
				</div>
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
					{#if decoded.register.description}<p class="text-sm leading-relaxed text-zinc-400">
							{decoded.register.description}
						</p>{/if}
				</div>
				<Separator class="bg-zinc-800" />
				<div class="space-y-2">
					<h3 class="font-mono text-xs tracking-wider text-zinc-500 uppercase">Decoded fields</h3>
					{#each decoded.fields as field (field.field.name)}
						<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0">
									<p class="font-mono text-sm text-zinc-100">
										{field.field.displayName ?? field.field.name}
									</p>
									<p class="text-[11px] text-zinc-500">
										bits {field.field.highBit}:{field.field.lowBit}{field.field.softwareAccess
											? ` · ${field.field.softwareAccess}`
											: ''}
									</p>
								</div>
								<div class="text-right">
									<p class="font-mono text-cyan-300">{field.value}</p>
									{#if field.enumValue}<p class="text-xs text-emerald-400">
											{field.enumValue.displayName ?? field.enumValue.name}
										</p>{/if}
								</div>
							</div>
							{#if field.field.description}<p class="mt-2 text-xs leading-relaxed text-zinc-500">
									{field.field.description}
								</p>{/if}
						</div>
					{:else}
						<p class="text-sm text-zinc-500">No fields are defined for this register.</p>
					{/each}
				</div>
			{:else}
				<div class="rounded-lg border border-dashed border-zinc-800 p-5 text-sm text-zinc-500">
					Load a SystemRDL file to decode this address.
				</div>
			{/if}
		</div>
	</SheetContent>
</Sheet>
