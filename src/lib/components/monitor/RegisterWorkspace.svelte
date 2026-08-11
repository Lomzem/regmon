<script lang="ts">
	import Fuse from 'fuse.js';
	import Binoculars from '@lucide/svelte/icons/binoculars';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import RawUartLog from '$lib/components/monitor/RawUartLog.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
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
	import { indexRegisters } from '$lib/rdl/decode';
	import {
		formatUpdateTime,
		isStaleAddress,
		registerMatchesFilter
	} from '$lib/monitor/presentation';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let watchSearchOpen = $state(false);
	let watchSearch = $state('');
	let watchSelection = $state('');
	let activeTab = $state('all');
	let viewportWidth = $state(1024);
	const addresses = Array.from({ length: 256 }, (_, address) => address);
	const nibbles = Array.from({ length: 16 }, (_, nibble) => nibble.toString(16).toUpperCase());
	let registersByAddress = $derived(indexRegisters(view.registerMap?.registers ?? []));
	let staleAddresses = $derived(new Set(view.missingAddresses));
	let watchOptions = $derived(
		addresses.map((address) => {
			const register = registersByAddress.get(address);
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
	let watchFuse = $derived(
		new Fuse(watchOptions, {
			keys: ['search'],
			threshold: 0.35,
			ignoreLocation: true
		})
	);
	let visibleWatchOptions = $derived.by(() => {
		const needle = watchSearch.trim().toLowerCase();
		return needle
			? watchFuse.search(needle, { limit: 32 }).map((result) => result.item)
			: watchOptions.slice(0, 32);
	});
	let matchingAddressCount = $derived(
		view.snapshot
			? addresses.filter((address) =>
					registerMatchesFilter(
						address,
						view.snapshot?.[address] ?? 0,
						view.filter,
						registersByAddress.get(address)
					)
				).length
			: 0
	);

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
		watchSelection = '';
		watchSearchOpen = false;
	}
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<Card class="min-w-0 py-0">
	<CardContent class="p-4">
		<Tabs bind:value={activeTab} class="min-w-0">
			<TabsList variant="line" class="mb-2 h-auto max-w-full overflow-x-auto">
				<TabsTrigger class="min-h-11 shrink-0 sm:min-h-8" value="all">All registers</TabsTrigger>
				<TabsTrigger class="min-h-11 shrink-0 sm:min-h-8" value="watchlist"
					>Watchlist <Badge variant="secondary">{view.watchlist.length}</Badge></TabsTrigger
				>
				<TabsTrigger class="min-h-11 shrink-0 sm:min-h-8" value="uart">Transport Log</TabsTrigger>
			</TabsList>

			<TabsContent value="all" class="min-w-0">
				<div
					class="mb-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
				>
					<label class="relative block min-w-0 flex-1 sm:max-w-md">
						<span class="sr-only">Filter register grid</span>
						<Search
							class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							class="min-h-11 pl-9 sm:min-h-9"
							value={view.filter}
							placeholder="Filter address, value, register, or field"
							oninput={(event) =>
								monitor.dispatch({ type: 'set-filter', filter: event.currentTarget.value })}
						/>
					</label>
					<div
						class="flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground"
						aria-live="polite"
					>
						{#if view.filter.trim()}
							<span>{matchingAddressCount} of 256 highlighted</span>
							<span aria-hidden="true"> · </span>
						{/if}
						<span>{view.snapshotSource ?? 'No source'}</span>
						<span aria-hidden="true"> · </span>
						<span>{formatUpdateTime(view.snapshotAt)}</span>
					</div>
				</div>
				{#if view.missingAddresses.length > 0 && !view.polling}
					<div
						class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
					>
						{view.missingAddresses.length} register values are stale. Amber cells keep their previous
						value and identify addresses that did not respond in the last scan.
					</div>
				{/if}
				{#if !view.snapshot}
					<div
						class="flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed bg-muted/40 px-6 py-8 text-center"
					>
						<Binoculars class="mb-3 size-8 text-muted-foreground" />
						<p class="font-medium">No register snapshot</p>
						<p class="mt-1 max-w-md text-sm text-muted-foreground">
							Select an authorized device and connect to request the first 256-byte dump.
						</p>
					</div>
				{:else}
					<div class="relative min-w-0">
						<div
							class="max-h-[32rem] overflow-auto overscroll-contain pb-3 sm:max-h-none sm:overflow-x-auto sm:overflow-y-visible"
							role="region"
							aria-label="256-byte register grid; scroll horizontally on narrow screens"
						>
							<div
								class="grid w-max grid-cols-[2.5rem_repeat(16,2.75rem)] gap-1 font-mono sm:grid-cols-[2rem_repeat(16,2.5rem)]"
							>
								<div class="sticky top-0 left-0 z-30 bg-card" aria-hidden="true"></div>
								{#each nibbles as nibble (nibble)}
									<div
										class="sticky top-0 z-20 flex h-8 items-center justify-center bg-card text-[10px] text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]"
									>
										{nibble}
									</div>
								{/each}
								{#each addresses as address (address)}
									{#if address % 16 === 0}
										<div
											class="sticky left-0 z-10 flex h-11 items-center justify-center bg-card text-[10px] text-muted-foreground shadow-[1px_0_0_hsl(var(--border))] sm:h-9"
										>
											{hex(address).slice(0, 1)}x
										</div>
									{/if}
									{@const value = view.snapshot[address]}
									{@const changed =
										view.previousSnapshot !== null && view.previousSnapshot[address] !== value}
									{@const watched = view.watchlist.includes(address)}
									{@const stale = isStaleAddress(address, staleAddresses)}
									{@const matches = registerMatchesFilter(
										address,
										value,
										view.filter,
										registersByAddress.get(address)
									)}
									<button
										type="button"
										class={[
											'relative flex h-11 w-11 items-center justify-center rounded border font-mono text-xs transition-[color,background-color,border-color,opacity] focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:h-9 sm:w-10',
											view.selectedAddress === address
												? 'border-primary bg-primary/20 text-primary'
												: 'border-border bg-card text-muted-foreground hover:border-muted-foreground',
											value !== 0 && 'bg-accent text-accent-foreground',
											changed && 'animate-pulse border-primary bg-primary/20 text-primary',
											stale && 'border-amber-500/70 bg-amber-500/15 text-amber-200',
											!matches && 'opacity-25 hover:opacity-70 focus-visible:opacity-100'
										]}
										onclick={() => inspectAddress(address)}
										title={stale
											? `Register 0x${hex(address)} is stale; showing the previous value from ${formatUpdateTime(view.snapshotAt)}`
											: `Register 0x${hex(address)}, value 0x${hex(value)}`}
										aria-label={`Register 0x${hex(address)}, value 0x${hex(value)}${changed ? ', changed' : ''}${watched ? ', watched' : ''}${stale ? ', stale, previous value retained' : ''}`}
									>
										{hex(value)}
										{#if watched}<span
												class="absolute top-0.5 right-0.5 size-1 rounded-full bg-primary"
												aria-hidden="true"
											></span>{/if}
										{#if stale}<span
												class="absolute bottom-0.5 left-0.5 size-1.5 rounded-sm bg-amber-400"
												aria-hidden="true"
											></span>{/if}
									</button>
								{/each}
							</div>
						</div>
						<div
							class="pointer-events-none absolute top-8 right-0 bottom-3 w-8 bg-gradient-to-l from-card to-transparent sm:hidden"
							aria-hidden="true"
						></div>
						<p class="mt-1 text-[10px] text-muted-foreground sm:hidden">
							Swipe or scroll horizontally to inspect all columns.
						</p>
					</div>
				{/if}
			</TabsContent>

			<TabsContent value="watchlist" class="space-y-4">
				<Popover bind:open={watchSearchOpen}>
					<PopoverTrigger>
						{#snippet child({ props })}
							<Button
								{...props}
								class="min-h-11 w-full justify-between font-normal text-muted-foreground sm:min-h-9"
								variant="outline"
								role="combobox"
								aria-expanded={watchSearchOpen}
							>
								Find a register, field, or address
								<ChevronsUpDown class="opacity-50" />
							</Button>
						{/snippet}
					</PopoverTrigger>
					<PopoverContent
						class="max-h-[min(24rem,calc(100vh-2rem))] w-[var(--bits-popover-anchor-width)] overflow-hidden border-border bg-popover p-0 shadow-2xl backdrop-blur-none"
						align="start"
						side="bottom"
						sideOffset={8}
						avoidCollisions={viewportWidth >= 640}
						collisionPadding={12}
					>
						<Command bind:value={watchSelection} shouldFilter={false} disablePointerSelection>
							<CommandInput bind:value={watchSearch} placeholder="Search registers and fields" />
							<CommandList class="max-h-[min(18rem,45vh)] overflow-y-auto">
								<CommandEmpty>No matching register.</CommandEmpty>
								{#each visibleWatchOptions as option (option.address)}
									<CommandItem
										class="min-h-10"
										value={option.search}
										onpointerenter={() => (watchSelection = option.search)}
										onclick={() => addToWatchlist(option.address)}
										onSelect={() => addToWatchlist(option.address)}
									>
										<span class="w-10 shrink-0 font-mono text-xs text-primary"
											>0x{hex(option.address)}</span
										>
										<span class="min-w-0">
											<span class="block truncate">{option.label}</span>
											{#if option.fields}<span class="block truncate text-xs text-muted-foreground"
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
							{@const register = registersByAddress.get(address)}
							{@const value = view.snapshot?.[address] ?? 0}
							{@const stale = isStaleAddress(address, staleAddresses)}
							<div class="group relative">
								<button
									type="button"
									class={[
										'flex min-h-14 w-full items-center justify-between rounded-lg border bg-muted/50 p-3 pr-12 text-left transition-colors hover:border-accent-foreground/40 hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
										stale && 'border-amber-500/60 bg-amber-500/10'
									]}
									onclick={() => inspectAddress(address)}
									aria-label={`Inspect register 0x${hex(address)}${stale ? ', stale, previous value retained' : ''}`}
								>
									<span class="min-w-0">
										<span class="block font-mono text-xs text-primary">0x{hex(address)}</span>
										<span class="block truncate text-xs text-muted-foreground"
											>{register?.displayName ?? register?.name ?? 'Unmapped register'}</span
										>
										{#if stale}<Badge
												class="mt-1 border-amber-500/50 text-amber-700 dark:text-amber-300"
												variant="outline">Stale</Badge
											>{/if}
									</span>
									<span class="font-mono text-lg">{hex(value)}</span>
								</button>
								<Button
									class="absolute top-1.5 right-1.5 size-10 sm:size-7 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
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
