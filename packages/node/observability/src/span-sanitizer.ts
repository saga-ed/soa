import { diag, type Attributes } from '@opentelemetry/api';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

/**
 * PII span sanitizer.
 *
 * The Node auto-instrumentations capture full request URLs / targets verbatim
 * (`http.url`, `http.target`, `url.full`, `url.path`, `url.query`). For a
 * student-facing platform those free-form attributes are the real PII vector:
 * an id or email embedded in a path (`/students/12345`) or query string
 * (`?email=a@b.com`) ships to Datadog unfiltered. This module strips that
 * data before export while preserving the *shape* (route template) that makes
 * the span useful for troubleshooting.
 *
 * DELIBERATELY NOT TOUCHED (operational data, kept by explicit decision):
 *   - `http.client_ip` and the geo enrichment (`client_ip_details.*`).
 *   - `http.route` (already a template like `/students/:id` — safe + high value).
 *
 * INTERCEPTION POINT — why a wrapping SpanExporter, not a SpanProcessor:
 * in OTel JS (sdk-trace-base 1.x) a `ReadableSpan` handed to
 * `SpanProcessor.onEnd` is treated as read-only; mutating `span.attributes`
 * there is unsupported and silently ineffective. The exporter receives the
 * same `ReadableSpan[]`, but here we own the boundary to the wire: although
 * `attributes` is declared `readonly`, the concrete SDK span impl backs it
 * with a mutable plain object, so we rewrite it in place and then delegate to
 * the real OTLP exporter. This is the robust, version-stable seam. (If a
 * future impl makes `attributes` truly read-only, the rewrite throws and is
 * caught per the degrade-safe contract below, with a throttled diag warning.)
 *
 * DEGRADE-SAFE CONTRACT (fleet blast radius): sanitization must NEVER throw and
 * NEVER drop a span. Any error while rewriting one span is swallowed and that
 * span is passed through unmodified — we fail OPEN (ship a span that may retain
 * a path) rather than closed (lose the telemetry entirely). The alternative —
 * an exception escaping into the BatchSpanProcessor's export loop — would take
 * down tracing for the whole service.
 */

// URL-ish attribute keys whose string values get path-segment sanitization.
// `url.query` is NOT here — a raw query string has no safe shape, so it is
// dropped outright (DROP_ATTR_KEYS) rather than rewritten. The two lists are
// disjoint by construction so the rewrite/drop split is structural, not a
// runtime special-case.
const URL_ATTR_KEYS = ['http.url', 'http.target', 'url.full', 'url.path'] as const;

/** Attribute keys removed outright (raw query string, never a safe shape). */
const DROP_ATTR_KEYS = ['url.query'] as const;

// Path segments that look like identifiers get replaced with `:id`. Covers
// numeric ids, UUIDs, long hex/base64 tokens, and email-shaped segments.
const NUMERIC_SEGMENT = /^\d+$/;
const UUID_SEGMENT =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_TOKEN_SEGMENT = /^[A-Za-z0-9_-]{20,}$/; // hex/base64-ish opaque ids
// Email-shaped segment: a literal `@` OR its percent-encoded form `%40`.
// Auto-instrumented `http.target`/`url.path` values are frequently
// percent-encoded, so matching only the literal `@` would leak encoded emails.
const EMAIL_SEGMENT = /@|%40/i;

// NO NPM-SCOPE EXEMPTION — deliberately, after three attempts.
//
// A scoped package (`@saga-ed/soa-observability`) is an `@`-bearing path
// segment, so the email rule redacts the scope to `:id`. An exemption for it
// was tried three times and each revision leaked a `/@handle` route one step to
// the side of the last: first when the rule required no dot, then for
// `/@bob/posts` under an `@scope/name` rule, and finally — after the exemption
// was gated on "does this token look like a code location" — for any request
// path containing the literal `node_modules/` or a `file://` prefix. That last
// attempt is the one that settles it: this text is ATTACKER-INFLUENCEABLE
// (routers echo the request path into the message), so any marker used to
// prove provenance can simply be included in the request. Shape cannot
// establish provenance.
//
// The cost is one token per frame: `/app/node_modules/@saga-ed/pkg/index.js`
// ships as `/app/node_modules/:id/pkg/index.js` — the package name, path, and
// filename all survive, so the frame stays diagnosable. Unscoped packages are
// untouched. That is a cheap price for closing a leak class that reopened
// three times.

// An id fused to a file extension ("12345.json") fails every anchored test
// below, because `.` sits outside their character classes. Test the stem
// separately so `/exports/98765.csv` redacts like `/exports/98765` — the
// extension is structure, the stem is the identifier.
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

function looksLikeIdentifier(segment: string): boolean {
    if (matchesIdentifierRule(segment)) {
        return true;
    }

    // Retry without a trailing extension, so an id fused to one still redacts.
    const stem = segment.replace(FILE_EXTENSION, '');
    return stem !== segment && stem !== '' && matchesIdentifierRule(stem);
}

function matchesIdentifierRule(segment: string): boolean {
    return (
        NUMERIC_SEGMENT.test(segment) ||
        UUID_SEGMENT.test(segment) ||
        EMAIL_SEGMENT.test(segment) ||
        LONG_TOKEN_SEGMENT.test(segment)
    );
}

/**
 * Longest message/stack scrubbed before truncation.
 *
 * Scrubbing runs synchronously on the Express error path, so its cost is
 * request-blocking and the input is attacker-influenceable (frameworks echo the
 * request path into the message). A hard cap makes the work bounded regardless
 * of regex behaviour on pathological input. 16 KiB comfortably holds a deep
 * Node stack; beyond that a marker is appended so truncation is never silent.
 */
const MAX_SCRUB_LENGTH = 16 * 1024;
const TRUNCATION_MARKER = '… [truncated by pii-sanitizer]';

/**
 * Free text is tokenized on whitespace rather than matched with one big
 * pattern. Earlier revisions accreted a `\bhttps?://` branch, a `(?<![\w/])`
 * lookbehind and a trailing-punctuation strip, and each addition left a gap a
 * step to the side of the last one: `file:///` frames (the normal shape in an
 * ESM service) matched no branch, and `baseUrl/students/12345` was skipped
 * because a word character preceded the slash. Splitting first means every
 * token is considered exactly once, whatever scheme or prefix it carries.
 */
const WHITESPACE_RUN = /(\s+)/;

// Punctuation that can wrap or follow a path in prose but never belongs to it.
// Stripped from both ends before sanitizing and restored after, so an id never
// stays fused to a bracket or sentence period.
const LEADING_PUNCTUATION = /^[('"[{<]+/;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'">]+$/;

// A token is path-shaped if it carries a scheme (`file:///…`, `https://…`,
// `prisma://…`) or contains a slash at all. Scheme-agnostic by design: matching
// a fixed list is what let `file://` through.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Anchored, so it is applied to a single token rather than scanned across free
 * text. Running a `g`-flagged email pattern over prose is what went quadratic:
 * on a long dotted run (`a.a.a.…`) with no `@` anywhere, the engine matches the
 * dotted labels, fails at `@`, then backtracks through every split point — and
 * repeats that from every start offset. Splitting the domain into dot-free
 * labels did not help, because the local part has the same shape.
 *
 * Tokens are already whitespace-delimited, and an email cannot contain
 * whitespace, so anchoring makes the work linear: each piece is examined once,
 * and only if it could hold an address at all. Anchoring alone would miss the
 * forms whitespace does not separate, so `redactEmails` splits a token on
 * `,`/`;` and `isBareEmail` retries without a `scheme:` prefix — both keep
 * every test anchored rather than reintroducing a scanning pattern.
 */
const EMAIL_LABEL = String.raw`[A-Za-z0-9_%+-]+`;
const BARE_EMAIL_TOKEN = new RegExp(
    String.raw`^${EMAIL_LABEL}(?:\.${EMAIL_LABEL})*@${EMAIL_LABEL}(?:\.${EMAIL_LABEL})*\.[A-Za-z]{2,}$`,
);

/**
 * Scrub PII out of free-form text (an exception message or stack trace).
 *
 * Unlike `sanitizeUrl`, which receives a whole attribute value, this works on
 * arbitrary prose: it sanitizes each path-shaped token in place and redacts
 * bare email addresses anywhere in the text.
 */
export function sanitizeText(text: string): string {
    // Scrub BEFORE truncating. Truncating first cuts the trailing context every
    // anchored rule needs — an email loses its TLD, a UUID its final group — so
    // the value stops matching and ships half-redacted. The cap then applies to
    // already-scrubbed text, bounding what is retained rather than what is
    // examined; the linear scanners above are what bound the work.
    const scrubbed = text.split(WHITESPACE_RUN).map(sanitizeToken).join('');

    return scrubbed.length > MAX_SCRUB_LENGTH
        ? scrubbed.slice(0, MAX_SCRUB_LENGTH) + TRUNCATION_MARKER
        : scrubbed;
}

function sanitizeToken(token: string): string {
    const lead = LEADING_PUNCTUATION.exec(token)?.[0] ?? '';
    const withoutLead = token.slice(lead.length);
    const trail = TRAILING_PUNCTUATION.exec(withoutLead)?.[0] ?? '';
    const core = trail ? withoutLead.slice(0, -trail.length) : withoutLead;

    if (core === '') {
        return token;
    }
    // ORDER MATTERS: path-shaped tokens go to `sanitizeUrl` FIRST. A URL can
    // carry an address in its authority (`http://alice@saga.org/p`), and
    // `sanitizeUrl` redacts just the credential while keeping the host — which
    // is operational data worth keeping. Running the email pass first would
    // match the whole `alice@saga.org` piece and destroy the host with it.
    if (isPathShaped(core)) {
        return lead + sanitizeUrl(core) + trail;
    }
    const emailRedacted = redactEmails(core);
    if (emailRedacted !== null) {
        return lead + emailRedacted + trail;
    }
    return token;
}

/**
 * Redact every address in an email-shaped token, or `null` if it holds none.
 *
 * Whitespace is not the only delimiter that packs an address into a larger
 * token, and enumerating the delimiters one at a time is what kept this leaking
 * — first `a@b.com;c@d.com` (a recipient list), then `email='a@b.com'` and
 * `to=a@b.com` (a driver echoing SQL or a query parameter into its message,
 * which is precisely the exception-message vector this package creates).
 *
 * So the split is defined by the COMPLEMENT of what an address can contain:
 * anything outside `EMAIL_LABEL` plus `@` and `.` is a delimiter. That is a
 * closed rule rather than a list to extend on the next report — a character
 * that cannot appear in an address cannot be hiding one.
 *
 * Each piece stays anchored, which is the property that makes the scan linear
 * (see `BARE_EMAIL_TOKEN`), and the separators are preserved by the capturing
 * split so a mixed token rejoins with its non-address text intact.
 */
function redactEmails(core: string): string | null {
    // `indexOf` first: the anchored tests only run on tokens that could
    // possibly hold an address, so prose never pays for them. NB: probe for
    // `%40` with a substring search, not `PERCENT_ENCODED_AT` — that regex is
    // `g`-flagged for the replace below, and a `g` regex carries `lastIndex`
    // across `.test()` calls.
    if (core.indexOf('@') === -1 && !core.toLowerCase().includes('%40')) {
        return null;
    }

    let redactedAny = false;
    const pieces = core.split(EMAIL_LIST_SEPARATOR).map((piece) => {
        // `%40` is the percent-encoded `@`. `EMAIL_SEGMENT` already treats the
        // two as equivalent for path segments; free text has to agree, or an
        // encoded address in prose survives while its literal form is redacted.
        const decoded = piece.replace(PERCENT_ENCODED_AT, '@');
        if (!isBareEmail(decoded)) {
            return piece;
        }
        redactedAny = true;
        return ':email';
    });

    return redactedAny ? pieces.join('') : null;
}

/**
 * Anchored email test, retried once without a URI scheme prefix.
 *
 * `mailto:a@b.com` is the shape that motivated the retry: the prefix breaks the
 * anchor so the address test fails, and it is not path-shaped either (no
 * slash), so the token was returned verbatim — an address shipped in the
 * clear. Stripping only a leading `scheme:` keeps each test anchored, which is
 * the property that makes the scan linear.
 */
function isBareEmail(piece: string): boolean {
    if (BARE_EMAIL_TOKEN.test(piece)) {
        return true;
    }
    const withoutScheme = piece.replace(URI_SCHEME_PREFIX, '');
    return withoutScheme !== piece && BARE_EMAIL_TOKEN.test(withoutScheme);
}

// Capturing, so `split` keeps the separators and the token rejoins verbatim.
// The class is the complement of the address alphabet (`EMAIL_LABEL` + `@.`),
// so it needs no extension when a new packing shape turns up.
const EMAIL_LIST_SEPARATOR = /([^A-Za-z0-9_%+\-@.]+)/;
const PERCENT_ENCODED_AT = /%40/gi;
// `mailto:`, `MAILTO:` — a scheme with no `//`, so HAS_SCHEME does not match it.
const URI_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Redact the userinfo component of an authority (`user:pw@host` → `:userinfo@host`).
 *
 * Everything before the `@` in an authority is a credential, and it was shipping
 * VERBATIM: `sanitizeUrl` split `scheme://host` off as an opaque prefix and only
 * ever rewrote the path, so nothing examined the authority. That leaked an
 * address on `http://alice@saga.org/p` and, worse, a password on a connection
 * string — `postgres://admin:s3cret@db.internal:5432/main` reached `http.url`
 * with the secret intact.
 *
 * The host is deliberately KEPT: it is the operational half of the attribute
 * (which service was called) and carries no user data. Only the credential is
 * replaced, and the last `@` is the delimiter — an unencoded `@` may appear
 * inside the userinfo itself.
 */
function redactUserinfo(authority: string): string {
    const at = authority.lastIndexOf('@');
    return at === -1 ? authority : ':userinfo' + authority.slice(at);
}

function isPathShaped(token: string): boolean {
    if (HAS_SCHEME.test(token)) return true;

    // A path must START at a slash (`/students/12345`) or contain one with a
    // non-numeric side (`baseUrl/students/12345`, `dist/main.js`). Treating any
    // slash as a path turns a ratio in prose — "rate limit 5/second" — into
    // `:id/second`, redacting text that was never an identifier.
    const slash = token.indexOf('/');
    if (slash === -1) return false;
    if (token.startsWith('/')) return token.length > 1;
    return !SIMPLE_RATIO.test(token);
}

// `5/second`, `1/2`, `3/10s` — a bare number over a short word or number. These
// are quantities in prose, not paths.
const SIMPLE_RATIO = /^\d+\/[A-Za-z0-9]*$/;

/**
 * Sanitize a URL/path string: drop the query string entirely and templatize
 * identifier-looking path segments. Works on absolute URLs and bare paths.
 * tRPC method names (`/trpc/auth.getProvidersByEmail`) are method *names*, not
 * data, and are NOT identifier-shaped → preserved.
 */
export function sanitizeUrl(value: string): string {
    // Split scheme://host from the path so we only rewrite the path portion.
    // `file:///app/x` has an empty host, so the host part must be optional —
    // requiring `[^/]+` here is what made ESM stack frames fall through.
    let prefix = '';
    let rest = value;

    const schemeMatch = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(\/.*)?$/i.exec(value);
    if (schemeMatch && schemeMatch[1] !== undefined) {
        prefix = schemeMatch[1] + redactUserinfo(schemeMatch[2] ?? '');
        rest = schemeMatch[3] ?? '';
    }

    // Drop query string + fragment.
    const queryIdx = rest.search(/[?#]/);
    if (queryIdx !== -1) rest = rest.slice(0, queryIdx);

    if (rest === '' || rest === '/') return prefix + rest;

    const sanitizedPath = rest
        .split('/')
        .map((seg) => (looksLikeIdentifier(seg) ? ':id' : seg))
        .join('/');

    return prefix + sanitizedPath;
}

// PER-ENTRY ISOLATION. The degrade-safe contract is per SPAN at the export
// loop, but that granularity is too coarse to hold the PII guarantee: a single
// non-writable key (a frozen attributes object, a getter-backed value) threw
// out of the shared loop and skipped EVERY REMAINING KEY on that span. The
// entries are independent, so one unwritable one must cost only itself.
//
// Isolating them must not make them SILENT, though: the first failure still has
// to reach the throttled sink, or a read-only-attributes regression disables
// sanitization fleet-wide with no signal. So the first error is captured and
// rethrown once the remaining entries have been processed — the caller's
// existing per-span catch reports it at its normal cadence, and later entries
// no longer pay for an earlier one.
function sanitizeAttributes(attributes: Attributes): void {
    let firstError: unknown;
    const record = (err: unknown) => {
        if (firstError === undefined) firstError = err;
    };

    for (const key of DROP_ATTR_KEYS) {
        try {
            if (key in attributes) delete attributes[key];
        } catch (err) {
            record(err);
        }
    }
    for (const key of URL_ATTR_KEYS) {
        try {
            const val = attributes[key];
            // Only string-valued URL attrs are rewritten; numeric/boolean/array
            // attribute values (e.g. http.status_code) are left untouched.
            if (typeof val === 'string') {
                attributes[key] = sanitizeUrl(val);
            }
        } catch (err) {
            record(err);
        }
    }

    if (firstError !== undefined) throw firstError;
}

// Free-text attributes on an `exception` span event. Scrubbing these at the
// exporter is what makes the guarantee hold fleet-wide: the auto-instrumentations
// record exceptions themselves (@opentelemetry/instrumentation-express calls
// recordException on the RAW error for every express.* layer span), so scrubbing
// only at our own call site would leave the verbatim value on a sibling span in
// the same trace. Applies to every span, however the event was produced.
const EXCEPTION_TEXT_ATTR_KEYS = [
    'exception.message',
    'exception.stacktrace',
] as const;

function sanitizeEvents(span: ReadableSpan): void {
    // `events` is non-optional on ReadableSpan, but this runs on the export hot
    // path against spans from any SDK version — a missing array must degrade to
    // "nothing to scrub", not throw and skip attribute sanitization too.
    if (!Array.isArray(span.events)) return;

    let firstError: unknown;
    for (const event of span.events) {
        if (!event.attributes) continue;
        for (const key of EXCEPTION_TEXT_ATTR_KEYS) {
            // Per-KEY, per-EVENT isolation — see `sanitizeAttributes`. A frozen
            // event[0] used to abort the loop and ship event[1]'s message
            // verbatim, which is the highest-PII payload on the span (the
            // instrumentations record it from the RAW error). The first error
            // is rethrown after the loop so the failure still reaches the sink.
            try {
                const val = event.attributes[key];
                if (typeof val === 'string') {
                    event.attributes[key] = sanitizeText(val);
                }
            } catch (err) {
                if (firstError === undefined) firstError = err;
            }
        }
    }

    if (firstError !== undefined) throw firstError;
}

// Detectability of a persistent sanitize failure must NOT depend on whether a
// service wired an OTel diag logger. The global `diag` defaults to a no-op with
// NO console fallback (verified against @opentelemetry/api), so a bare
// `diag.warn` here is silent on any service that didn't pass `initTracing` a
// logger or set OTEL_LOG_LEVEL — which would re-open the exact silent-swallow
// this warning exists to close. So we ALSO emit through `diag` (when a logger
// IS configured the warning lands in the service log stream) AND through a
// self-contained sink that always reaches somewhere. The sink is injectable so
// it can be spied/silenced in tests.
type WarnSink = (message: string, err: unknown) => void;

const defaultWarnSink: WarnSink = (message, err) => {
    // diag.warn is a no-op when no diag logger is registered, so it can't be
    // the sole channel; console.warn is the unconditional floor.
    diag.warn(message, err);
    // eslint-disable-next-line no-console
    console.warn(message, err);
};

let warnSink: WarnSink = defaultWarnSink;

/** Override the failure-warning sink (test seam). */
export function setSanitizerWarnSink(sink: WarnSink): void {
    warnSink = sink;
}

/** Restore the default failure-warning sink + reset every throttle (test seam). */
export function resetSanitizerWarnSink(): void {
    warnSink = defaultWarnSink;
    for (const channel of Object.keys(failureCounts) as WarnChannel[]) {
        failureCounts[channel] = 0;
    }
}

// `export()` is a hot path, so a persistent sanitize failure (e.g. a future
// SDK making `span.attributes` read-only → every assignment throws) must not
// flood the log stream. Warn on the FIRST failure (count 0) then at most once
// per this many swallowed errors, so a regression is DETECTABLE immediately
// without becoming a log storm. NOTE: count-based, so cadence scales with span
// volume — acceptable here because the first occurrence always fires.
const SANITIZE_WARN_EVERY = 1000;

/**
 * Independent failure sources. Counters are PER CHANNEL: sharing one would let
 * a high-volume failure (attribute rewrite, at span-export rate) advance the
 * count past the point where an unrelated first failure in another channel
 * lands on a multiple of the throttle — silently swallowing the one warning
 * that was supposed to be guaranteed. "First occurrence always fires" is only
 * true if each source counts its own.
 */
type WarnChannel =
    | 'attributes'
    | 'events'
    | 'record-exception'
    | 'inner-export';

const failureCounts: Record<WarnChannel, number> = {
    attributes: 0,
    events: 0,
    'record-exception': 0,
    'inner-export': 0,
};

/**
 * Report a swallowed sanitize/telemetry failure through the throttled sink.
 *
 * Shared so every degrade-safe catch in this package stays detectable through
 * one sink, while each channel keeps its own throttle.
 */
export function warnSanitizeFailure(
    channel: WarnChannel,
    message: string,
    err: unknown,
): void {
    if (failureCounts[channel]++ % SANITIZE_WARN_EVERY === 0) {
        warnSink(message, err);
    }
}

/**
 * Wraps a SpanExporter, sanitizing PII out of span attributes before delegating
 * to the inner exporter. See module doc for the degrade-safe contract.
 */
export class PiiSanitizingSpanExporter implements SpanExporter {
    constructor(private readonly inner: SpanExporter) {}

    export(
        spans: ReadableSpan[],
        resultCallback: (result: ExportResult) => void,
    ): void {
        // Attributes and events are sanitized under SEPARATE try blocks. Sharing
        // one meant a throw in the attribute rewrite (which the class doc
        // anticipates, if a future SDK makes `attributes` truly read-only)
        // skipped event scrubbing entirely — and the exception event is the
        // higher-PII payload, since instrumentations record it from the RAW
        // error. Each failure must degrade only its own half.
        for (const span of spans) {
            try {
                // `span.attributes` is declared `readonly` on ReadableSpan, but
                // the concrete SDK span impl backs it with a mutable plain
                // object, so in-place rewrite works. If a future impl makes it
                // truly read-only the assignment throws → caught below.
                sanitizeAttributes(span.attributes);
            } catch (err) {
                // Fail OPEN: leave this span untouched rather than dropping it
                // or aborting the whole batch. Never rethrow. But surface a
                // persistent failure (throttled) — a silent swallow would let a
                // read-only-attributes regression disable PII sanitization
                // fleet-wide with no signal.
                warnSanitizeFailure(
                    'attributes',
                    '[pii-sanitizer] span attribute sanitization failed; shipping span unmodified',
                    err,
                );
            }

            try {
                sanitizeEvents(span);
            } catch (err) {
                warnSanitizeFailure(
                    'events',
                    '[pii-sanitizer] span event sanitization failed; shipping events unmodified',
                    err,
                );
            }
        }
        // A synchronous throw out of the inner exporter must still produce a
        // RESULT. `BatchSpanProcessor` wraps this call in a promise that only
        // settles via `resultCallback`, so letting the throw escape leaves that
        // promise pending forever: the batch is never retried, never dropped,
        // and the processor's in-flight-export guard blocks every subsequent
        // flush — tracing stops for the life of the process. Reporting a failed
        // result instead keeps the wrapper transparent, since a well-behaved
        // exporter signals failure exactly this way.
        try {
            this.inner.export(spans, resultCallback);
        } catch (err) {
            warnSanitizeFailure(
                'inner-export',
                '[pii-sanitizer] inner exporter threw synchronously; reporting export failure',
                err,
            );
            resultCallback({
                code: ExportResultCode.FAILED,
                error: err instanceof Error ? err : new Error(String(err)),
            });
        }
    }

    shutdown(): Promise<void> {
        return this.inner.shutdown();
    }

    forceFlush(): Promise<void> {
        return this.inner.forceFlush?.() ?? Promise.resolve();
    }
}
