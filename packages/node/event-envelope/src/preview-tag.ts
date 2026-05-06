/**
 * Suffix an event-routing name (exchange, queue, consumer tag) with the
 * preview-environment tag, so multiple PR-preview deploys can share a
 * single RabbitMQ broker without cross-contamination.
 *
 * The tag is read from `EVENT_PREVIEW_TAG` by default; production deploys
 * leave it unset and the helper is a no-op. Both publisher and consumer
 * sides MUST apply the same tag — see d-preview-deploy-isolation.md.
 *
 * @example
 *   applyPreviewTag('iam.events')                          // → 'iam.events'
 *   applyPreviewTag('iam.events', 'pr-142')                // → 'iam.events.pr-142'
 *   process.env.EVENT_PREVIEW_TAG = 'pr-142';
 *   applyPreviewTag('iam.events')                          // → 'iam.events.pr-142'
 */
export function applyPreviewTag(name: string, tag?: string): string {
    const resolved = (tag ?? process.env.EVENT_PREVIEW_TAG ?? '').trim();
    return resolved ? `${name}.${resolved}` : name;
}
