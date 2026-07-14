/**
 * lib/debug-log.js — rolling per-tick debug logger for the managers.
 *
 * Appends one timestamped `key=value` line per call and keeps only the last CAP
 * lines (so the file can't grow without bound over a long run). ns.read / ns.write
 * are 0-GB, so this adds NO static RAM to the caller as long as the caller only
 * passes data it already has in hand — never make an extra singularity call purely
 * to log (that WOULD add RAM). Gate calls behind a manager's `*_DEBUG` constant so
 * logging can be turned off without deleting the call sites.
 *
 * View in-game with `tail`-style `cat`/`nano` on the file, or `run` a reader — the
 * newest lines are at the bottom.
 */

/** Write one debug line to `file`. `fields` is a plain object; values are formatted
 *  compactly (objects → JSON, null/undefined → "-"). Keeps the last `cap` lines. */
export function debugLog(ns, file, fields, cap = 400) {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const line = `${ts} ` + Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(" ");

    let prior = "";
    try { prior = ns.read(file); } catch { prior = ""; }
    const lines = prior ? prior.split("\n").filter(Boolean) : [];
    lines.push(line);
    ns.write(file, lines.slice(-cap).join("\n") + "\n", "w");
}

function fmt(v) {
    if (v === null || v === undefined) return "-";
    if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : (v > 0 ? "inf" : "-inf");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}
