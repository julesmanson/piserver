/*
 * clientside-logging.js (part of PiServer Beta 0.1.0 mockproject)
 * Can be used with any HTTP server.
 * Plug-n-Play: drop into any project folder and it's ready to go.
 * Minimal fuss - for other servers only need to match route to server's endpoint.
 * Maximum flexibility - many options as defaults.
 * Autostarts on import, no dependencies.
 */
/*
 * EVENT REFERENCE RECOMMENDATIONS FOR MOST COMMON LOGGING NEEDS
 * ✅ = include   ⚠️ = optional   ❌ = exclude
 *
 * PREVENTABLE — Uncaught Errors (robust coding eliminates these)
 * ✅ TypeError              — null/undefined access, calling a non-function, type mismatches. Most common JS error.
 * ✅ ReferenceError         — undefined variable or accessed before initialization.
 * ✅ unhandledrejection     — Promise rejected with no .catch() or try/await to handle it.
 * ✅ RangeError             — invalid array length, out-of-range argument, infinite recursion.
 * ✅ SyntaxError            — malformed code at runtime, almost always through eval().
 * ✅ AggregateError         — Promise.any() with all promises rejecting and no fallback.
 * ⚠️ URIError               — malformed string in encodeURIComponent/decodeURIComponent. Rare.
 * ❌ EvalError              — eval() misuse. Extremely rare in modern JS; eval() itself is discouraged.
 *
 * STOCHASTIC — Outside Your Control
 * ✅ network                — resource load failure (img, script, link) from dropped connection or CDN outage.
 * ✅ securitypolicyviolation — CSP blocked a resource, often from browser extensions or third-party scripts.
 * ⚠️ messageerror           — Worker/BroadcastChannel deserialization failure. Only relevant if using Workers.
 * ❌ rejectionhandled       — late handler added to an already-flagged rejected Promise. Edge case, noisy.
 * ❌ InternalError          — Firefox-only, non-standard. JS engine failure, usually from deep recursion.
 */
// Not coded for messageerror, rejectionhandled, or InternalError events.

// ---------------------------------------------------------------------------
// Config — one entry in array per log file.
// keyword:       required for multiple files, must be unique, routes logEvent() calls.
// relative_path: omit, use "", or leave empty → defaults to server webroot.
// heading:       first line written to a new file. Omit or leave empty to skip.
// events:        omit, use [], or leave empty → catches all event types.
// events not coded in: messageerror, rejectionhandled, InternalError.
// ---------------------------------------------------------------------------
export const config_events = [
    {
        keyword:       "UNCAUGHTEVENTS",
        filename:      "UNCAUGHTEVENTS.LOG",
        relative_path: "mockproject/assets/logs",
        heading:       "UNCAUGHTEVENTS.LOG — uncaught JavaScript errors caught by window event listeners",
        events: [
            "TypeError", "ReferenceError", "unhandledrejection",
            "RangeError", "SyntaxError", "AggregateError", "URIError"
        ]
    },
    {
        keyword:       "STOCHASTICEVENTS",
        filename:      "STOCHASTICEVENTS.TXT",
        relative_path: "mockproject/assets/logs",
        heading:       "STOCHASTICEVENTS.TXT — stochastic errors outside application control",
        events: [
            "network", "securitypolicyviolation"
        ]
    }
];

// ---------------------------------------------------------------------------
// Config — timestamp.
// Uses the native Temporal API (system timezone — no zone config needed).
// Any key with an unrecognized value or wrong primitive type falls back to
// Temporal log format (2026-08-15 19:08:50). If Temporal is unavailable,
// falls back to a raw ISO string. Omitting all keys still produces a minimal
// log-format timestamp — nothing here is required for the logger to function.
//
// label:     how the timezone appears in output.
//   "city"        → Los Angeles
//   "shortGeneric"→ PT                   (generic, no DST distinction)
//   "short"       → PDT / PST            (switches with daylight saving)
//   "longGeneric" → Pacific Time
//   "long"        → Pacific Daylight Time / Pacific Standard Time
//   "shortOffset" → GMT-7
//   "longOffset"  → GMT-07:00
//
// miltime:   true = 24-hour, anything else = 12-hour.
// locale:    BCP 47 tag e.g. "en-US". Must be a string or falls back to log format.
// extension: polyfill fallback if the native Temporal API is unavailable, or drop in
//            any module exporting getTimestamp() for fully custom timestamp formatting.
//            Set to "" to use the built-in Temporal formats above.
// ---------------------------------------------------------------------------
export const config_timestamp = {
    locale:    "en-US",
    miltime:   true,
    label:     "city",
    extension: "./temporal-extension.js"
};

// ---------------------------------------------------------------------------
// Config — must match the log route or endpoint defined in your server's config.
//
// route: "/log" works when this project is served by PiServer (same origin).
//        Use a full URL if the project is served by a different server or port,
//        or opened directly as a local file:  "http://localhost:8000/log"
//        The project files can live anywhere — only the route needs to point to PiServer's endpoint.
// ---------------------------------------------------------------------------
export const config_server = {
    route: "/log",
    token: ""
};

// ---------------------------------------------------------------------------
// Load extension — delegates timestamp formatting if present.
// Falls back to built-in Temporal formats, then raw ISO string.
// ---------------------------------------------------------------------------
let _getTimestamp = null;
if (config_timestamp.extension) {
    try {
        const m = await import(config_timestamp.extension);
        _getTimestamp = m.getTimestamp;
    } catch (_) {}
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------
const _registry = new Map();   // keyword -> normalized config entry
const _eventMap = new Map();   // errorType -> normalized config entry, "*" = catch-all
let _initialized = false;

function _timestamp() {
    if (_getTimestamp) {
        try { return _getTimestamp(); } catch (_) {}
    }
    try {
        const { locale, miltime, label } = config_timestamp;
        const knownLabels = ["city", "shortGeneric", "short", "longGeneric", "long", "shortOffset", "longOffset"];
        const zdt = Temporal.Now.zonedDateTimeISO();

        // any bad key → log format: 2026-08-15 19:08:50
        if (typeof locale !== "string" || typeof label !== "string" || !knownLabels.includes(label))
            return zdt.toPlainDate().toString() + " " + zdt.toPlainTime().toString().slice(0, 8);

        const tz  = zdt.timeZoneId;
        const now = new Date();
        const logFmt = () => zdt.toPlainDate().toString() + " " + zdt.toPlainTime().toString().slice(0, 8);
        try {
            const date = zdt.toPlainDate().toLocaleString(locale, { dateStyle: "long" });
            const time = zdt.toPlainTime().toLocaleString(locale, {
                hour: miltime === true ? "2-digit" : "numeric", minute: "2-digit", second: "2-digit",
                hour12: miltime !== true
            });
            const tzLabel = label === "city"
                ? tz.split("/").pop().replace(/_/g, " ")
                : new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: label, hour: "numeric" })
                    .formatToParts(now).find(p => p.type === "timeZoneName")?.value ?? "";
            return `${date} ${time} ${tzLabel}`;
        } catch (_) { return logFmt(); }  // bad locale string or other formatting error → log format
    } catch (_) {}
    return new Date().toISOString();
}

function _normalize(cfg) {
    const rp = cfg.relative_path;
    const ev = cfg.events;
    return {
        ...cfg,
        relative_path: (rp && rp.trim() !== "") ? rp : "",
        heading:       cfg.heading || "",
        events:        Array.isArray(ev) && ev.length > 0 ? ev : []
    };
}

function _post(payload) {
    try {
        const headers = { "Content-Type": "application/json" };
        if (config_server.token) headers["Authorization"] = `Bearer ${config_server.token}`;
        fetch(config_server.route, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        });
    } catch (_) {}
}

function _format(message, source, lineno, colno, stack) {
    const ts    = _timestamp();
    const trace = stack ? `\nstack     : ${String(stack).replace(/\n/g, "\n            ")}` : "";
    return `timestamp : ${ts}\nsource    : ${source || "unknown"}\nline      : ${lineno || 0}\ncol       : ${colno || 0}\nmessage   : ${message}${trace}`;
}

function _route(errorType) {
    return _eventMap.get(errorType) ?? _eventMap.get("*") ?? config_events[0];
}

function _write(content, cfg) {
    _post({ filename: cfg.filename, relative_path: cfg.relative_path, content: content + "\n" });
}

async function _initHeader(cfg) {
    const heading = cfg.heading || "";
    if (!heading) return;
    try {
        const params = new URLSearchParams({ filename: cfg.filename, relative_path: cfg.relative_path });
        const res = await fetch(`${config_server.route}?${params}`);
        if (res.ok) return; // file already exists — skip header
    } catch (_) {}
    _write(heading, cfg);
}

function _attachListeners() {
    // Uncaught JS errors — TypeError, ReferenceError, RangeError, SyntaxError, URIError, etc.
    window.addEventListener("error", (evt) => {
        if (evt.error) {
            const content = _format(evt.message, evt.filename, evt.lineno, evt.colno, evt.error.stack);
            _write(content, _route(evt.error.constructor.name));
        }
    });

    // Resource load failures (img, script, link) — no evt.error present, capture phase required
    window.addEventListener("error", (evt) => {
        if (!evt.error && evt.target && evt.target !== window) {
            const src = evt.target.src || evt.target.href || "unknown";
            const content = `timestamp : ${_timestamp()}\ntype      : network\nmessage   : resource load failed\nlocation  : ${src}`;
            _write(content, _route("network"));
        }
    }, true);

    // Unhandled promise rejections
    window.addEventListener("unhandledrejection", (evt) => {
        const reason = evt.reason;
        const message = reason?.message ?? String(reason);
        const content = _format(message, window.location.href, 0, 0, reason?.stack ?? null);
        _write(content, _route("unhandledrejection"));
    });

    // CSP violations
    window.addEventListener("securitypolicyviolation", (evt) => {
        const content = `timestamp : ${_timestamp()}\nmessage   : CSP violation\ndirective : ${evt.violatedDirective}\nblocked   : ${evt.blockedURI}`;
        _write(content, _route("securitypolicyviolation"));
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function logEvent(content, keyword) {
    const cfg = keyword ? (_registry.get(keyword) ?? config_events[0]) : config_events[0];
    _write(content, cfg);
}

export async function initLogger() {
    if (_initialized) return;
    _initialized = true;

    const normalized = [];
    for (const raw of config_events) {
        const cfg = _normalize(raw);
        normalized.push(cfg);
        if (cfg.keyword) _registry.set(cfg.keyword, cfg);
        if (cfg.events.length === 0) {
            _eventMap.set("*", cfg);
        } else {
            for (const evt of cfg.events) _eventMap.set(evt, cfg);
        }
    }

    _attachListeners();

    for (const cfg of normalized) {
        await _initHeader(cfg);
    }
}

// Auto-activate on import
initLogger();
