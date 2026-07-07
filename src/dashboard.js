/**
 * dashboard.js — unified HTML/CSS overlay for the whole booster/orbiter system.
 *
 * A standalone reader: it touches NONE of the batching logic. Each long-running script
 * publishes a small JSON snapshot to its own status-bus port (see lib/status.js and the
 * STATUS_PORT_* constants); this script peeks all of them once a second and renders one
 * floating panel via the game's DOM. Replaces juggling 4-5 separate tail windows.
 *
 * Works on the Steam build too: Steam Bitburner is an Electron app (bundled Chromium),
 * so `document`/`window` are the real DOM, exactly as in the browser build. We reach
 * them through eval("document") — the standard Bitburner idiom that keeps the static
 * RAM analyzer from charging for the global and avoids bundler issues.
 *
 * The panel is draggable by its header and remembers its position in localStorage. The
 * × button (or `kill dashboard.js`) removes the overlay cleanly via ns.atExit.
 */

import {
    STATUS_PORT_CONTROLLER,
    STATUS_PORT_CONTRACTS,
    STATUS_PORT_PSERVER,
    STATUS_PORT_HACKNET,
    STATUS_PORT_PILOT,
    STATUS_PORT_LIFECYCLE,
    PILOT_LOOP_SLEEP,
    LIFECYCLE_LOOP_SLEEP,
    LOOP_SLEEP,
    SHARE_RAM,
} from "/config/constants.js";
import { readStatus } from "/lib/status.js";

/** Manager stale threshold, ms: the managers loop every 10s, so they need a much
 *  longer grace than the controller before "not reporting" means anything. */
const MGR_STALE_MS = 25000;
// Slow-tick managers (pilot 30s, lifecycle 60s) publish less often than the 10s
// managers the default threshold assumes — stale only past 2.5x their own period.
const PILOT_STALE_MS = 2.5 * PILOT_LOOP_SLEEP;
const LIFECYCLE_STALE_MS = 2.5 * LIFECYCLE_LOOP_SLEEP;
/** Engine-lag alert: same rule the controller's own debug log uses (gap > 2×sleep). */
const LAG_MS = 2 * LOOP_SLEEP;

const ROOT_ID = "bb-dashboard";
const POS_KEY = "bb-dashboard-pos";

export async function main(ns) {
    ns.disableLog("ALL");
    const doc = eval("document");
    const win = eval("window");

    injectStyle(doc);
    const { root, body, titleEl } = createPanel(doc, win);
    let stopped = false;
    root.querySelector(".bb-close").onclick = () => { stopped = true; };
    ns.atExit(() => root.remove());

    while (!stopped) {
        const snaps = {
            ctrl: readStatus(ns, STATUS_PORT_CONTROLLER),
            contracts: readStatus(ns, STATUS_PORT_CONTRACTS),
            pserver: readStatus(ns, STATUS_PORT_PSERVER),
            hacknet: readStatus(ns, STATUS_PORT_HACKNET),
            pilot: readStatus(ns, STATUS_PORT_PILOT),
            lifecycle: readStatus(ns, STATUS_PORT_LIFECYCLE),
        };
        // Live title: "Dashboard - <Controller> · <income>/s · <n> tgt".
        const c = snaps.ctrl;
        titleEl.textContent = c
            ? `Dashboard - ${capitalize(c.stage || "controller")} · ${fmtMoney(c.income)}/s · ${c.activeCount ?? 0} tgt`
            : "Dashboard - Offline";
        body.innerHTML = render(snaps);
        await ns.sleep(1000);
    }
}

// ── DOM scaffolding ──────────────────────────────────────────────────────────

/** Build (or reuse) the panel: a fixed container with a draggable header and a body
 *  div that render() refills each tick. Returns { root, body }. */
function createPanel(doc, win) {
    doc.getElementById(ROOT_ID)?.remove(); // clear a stale panel from a previous run
    const root = doc.createElement("div");
    root.id = ROOT_ID;

    const header = doc.createElement("div");
    header.className = "bb-header";
    header.innerHTML = `<span class="bb-title">Dashboard</span><span class="bb-close" title="close">×</span>`;
    root.appendChild(header);

    const body = doc.createElement("div");
    body.className = "bb-body";
    body.innerHTML = `<div class="bb-empty">waiting for status…</div>`;
    root.appendChild(body);

    doc.body.appendChild(root);
    restorePos(root, win);
    makeDraggable(root, header, win);
    return { root, body, titleEl: header.querySelector(".bb-title") };
}

/** Restore the last saved top/left from localStorage (default top-right). */
function restorePos(root, win) {
    try {
        const saved = JSON.parse(win.localStorage.getItem(POS_KEY) || "null");
        if (saved && typeof saved.left === "number") {
            root.style.left = saved.left + "px";
            root.style.top = saved.top + "px";
            root.style.right = "auto";
            return;
        }
    } catch { /* fall through to default */ }
    root.style.top = "90px";
    root.style.right = "20px";
}

/** Drag the panel by its header; persist the resting position. */
function makeDraggable(root, header, win) {
    let dx = 0, dy = 0, dragging = false;
    header.addEventListener("mousedown", (e) => {
        if (e.target.classList.contains("bb-close")) return;
        dragging = true;
        const r = root.getBoundingClientRect();
        dx = e.clientX - r.left;
        dy = e.clientY - r.top;
        root.style.right = "auto";
        e.preventDefault();
    });
    win.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        root.style.left = (e.clientX - dx) + "px";
        root.style.top = (e.clientY - dy) + "px";
    });
    win.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        const r = root.getBoundingClientRect();
        try { win.localStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, top: r.top })); } catch { /* ignore */ }
    });
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render(snaps) {
    const now = Date.now();
    const c = snaps.ctrl;
    const parts = [];

    parts.push(renderKpis(c, now));
    parts.push(renderTargets(c));
    parts.push(renderScripts(snaps, now));
    parts.push(renderAlerts(snaps, now));

    return parts.join("");
}

function renderKpis(c, now) {
    if (!c) return `<div class="bb-section bb-offline">Controller offline — run booster.js or orbiter.js</div>`;
    const util = c.totalRam > 0 ? 1 - c.poolFree / c.totalRam : 0;
    const fillPct = c.depth > 0 ? c.inFlight / c.depth : 0;
    // Pool breakdown: free (green) / share (yellow) / everything else in use (red,
    // i.e. RAM the batcher + prep are consuming). share = shareThreads × SHARE_RAM;
    // used = total − free; batcher portion = used − share.
    const tot = c.totalRam || 1;
    const shareRam = (c.shareThreads || 0) * SHARE_RAM;
    const batcherRam = Math.max(0, (c.totalRam - c.poolFree) - shareRam);
    return `
    <div class="bb-section bb-poolrow">
      <div class="bb-poollabel">RAM POOL ${fmtRam(c.totalRam)} · ${Math.round(util * 100)}% used · rooted ${c.rooted}/${c.total}</div>
      ${stackBar([
          { frac: batcherRam / tot, color: "var(--bb-red)" },
          { frac: shareRam / tot, color: "var(--bb-amber)" },
          { frac: c.poolFree / tot, color: "var(--bb-green)" },
      ])}
      <div class="bb-legend">
        <span><i style="background:var(--bb-red)"></i>batcher ${fmtRam(batcherRam)}</span>
        <span><i style="background:var(--bb-amber)"></i>share ${fmtRam(shareRam)}</span>
        <span><i style="background:var(--bb-green)"></i>free ${fmtRam(c.poolFree)}</span>
      </div>
      <div class="bb-poollabel">PIPELINE ${fmtCount(c.inFlight)}/${fmtCount(c.depth)} (${Math.round(fillPct * 100)}%)</div>
      ${bar(fillPct, "var(--bb-green)")}
    </div>`;
}

/**
 * The target table: the best 20 servers by $/s in one ranked list, already ordered
 * and tagged by the controller. Colour by state — green = batching, blue = prepped
 * but idle (lost out on RAM this tick), red = prepping / needs prep. Idle and prepping
 * rows show money/sec/time/$/s only; hack-% and pipeline fill don't apply since nothing
 * is in flight for them yet.
 */
function renderTargets(c) {
    if (!c) return "";
    const rows = c.targets || [];
    if (rows.length === 0) return `<div class="bb-section bb-dim">No targets.</div>`;

    // The controller already ordered the list by whichever metric selectBatchers used
    // this tick. Mirror that in the value column + a badge so the order makes sense.
    const byIncome = c.rankByIncome !== false; // default $/s for older snapshots
    const metricHdr = byIncome ? "$/s" : "$/GB·s";
    const metricLabel = byIncome ? "ranked by $/s · RAM-rich" : "ranked by $/GB·s · RAM-limited";
    // score is $/(ms·GB); ×1000 → $/(s·GB) for a human-readable per-second figure.
    const metricVal = (t) => byIncome ? fmtMoney(t.income) : fmtMoney((t.score || 0) * 1000);

    const body = rows.map((t) => {
        let cls, hkCell, fillCell;
        if (t.kind === "active") {
            cls = "bb-row-green";
            const fillFrac = t.depth > 0 ? t.committed / t.depth : 0;
            hkCell = `<td class="bb-num">${Math.round(t.f * 100)}%</td>`;
            fillCell = `<td class="bb-fill">${miniBar(fillFrac)}<span class="bb-filltxt">${fmtCount(t.committed)}/${fmtCount(t.depth)}</span></td>`;
        } else {
            cls = t.kind === "prepping" ? "bb-row-red" : "bb-row-blue";
            hkCell = `<td class="bb-num bb-dim">—</td>`;
            fillCell = `<td class="bb-fill bb-dim">—</td>`;
        }
        return `<tr class="${cls}">
          <td class="bb-host">${t.host}</td>
          <td class="bb-num">${Math.round(t.moneyFrac * 100)}%</td>
          <td class="bb-num">+${t.secOver.toFixed(2)}</td>
          ${hkCell}
          <td class="bb-num bb-dim">${fmtTime(t.time)}</td>
          ${fillCell}
          <td class="bb-num bb-green">${metricVal(t)}</td>
        </tr>`;
    }).join("");
    return `
    <div class="bb-section">
      <div class="bb-label">TARGETS · ${metricLabel}</div>
      <table class="bb-table">
        <thead><tr><th>TARGET</th><th>MON</th><th>SEC</th><th>HK</th><th>TIME</th><th>FILL</th><th>${metricHdr}</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderScripts(snaps, now) {
    const c = snaps.ctrl;
    const rows = [];

    rows.push(managerRow("contracts", snaps.contracts, now,
        snaps.contracts ? [
            ["solved", fmtCount(snaps.contracts.solved)],
            ["failed", fmtCount(snaps.contracts.failed)],
            ["skipped", fmtCount(snaps.contracts.skipped)],
        ] : []));
    rows.push(managerRow("pserver", snaps.pserver, now,
        snaps.pserver ? [
            ["fleet", `${snaps.pserver.count}/${snaps.pserver.limit}`],
            ["RAM", fmtRam(snaps.pserver.fleetRam)],
            ["income", fmtMoney(snaps.pserver.income) + "/s"],
            ["next cost", fmtMoney(snaps.pserver.nextCost)],
        ] : []));
    rows.push(managerRow("hacknet", snaps.hacknet, now,
        snaps.hacknet ? [
            ["nodes", `${snaps.hacknet.nodes}/${snaps.hacknet.maxNodes ?? "∞"}`],
            ["production", fmtMoney(snaps.hacknet.production) + "/s"],
            ["horizon", `${snaps.hacknet.horizonHrs.toFixed(1)}h`],
            ["next cost", fmtMoney(snaps.hacknet.nextCost)],
        ] : []));
    rows.push(managerRow("pilot", snaps.pilot, now,
        snaps.pilot ? [
            ["programs", `${snaps.pilot.programs.owned}/${snaps.pilot.programs.total}`],
            ["backdoors", `${snaps.pilot.backdoors.done.length}/${snaps.pilot.backdoors.done.length + snaps.pilot.backdoors.pending.length}`],
            ["factions", fmtCount(snaps.pilot.factions)],
            ["ladder", snaps.pilot.focusOwner ?? "—"],
            ["grinding", snaps.pilot.augs?.grindTarget ? `${snaps.pilot.augs.grindTarget.aug} - ${snaps.pilot.augs.grindTarget.faction}` : "—"],
        ] : [], PILOT_STALE_MS));
    rows.push(managerRow("lifecycle", snaps.lifecycle, now,
        snaps.lifecycle ? [
            ["augs ready", fmtCount(snaps.lifecycle.readyCount)],
            ["run age", `${snaps.lifecycle.runHrs.toFixed(1)}h`],
            ["no-unlock", `${snaps.lifecycle.stagnantMin.toFixed(0)}m`],
            ["auto-install", snaps.lifecycle.autoInstallArmed ? "ARMED" : "off"],
        ] : [], LIFECYCLE_STALE_MS));

    // Share row: state lives on the controller snapshot, not its own port.
    const shareState = !c ? "off" : c.shareOff ? "paused" : c.shareThreads > 0 ? "live" : "idle";
    const shareDot = shareState === "live" ? "ok" : shareState === "paused" ? "stale" : "idle";
    const shareStats = c ? [
        ["state", c.shareOff ? "paused" : c.shareThreads > 0 ? "sharing" : "idle"],
        ["threads", fmtCount(c.shareThreads || 0)],
        ["RAM", fmtRam((c.shareThreads || 0) * SHARE_RAM)],
    ] : [];
    rows.push(managerRowHtml("share", shareDot, c ? "" : "no controller publishing", shareStats));

    return `<div class="bb-section"><div class="bb-label">MANAGERS</div><div class="bb-mgrlist">${rows.join("")}</div></div>`;
}

/**
 * One manager status row: dot + name + last action on one line, then a single
 * compact stats line below (`label · value` pairs separated by `|`). `stats` is
 * [[label, value], ...]. Two lines per manager instead of three saves vertical space.
 */
function managerRow(name, snap, now, stats, staleMs = MGR_STALE_MS) {
    let dot = "idle", action = "no data yet";
    if (snap) {
        const age = now - (snap.ts || 0);
        const doneish = /done|maxed|exit|exhaust/i.test(snap.action || "");
        if (age > staleMs) dot = doneish ? "done" : "stale";
        else dot = "ok";
        action = snap.action || "";
    }
    return managerRowHtml(name, dot, action, stats);
}

function managerRowHtml(name, dot, action, stats) {
    const statsHtml = stats.map(([k, v]) => `<span class="bb-mgrstat"><span class="bb-mgrk">${k}</span> · ${v}</span>`).join(`<span class="bb-mgrsep">|</span>`);
    return `<div class="bb-mgrrow">
      <div class="bb-mgrhead"><span class="bb-dot bb-dot-${dot}"></span><span class="bb-mgrname">${name}</span>${action ? `<span class="bb-mgraction">${action}</span>` : ""}</div>
      <div class="bb-mgrstats">${statsHtml}</div>
    </div>`;
}

function renderAlerts(snaps, now) {
    const c = snaps.ctrl;
    const alerts = [];
    if (!c) alerts.push("Controller offline");
    else {
        if (c.tickGap > LAG_MS) alerts.push(`Engine lag: tick gap ${Math.round(c.tickGap)}ms`);
        if (c.totalRam > 0 && c.poolFree / c.totalRam < 0.03) alerts.push("Pool nearly full");
        if (c.shareOff) alerts.push("Share manually paused");
    }
    for (const [name, staleMs] of [["contracts", MGR_STALE_MS], ["pserver", MGR_STALE_MS], ["hacknet", MGR_STALE_MS], ["pilot", PILOT_STALE_MS], ["lifecycle", LIFECYCLE_STALE_MS]]) {
        const s = snaps[name];
        if (s && now - (s.ts || 0) > staleMs && !/done|maxed|exit|exhaust/i.test(s.action || "")) {
            alerts.push(`${name} not reporting`);
        }
    }
    if (snaps.pilot?.pendingInvites?.length > 0) {
        alerts.push(`Faction invite needs decision: ${snaps.pilot.pendingInvites.join(", ")}`);
    }
    if (snaps.lifecycle?.recommendInstall) {
        alerts.push(`Recommend aug install: ${snaps.lifecycle.reason}`);
    }
    if (snaps.lifecycle?.bnCompletable) {
        alerts.push("BitNode completable — run utils/finish-bn.js <nextBN>");
    }
    if (alerts.length === 0) return `<div class="bb-section bb-alerts bb-alerts-ok"><span class="bb-dot bb-dot-ok"></span>ALL SYSTEMS NOMINAL</div>`;
    return `<div class="bb-section bb-alerts bb-alerts-warn">⚠ ${alerts.join(" · ")}</div>`;
}

// ── Small HTML/format helpers ────────────────────────────────────────────────

function bar(frac, color) {
    const w = Math.max(0, Math.min(1, frac)) * 100;
    return `<div class="bb-bar"><div class="bb-barfill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>`;
}

/** A horizontally-stacked bar from segments [{ frac, color }] (fracs of the whole). */
function stackBar(segments) {
    const cells = segments
        .filter((s) => s.frac > 0)
        .map((s) => `<div class="bb-barfill" style="width:${(Math.min(1, s.frac) * 100).toFixed(1)}%;background:${s.color}"></div>`)
        .join("");
    return `<div class="bb-bar bb-stack">${cells}</div>`;
}

function miniBar(frac) {
    const w = Math.max(0, Math.min(1, frac)) * 100;
    const color = frac >= 0.99 ? "var(--bb-green)" : frac >= 0.85 ? "var(--bb-cyan)" : "var(--bb-amber)";
    return `<span class="bb-minibar"><span class="bb-minifill" style="width:${w.toFixed(0)}%;background:${color}"></span></span>`;
}

/** Compact money: $1.23k / m / b / t / q / Q (k=1e3 … q=quadrillion, Q=quintillion). */
function fmtMoney(n) {
    if (n == null || !isFinite(n)) return "$0";
    const neg = n < 0 ? "-" : "";
    n = Math.abs(n);
    const units = [["Q", 1e18], ["q", 1e15], ["t", 1e12], ["b", 1e9], ["m", 1e6], ["k", 1e3]];
    for (const [s, v] of units) if (n >= v) return `${neg}$${(n / v).toFixed(2)}${s}`;
    return `${neg}$${n.toFixed(0)}`;
}

/** Compact integer count (threads, pipeline depth): plain below 1,000,000, then
 *  m / b / t / q / Q suffixes. Counts are whole numbers, so no $/GB unit. */
function fmtCount(n) {
    if (n == null || !isFinite(n)) return "0";
    const neg = n < 0 ? "-" : "";
    n = Math.abs(n);
    if (n >= 1e6) {
        const units = [["Q", 1e18], ["q", 1e15], ["t", 1e12], ["b", 1e9], ["m", 1e6]];
        for (const [s, v] of units) if (n >= v) return `${neg}${(n / v).toFixed(2)}${s}`;
    }
    return neg + Math.round(n);
}

/** Capitalize the first letter (e.g. "orbiter" → "Orbiter"). */
function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Compact duration: "45s" / "1m23s" / "1h04m". */
function fmtTime(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60).toString().padStart(2, "0")}m`;
}

/** Compact RAM: MB / GB / TB / PB (input is GB, the Bitburner unit). */
function fmtRam(gb) {
    if (gb == null || !isFinite(gb)) return "0GB";
    const neg = gb < 0 ? "-" : "";
    gb = Math.abs(gb);
    if (gb >= 1e6) return `${neg}${(gb / 1e6).toFixed(2)}PB`;
    if (gb >= 1e3) return `${neg}${(gb / 1e3).toFixed(2)}TB`;
    if (gb >= 1) return `${neg}${gb.toFixed(0)}GB`;
    return `${neg}${(gb * 1024).toFixed(0)}MB`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

function injectStyle(doc) {
    // Reuse the tag if a previous run left one (it persists in <head> across script
    // restarts), so edits to the CSS take effect on the next run instead of being
    // ignored because an older stylesheet is still present.
    let style = doc.getElementById("bb-dashboard-style");
    if (!style) {
        style = doc.createElement("style");
        style.id = "bb-dashboard-style";
        doc.head.appendChild(style);
    }
    style.textContent = `
:root {
  --bb-green: #2ee6a6; --bb-cyan: #36c5f0; --bb-amber: #f0b132; --bb-red: #f0556a; --bb-blue: #4d9bff;
  --bb-bg: rgba(12,18,22,0.92); --bb-fg: #cfe8e3; --bb-dim: #6f8a86; --bb-line: rgba(54,197,240,0.18);
}
#${ROOT_ID} {
  position: fixed; z-index: 99999; width: 880px; max-height: 90vh; overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--bb-bg); color: var(--bb-fg);
  font-family: "JetBrains Mono","Consolas","Courier New",monospace; font-size: 18px; line-height: 1.45;
  border: 1px solid var(--bb-line); border-radius: 14px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.55); backdrop-filter: blur(6px);
}
#${ROOT_ID} .bb-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 11px 18px; cursor: move; user-select: none;
  background: linear-gradient(90deg, rgba(46,230,166,0.14), rgba(54,197,240,0.06));
  border-bottom: 1px solid var(--bb-line);
}
#${ROOT_ID} .bb-title { color: var(--bb-green); font-weight: 600; letter-spacing: 1.5px; font-size: 16px; }
#${ROOT_ID} .bb-close { cursor: pointer; color: var(--bb-dim); font-size: 24px; padding: 0 6px; }
#${ROOT_ID} .bb-close:hover { color: var(--bb-red); }
#${ROOT_ID} .bb-body { overflow-y: auto; padding: 6px 0; }
#${ROOT_ID} .bb-section { padding: 10px 18px; border-bottom: 1px solid rgba(54,197,240,0.07); }
#${ROOT_ID} .bb-label { color: var(--bb-dim); font-size: 17px; letter-spacing: 1.5px; margin-bottom: 8px; }
#${ROOT_ID} .bb-dim { color: var(--bb-dim); }
#${ROOT_ID} .bb-green { color: var(--bb-green); }
#${ROOT_ID} .bb-offline, #${ROOT_ID} .bb-empty { color: var(--bb-amber); text-align: center; padding: 22px; }

#${ROOT_ID} .bb-poolrow .bb-poollabel { color: var(--bb-dim); font-size: 17px; margin: 7px 0 3px; }
#${ROOT_ID} .bb-bar { height: 9px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; }
#${ROOT_ID} .bb-barfill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
#${ROOT_ID} .bb-stack { display: flex; }
#${ROOT_ID} .bb-stack .bb-barfill { border-radius: 0; }
#${ROOT_ID} .bb-legend { display: flex; gap: 16px; font-size: 13px; color: var(--bb-dim); margin: 5px 0 2px; }
#${ROOT_ID} .bb-legend i { display: inline-block; width: 11px; height: 11px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }

#${ROOT_ID} .bb-table { width: 100%; border-collapse: collapse; }
#${ROOT_ID} .bb-table th { color: var(--bb-dim); font-size: 16px; text-align: right; padding: 4px 6px; letter-spacing: 0.5px; font-weight: 500; }
#${ROOT_ID} .bb-table th:first-child { text-align: left; }
#${ROOT_ID} .bb-table th:nth-child(6) { text-align: left; padding-left: 22px; } /* FILL */
#${ROOT_ID} .bb-table td:nth-child(6) { padding-left: 22px; } /* FILL */
#${ROOT_ID} .bb-table td { padding: 4px 6px; font-size: 16px; }
#${ROOT_ID} .bb-host { color: var(--bb-fg); }
#${ROOT_ID} .bb-num { text-align: right; font-variant-numeric: tabular-nums; }
#${ROOT_ID} .bb-fill { display: flex; align-items: center; gap: 8px; justify-content: flex-start; }
#${ROOT_ID} .bb-filltxt { color: var(--bb-dim); font-size: 17px; min-width: 52px; text-align: right; }
#${ROOT_ID} .bb-row-green .bb-host { border-left: 3px solid var(--bb-green); padding-left: 7px; }
#${ROOT_ID} .bb-row-red .bb-host { border-left: 3px solid var(--bb-red); padding-left: 7px; }
#${ROOT_ID} .bb-row-blue .bb-host { border-left: 3px solid var(--bb-blue); padding-left: 7px; }

#${ROOT_ID} .bb-minibar { display: inline-block; width: 72px; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; }
#${ROOT_ID} .bb-minifill { display: block; height: 100%; }
#${ROOT_ID} .bb-mgrlist { display: flex; flex-direction: column; gap: 6px; }
#${ROOT_ID} .bb-mgrrow { padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); }
#${ROOT_ID} .bb-mgrhead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
#${ROOT_ID} .bb-mgrname { color: var(--bb-fg); text-transform: capitalize; font-weight: 600; font-size: 16px; }
#${ROOT_ID} .bb-mgraction { color: var(--bb-dim); font-size: 13px; font-style: italic; }
#${ROOT_ID} .bb-mgrstats { display: flex; flex-wrap: wrap; gap: 8px; font-size: 14px; color: var(--bb-fg); }
#${ROOT_ID} .bb-mgrk { color: var(--bb-dim); }
#${ROOT_ID} .bb-mgrsep { color: var(--bb-dim); opacity: 0.5; margin: 0 2px; }
#${ROOT_ID} .bb-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
#${ROOT_ID} .bb-dot-ok { background: var(--bb-green); box-shadow: 0 0 8px var(--bb-green); }
#${ROOT_ID} .bb-dot-stale { background: var(--bb-red); box-shadow: 0 0 8px var(--bb-red); }
#${ROOT_ID} .bb-dot-done { background: var(--bb-blue); box-shadow: 0 0 8px var(--bb-blue); }
#${ROOT_ID} .bb-dot-idle { background: var(--bb-dim); }

#${ROOT_ID} .bb-alerts { font-size: 18px; border-bottom: none; }
#${ROOT_ID} .bb-alerts .bb-dot { margin-right: 8px; vertical-align: middle; }
#${ROOT_ID} .bb-alerts-ok { color: var(--bb-green); letter-spacing: 1px; }
#${ROOT_ID} .bb-alerts-warn { color: var(--bb-amber); }
`;
}
