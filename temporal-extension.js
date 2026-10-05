/*
 * temporal-extension.js — timestamp formatting utility (part of PiServer 0.5.8-beta)
 * Jules Manson, 2026. MIT License.
 * Standalone ES module, no dependencies. Import getTimestamp() anywhere.
 */

// ---------------------------------------------------------------------------
// FORMAT OPTIONS — config_timestamp.style.format
//   piserver → August 15, 2026 19:08:50 Los Angeles (PT)   [miltime: true]
//            → August 15, 2026 7:08:50 PM Los Angeles (PT) [miltime: false]
//   usLong   → August 15, 2026 19:08:50 PT        (label from style.label)
//   usShort  → Aug 15, 2026 19:08:50 PT
//   usNum    → 08/15/2026 19:08:50
//   european → 15 August 2026 19:08:50
//   log      → 2026-08-15 19:08:50
//   iso      → 2026-08-15T19:08:50.945Z
//   compact  → 20260815T190850
//
// ZONE OPTIONS — config_timestamp.zone entries, tried in order, first valid wins
//   city   → IANA name, e.g. "America/Los_Angeles" (auto DST)
//   offset → fixed UTC offset, e.g. "Etc/GMT+7" (sign inverted: +7 = UTC-7)
//   utc    → "UTC" (no DST)
//
// LABEL OPTIONS — config_timestamp.style.label (timezone display style)
//   city → Los Angeles          shortGeneric → PT         short → PDT/PST (DST)
//   longGeneric → Pacific Time  long → Pacific Daylight/Standard Time
//   shortOffset → GMT-7         longOffset → GMT-07:00
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// User config — edit these values to change timestamp behavior globally.
// ---------------------------------------------------------------------------
export const config_timestamp = {

    zone: { // tried in order, first valid wins silently — see ZONE OPTIONS above
        city:   "America/Los_Angeles",
        offset: "Etc/GMT+7",
        utc:    "UTC"
    },

    style: {
        locale: "en-US",    // BCP 47 tag; invalid falls back to navigator.language, then "en"
        miltime: true,      // true = 24-hour, else 12-hour
        format: "piserver", // see FORMAT OPTIONS above
        label:  "city"      // see LABEL OPTIONS above
    }
};

// ---------------------------------------------------------------------------
// getTimestamp() — each config item validates independently; a failed one
// falls back and prepends a warning line, everything else still works.
// ---------------------------------------------------------------------------
export function getTimestamp() {
    const errors = [];
    const d = new Date();

    // resolve zone — try each entry in order, use first valid one silently
    let tz = null;
    for (const [key, val] of Object.entries(config_timestamp.zone)) {
        try { new Intl.DateTimeFormat("en-US", { timeZone: val }).format(d); tz = val; break; }
        catch (_) {}
    }
    if (!tz) { errors.push("all zone entries invalid, used UTC"); tz = "UTC"; }

    // resolve locale — try configured, then navigator.language, then "en"
    let locale = null;
    for (const candidate of [config_timestamp.style.locale, navigator?.language, "en"]) {
        if (!candidate) continue;
        try { new Intl.DateTimeFormat(candidate, { timeZone: tz }).format(d); locale = candidate; break; }
        catch (_) {}
    }
    if (!locale) { errors.push("locale could not be resolved, used en"); locale = "en"; }

    // validate format
    const knownFormats = ["piserver", "usLong", "usShort", "usNum", "european", "log", "iso", "compact"];
    let fmt = config_timestamp.style.format;
    if (!knownFormats.includes(fmt)) {
        errors.push(`format "${fmt}" not recognized, used log`);
        fmt = "log";
    }

    // validate label
    const knownTzNames = ["city", "shortGeneric", "short", "longGeneric", "long", "shortOffset", "longOffset"];
    let tzName = config_timestamp.style.label;
    if (!knownTzNames.includes(tzName)) {
        errors.push(`label "${tzName}" not recognized, used shortGeneric`);
        tzName = "shortGeneric";
    }

    // build timestamp
    let ts;
    try {
        if (fmt === "iso") {
            ts = d.toISOString();

        } else if (fmt === "compact") {
            ts = d.toISOString().replace(/[-:]/g, "").slice(0, 15);

        } else if (fmt === "log") {
            const date = new Intl.DateTimeFormat("en-CA", {
                year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz
            }).format(d);
            const time = new Intl.DateTimeFormat("en-CA", {
                hour: "2-digit", minute: "2-digit", second: "2-digit",
                timeZone: tz, hour12: false
            }).format(d);
            ts = `${date} ${time}`;

        } else {
            const tzLabel = tzName === "city"
                ? tz.split("/").pop().replace(/_/g, " ")
                : new Intl.DateTimeFormat(locale, {
                    timeZone: tz, timeZoneName: tzName, hour: "numeric"
                  }).formatToParts(d).find(p => p.type === "timeZoneName")?.value ?? "";

            const time = new Intl.DateTimeFormat(locale, {
                hour: config_timestamp.style.miltime === true ? "2-digit" : "numeric",
                minute: "2-digit", second: "2-digit",
                timeZone: tz, hour12: config_timestamp.style.miltime !== true
            }).format(d);

            if (fmt === "piserver") {
                const date = new Intl.DateTimeFormat(locale, {
                    year: "numeric", month: "long", day: "numeric", timeZone: tz
                }).format(d);
                const cityLabel = tz.split("/").pop().replace(/_/g, " ");
                const tzAbbrev = new Intl.DateTimeFormat(locale, {
                    timeZone: tz, timeZoneName: "shortGeneric", hour: "numeric"
                }).formatToParts(d).find(p => p.type === "timeZoneName")?.value ?? "";
                ts = `${date} ${time} ${cityLabel} (${tzAbbrev})`;

            } else if (fmt === "usLong") {
                const date = new Intl.DateTimeFormat(locale, {
                    year: "numeric", month: "long", day: "numeric", timeZone: tz
                }).format(d);
                ts = `${date} ${time} ${tzLabel}`;

            } else if (fmt === "usShort") {
                const date = new Intl.DateTimeFormat(locale, {
                    year: "numeric", month: "short", day: "numeric", timeZone: tz
                }).format(d);
                ts = `${date} ${time} ${tzLabel}`;

            } else if (fmt === "usNum") {
                const date = new Intl.DateTimeFormat(locale, {
                    year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz
                }).format(d);
                ts = `${date} ${time}`;

            } else if (fmt === "european") {
                const date = new Intl.DateTimeFormat("en-GB", {
                    year: "numeric", month: "long", day: "numeric", timeZone: tz
                }).format(d);
                ts = `${date} ${time}`;
            }
        }
    } catch (_) {
        errors.push(`unexpected formatting error, fell back to ISO`);
        ts = d.toISOString();
    }

    if (errors.length === 0) return ts;
    return errors.map(e => "timestamp : " + e).join("\n") + "\ntimestamp : " + ts;
}
