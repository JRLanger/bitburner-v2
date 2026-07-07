/**
 * lib/tail-ui.js — text tail-window renderer with dashboard information parity.
 *
 * Renders the controller's tail from the SAME snapshot object buildSnapshot already
 * publishes to the status bus for dashboard.js — one source of truth, two views. Shows
 * everything the dashboard shows: pool usage breakdown (batcher/share/free), pipeline
 * fill, the ranked target table tagged by state (attacking / prepping / prepped-idle),
 * ranking mode, share state, manager status lines (read from their status ports), and
 * alerts (engine lag, pool nearly full, share paused).
 *
 * SAFE TO IMPORT ANYWHERE: uses only 0-GB NS calls (print/clearLog, ns.format.*, port
 * peeks via lib/status.js), so importing it adds no RAM to booster/orbiter.
 */

import {
    LOOP_SLEEP,
    SHARE_RAM,
    STATUS_PORT_CONTRACTS,
    STATUS_PORT_PSERVER,
    STATUS_PORT_HACKNET,
    STATUS_PORT_PILOT,
    STATUS_PORT_LIFECYCLE,
    PILOT_LOOP_SLEEP,
    LIFECYCLE_LOOP_SLEEP,
} from "/config/constants.js";
import { readStatus } from "/lib/status.js";

/** Manager stale threshold, ms (managers loop every 10s — mirror dashboard.js). */
const MGR_STALE_MS = 25000;
// Slow-tick managers publish less often — stale only past 2.5x their own period.
const PILOT_STALE_MS = 2.5 * PILOT_LOOP_SLEEP;
const LIFECYCLE_STALE_MS = 2.5 * LIFECYCLE_LOOP_SLEEP;
/** Inner width of the box (characters after the border glyph). */
const W = 78;

/** Render one full tail frame from a controller status snapshot (see buildSnapshot). */
export function renderTail(ns, snap) {
    ns.clearLog();
    const fmt = ns.format;
    const stage = (snap.stage || "controller").toUpperCase();

    // ── Header / KPIs ──
    const title = `╔═ ${stage} ═ ${new Date().toLocaleTimeString()} `;
    ns.print(title + "═".repeat(Math.max(0, W - title.length + 1)));
    const usedFrac = snap.totalRam > 0 ? 1 - snap.poolFree / snap.totalRam : 0;
    ns.print(
        `║ Lv ${snap.level}  |  Rooted ${snap.rooted}/${snap.total}  |  ` +
        `Pool ${fmt.ram(snap.totalRam)} · ${Math.round(usedFrac * 100)}% used · ${fmt.ram(snap.poolFree)} free`
    );
    const shareRam = (snap.shareThreads || 0) * SHARE_RAM;
    const fillPct = snap.depth > 0 ? Math.round((snap.inFlight / snap.depth) * 100) : 0;
    const ramp = snap.topRampF > 0
        ? `Ramp ${Math.round(snap.topRampF * 100)}%${snap.rampSaturated ? " SAT" : ""}  |  `
        : "";
    ns.print(
        `║ Attacking ${snap.activeCount}  |  Prepping ${snap.prepCount ?? "?"}  |  ${ramp}` +
        `Pipeline ${snap.inFlight}/${snap.depth} (${fillPct}%)  |  $${fmt.number(snap.income)}/s`
    );
    const shareLine = snap.shareOff
        ? "Share OFF (manual — /utils/share-on.js to resume)"
        : `Share ${snap.shareThreads || 0} thr (${fmt.ram(shareRam)})`;
    const mode = snap.rankByIncome ? "ranked by $/s · RAM-rich" : "ranked by $/GB·s · RAM-limited";
    ns.print(`║ ${shareLine}  |  ${mode}`);

    // ── Target table (same ranked, state-tagged list the dashboard shows) ──
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(
        "║ " + "TARGET".padEnd(17) + "ST".padEnd(5) + "MON%".padStart(5) + "SEC".padStart(7) +
        "HK%".padStart(5) + "TIME".padStart(7) + "FILL".padStart(10) +
        (snap.rankByIncome ? "$/s" : "$/GB·s").padStart(11)
    );
    for (const t of snap.targets || []) {
        const st = t.kind === "active" ? "ATK" : t.kind === "prepping" ? "PRE" : "IDL";
        const hk = t.kind === "active" ? `${Math.round(t.f * 100)}%` : "—";
        const fill = t.kind === "active" ? `${t.committed}/${t.depth}` : "—";
        // score is $/(ms·GB); ×1000 → $/(s·GB), mirroring the dashboard's metric column.
        const metric = snap.rankByIncome ? t.income : (t.score || 0) * 1000;
        ns.print(
            "║ " + t.host.padEnd(17) + st.padEnd(5) +
            `${Math.round(t.moneyFrac * 100)}%`.padStart(5) +
            `+${t.secOver.toFixed(2)}`.padStart(7) +
            hk.padStart(5) + fmtTime(t.time).padStart(7) + fill.padStart(10) +
            `$${fmt.number(metric)}`.padStart(11)
        );
    }

    // ── Managers (same status ports the dashboard reads) ──
    const now = Date.now();
    ns.print(`╠═ Managers ${"═".repeat(W - 11)}`);
    ns.print(`║ ${mgrLine("contracts", readStatus(ns, STATUS_PORT_CONTRACTS), now, (s) =>
        `solved ${s.solved ?? 0} · failed ${s.failed ?? 0} · skipped ${s.skipped ?? 0}`)}`);
    ns.print(`║ ${mgrLine("pserver", readStatus(ns, STATUS_PORT_PSERVER), now, (s) =>
        `fleet ${s.count}/${s.limit} · ${fmt.ram(s.fleetRam ?? 0)} · next $${fmt.number(s.nextCost ?? 0)}`)}`);
    ns.print(`║ ${mgrLine("hacknet", readStatus(ns, STATUS_PORT_HACKNET), now, (s) =>
        `nodes ${s.nodes}/${s.maxNodes ?? "∞"} · $${fmt.number(s.production ?? 0)}/s · next $${fmt.number(s.nextCost ?? 0)}`)}`);
    const pilotSnap = readStatus(ns, STATUS_PORT_PILOT);
    ns.print(`║ ${mgrLine("pilot", pilotSnap, now, (s) =>
        `programs ${s.programs.owned}/${s.programs.total} · backdoors ${s.backdoors.done.length}/${s.backdoors.done.length + s.backdoors.pending.length} · ladder ${s.focusOwner ?? "—"}`, PILOT_STALE_MS)}`);
    const lifecycleSnap = readStatus(ns, STATUS_PORT_LIFECYCLE);
    ns.print(`║ ${mgrLine("lifecycle", lifecycleSnap, now, (s) =>
        `ready ${s.readyCount} · run ${s.runHrs.toFixed(1)}h · no-unlock ${s.stagnantMin.toFixed(0)}m · auto-install ${s.autoInstallArmed ? "ARMED" : "off"}`, LIFECYCLE_STALE_MS)}`);

    // ── Alerts (same rules as dashboard.js renderAlerts) ──
    const alerts = [];
    if (snap.tickGap > 2 * LOOP_SLEEP) alerts.push(`engine lag ${Math.round(snap.tickGap)}ms`);
    if (snap.totalRam > 0 && snap.poolFree / snap.totalRam < 0.03) alerts.push("pool nearly full");
    if (snap.shareOff) alerts.push("share manually paused");
    if (pilotSnap?.pendingInvites?.length > 0) alerts.push(`faction invite needs decision: ${pilotSnap.pendingInvites.join(", ")}`);
    if (lifecycleSnap?.recommendInstall) alerts.push(`recommend aug install: ${lifecycleSnap.reason}`);
    if (lifecycleSnap?.bnCompletable) alerts.push("BitNode completable — run utils/finish-bn.js <nextBN>");
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(alerts.length === 0 ? "║ ✓ all systems nominal" : `║ ⚠ ${alerts.join(" · ")}`);
    ns.print(`╚${"═".repeat(W)}`);
}

/** One manager line: status glyph + name + key stats (or last action / no data). */
function mgrLine(name, snap, now, stats, staleMs = MGR_STALE_MS) {
    if (!snap) return `· ${name.padEnd(10)} no data yet`;
    const age = now - (snap.ts || 0);
    const doneish = /done|maxed|exit|exhaust/i.test(snap.action || "");
    const glyph = age <= staleMs ? "●" : doneish ? "◦" : "✕";
    const suffix = age > staleMs && !doneish ? "  [not reporting]" : "";
    let detail;
    try {
        detail = stats(snap);
    } catch {
        detail = snap.action || "";
    }
    return `${glyph} ${name.padEnd(10)} ${detail}${suffix}`;
}

/** Compact duration from ms: "45s" / "1m23s" / "1h04m" (mirrors dashboard.js). */
function fmtTime(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60).toString().padStart(2, "0")}m`;
}
