// Enable Node's validated on-disk code cache before loading TypeScript. A static import of main.ts would load it
// too early. Node treats a disabled or unwritable cache as a no-op; it must never prevent a command from running.
import { enableCompileCache } from 'node:module';

enableCompileCache();
const { main } = await import('../src/cli/main.ts');
// The legacy entry-point override already runs main during import.
if (process.env.PHONEDOCK_CLI_MAIN !== '1') await main();
