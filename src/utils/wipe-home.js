/**
 * wipe-home.js — delete every file on home.
 *
 * ns.rm() refuses to delete a script while it's running, so this script deletes
 * everything else first, then deletes itself last (it's still "running" while its
 * own main() executes). Run manually from the terminal: `run /utils/wipe-home.js`.
 */
export async function main(ns) {
    const self = ns.getScriptName();
    const files = ns.ls("home").filter((f) => f !== self);

    for (const file of files) {
        ns.rm(file, "home");
    }

    ns.tprint(`Deleted ${files.length} file(s) from home.`);
    ns.rm(self, "home");
}
