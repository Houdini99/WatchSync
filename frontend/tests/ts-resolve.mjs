// Lets Node's test runner load the app's TypeScript the way Vite does: the
// sources import siblings without an extension ('./types'), which plain Node
// ESM refuses. Loaded with --import (see the `test` script in package.json).
import { registerHooks } from 'node:module';

// The real hls.js needs Media Source Extensions; tests swap in a recorder.
const FAKE_HLS = new URL('./fakes/hls.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'hls.js') return { url: FAKE_HLS, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !relative) throw err;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
