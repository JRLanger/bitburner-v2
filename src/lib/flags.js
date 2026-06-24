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
 */

import { FLAG_PORT } from "/config/constants.js";

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
