/**
 * lib/flags.js — shared runtime flag store backed by a Netscript port.
 *
 * A single port (FLAG_PORT) holds one plain object of flags. Ports are wiped on game
 * restart AND on aug/soft reset (verified in-game), so every flag stored here is
 * automatically PER-RUN: it survives across ticks and across separate scripts, but
 * clears the instant the run resets. That lifecycle is exactly
 * what the manager-launch suppression needs — a manager that finished building this run
 * must start over after a reset wipes its infra — and it removes any need to detect the
 * reset ourselves.
 *
 * SAFE TO IMPORT ANYWHERE: every port op (peek / writePort / clearPort) costs 0 GB, so
 * importing this module adds no RAM to the importer. (A shared module that called metered
 * NS functions would tax every importer for the full cost — see CLAUDE.md / the import
 * note in booster — but pure 0-GB port ops are free.)
 *
 * writePort clones with structuredClone(), so a plain object round-trips directly — no
 * JSON.stringify needed. Each helper's read-modify-write is synchronous (no await), so it
 * is atomic against other scripts under Netscript's cooperative scheduling.
 *
 * RESERVATION LEDGER (docs/plans/wallet-reservations.md): a `reservations` flag holds a
 * map of key -> {amount, owner, reason, ts}. Money a manager has earmarked (e.g. pilot's
 * simulated cost of the next acquirable aug batch) is written here under a key that ONLY
 * that manager ever writes (single writer per key — no two scripts race the same entry).
 * moneyFloor() below folds the live sum of these reservations into the frozen floor, so
 * EVERY existing spender — which already computes `money = raw - moneyFloor(ns)` — treats
 * reserved money as untouchable with zero changes to its own code. Staleness is handled
 * read-side only: reservationsTotal() ignores any entry older than RESERVATION_TTL_MS, so
 * a writer that dies (crashes, gets killed) has its reservation silently expire rather
 * than leak forever — no pruning process needed. Cross-run staleness is a non-issue since
 * the whole port (and thus the ledger) is wiped on every reset, same as every other flag.
 */

import { FLAG_PORT, RESERVATION_TTL_MS } from "/config/constants.js";

/** Sentinel peek() returns when the port is empty. */
const EMPTY = "NULL PORT DATA";

/** Read the whole flag object (empty object if the port is unset/cleared). */
export function readFlags(ns) {
    const data = ns.peek(FLAG_PORT);
    return data === EMPTY ? {} : data;
}

/** Replace the whole flag object (clear, then write so the port stays single-slot). */
export function writeFlags(ns, flags) {
    ns.clearPort(FLAG_PORT);
    ns.writePort(FLAG_PORT, flags);
}

/** Read one flag by key, returning `fallback` when it isn't set. */
export function getFlag(ns, key, fallback = undefined) {
    const flags = readFlags(ns);
    return key in flags ? flags[key] : fallback;
}

/** Set one flag by key, preserving every other flag. */
export function setFlag(ns, key, value) {
    const flags = readFlags(ns);
    flags[key] = value;
    writeFlags(ns, flags);
}

/** Upsert one reservation entry, stamping `ts = Date.now()` so reservationsTotal()
 *  can age it out. A writer must refresh (call this again) every tick it wants the
 *  reservation to keep counting — that's what makes the read-side TTL safe: a dead
 *  writer's entry goes stale and stops counting on its own. */
export function setReservation(ns, key, amount, owner, reason) {
    const flags = readFlags(ns);
    flags.reservations = flags.reservations ?? {};
    flags.reservations[key] = { amount, owner, reason, ts: Date.now() };
    writeFlags(ns, flags);
}

/** Remove one reservation entry outright (e.g. lifecycle spending the batch it
 *  covers). No-op if the key isn't present. */
export function clearReservation(ns, key) {
    const flags = readFlags(ns);
    if (!flags.reservations || !(key in flags.reservations)) return;
    delete flags.reservations[key];
    writeFlags(ns, flags);
}

/** Sum of all reservation amounts that are still fresh (ts within the last
 *  RESERVATION_TTL_MS). Entries older than that count as 0 without being deleted —
 *  the TTL is enforced purely on the read side, so there's no separate pruning pass
 *  to keep in sync with writers. */
export function reservationsTotal(ns) {
    const reservations = readFlags(ns).reservations ?? {};
    const cutoff = Date.now() - RESERVATION_TTL_MS;
    let total = 0;
    for (const entry of Object.values(reservations)) {
        if (entry.ts > cutoff) total += entry.amount;
    }
    return total;
}

/** Money every manager must leave untouched (arbitration.md Decision 2): each
 *  manager subtracts this from its spendable-money read, so lifecycle can freeze
 *  ALL spending pre-reset by setting the flag to Infinity (structuredClone
 *  preserves Infinity through the port). Now the FROZEN floor (the flag, 0 when
 *  unset) PLUS the live reservation ledger — every manager already reads through
 *  this function, so money earmarked for e.g. the acquirable aug batch is
 *  invisible to every other spender with no manager-side changes required. */
export function moneyFloor(ns) {
    return getFlag(ns, "moneyFloor", 0) + reservationsTotal(ns);
}
