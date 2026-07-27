import { createContext } from 'svelte';
import type { BrowserMonitor } from './monitor.svelte';

export const [getMonitorContext, setMonitorContext] = createContext<BrowserMonitor>();
