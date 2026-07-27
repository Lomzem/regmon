<script lang="ts">
	import Binoculars from '@lucide/svelte/icons/binoculars';
	import ListPlus from '@lucide/svelte/icons/list-plus';
	import Replace from '@lucide/svelte/icons/replace';
	import Search from '@lucide/svelte/icons/search';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import { getMonitorContext } from '$lib/monitor/context';
	import { parseAddressExpression } from '$lib/registers/filter';

	const monitor = getMonitorContext();
	let view = $derived(monitor.view);
	let expression = $state('');
	let expressionError = $state('');
	let activeTab = $state('all');
	const addresses = Array.from({ length: 256 }, (_, address) => address);
	const nibbles = Array.from({ length: 16 }, (_, nibble) => nibble.toString(16).toUpperCase());
	let filteredWatchlist = $derived.by(() => {
		const needle = view.filter.trim().toLowerCase();
		if (!needle) return view.watchlist;
		return view.watchlist.filter((address) => {
			const register = view.registerMap?.registers.find(
				(candidate) => candidate.address === address
			);
			return `${register?.name ?? ''} ${register?.displayName ?? ''} ${register?.description ?? ''}`
				.toLowerCase()
				.includes(needle);
		});
	});

	function hex(value: number): string {
		return value.toString(16).padStart(2, '0').toUpperCase();
	}

	function toggleAddress(address: number): void {
		const watched = view.watchlist.includes(address);
		monitor.dispatch({
			type: 'set-watchlist',
			addresses: watched
				? view.watchlist.filter((candidate) => candidate !== address)
				: [...view.watchlist, address]
		});
		monitor.dispatch({ type: 'select-address', address });
	}

	function applyExpression(mode: 'add' | 'replace'): void {
		const result = parseAddressExpression(expression);
		if (!result.ok) {
			expressionError = `${result.error.message} (column ${result.error.position + 1})`;
			return;
		}
		expressionError = '';
		monitor.dispatch({
			type: 'set-watchlist',
			addresses: mode === 'replace' ? result.addresses : [...view.watchlist, ...result.addresses]
		});
	}
</script>

<Card class="border-zinc-800 bg-zinc-950/75">
	<CardHeader class="border-b border-zinc-800">
		<div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
			<div>
				<CardTitle class="font-mono text-sm tracking-[0.18em] uppercase">Register matrix</CardTitle>
				<CardDescription>Click a byte to inspect it and toggle its watch marker.</CardDescription>
			</div>
			<div class="flex items-center gap-2 text-xs text-zinc-500">
				<span class="size-2 rounded-sm bg-zinc-700"></span> nonzero
				<span class="size-2 rounded-sm bg-amber-400"></span> changed
				<span class="size-2 rounded-sm bg-cyan-400"></span> watched
			</div>
		</div>
	</CardHeader>
	<CardContent class="p-3 sm:p-5">
		<Tabs bind:value={activeTab}>
			<TabsList variant="line" class="mb-2">
				<TabsTrigger value="all">All registers</TabsTrigger>
				<TabsTrigger value="watchlist"
					>Watchlist <Badge variant="secondary">{view.watchlist.length}</Badge></TabsTrigger
				>
			</TabsList>

			<TabsContent value="all">
				{#if !view.snapshot}
					<div
						class="flex min-h-80 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 px-6 text-center"
					>
						<Binoculars class="mb-3 size-8 text-zinc-600" />
						<p class="font-medium">No register snapshot</p>
						<p class="mt-1 max-w-md text-sm text-zinc-500">
							Select an authorized device and connect to request the first 256-byte dump.
						</p>
					</div>
				{:else}
					<div class="overflow-x-auto pb-2" role="region" aria-label="256-byte register grid">
						<div class="grid w-max grid-cols-[2rem_repeat(16,2.5rem)] gap-1 font-mono">
							<div aria-hidden="true"></div>
							{#each nibbles as nibble (nibble)}
								<div class="flex h-7 items-center justify-center text-[10px] text-zinc-600">
									{nibble}
								</div>
							{/each}
							{#each addresses as address (address)}
								{#if address % 16 === 0}
									<div class="flex h-9 items-center justify-center text-[10px] text-zinc-600">
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
										'relative flex h-9 w-10 items-center justify-center rounded border font-mono text-xs transition-colors focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none',
										view.selectedAddress === address
											? 'border-cyan-300 bg-cyan-400/20 text-cyan-100'
											: 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-600',
										value !== 0 && 'bg-zinc-800/80 text-zinc-100',
										changed && 'animate-pulse border-amber-400 bg-amber-400/25 text-amber-100'
									]}
									onclick={() => toggleAddress(address)}
									aria-label={`Register 0x${hex(address)}, value 0x${hex(value)}${changed ? ', changed' : ''}${watched ? ', watched' : ''}`}
									aria-pressed={watched}
								>
									{hex(value)}
									{#if watched}<span
											class="absolute top-0.5 right-0.5 size-1 rounded-full bg-cyan-300"
											aria-hidden="true"
										></span>{/if}
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</TabsContent>

			<TabsContent value="watchlist" class="space-y-4">
				<form
					class="grid gap-2 lg:grid-cols-[1fr_auto_auto]"
					onsubmit={(event) => {
						event.preventDefault();
						applyExpression('add');
					}}
				>
					<div>
						<label for="watch-expression" class="sr-only">Address expression</label>
						<Input
							id="watch-expression"
							bind:value={expression}
							placeholder="Addresses: 00, 10-1F, 0x80"
							aria-invalid={expressionError ? 'true' : undefined}
						/>
					</div>
					<Button type="submit" variant="outline"><ListPlus /> Add</Button>
					<Button type="button" variant="outline" onclick={() => applyExpression('replace')}
						><Replace /> Replace</Button
					>
				</form>
				{#if expressionError}<p class="text-xs text-red-400" role="alert">{expressionError}</p>{/if}

				<div class="relative">
					<Search
						class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-600"
					/>
					<label for="metadata-filter" class="sr-only">Filter watchlist by register metadata</label>
					<Input
						id="metadata-filter"
						class="pl-9"
						value={view.filter}
						oninput={(event) =>
							monitor.dispatch({ type: 'set-filter', filter: event.currentTarget.value })}
						placeholder="Filter by register name or description"
					/>
				</div>

				{#if filteredWatchlist.length === 0}
					<div
						class="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500"
					>
						{view.watchlist.length === 0
							? 'No watched addresses. Add an expression or click cells in the matrix.'
							: 'No watched register matches the metadata filter.'}
					</div>
				{:else}
					<div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
						{#each filteredWatchlist as address (address)}
							{@const register = view.registerMap?.registers.find(
								(candidate) => candidate.address === address
							)}
							{@const value = view.snapshot?.[address] ?? 0}
							<button
								type="button"
								class="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-left transition-colors hover:border-cyan-800 hover:bg-cyan-950/20 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
								onclick={() => toggleAddress(address)}
								aria-label={`Remove register 0x${hex(address)} from watchlist and inspect it`}
							>
								<span class="min-w-0">
									<span class="block font-mono text-xs text-cyan-400">0x{hex(address)}</span>
									<span class="block truncate text-xs text-zinc-500"
										>{register?.displayName ?? register?.name ?? 'Unmapped register'}</span
									>
								</span>
								<span class="font-mono text-lg">{hex(value)}</span>
							</button>
						{/each}
					</div>
				{/if}
			</TabsContent>
		</Tabs>
	</CardContent>
</Card>
