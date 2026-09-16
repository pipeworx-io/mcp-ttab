interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * TTAB (Trademark Trial and Appeal Board) MCP — TTABVUE inquiry system
 *
 * Trademark DISPUTES: oppositions, cancellations, extensions of time to
 * oppose, and ex parte appeals before the USPTO's Trademark Trial and Appeal
 * Board. Complements the `trademarks` pack (mark-text clearance) with the
 * adversarial layer — who is fighting whom over which mark.
 *
 * Source: https://ttabvue.uspto.gov/ttabvue/ — a server-rendered Java app
 * (v2.8.0), keyless, no bot wall, HTML only. There is no JSON API.
 *
 * Query surface (advanced search, `v?qt=adv&...`), all confirmed live:
 *   procstatus  Pending | Terminated | All
 *   pno         8-digit board proceeding number (91xxxxxx opposition,
 *               92xxxxxx cancellation) — OR an application serial number for
 *               EXT / EXA entries, which share the serial-number space
 *   propno      application / registration number
 *   qs          all these words anywhere in the record
 *   propname    mark text            (propnameop: '' contains | beg | mat)
 *   pn          party name           (pop:        '' contains | beg | mat)
 *   pn2         other party name     (pop2:       same)
 *   cn          correspondent        (cop:        same)
 *   page        1-based, 25 rows per page
 *
 * Gotchas the HTML will not tell you:
 * - An unknown proceeding number returns HTTP 200 with an EMPTY record page,
 *   not a 404. Detect the empty `Number:` field, never trust the status code.
 * - Result counts saturate at the literal string "100+" — it is not a number.
 * - EXT (extension of time to oppose) and EXA (ex parte appeal) are keyed by
 *   APPLICATION SERIAL NUMBER, so one number can name two different records.
 *   `pty` disambiguates; omitting it lets TTABVUE pick.
 * - One party can appear under several spellings ("Nike, Inc." vs "NIKE INC")
 *   because names are stored exactly as filed. Party strings are returned raw.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'TTAB');
}

const BASE = 'https://ttabvue.uspto.gov/ttabvue/v';
/** TTABVUE returns 25 result rows per page. */
const PAGE_SIZE = 25;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** TTABVUE's proceeding-type codes, spelled out. */
const PROCEEDING_TYPES: Record<string, string> = {
  OPP: 'opposition',
  CAN: 'cancellation',
  EXT: 'extension of time to oppose',
  EXA: 'ex parte appeal',
  COU: 'concurrent use',
};

/** The detail page prints a heading rather than the code — map it back. */
const HEADING_CODES: Record<string, string> = {
  opposition: 'OPP',
  cancellation: 'CAN',
  'extension of time': 'EXT',
  'exparte appeal': 'EXA',
  'ex parte appeal': 'EXA',
  'concurrent use': 'COU',
};

// ── HTML helpers ─────────────────────────────────────────────────────

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/ /g, ' ');
}

function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Value of a `<th>Label:</th><td>value</td>` pair. */
function labelled(html: string, label: string): string | null {
  const re = new RegExp(`<th[^>]*>\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`);
  const m = html.match(re);
  const v = m ? text(m[1]) : '';
  return v === '' ? null : v;
}

async function fetchPage(params: Record<string, string>): Promise<string> {
  const qs = new URLSearchParams(params).toString();
  const res = await pwFetch(`${BASE}?${qs}`, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`TTABVUE returned HTTP ${res.status} for ${qs}`);
  return await res.text();
}

// ── Search-result parsing ────────────────────────────────────────────

interface Property {
  mark: string;
  serial_number: string | null;
  registration_number: string | null;
}

interface PartyRef {
  name: string;
  properties: Property[];
}

/**
 * Parse one search-result party cell. Each cell holds one or more parties,
 * each followed by its marks; a mark carries a serial number and, once
 * registered, a registration number.
 */
function parsePartyCell(cell: string): PartyRef[] {
  const nameRe = /<a href="v\?pnam=[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const names: string[] = [];
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(cell)) !== null) {
    names.push(text(m[1]));
    starts.push(m.index + m[0].length);
  }
  return names.map((name, i) => {
    const chunk = cell.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : cell.length);
    const properties: Property[] = [];
    const markRe =
      /<span class="t3">Mark:<\/span>\s*<span class="p1">([\s\S]*?)<\/span>([\s\S]*?)(?=<span class="t3">Mark:<\/span>|$)/g;
    let mm: RegExpExecArray | null;
    while ((mm = markRe.exec(chunk)) !== null) {
      const rest = mm[2];
      const serial = rest.match(/caseNumber=(\d+)&amp;caseType=SERIAL_NO/);
      const reg = rest.match(/caseNumber=(\d+)&amp;caseType=US_REGISTRATION_NO/);
      properties.push({
        mark: text(mm[1]),
        serial_number: serial ? serial[1] : null,
        registration_number: reg ? reg[1] : null,
      });
    }
    return { name, properties };
  });
}

interface SearchRow {
  proceeding_number: string;
  type_code: string;
  type: string;
  filing_date: string | null;
  defendants: PartyRef[];
  plaintiffs: PartyRef[];
  url: string;
}

function parseSearchResults(
  html: string,
  currentPage = 1,
): { rows: SearchRow[]; result_count: string | null; pages_available: number } {
  const countM = html.match(/Number of results:\s*<\/span>\s*<span class="p1">([^<]*)<\/span>/);
  const result_count = countM ? countM[1].trim() : null;

  // Page links are HTML-escaped (`&amp;page=2`), so key on `page=` alone. They
  // only ever point at OTHER pages, so on page 2 of 2 the highest link is 1 —
  // floor the answer at the page we are actually on, and prefer the arithmetic
  // when the count is a real number rather than the saturated "100+".
  const pageNums = [...html.matchAll(/href="v\?[^"]*page=(\d+)"/g)].map((p) => Number(p[1]));
  const total = result_count && /^\d+$/.test(result_count) ? Number(result_count) : null;
  const pages_available = total
    ? Math.max(Math.ceil(total / PAGE_SIZE), currentPage)
    : Math.max(currentPage, ...pageNums, 1);

  // Every result row is exactly three top-level `<td class="p1">` cells:
  // proceeding, defendant(s), plaintiff(s). Nested layout tables use bare
  // `<td>`, so this split never straddles a row.
  const cells = html.split('<td class="p1">').slice(1);
  const rows: SearchRow[] = [];
  for (let i = 0; i + 2 < cells.length; i += 3) {
    const head = cells[i].match(/<a href="v\?pno=(\d+)&amp;pty=([A-Z]+)"[^>]*>\d+<\/a><br>([\d/]*)/);
    if (!head) continue;
    const code = head[2];
    rows.push({
      proceeding_number: head[1],
      type_code: code,
      type: PROCEEDING_TYPES[code] ?? code,
      filing_date: head[3] || null,
      defendants: parsePartyCell(cells[i + 1]),
      plaintiffs: parsePartyCell(cells[i + 2]),
      url: `${BASE}?pno=${head[1]}&pty=${code}`,
    });
  }
  return { rows, result_count, pages_available };
}

// ── Tools ────────────────────────────────────────────────────────────

const MATCH_MODES: Record<string, string> = { contains: '', starts_with: 'beg', exact: 'mat' };

function searchParams(args: Record<string, unknown>): Record<string, string> {
  const mode = MATCH_MODES[(args.match_mode as string) ?? 'contains'] ?? '';
  const status = ((args.status as string) ?? 'all').toLowerCase();
  const params: Record<string, string> = {
    qt: 'adv',
    procstatus: status === 'pending' ? 'Pending' : status === 'terminated' ? 'Terminated' : 'All',
    // Sending `qs` — even empty — is what puts results in reverse
    // chronological order. Omit it and the same query comes back sorted
    // ascending by proceeding number, so "recent" reads as 1990s appeals.
    // Measured 2026-08-30 against pn=Nike, Inc.: with `qs=` the first row is
    // 92092660 (filed 08/27/2026); without it, 74000757 (an EXA from 1990).
    qs: String(args.query ?? ''),
  };
  if (args.party) {
    params.pop = mode;
    params.pn = String(args.party);
  }
  if (args.other_party) {
    params.pop2 = mode;
    params.pn2 = String(args.other_party);
  }
  if (args.mark) {
    params.propnameop = mode;
    params.propname = String(args.mark);
  }
  if (args.correspondent) {
    params.cop = mode;
    params.cn = String(args.correspondent);
  }
  if (args.serial_or_registration_number) params.propno = String(args.serial_or_registration_number);
  const page = Number(args.page ?? 1);
  if (page > 1) params.page = String(page);
  return params;
}

async function ttabSearch(args: Record<string, unknown>) {
  const criteria = ['party', 'other_party', 'mark', 'correspondent', 'serial_or_registration_number', 'query'];
  if (!criteria.some((k) => args[k])) {
    return {
      found: false,
      reason: 'no_criteria',
      hint: 'Pass at least one of: party, other_party, mark, correspondent, serial_or_registration_number, query.',
    };
  }
  const params = searchParams(args);
  const html = await fetchPage(params);
  const { rows, result_count, pages_available } = parseSearchResults(html, Number(args.page ?? 1));
  const limit = Math.min(Number(args.limit ?? 25), 25);
  const kept = rows.slice(0, limit);

  if (!kept.length) {
    return {
      found: false,
      reason: 'no_proceedings',
      result_count: result_count ?? '0',
      hint: 'TTABVUE matches party and mark text as filed. Try a shorter or differently spelled string ("Nike" rather than "Nike, Inc."), or set match_mode to "contains".',
      query: params,
    };
  }

  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.type] = (byType[r.type] ?? 0) + 1;

  return {
    found: true,
    result_count,
    result_count_note:
      result_count === '100+' ? 'TTABVUE caps its reported total at "100+" — page through for more.' : undefined,
    page: Number(args.page ?? 1),
    pages_available,
    returned: kept.length,
    types_on_this_page: byType,
    proceedings: kept,
    source: 'USPTO TTABVUE (Trademark Trial and Appeal Board Inquiry System)',
  };
}

async function ttabProceeding(args: Record<string, unknown>) {
  const pno = String(args.proceeding_number ?? '').replace(/\D/g, '');
  if (!pno) {
    return {
      found: false,
      reason: 'missing_proceeding_number',
      hint: 'Pass proceeding_number, e.g. 91308065 (opposition) or 92092660 (cancellation).',
    };
  }
  const params: Record<string, string> = { pno };
  if (args.type) params.pty = String(args.type).toUpperCase();
  const html = await fetchPage(params);

  const number = labelled(html, 'Number:');
  if (!number) {
    return {
      found: false,
      reason: 'proceeding_not_found',
      proceeding_number: pno,
      hint: args.type
        ? `TTABVUE has no ${String(args.type).toUpperCase()} record for ${pno}. Extensions of time (EXT) and ex parte appeals (EXA) are keyed by application serial number, so the same number can exist under a different type — retry without "type", or use ttab_search.`
        : `TTABVUE has no record for ${pno}. Board proceeding numbers are 8 digits starting 91 (opposition) or 92 (cancellation); find one with ttab_search.`,
    };
  }

  const typeName = (html.match(/<h2 class="t1">([^<]*)<\/h2>/)?.[1] ?? '').trim();

  const parties: Array<{
    role: string;
    name: string;
    correspondence: string | null;
    granted_to_date?: string | null;
    properties: Property[];
  }> = [];
  // Role labels vary by proceeding type: oppositions and cancellations say
  // Defendant/Plaintiff, but an extension of time says "Potential Opposer" and
  // an ex parte appeal carries only one side. Take whatever label is there.
  const blocks = html.split(/<td class="t2b"[^>]*>([^<]{1,40})<\/td>/);
  for (let i = 1; i + 1 < blocks.length; i += 2) {
    const role = blocks[i];
    const blk = blocks[i + 1];
    const nameM = blk.match(/<a href="v\?pnam=[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!nameM) continue; // not a party block
    const corrM = blk.match(/<th[^>]*>Correspondence:<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
    const properties: Property[] = [];
    for (const chunk of blk.split(/<th[^>]*>Serial #:<\/th>/).slice(1)) {
      const serial = chunk.match(/caseNumber=(\d+)&amp;caseType=SERIAL_NO/);
      const reg = chunk.match(/caseNumber=(\d+)&amp;caseType=US_REGISTRATION_NO/);
      properties.push({
        mark: labelled(chunk, 'Mark:') ?? '',
        serial_number: serial ? serial[1] : null,
        registration_number: reg ? reg[1] : null,
      });
    }
    parties.push({
      role: role.trim().toLowerCase(),
      name: text(nameM[1]),
      correspondence: corrM ? text(corrM[1]) : null,
      // Only extensions of time carry this — how long the potential opposer
      // has to decide whether to oppose.
      granted_to_date: labelled(blk, 'Granted&nbsp;To&nbsp;Date:') ?? undefined,
      properties,
    });
  }

  const history: Array<{ entry: string; date: string; text: string; due_date: string | null }> = [];
  const phStart = html.indexOf('Prosecution History');
  if (phStart !== -1) {
    const ph = html.slice(phStart, html.indexOf('</table>', phStart));
    for (const row of ph.matchAll(/<tr>\s*((?:<td class="p1">[\s\S]*?<\/td>\s*)+)<\/tr>/g)) {
      const tds = [...row[1].matchAll(/<td class="p1">([\s\S]*?)<\/td>/g)].map((t) => text(t[1]));
      if (tds.length >= 3) {
        history.push({ entry: tds[0], date: tds[1], text: tds[2], due_date: tds[3] || null });
      }
    }
  }

  const code = HEADING_CODES[typeName.toLowerCase()] ?? (params.pty ?? '').toUpperCase() ?? '';
  return {
    found: true,
    proceeding_number: number,
    type: PROCEEDING_TYPES[code] ?? typeName.toLowerCase() ?? null,
    type_code: code || null,
    type_heading: typeName || null,
    filing_date: labelled(html, 'Filing Date:'),
    status: labelled(html, 'Status:'),
    status_date: labelled(html, 'Status Date:'),
    interlocutory_attorney: labelled(html, 'Interlocutory Attorney:'),
    paralegal: labelled(html, 'Paralegal Name:'),
    parties,
    prosecution_history: history,
    prosecution_history_count: history.length,
    url: `${BASE}?pno=${pno}${params.pty ? `&pty=${params.pty}` : ''}`,
    source: 'USPTO TTABVUE (Trademark Trial and Appeal Board Inquiry System)',
  };
}

async function ttabPartyHistory(args: Record<string, unknown>) {
  const party = String(args.party ?? '').trim();
  if (!party) {
    return { found: false, reason: 'missing_party', hint: 'Pass party, e.g. "Monster Energy Company".' };
  }
  const maxPages = Math.min(Math.max(Number(args.max_pages ?? 2), 1), 5);
  const status = ((args.status as string) ?? 'all').toLowerCase();

  const all: SearchRow[] = [];
  let result_count: string | null = null;
  let pages_available = 1;
  let pagesFetched = 0;
  for (let page = 1; page <= maxPages; page++) {
    const params = searchParams({ party, status, match_mode: args.match_mode, page });
    const html = await fetchPage(params);
    const parsed = parseSearchResults(html, page);
    if (page === 1) {
      result_count = parsed.result_count;
      pages_available = parsed.pages_available;
    }
    pagesFetched = page;
    if (!parsed.rows.length) break;
    all.push(...parsed.rows);
    if (page >= parsed.pages_available) break;
  }

  if (!all.length) {
    return {
      found: false,
      reason: 'no_proceedings',
      party,
      hint: 'TTABVUE stores party names exactly as filed and one company often appears under several spellings. Try a distinctive word only ("Monster Energy" rather than "Monster Energy Company, Inc.").',
    };
  }

  const norm = party.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const matches = (p: PartyRef) =>
    p.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').includes(norm);

  let asPlaintiff = 0;
  let asDefendant = 0;
  const byType: Record<string, number> = {};
  const nameSpellings: Record<string, number> = {};
  for (const r of all) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
    for (const p of r.plaintiffs) if (matches(p)) { asPlaintiff++; nameSpellings[p.name] = (nameSpellings[p.name] ?? 0) + 1; }
    for (const p of r.defendants) if (matches(p)) { asDefendant++; nameSpellings[p.name] = (nameSpellings[p.name] ?? 0) + 1; }
  }

  return {
    found: true,
    party,
    result_count,
    result_count_note:
      result_count === '100+'
        ? 'TTABVUE caps its reported total at "100+"; the counts below cover only the pages read.'
        : undefined,
    pages_read: pagesFetched,
    pages_available,
    proceedings_read: all.length,
    as_plaintiff: asPlaintiff,
    as_defendant: asDefendant,
    by_type: byType,
    name_spellings: nameSpellings,
    proceedings: all.slice(0, Math.min(Number(args.limit ?? 50), 125)),
    source: 'USPTO TTABVUE (Trademark Trial and Appeal Board Inquiry System)',
  };
}

// ── Tool definitions ─────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'ttab_search',
    description:
      'Searches USPTO Trademark Trial and Appeal Board (TTAB) proceedings — trademark oppositions, cancellation petitions, extensions of time to oppose, and ex parte appeals — by party name, mark text, correspondent law firm, or application/registration number. Answers "is anyone opposing this trademark", "who has petitioned to cancel this registration", "which brands does this company fight", "what TTAB disputes involve this mark". Each result carries the board proceeding number, proceeding type (opposition, cancellation, extension of time, ex parte appeal), filing date, and both sides — defendant and plaintiff, each with their marks and serial/registration numbers. Sourced live from USPTO TTABVUE.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        party: { type: 'string', description: 'Party name as filed, e.g. "Nike, Inc." or just "Nike". Matches either side of the proceeding.' },
        other_party: { type: 'string', description: 'Second party name — use with `party` to find proceedings between two specific companies.' },
        mark: { type: 'string', description: 'Trademark text being fought over, e.g. "JUST DO IT".' },
        correspondent: { type: 'string', description: 'Correspondent (law firm or attorney of record) name.' },
        serial_or_registration_number: { type: 'string', description: 'Application serial number, registration number, or expungement/reexamination number the proceeding is about.' },
        query: { type: 'string', description: 'All these words anywhere in the record — proceeding number, application/registration number, parties, or marks.' },
        status: { type: 'string', enum: ['all', 'pending', 'terminated'], description: 'Proceeding status filter. Default all.' },
        match_mode: { type: 'string', enum: ['contains', 'starts_with', 'exact'], description: 'How party/mark/correspondent text is matched. Default contains.' },
        page: { type: 'number', description: '1-based page; TTABVUE returns 25 proceedings per page, newest first.' },
        limit: { type: 'number', description: 'Max proceedings to return from the page, 1-25. Default 25.' },
      },
    },
  },
  {
    name: 'ttab_proceeding',
    description:
      'Returns one USPTO TTAB proceeding in full: its type (opposition, cancellation, extension of time to oppose, ex parte appeal), status and status date, filing date, interlocutory attorney and paralegal, both parties with their correspondence addresses and every pleaded mark (serial number, registration number, application status), and the complete prosecution history — every docket entry with its date, text, and any due date. Answers "what happened in TTAB proceeding 91308065", "is this opposition still pending", "what is the answer deadline", "which marks were pleaded". Sourced live from USPTO TTABVUE.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        proceeding_number: { type: 'string', description: '8-digit board proceeding number (91xxxxxx opposition, 92xxxxxx cancellation), or the application serial number for an extension of time / ex parte appeal.' },
        type: { type: 'string', enum: ['OPP', 'CAN', 'EXT', 'EXA', 'COU'], description: 'Proceeding type. Only needed to disambiguate an extension of time (EXT) from an ex parte appeal (EXA), which share the application serial-number space.' },
      },
      required: ['proceeding_number'],
    },
  },
  {
    name: 'ttab_party_history',
    description:
      'Profiles one company or person across USPTO TTAB proceedings: how many times they appear as plaintiff (the one opposing or petitioning to cancel) versus defendant (the one being opposed), a breakdown by proceeding type, every name spelling they have been filed under, and the proceedings themselves. Answers "how often does this company oppose other trademarks", "is this brand an aggressive TTAB litigant", "who has this company been in TTAB disputes with". Reads several result pages. Sourced live from USPTO TTABVUE.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        party: { type: 'string', description: 'Party name as filed, e.g. "Monster Energy Company". A distinctive word matches more reliably than a full legal name.' },
        status: { type: 'string', enum: ['all', 'pending', 'terminated'], description: 'Proceeding status filter. Default all.' },
        match_mode: { type: 'string', enum: ['contains', 'starts_with', 'exact'], description: 'How the party name is matched. Default contains.' },
        max_pages: { type: 'number', description: 'How many 25-row pages to read, 1-5. Default 2.' },
        limit: { type: 'number', description: 'Max proceedings to return in the list, up to 125. Default 50.' },
      },
      required: ['party'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ttab_search':
      return ttabSearch(args);
    case 'ttab_proceeding':
      return ttabProceeding(args);
    case 'ttab_party_history':
      return ttabPartyHistory(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
