// Deliberately-broken fixture for the `saga-soa/init-tracing-first` rule.
// `reflect-metadata` is imported BEFORE initTracing() — the canonical
// footgun. ESLint MUST report a saga-soa/init-tracing-first error on
// this file. Excluded from project-wide lint via base.js `ignores`.

import 'reflect-metadata';
import { initTracing } from '@saga-ed/soa-observability';

initTracing();
