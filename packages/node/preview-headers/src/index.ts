/**
 * @saga-ed/soa-preview-headers — the canonical HTTP-plane preview/sandbox
 * routing-header primitives for Saga services.
 *
 * Every service routes preview traffic with `x-saga-preview-<service>:
 * sandbox-<name>`: the header is captured off the inbound request, forwarded
 * onto outbound S2S calls, and matched by the ALB to reach the right preview
 * deployment. This package is the one home for that mechanism, consolidating the
 * per-service copies that previously drifted (and re-implemented the same
 * origination feature N times). It is the HTTP-plane sibling of the event-plane
 * `applyPreviewTag()` in `@saga-ed/soa-event-envelope`.
 *
 * Backend-only: it depends on `node:async_hooks` and must not enter a browser
 * bundle. Browser forwarders read `document.cookie` and stay separate.
 */
export { HEADER_PREFIX, toPreviewHeaderName, toServiceKey, extractPreviewHeaders } from './header-keys.js';
export { parseOriginateMap } from './originate-map.js';
export { runWithPreviewHeaders, getPreviewHeaders } from './store.js';
export { withPreviewHeaders } from './forward.js';
