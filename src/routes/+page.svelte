<script lang="ts">
	import Activity from '@lucide/svelte/icons/activity';
	import ConnectionToolbar from '$lib/components/monitor/ConnectionToolbar.svelte';
	import RdlAndLog from '$lib/components/monitor/RdlAndLog.svelte';
	import RegisterInspector from '$lib/components/monitor/RegisterInspector.svelte';
	import RegisterWorkspace from '$lib/components/monitor/RegisterWorkspace.svelte';
	import { setMonitorContext } from '$lib/monitor/context';
	import { BrowserMonitor } from '$lib/monitor/monitor.svelte';
	import { onDestroy } from 'svelte';

	const monitor = new BrowserMonitor();
	setMonitorContext(monitor);

	onDestroy(() => monitor.close());
</script>

<svelte:head>
	<title>Regmon · Browser Register Monitor</title>
	<meta
		name="description"
		content="A local Web Serial diagnostic console for inspecting 8-bit device registers."
	/>
</svelte:head>

<main class="min-h-screen bg-zinc-950 text-zinc-100 selection:bg-cyan-400/30">
	<div
		class="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-4 px-3 py-4 sm:px-6 lg:gap-6 lg:px-8 lg:py-6"
	>
		<header class="flex items-center justify-between border-b border-zinc-800 pb-4">
			<div class="flex items-center gap-3">
				<div
					class="flex size-10 items-center justify-center rounded-lg border border-cyan-800 bg-cyan-950/50 text-cyan-300 shadow-inner shadow-cyan-950"
				>
					<Activity />
				</div>
				<div>
					<h1 class="font-mono text-lg font-semibold tracking-[0.18em] uppercase sm:text-xl">
						Regmon
					</h1>
					<p class="text-xs text-zinc-500">Web Serial register diagnostics</p>
				</div>
			</div>
			<p class="hidden font-mono text-[10px] tracking-widest text-zinc-600 uppercase sm:block">
				Local session · no telemetry
			</p>
		</header>

		<ConnectionToolbar />
		<RegisterWorkspace />
		<RdlAndLog />
		<RegisterInspector />

		<footer
			class="mt-auto flex flex-wrap justify-between gap-2 border-t border-zinc-900 pt-4 font-mono text-[10px] tracking-wider text-zinc-700 uppercase"
		>
			<span>256 × 8-bit address space</span>
			<span>Browser-only diagnostic console</span>
		</footer>
	</div>
</main>
