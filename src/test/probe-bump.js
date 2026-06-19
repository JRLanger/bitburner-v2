/**
 * probe-bump.js — helper for probe-timing.js. After an initial delay, repeatedly
 * grows the target to RAISE and HOLD its security elevated, so the main probe can
 * test whether an in-flight weaken's duration reacts to mid-flight security.
 *
 * Args: [0] target, [1] delayMs before bumping, [2] grows to fire.
 */
export async function main(ns) {
    const target = ns.args[0];
    const delayMs = ns.args[1] ?? 2000;
    const grows = ns.args[2] ?? 40;
    await ns.sleep(delayMs);
    for (let i = 0; i < grows; i++) await ns.grow(target);
}
