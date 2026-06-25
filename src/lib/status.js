/**
 * lib/status.js — tiny status-bus helpers over Netscript ports.
 *
 * Each long-running script publishes a small JSON snapshot of its live state to its
 * own dedicated port (see STATUS_PORT_* in config/constants.js); dashboard.js peeks
 * those ports each tick and renders one unified overlay. A script can't read another
 * script's memory, so the port is the decoupling seam: publishers don't know or care
 * that a dashboard exists, and the dashboard is a pure reader.
 *
 * Mirrors the lib/flags.js port idiom. All NS port ops are free RAM, so importing
 * this module costs nothing. Snapshots should carry a `ts` (Date.now()) field so the
 * dashboard can flag a dead/stale publisher (no update in a few seconds).
 */

/**
 * Publish a snapshot object to a status port, replacing whatever was there. clearPort
 * first so the single slot always holds exactly the latest snapshot (writePort to a
 * full port would otherwise fail). The object is JSON-serialised; keep it small and
 * plain (no functions / circular refs).
 */
export function publishStatus(ns, port, obj) {
    ns.clearPort(port);
    ns.writePort(port, JSON.stringify(obj));
}

/**
 * Read the latest snapshot from a status port WITHOUT consuming it (peek), so the
 * snapshot survives for the next dashboard tick and any second reader. Returns the
 * parsed object, or null if the port is empty or holds unparseable data.
 */
export function readStatus(ns, port) {
    const raw = ns.peek(port);
    if (raw === "NULL PORT DATA") return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
