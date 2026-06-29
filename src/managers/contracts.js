/**
 * managers/contracts.js — coding-contract finder/solver.
 *
 * An independent persistent loop, launched on home by booster (FIRST in the manager
 * dependency order — see docs/devlog/02-booster.md "Manager orchestration"). Coding
 * contracts (.cct files) spawn at random across the network and pay free money /
 * faction reputation when solved, with no prerequisites, so this manager leads the
 * launch order (its gate is always true).
 *
 * Each tick it reads the host list from the topology JSON booster writes (free), then
 * `ns.ls(host, ".cct")` to find contracts on each host. Discovery lives here, not in
 * booster's scan loop: the manager needs getContract (15 GB) to solve regardless, ls
 * is cheap, and the manager's own cadence finds contracts promptly without coupling
 * booster's data format to a downstream feature. See docs/scripts/contracts.md.
 *
 * Solving is registry-driven and keyed by contract type: solve-all, skip-unknown —
 * attempt only the types we have a pure solver for, log + skip the rest. Adding a new
 * type later = add one pure function and one SOLVERS entry.
 */

import { SERVERS_JSON, MANAGER_LOOP_SLEEP, STATUS_PORT_CONTRACTS } from "/config/constants.js";
import { publishStatus } from "/lib/status.js";

export async function main(ns) {
    ns.disableLog("ALL");

    // Lifetime tallies + a small ring of recent activity lines for the status box.
    const totals = { solved: 0, failed: 0, skipped: 0 };
    const recent = [];
    const note = (line) => {
        recent.push(`${new Date().toLocaleTimeString()} ${line}`);
        while (recent.length > 8) recent.shift();
    };

    // Contracts we've already attempted and got rejected on. A solver is
    // deterministic, so a rejected contract would yield the same wrong answer every
    // tick — retrying only burns its limited tries until it self-destructs. Record
    // "host:file" on first rejection and never re-attempt it. (In-memory only: a
    // manager restart clears it, which is fine — at worst one extra attempt.)
    const failedOnce = new Set();

    while (true) {
        sweep(ns, totals, note, failedOnce);
        renderStatus(ns, totals, recent);
        publishStatus(ns, STATUS_PORT_CONTRACTS, {
            ts: Date.now(),
            solved: totals.solved,
            failed: totals.failed,
            skipped: totals.skipped,
            action: recent.length ? recent[recent.length - 1] : "(no contracts seen yet)",
        });
        await ns.sleep(MANAGER_LOOP_SLEEP);
    }
}

/**
 * One discovery+solve pass over the whole network. Reads the host list from the
 * topology JSON (free) and ls-es each host for .cct files. ls needs no root, so every
 * host is scanned. Mutates `totals` and appends activity via `note`.
 */
function sweep(ns, totals, note, failedOnce) {
    let hosts;
    try {
        hosts = JSON.parse(ns.read(SERVERS_JSON) || "[]").map((s) => s.hostname);
    } catch {
        hosts = []; // missing/half-written JSON — try again next tick
    }
    if (!hosts.includes("home")) hosts.push("home"); // contracts can spawn on home too

    for (const host of hosts) {
        for (const file of ns.ls(host, ".cct")) {
            const key = `${host}:${file}`;
            if (failedOnce.has(key)) continue; // already tried, wrong answer is deterministic
            solveOne(ns, host, file, totals, note, () => failedOnce.add(key));
        }
    }
}

/** Resolve and submit a single contract. One try/catch so a bad solver can't kill the loop. */
function solveOne(ns, host, file, totals, note, markFailed) {
    let contract;
    try {
        contract = ns.codingcontract.getContract(file, host); // { type, data, submit, numTriesRemaining }
    } catch (e) {
        totals.failed++;
        note(`✖ read ${file}@${host}: ${e}`);
        return;
    }

    const solver = SOLVERS[contract.type];
    if (!solver) {
        totals.skipped++;
        note(`… skip ${contract.type} @${host}`);
        return;
    }
    if (contract.numTriesRemaining() <= 0) {
        totals.skipped++;
        note(`… no tries: ${contract.type} @${host}`);
        return;
    }

    let answer;
    try {
        answer = solver(contract.data);
    } catch (e) {
        totals.failed++;
        markFailed();
        note(`✖ solver ${contract.type} @${host}: ${e}`);
        return;
    }

    const reward = contract.submit(answer);
    if (reward) {
        totals.solved++;
        note(`✔ ${contract.type} @${host}`);
    } else {
        totals.failed++;
        markFailed(); // don't retry a deterministic wrong answer next tick
        note(`✖ rejected ${contract.type} @${host}`);
    }
}

/** Refresh the tail-window status box each tick (mirrors pserver.js style). */
function renderStatus(ns, totals, recent) {
    ns.clearLog();
    const W = 52;
    ns.print(`╔═ CONTRACTS ═ ${new Date().toLocaleTimeString()} ${"═".repeat(Math.max(0, W - 25))}`);
    ns.print(`║ Solved ${totals.solved}  |  Failed ${totals.failed}  |  Skipped ${totals.skipped}`);
    ns.print(`╠${"═".repeat(W)}`);
    if (recent.length === 0) ns.print("║ (no contracts seen yet)");
    for (const line of recent) ns.print(`║ ${line}`);
    ns.print(`╚${"═".repeat(W)}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Solver registry — keyed by the exact contract-type string (CodingContractName).
// Each value is a PURE function (no ns) taking the contract's `data` and returning
// the answer in the shape the engine expects (see CodingContractSignatures).
// ════════════════════════════════════════════════════════════════════════════

const SOLVERS = {
    "Find Largest Prime Factor": findLargestPrimeFactor,
    "Subarray with Maximum Sum": subarrayWithMaximumSum,
    "Total Ways to Sum": totalWaysToSum,
    "Total Ways to Sum II": totalWaysToSumII,
    "Spiralize Matrix": spiralizeMatrix,
    "Array Jumping Game": arrayJumpingGame,
    "Array Jumping Game II": arrayJumpingGameII,
    "Merge Overlapping Intervals": mergeOverlappingIntervals,
    "Generate IP Addresses": generateIPAddresses,
    "Algorithmic Stock Trader I": stockTraderI,
    "Algorithmic Stock Trader II": stockTraderII,
    "Algorithmic Stock Trader III": stockTraderIII,
    "Algorithmic Stock Trader IV": stockTraderIV,
    "Minimum Path Sum in a Triangle": minPathSumTriangle,
    "Unique Paths in a Grid I": uniquePathsI,
    "Unique Paths in a Grid II": uniquePathsII,
    "Shortest Path in a Grid": shortestPathInGrid,
    "Sanitize Parentheses in Expression": sanitizeParentheses,
    "Find All Valid Math Expressions": findAllValidMathExpressions,
    "HammingCodes: Integer to Encoded Binary": hammingEncode,
    "HammingCodes: Encoded Binary to Integer": hammingDecode,
    "Proper 2-Coloring of a Graph": twoColoring,
    "Compression I: RLE Compression": rleCompress,
    "Compression II: LZ Decompression": lzDecompress,
    "Compression III: LZ Compression": lzCompress,
    "Encryption I: Caesar Cipher": caesarCipher,
    "Encryption II: Vigenère Cipher": vigenereCipher,
    "Square Root": squareRoot,
    "Total Number of Primes": totalPrimesInRange,
    "Largest Rectangle in a Matrix": largestRectangleInMatrix,
};

// ── Number theory ───────────────────────────────────────────────────────────

/** data: number → largest prime factor. */
function findLargestPrimeFactor(n) {
    let num = n;
    let largest = 1;
    for (let d = 2; d * d <= num; d++) {
        while (num % d === 0) {
            largest = d;
            num /= d;
        }
    }
    return num > 1 ? num : largest;
}

/** data: number[] (range [lo, hi]) → count of primes in [lo, hi] inclusive. */
function totalPrimesInRange([lo, hi]) {
    const sieve = new Uint8Array(hi + 1).fill(1);
    sieve[0] = 0;
    if (hi >= 1) sieve[1] = 0;
    for (let i = 2; i * i <= hi; i++) {
        if (sieve[i]) for (let j = i * i; j <= hi; j += i) sieve[j] = 0;
    }
    let count = 0;
    for (let i = Math.max(2, lo); i <= hi; i++) count += sieve[i];
    return count;
}

/** data: [bigint n, ...] → integer square root (floor) of n as bigint. */
function squareRoot(data) {
    const n = Array.isArray(data) ? data[0] : data;
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}

// ── Arrays / DP ─────────────────────────────────────────────────────────────

/** data: number[] → maximum contiguous subarray sum (Kadane). */
function subarrayWithMaximumSum(arr) {
    let best = arr[0];
    let cur = arr[0];
    for (let i = 1; i < arr.length; i++) {
        cur = Math.max(arr[i], cur + arr[i]);
        best = Math.max(best, cur);
    }
    return best;
}

/** data: number n → number of ways to write n as a sum of ≥2 positive integers. */
function totalWaysToSum(n) {
    const ways = new Array(n + 1).fill(0);
    ways[0] = 1;
    for (let coin = 1; coin < n; coin++) {
        for (let amt = coin; amt <= n; amt++) ways[amt] += ways[amt - coin];
    }
    return ways[n];
}

/** data: [n, number[] set] → number of ways to sum to n using the given parts. */
function totalWaysToSumII([n, parts]) {
    const ways = new Array(n + 1).fill(0);
    ways[0] = 1;
    for (const coin of parts) {
        for (let amt = coin; amt <= n; amt++) ways[amt] += ways[amt - coin];
    }
    return ways[n];
}

/** data: number[][] → elements in clockwise spiral order. */
function spiralizeMatrix(matrix) {
    const out = [];
    if (matrix.length === 0) return out;
    let top = 0;
    let bottom = matrix.length - 1;
    let left = 0;
    let right = matrix[0].length - 1;
    while (top <= bottom && left <= right) {
        for (let c = left; c <= right; c++) out.push(matrix[top][c]);
        top++;
        for (let r = top; r <= bottom; r++) out.push(matrix[r][right]);
        right--;
        if (top <= bottom) {
            for (let c = right; c >= left; c--) out.push(matrix[bottom][c]);
            bottom--;
        }
        if (left <= right) {
            for (let r = bottom; r >= top; r--) out.push(matrix[r][left]);
            left++;
        }
    }
    return out;
}

/** data: number[] of max jump lengths → 1 if the last index is reachable, else 0. */
function arrayJumpingGame(arr) {
    let reach = 0;
    for (let i = 0; i < arr.length; i++) {
        if (i > reach) return 0;
        reach = Math.max(reach, i + arr[i]);
    }
    return 1;
}

/** data: number[] → minimum jumps to reach the last index (0 if unreachable). */
function arrayJumpingGameII(arr) {
    const n = arr.length;
    if (n <= 1) return 0;
    let jumps = 0;
    let curEnd = 0;
    let farthest = 0;
    for (let i = 0; i < n - 1; i++) {
        farthest = Math.max(farthest, i + arr[i]);
        if (i === curEnd) {
            jumps++;
            curEnd = farthest;
            if (curEnd >= n - 1) return jumps;
            if (curEnd === i) return 0; // stuck — cannot advance
        }
    }
    return curEnd >= n - 1 ? jumps : 0;
}

/** data: [number,number][] → merged, sorted non-overlapping intervals. */
function mergeOverlappingIntervals(intervals) {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [start, end] of sorted) {
        const last = out[out.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else out.push([start, end]);
    }
    return out;
}

// ── Grid path DP ────────────────────────────────────────────────────────────

/** data: number[][] triangle → minimum top-to-bottom path sum. */
function minPathSumTriangle(triangle) {
    const dp = [...triangle[triangle.length - 1]];
    for (let r = triangle.length - 2; r >= 0; r--) {
        for (let c = 0; c <= r; c++) {
            dp[c] = triangle[r][c] + Math.min(dp[c], dp[c + 1]);
        }
    }
    return dp[0];
}

/** data: [rows, cols] → number of unique paths moving only right/down. */
function uniquePathsI([rows, cols]) {
    const dp = new Array(cols).fill(1);
    for (let r = 1; r < rows; r++) {
        for (let c = 1; c < cols; c++) dp[c] += dp[c - 1];
    }
    return dp[rows === 0 ? 0 : cols - 1];
}

/** data: (1|0)[][] grid (1 = obstacle) → unique right/down paths avoiding obstacles. */
function uniquePathsII(grid) {
    const rows = grid.length;
    const cols = grid[0].length;
    const dp = new Array(cols).fill(0);
    dp[0] = grid[0][0] === 1 ? 0 : 1;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] === 1) dp[c] = 0;
            else if (c > 0) dp[c] += dp[c - 1];
        }
    }
    return dp[cols - 1];
}

/**
 * data: (1|0)[][] grid (1 = obstacle) → shortest path string of U/D/L/R from
 * top-left to bottom-right, or "" if unreachable. BFS.
 */
function shortestPathInGrid(grid) {
    const rows = grid.length;
    const cols = grid[0].length;
    if (grid[0][0] === 1 || grid[rows - 1][cols - 1] === 1) return "";
    const moves = [
        [-1, 0, "U"],
        [1, 0, "D"],
        [0, -1, "L"],
        [0, 1, "R"],
    ];
    const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
    seen[0][0] = true;
    let queue = [[0, 0, ""]];
    while (queue.length) {
        const next = [];
        for (const [r, c, path] of queue) {
            if (r === rows - 1 && c === cols - 1) return path;
            for (const [dr, dc, dir] of moves) {
                const nr = r + dr;
                const nc = c + dc;
                if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
                if (seen[nr][nc] || grid[nr][nc] === 1) continue;
                seen[nr][nc] = true;
                next.push([nr, nc, path + dir]);
            }
        }
        queue = next;
    }
    return "";
}

// ── Stock trader ────────────────────────────────────────────────────────────

/** Max profit with at most `k` non-overlapping buy/sell transactions. */
function maxProfit(k, prices) {
    const n = prices.length;
    if (n < 2 || k === 0) return 0;
    if (k >= Math.floor(n / 2)) {
        let profit = 0;
        for (let i = 1; i < n; i++) if (prices[i] > prices[i - 1]) profit += prices[i] - prices[i - 1];
        return profit;
    }
    const buy = new Array(k + 1).fill(-Infinity);
    const sell = new Array(k + 1).fill(0);
    for (const price of prices) {
        for (let t = 1; t <= k; t++) {
            buy[t] = Math.max(buy[t], sell[t - 1] - price);
            sell[t] = Math.max(sell[t], buy[t] + price);
        }
    }
    return sell[k];
}

function stockTraderI(prices) {
    return maxProfit(1, prices);
}
function stockTraderII(prices) {
    return maxProfit(prices.length, prices);
}
function stockTraderIII(prices) {
    return maxProfit(2, prices);
}
/** data: [k, number[] prices]. */
function stockTraderIV([k, prices]) {
    return maxProfit(k, prices);
}

// ── Strings: IP, parentheses, math expressions ──────────────────────────────

/** data: string of digits → all valid IPv4 strings formable by inserting 3 dots. */
function generateIPAddresses(s) {
    const out = [];
    const valid = (seg) =>
        seg.length >= 1 && seg.length <= 3 && Number(seg) <= 255 && (seg.length === 1 || seg[0] !== "0");
    for (let a = 1; a <= 3; a++)
        for (let b = 1; b <= 3; b++)
            for (let c = 1; c <= 3; c++) {
                const d = s.length - a - b - c;
                if (d < 1 || d > 3) continue;
                const p1 = s.slice(0, a);
                const p2 = s.slice(a, a + b);
                const p3 = s.slice(a + b, a + b + c);
                const p4 = s.slice(a + b + c);
                if (valid(p1) && valid(p2) && valid(p3) && valid(p4)) {
                    out.push(`${p1}.${p2}.${p3}.${p4}`);
                }
            }
    return out;
}

/**
 * data: string with letters and parentheses → all unique strings with the minimum
 * number of removed parentheses that make it valid.
 */
function sanitizeParentheses(s) {
    const isValid = (str) => {
        let bal = 0;
        for (const ch of str) {
            if (ch === "(") bal++;
            else if (ch === ")") {
                bal--;
                if (bal < 0) return false;
            }
        }
        return bal === 0;
    };

    const results = new Set();
    let level = new Set([s]);
    while (level.size > 0) {
        for (const str of level) if (isValid(str)) results.add(str);
        if (results.size > 0) break; // found minimum removals
        const nextLevel = new Set();
        for (const str of level) {
            for (let i = 0; i < str.length; i++) {
                if (str[i] === "(" || str[i] === ")") {
                    nextLevel.add(str.slice(0, i) + str.slice(i + 1));
                }
            }
        }
        level = nextLevel;
    }
    return results.size > 0 ? [...results] : [""];
}

/**
 * data: [string digits, number target] → all expressions inserting +,-,* between
 * digits that evaluate to target. Backtracking with running eval (handles * precedence).
 */
function findAllValidMathExpressions([digits, target]) {
    const out = [];
    const recurse = (pos, expr, value, prev) => {
        if (pos === digits.length) {
            if (value === target) out.push(expr);
            return;
        }
        for (let i = pos; i < digits.length; i++) {
            const part = digits.slice(pos, i + 1);
            if (part.length > 1 && part[0] === "0") break; // no leading zeros
            const num = Number(part);
            if (pos === 0) {
                recurse(i + 1, part, num, num);
            } else {
                recurse(i + 1, expr + "+" + part, value + num, num);
                recurse(i + 1, expr + "-" + part, value - num, -num);
                recurse(i + 1, expr + "*" + part, value - prev + prev * num, prev * num);
            }
        }
    };
    recurse(0, "", 0, 0);
    return out;
}

// ── HammingCodes ────────────────────────────────────────────────────────────

/**
 * data: number → extended-Hamming-encoded binary string (parity bits at powers of 2,
 * plus an overall parity bit at index 0).
 */
function hammingEncode(value) {
    const dataBits = value.toString(2).split("").map(Number);

    // Total length = data bits + parity bits + 1 overall-parity bit.
    let parity = 0;
    while (2 ** parity < dataBits.length + parity + 1) parity++;
    const size = dataBits.length + parity + 1;

    const enc = new Array(size).fill(0);
    // Place data bits in non-power-of-two positions (index 0 reserved for overall parity).
    let di = 0;
    for (let i = 1; i < size; i++) {
        if ((i & (i - 1)) === 0) continue; // power of two → parity slot
        enc[i] = dataBits[di++];
    }
    // Compute each parity bit (positions 1,2,4,...).
    for (let p = 0; 2 ** p < size; p++) {
        const pos = 2 ** p;
        let count = 0;
        for (let i = 1; i < size; i++) {
            if (i & pos) count ^= enc[i];
        }
        enc[pos] = count;
    }
    // Overall parity at index 0 makes the whole string even-parity.
    let overall = 0;
    for (let i = 1; i < size; i++) overall ^= enc[i];
    enc[0] = overall;
    return enc.join("");
}

/**
 * data: string encoded binary (possibly one flipped bit) → decoded integer.
 * Corrects a single-bit error via the syndrome, then reads data bits.
 */
function hammingDecode(encoded) {
    const bits = encoded.split("").map(Number);
    let syndrome = 0;
    for (let i = 1; i < bits.length; i++) {
        if (bits[i]) syndrome ^= i;
    }
    if (syndrome > 0 && syndrome < bits.length) bits[syndrome] ^= 1; // fix flipped bit
    let result = "";
    for (let i = 1; i < bits.length; i++) {
        if ((i & (i - 1)) === 0) continue; // skip parity positions
        result += bits[i];
    }
    return parseInt(result, 2);
}

// ── Graph 2-coloring ────────────────────────────────────────────────────────

/**
 * data: [n, [number,number][] edges] → a valid 2-coloring (array of 0/1 length n),
 * or [] if the graph isn't bipartite.
 */
function twoColoring([n, edges]) {
    const adj = Array.from({ length: n }, () => []);
    for (const [u, v] of edges) {
        adj[u].push(v);
        adj[v].push(u);
    }
    const color = new Array(n).fill(-1);
    for (let start = 0; start < n; start++) {
        if (color[start] !== -1) continue;
        color[start] = 0;
        let queue = [start];
        while (queue.length) {
            const next = [];
            for (const u of queue) {
                for (const v of adj[u]) {
                    if (color[v] === -1) {
                        color[v] = color[u] ^ 1;
                        next.push(v);
                    } else if (color[v] === color[u]) {
                        return [];
                    }
                }
            }
            queue = next;
        }
    }
    return color;
}

// ── Compression ─────────────────────────────────────────────────────────────

/** data: string → run-length encoding, runs >9 split into chunks of ≤9. */
function rleCompress(s) {
    let out = "";
    let i = 0;
    while (i < s.length) {
        let count = 1;
        while (i + count < s.length && s[i + count] === s[i] && count < 9) count++;
        out += count + s[i];
        i += count;
    }
    return out;
}

/**
 * data: LZ-compressed string → decompressed plaintext. Alternating chunks: a literal
 * length L followed by L characters, then a backreference length L followed by a
 * single offset digit (copying from earlier output).
 */
function lzDecompress(compr) {
    let out = "";
    let i = 0;
    let literal = true;
    while (i < compr.length) {
        const len = Number(compr[i]);
        i++;
        if (len === 0) {
            literal = !literal;
            continue;
        }
        if (literal) {
            out += compr.substr(i, len);
            i += len;
        } else {
            const offset = Number(compr[i]);
            i++;
            for (let j = 0; j < len; j++) out += out[out.length - offset];
        }
        literal = !literal;
    }
    return out;
}

/**
 * data: string → minimal-length LZ compression.
 *
 * Format: fields alternate, starting with a literal. A field is a length digit 0–9;
 * a literal field is followed by that many verbatim chars, a backreference field by a
 * single offset digit (copy `length` chars from `offset` back in the output). A
 * length-0 field emits nothing and flips to the other type, which is how two literals
 * or two backrefs can sit adjacent. Optimal choice of where to cut is a DP.
 *
 * Memoized recursion over (position, next field type, mayFlip): emit the next field
 * as a 1–9-length chunk of the required type (then recurse with the type flipped), or
 * emit a length-0 field to switch type once (mayFlip guards against flipping twice in
 * a row, which would loop). `type` 0 = literal, 1 = backreference.
 */
function lzCompress(plain) {
    const n = plain.length;
    const memo = new Map();

    const validBackref = (i, len, offset) => {
        if (offset < 1 || i - offset < 0) return false;
        for (let k = 0; k < len; k++) {
            if (i + k >= n || plain[i + k] !== plain[i + k - offset]) return false;
        }
        return true;
    };

    const best = (i, type, mayFlip) => {
        if (i === n) return "";
        const key = `${i},${type},${mayFlip ? 1 : 0}`;
        const cached = memo.get(key);
        if (cached !== undefined) return cached;

        let result = null;
        const consider = (str) => {
            if (str !== null && (result === null || str.length < result.length)) result = str;
        };

        // Emit a length-0 field to flip type (at most once without consuming input).
        if (mayFlip) {
            const rest = best(i, type ^ 1, false);
            if (rest !== null) consider("0" + rest);
        }

        for (let len = 1; len <= 9 && i + len <= n; len++) {
            if (type === 0) {
                // literal chunk of `len` verbatim chars
                const rest = best(i + len, 1, true);
                if (rest !== null) consider(len + plain.slice(i, i + len) + rest);
            } else {
                // backreference chunk: any offset 1–9 that reproduces plain[i..i+len)
                for (let offset = 1; offset <= 9; offset++) {
                    if (!validBackref(i, len, offset)) continue;
                    const rest = best(i + len, 0, true);
                    if (rest !== null) consider("" + len + offset + rest);
                }
            }
        }

        memo.set(key, result);
        return result;
    };

    return best(0, 0, true) ?? "";
}

// ── Encryption ──────────────────────────────────────────────────────────────

/** data: [string text, number shift] → Caesar cipher (left shift), letters only. */
function caesarCipher([text, shift]) {
    let out = "";
    for (const ch of text) {
        if (ch >= "A" && ch <= "Z") {
            const code = ((ch.charCodeAt(0) - 65 - shift) % 26 + 26) % 26;
            out += String.fromCharCode(65 + code);
        } else {
            out += ch; // spaces and non-letters pass through
        }
    }
    return out;
}

/** data: [string text, string keyword] → Vigenère cipher (encryption), letters only. */
function vigenereCipher([text, keyword]) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch >= "A" && ch <= "Z") {
            const k = keyword.charCodeAt(i % keyword.length) - 65;
            const code = (ch.charCodeAt(0) - 65 + k) % 26;
            out += String.fromCharCode(65 + code);
        } else {
            out += ch;
        }
    }
    return out;
}

// ── Largest rectangle in a binary matrix ────────────────────────────────────

/**
 * data: (1|0)[][] → [[r1,c1],[r2,c2]] corners of the largest axis-aligned rectangle
 * that contains NO 1s (i.e. all-0s), top-left and bottom-right. Histogram-per-row
 * (height = run of consecutive 0s up to this row) with a monotonic stack.
 */
function largestRectangleInMatrix(grid) {
    const rows = grid.length;
    const cols = grid[0].length;
    const heights = new Array(cols).fill(0);
    let best = { area: 0, r1: 0, c1: 0, r2: 0, c2: 0 };

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) heights[c] = grid[r][c] === 0 ? heights[c] + 1 : 0;

        // Largest rectangle in this histogram row, tracking its column span + height.
        const stack = []; // indices of increasing bar heights
        for (let c = 0; c <= cols; c++) {
            const h = c === cols ? 0 : heights[c];
            while (stack.length && heights[stack[stack.length - 1]] >= h) {
                const top = stack.pop();
                const height = heights[top];
                const left = stack.length ? stack[stack.length - 1] + 1 : 0;
                const right = c - 1;
                const area = height * (right - left + 1);
                if (area > best.area) {
                    best = { area, r1: r - height + 1, c1: left, r2: r, c2: right };
                }
            }
            stack.push(c);
        }
    }
    if (best.area === 0) return [];
    return [
        [best.r1, best.c1],
        [best.r2, best.c2],
    ];
}
