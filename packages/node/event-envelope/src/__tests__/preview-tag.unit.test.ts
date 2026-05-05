import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPreviewTag } from '../preview-tag.js';

describe('applyPreviewTag', () => {
    const original = process.env.EVENT_PREVIEW_TAG;

    beforeEach(() => {
        delete process.env.EVENT_PREVIEW_TAG;
    });

    afterEach(() => {
        if (original === undefined) {
            delete process.env.EVENT_PREVIEW_TAG;
        } else {
            process.env.EVENT_PREVIEW_TAG = original;
        }
    });

    it('returns the name unchanged when no tag is set', () => {
        expect(applyPreviewTag('iam.events')).toBe('iam.events');
    });

    it('returns the name unchanged when the env var is empty', () => {
        process.env.EVENT_PREVIEW_TAG = '';
        expect(applyPreviewTag('iam.events')).toBe('iam.events');
    });

    it('returns the name unchanged when the env var is whitespace', () => {
        process.env.EVENT_PREVIEW_TAG = '   ';
        expect(applyPreviewTag('iam.events')).toBe('iam.events');
    });

    it('suffixes the env var when set', () => {
        process.env.EVENT_PREVIEW_TAG = 'pr-142';
        expect(applyPreviewTag('iam.events')).toBe('iam.events.pr-142');
    });

    it('explicit tag overrides the env var', () => {
        process.env.EVENT_PREVIEW_TAG = 'pr-142';
        expect(applyPreviewTag('iam.events', 'pr-999')).toBe('iam.events.pr-999');
    });

    it('explicit empty string overrides the env var', () => {
        process.env.EVENT_PREVIEW_TAG = 'pr-142';
        expect(applyPreviewTag('iam.events', '')).toBe('iam.events');
    });

    it('trims whitespace from the tag', () => {
        process.env.EVENT_PREVIEW_TAG = '  pr-142  ';
        expect(applyPreviewTag('iam.events')).toBe('iam.events.pr-142');
    });

    it('handles queue and consumer-tag style names', () => {
        process.env.EVENT_PREVIEW_TAG = 'pr-7';
        expect(applyPreviewTag('iam.user-projection')).toBe('iam.user-projection.pr-7');
        expect(applyPreviewTag('programs-iam-projection')).toBe('programs-iam-projection.pr-7');
    });
});
