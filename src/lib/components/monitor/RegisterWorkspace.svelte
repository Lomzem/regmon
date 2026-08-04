<script lang="ts">
	import Binoculars from '@lucide/svelte/icons/binoculars';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import X from '@lucide/svelte/icons/x';
	import RawUartLog from '$lib/components/monitor/RawUartLog.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent } from '$lib/components/ui/card';
	import {
		Command,
		CommandEmpty,
		CommandInput,
		CommandItem,
		CommandList
	} from '$lib/components/ui/command';
	import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover';
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import { getMonitorContext } from '$lib/monitor/context';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let watchSearchOpen = $state(false);
	let watchSearch = $state('');
	let activeTab = $state('all');
	const addresses = Array.from({ length: 256 }, (_, address) => address);
	const nibbles = Array.from({ length: 16 }, (_, nibble) => nibble.toString(16).toUpperCase());
	let watchOptions = $derived(
		addresses.map((address) => {
			const register = view.registerMap?.registers.find((candidate) => candidate.address === address);
			const fields = register?.fields
				.flatMap((field) => [field.name, field.displayName, field.description])
				.filter(Boolean)
				.join(' ');
			return {
				address,
				label: register?.displayName ?? register?.name ?? 'Unmapped register',
				fields: register?.fields.map((field) => field.displayName ?? field.name).join(', ') ?? '',
				search:
					`0x${hex(address)} ${hex(address)} ${address} ${register?.name ?? ''} ${register?.displayName ?? ''} ${register?.description ?? ''} ${fields ?? ''}`.toLowerCase()
			};
		})
	);
	let visibleWatchOptions = $derived.by(() => {
		const needle = watchSearch.trim().toLowerCase();
		return watchOptions
			.filter((option) => !needle || option.search.includes(needle))
			.slice(0, 32);
	});

	function hex(value: number): string {
		return value.toString(16).padStart(2, '0').toUpperCase();
	}

	function inspectAddress(address: number): void {
		monitor.dispatch({ type: 'select-address', address });
	}

	function removeFromWatchlist(address: number): void {
		monitor.dispatch({
			type: 'set-watchlist',
			addresses: view.watchlist.filter((candidate) => candidate !== address)
		});
	}

	function addToWatchlist(address: number): void {
		monitor.dispatch({
			type: 'set-watchlist',
			addresses: [...view.watchlist, address]
		});
		watchSearch = '';
		watchSearchOpen = false;
	}
</script>

<Card class="py-0">
	<CardContent class="p-4">
		<Tabs bind:value={activeTab}>
			<TabsList variant="line" class="mb-2">
				<TabsTrigger value="all">All registers</TabsTrigger>
				<TabsTrigger value="watchlist"
					>Watchlist <Badge variant="secondary">{view.watchlist.length}</Badge></TabsTrigger
				>
				<TabsTrigger value="uart">Raw UART Log</TabsTrigger>
			</TabsList>

			<TabsContent value="all">
				{#if !view.snapshot}
					<div
						class="flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed bg-background/50 px-6 py-8 text-center"
					>
						<Binoculars class="mb-3 size-8 text-muted-foreground" />
						<p class="font-medium">No register snapshot</p>
						<p class="mt-1 max-w-md text-sm text-muted-foreground">
							Select an authorized device and connect to request the first 256-byte dump.
						</p>
					</div>
				{:else}
					<div class="overflow-x-auto pb-2" role="region" aria-label="256-byte register grid">
						<div class="grid w-max grid-cols-[2rem_repeat(16,2.5rem)] gap-1 font-mono">
							<div aria-hidden="true"></div>
							{#each nibbles as nibble (nibble)}
								<div class="flex h-7 items-center justify-center text-[10px] text-muted-foreground">
									{nibble}
								</div>
							{/each}
							{#each addresses as address (address)}
								{#if address % 16 === 0}
									<div
										class="flex h-9 items-center justify-center text-[10px] text-muted-foreground"
									>
										{hex(address).slice(0, 1)}x
									</div>
								{/if}
								{@const value = view.snapshot[address]}
								{@const changed =
									view.previousSnapshot !== null && view.previousSnapshot[address] !== value}
								{@const watched = view.watchlist.includes(address)}
								<button
									type="button"
									class={[
										'relative flex h-9 w-10 items-center justify-center rounded border font-mono text-xs transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
										view.selectedAddress === address
											? 'border-primary bg-primary/20 text-foreground'
											: 'border-border bg-background text-muted-foreground hover:border-muted-foreground',
										value !== 0 && 'bg-secondary text-foreground',
										changed && 'animate-pulse border-chart-4 bg-chart-4/20 text-chart-4'
									]}
									onclick={() => inspectAddress(address)}
									aria-label={`Register 0x${hex(address)}, value 0x${hex(value)}${changed ? ', changed' : ''}${watched ? ', watched' : ''}`}
								>
									{hex(value)}
									{#if watched}<span
											class="absolute top-0.5 right-0.5 size-1 rounded-full bg-primary"
											aria-hidden="true"
										></span>{/if}
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</TabsContent>

			<TabsContent value="watchlist" class="space-y-4">
				<Popover bind:open={watchSearchOpen}>
					<PopoverTrigger>
						{#snippet child({ props })}
							<Button
								{...props}
								class="w-full justify-between font-normal text-muted-foreground"
								variant="outline"
								role="combobox"
								aria-expanded={watchSearchOpen}
							>
								Find a register, field, or address
								<ChevronsUpDown class="opacity-50" />
							</Button>
						{/snippet}
					</PopoverTrigger>
					<PopoverContent class="w-[var(--bits-popover-anchor-width)] p-0" align="start">
						<Command shouldFilter={false}>
							<CommandInput bind:value={watchSearch} placeholder="Search registers and fields" />
							<CommandList class="max-h-72">
								<CommandEmpty>No matching register.</CommandEmpty>
								{#each visibleWatchOptions as option (option.address)}
									<CommandItem
										value={option.search}
										onSelect={() => addToWatchlist(option.address)}
									>
										<span class="w-10 shrink-0 font-mono text-xs text-primary"
											>0x{hex(option.address)}</span
										>
										<span class="min-w-0">
											<span class="block truncate">{option.label}</span>
											{#if option.fields}<span
													class="block truncate text-xs text-muted-foreground"
													>{option.fields}</span
												>{/if}
										</span>
									</CommandItem>
								{/each}
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>

				{#if view.watchlist.length === 0}
					<div
						class="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"
					>
						No watched addresses.
					</div>
				{:else}
					<div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
						{#each view.watchlist as address (address)}
							{@const register = view.registerMap?.registers.find(
								(candidate) => candidate.address === address
							)}
							{@const value = view.snapshot?.[address] ?? 0}
							<div class="group relative">
								<button
									type="button"
									class="flex w-full items-center justify-between rounded-lg border bg-muted/50 p-3 pr-10 text-left transition-colors hover:border-primary/60 hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
									onclick={() => inspectAddress(address)}
									aria-label={`Inspect register 0x${hex(address)}`}
								>
									<span class="min-w-0">
										<span class="block font-mono text-xs text-primary">0x{hex(address)}</span>
										<span class="block truncate text-xs text-muted-foreground"
											>{register?.displayName ?? register?.name ?? 'Unmapped register'}</span
										>
									</span>
									<span class="font-mono text-lg">{hex(value)}</span>
								</button>
								<Button
									class="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
									variant="ghost"
									size="icon-xs"
									onclick={() => removeFromWatchlist(address)}
									aria-label={`Remove register 0x${hex(address)} from watchlist`}
									title="Remove from Watchlist"
								>
									<X />
								</Button>
							</div>
						{/each}
					</div>
				{/if}
			</TabsContent>

			<TabsContent value="uart">
				<RawUartLog />
			</TabsContent>
		</Tabs>
	</CardContent>
</Card>
