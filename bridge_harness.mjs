import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The bridge ships in the host app (da_lang), one level up from this submodule.
// Loading the real file (not a copy) keeps these tests tracking production.
const here = dirname(fileURLToPath(import.meta.url));
const bridgeSource = readFileSync(
  join(here, '../../flutter_packages/da_lang/lib/core/browser/js/da_browser_core_bridge.js'),
  'utf8',
);

// Loads da_browser_core_bridge.js into a fresh fake `window` and captures
// everything it posts to the (stubbed) flutter_inappwebview channel. `da` is the
// resulting window.__da. Host calls resolve through `hostResponder` (default ok).
export function loadBridge() {
  const calls = [];
  let hostResponder = () => ({ ok: true, value: null });

  const window = {
    flutter_inappwebview: {
      callHandler(handler, message) {
        calls.push({ handler, message });
        return handler === 'DaHost' ? hostResponder(message) : undefined;
      },
    },
  };

  // The bridge is a classic-script IIFE that reads a bare `window`; bind it.
  new Function('window', bridgeSource)(window);

  return {
    da: window.__da,
    hostCalls: () => calls.filter((c) => c.handler === 'DaHost').map((c) => c.message),
    bridgeCalls: () => calls.filter((c) => c.handler === 'DaBridge').map((c) => c.message),
    setHostResponder: (fn) => {
      hostResponder = fn;
    },
  };
}
