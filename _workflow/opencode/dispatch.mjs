import { main } from './dispatcher.mjs';
main().catch(e => { console.error(e.message); process.exitCode = 1; });
