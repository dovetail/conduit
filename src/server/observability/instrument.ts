// Side-effect module: initializes error reporting BEFORE anything else loads.
//
// It must be the very first import in the server entrypoint. Under TS→CommonJS,
// `import` statements compile to hoisted `require()` calls that run in source
// order before any other statement — so importing this first guarantees
// `initObservability()` (and therefore `Sentry.init`) runs before `express`,
// `http`, and the rest of the app are required. That lets @sentry/node
// instrument those modules and capture errors thrown in their load-time side
// effects. A plain `initObservability()` call in index.ts would run only after
// all imports had already loaded.
import { initObservability } from './index'

initObservability()
