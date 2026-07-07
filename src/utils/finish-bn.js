/**
 * utils/finish-bn.js — player-run one-shot: destroy w0r1d_d43m0n and jump BitNode.
 *
 * docs/plans/reset-lifecycle.md Part C. BitNode completion is the single most
 * consequential decision in the game (which Source-File to chase next), so it is
 * DELIBERATELY never automatic — lifecycle only ever raises a dashboard alert
 * ("BitNode completable — run utils/finish-bn.js <nextBN>") when the condition
 * is met; the player must run this script by hand with an explicit `nextBN` arg.
 *
 * Usage: `run /utils/finish-bn.js <nextBN>` (nextBN must be an integer 1-14).
 * boot.js is passed as the callback script so the new BitNode bootstraps itself
 * the same way a normal aug-install reset does.
 */
import { BOOT_SCRIPT } from "/config/constants.js";

const MIN_BN = 1;
const MAX_BN = 14;

export async function main(ns) {
    const raw = ns.args[0];
    const nextBN = Number(raw);

    if (raw === undefined || !Number.isInteger(nextBN) || nextBN < MIN_BN || nextBN > MAX_BN) {
        ns.tprint(
            `ERROR: finish-bn.js requires a valid nextBN argument (integer ${MIN_BN}-${MAX_BN}). ` +
            `Got: ${JSON.stringify(raw)}. Usage: run /utils/finish-bn.js <nextBN>`
        );
        return;
    }

    ns.tprint(`finish-bn.js: destroying w0r1d_d43m0n, jumping to BN${nextBN}. Callback: ${BOOT_SCRIPT}`);
    ns.singularity.destroyW0r1dD43m0n(nextBN, BOOT_SCRIPT);
}
