<script lang="ts">
	import ConnectionToolbar from '$lib/components/monitor/ConnectionToolbar.svelte';
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
	<title>RegMon · Register Monitor</title>
	<meta
		name="description"
		content="A desktop and browser diagnostic console for inspecting 8-bit device registers."
	/>
</svelte:head>

<main class="min-h-screen overflow-x-hidden bg-background text-foreground selection:bg-primary/30">
	<div
		class="mx-auto flex min-h-screen w-full max-w-7xl min-w-0 flex-col gap-4 px-3 py-4 sm:px-6 sm:py-5 lg:py-8"
	>
		<ConnectionToolbar />
		<RegisterWorkspace />
		<RegisterInspector />
	</div>
</main>
