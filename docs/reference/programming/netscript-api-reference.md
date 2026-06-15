# Bitburner NS API Reference

Source: https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.ns.md
Version: dev branch

---

## Basic Usage

```js
export async function main(ns) {
  ns.getHostname();           // direct ns functions
  ns.stock.getPrice();        // sub-namespace functions
  await ns.hack('n00dles');   // async functions must be awaited
}
```

---

## Namespaces (sub-properties)

| Property | Type | Description |
|----------|------|-------------|
| `ns.args` | `ScriptArg[]` | Arguments passed to the script (string, number, or boolean) |
| `ns.pid` | `number` | The current script's PID |
| `ns.bladeburner` | Bladeburner | Bladeburner functions ⚠️ spoilers |
| `ns.cloud` | Cloud | Purchased server functions (`getServerNames`, `purchaseServer`, `upgradeServer`, `getRamLimit`, `getServerCost`) |
| `ns.codingcontract` | CodingContract | Coding contract functions |
| `ns.corporation` | Corporation | Corporation functions ⚠️ spoilers |
| `ns.dnet` | Darknet | Darknet functions ⚠️ spoilers |
| `ns.enums` | NSEnums | Enum constants |
| `ns.format` | Format | Formatting functions (`number`, etc.) |
| `ns.formulas` | Formulas | Formulas functions (requires Formulas.exe) |
| `ns.gang` | Gang | Gang functions ⚠️ spoilers |
| `ns.go` | Go | Go (IPvGO) functions |
| `ns.grafting` | Grafting | Grafting functions ⚠️ spoilers |
| `ns.hacknet` | Hacknet | Hacknet node functions ⚠️ some spoilers |
| `ns.infiltration` | Infiltration | Infiltration functions |
| `ns.singularity` | Singularity | Singularity functions ⚠️ spoilers |
| `ns.sleeve` | Sleeve | Sleeve functions ⚠️ spoilers |
| `ns.stanek` | Stanek | Stanek's Gift functions ⚠️ spoilers |
| `ns.stock` | Stock | Stock market functions |
| `ns.ui` | UserInterface | UI functions (`openTail`, `closeTail`, `resizeTail`, `moveTail`) |

---

## Core Methods

### Hacking

| Method | Description |
|--------|-------------|
| `hack(host, opts?)` | Steal money from a server. Returns money stolen. |
| `grow(host, opts?)` | Increase money available on a server. Returns growth multiplier. |
| `weaken(host, opts?)` | Reduce server security level. Returns security reduced. |
| `hackAnalyze(host)` | Fraction of **current money** stolen per thread. Depends on security level and player skill. **Money-independent formula for thread count: `threads = f / hackAnalyze(host)`** |
| `hackAnalyzeThreads(host, hackAmount)` | Threads needed to steal `hackAmount`. **WARNING: divides by current server money — returns wrong values mid-cycle when money is not at max.** |
| `hackAnalyzeChance(host)` | Probability of a successful hack (0–1). |
| `hackAnalyzeSecurity(threads, host?)` | Security increase from hacking with N threads. |
| `growthAnalyze(host, multiplier, cores?)` | Threads needed for a given growth multiplier. |
| `growthAnalyzeSecurity(threads, host?, cores?)` | Security increase from growing with N threads. |
| `weakenAnalyze(threads, cores?)` | Security reduction from weakening with N threads. (Constant: 0.05 per thread, 1 core) |
| `getHackTime(host)` | Execution time of hack() in ms. |
| `getGrowTime(host)` | Execution time of grow() in ms. Always 3.2× hackTime. |
| `getWeakenTime(host)` | Execution time of weaken() in ms. Always 4× hackTime. |

### Server Info

| Method | Description |
|--------|-------------|
| `getServer(host)` | Full server data object. |
| `getServerMaxMoney(host)` | Maximum money available on server. |
| `getServerMoneyAvailable(host)` | Current money available on server. |
| `getServerMaxRam(host)` | Maximum RAM on server (GB). |
| `getServerUsedRam(host)` | Used RAM on server (GB). Includes blocked RAM on darknet servers. |
| `getServerSecurityLevel(host)` | Current security level. |
| `getServerMinSecurityLevel(host)` | Minimum security level. |
| `getServerBaseSecurityLevel(host)` | Base (starting) security level. |
| `getServerGrowth(host)` | Server growth parameter (affects grow() effectiveness). |
| `getServerRequiredHackingLevel(host)` | Hacking level required to hack. |
| `getServerNumPortsRequired(host)` | Ports that must be opened before NUKE.exe works. |
| `hasRootAccess(host)` | Whether you have root access. |
| `serverExists(host)` | Whether the server exists. |

### Network

| Method | Description |
|--------|-------------|
| `scan(host?, returnOpts?)` | List connected hostnames. Does not return darknet servers. |
| `nuke(host)` | Run NUKE.exe — gains root access if enough ports are open. |
| `brutessh(host)` | Run BruteSSH.exe — opens SSH port. |
| `ftpcrack(host)` | Run FTPCrack.exe — opens FTP port. |
| `relaysmtp(host)` | Run relaySMTP.exe — opens SMTP port. |
| `httpworm(host)` | Run HTTPWorm.exe — opens HTTP port. |
| `sqlinject(host)` | Run SQLInject.exe — opens SQL port. |
| `hasTorRouter()` | Whether player has darkweb access. |
| `dnsLookup(host)` | Hostname ↔ IP address conversion. |

### Script Execution

| Method | Description |
|--------|-------------|
| `exec(script, host, threadOrOptions, ...args)` | Start a script on any server. Returns PID or 0 on failure. |
| `run(script, threadOrOptions, ...args)` | Start a script on the current server. Returns PID or 0. |
| `kill(pid)` | Terminate script by PID. |
| `kill(filename, host, ...args)` | Terminate script by filename + host + args. |
| `killall(host, safetyGuard?)` | Terminate all scripts on a server. |
| `scriptKill(script, host)` | Kill all scripts with a given filename. |
| `ps(host?)` | List running scripts on a server. Returns array of `{filename, pid, args, ...}`. |
| `isRunning(script, host?, ...args)` | Check if a specific script is running. |
| `scriptRunning(script, host)` | Check if any script with this filename is running. |
| `spawn(script, threadOrOptions, ...args)` | Terminate current script and start another after a delay. |
| `exit()` | Terminate the current script immediately. |
| `self()` | Returns the currently running script object. |
| `getRunningScript(filename?, host?, ...args)` | General info about a running script. |
| `getRecentScripts()` | Recently killed scripts across all servers. |

### RAM

| Method | Description |
|--------|-------------|
| `getScriptRam(script, host?)` | RAM cost of a script in GB. |
| `getFunctionRamCost(name)` | RAM cost of a specific NS function. |
| `ramOverride(ram)` | Override static RAM allocation for current script. |

### Files

| Method | Description |
|--------|-------------|
| `scp(files, destination, source?)` | Copy files between servers. |
| `ls(host, substring?)` | List files on a server. Pass `.cct` to filter contracts. |
| `fileExists(filename, host?)` | Check if a file exists. |
| `rm(name, host?)` | Delete a file. |
| `mv(host, source, destination)` | Move/rename a file on a server. |
| `read(filename)` | Read content of a file. |
| `write(filename, data?, mode?)` | Write data to a file (`w` overwrite, `a` append). |
| `clear(handle)` | Clear file data. |
| `wget(url, target, host?)` | Download a file from the internet. |
| `getFileMetadata(filename)` | Metadata of a file. |

### Ports

| Method | Description |
|--------|-------------|
| `getPortHandle(portNumber)` | Get all data on a port. |
| `readPort(portNumber)` | Read and pop data from a port. |
| `peek(portNumber)` | Read without popping. |
| `writePort(portNumber, data)` | Write data to a port. |
| `tryWritePort(portNumber, data)` | Write only if port is not full. |
| `clearPort(portNumber)` | Clear all data from a port. |
| `nextPortWrite(port)` | Listen (await) for next port write. |

### Player & Stats

| Method | Description |
|--------|-------------|
| `getPlayer()` | Full player info object (skills, money, multipliers, etc.). |
| `getHackingLevel()` | Player's current hacking level. |
| `getHackingMultipliers()` | Hacking-related multipliers. |
| `getHacknetMultipliers()` | Hacknet-related multipliers. |
| `getMoneySources()` | Income breakdown by source for this run. |
| `getResetInfo()` | Information about past resets (augmentations, BitNodes). |
| `getBitNodeMultipliers(n?, lvl?)` | BitNode multipliers for a given node and level. |
| `getFavorToDonate()` | Faction favor required to be able to donate. |

### Sharing (Faction Reputation)

| Method | Description |
|--------|-------------|
| `share()` | **Shares server RAM with factions to increase faction reputation gain rate.** Blocks until script ends. RAM cost: 4 GB. |
| `getSharePower()` | Current share power value. Multiplicative effect on rep/second during **hacking work** for a faction. Non-linear effect on non-hacking work. Increases with more share threads at a sharply decreasing rate. **Does NOT affect hack income from servers.** |

### Logging & Output

| Method | Description |
|--------|-------------|
| `print(...args)` | Print to script's tail log. |
| `printf(format, ...args)` | Print formatted string to tail log. |
| `printRaw(node)` | Print a ReactNode to tail log. |
| `tprint(...args)` | Print to the Terminal. |
| `tprintf(format, ...values)` | Print formatted string to Terminal. |
| `tprintRaw(node)` | Print a ReactNode to Terminal. |
| `clearLog()` | Clear the script's tail log. |
| `disableLog(fn)` | Suppress log output for a given NS function name. Use `"ALL"` for all. |
| `enableLog(fn)` | Re-enable logging for a function. |
| `isLogEnabled(fn)` | Check if logging is enabled for a function. |
| `getScriptLogs(fn?, host?, ...args)` | Get all log lines for a script. |
| `alert(args)` | Open a message box popup. |
| `toast(msg, variant?, duration?)` | Show a bottom-right notification toast. |
| `prompt(txt, options?)` | Show an input modal dialog and await player response. |

### Script Income & Exp

| Method | Description |
|--------|-------------|
| `getScriptIncome(script?, host?, ...args)` | Income ($/sec) of a specific script. |
| `getScriptExpGain(script?, host?, ...args)` | Exp gain rate of a specific script. |
| `getTotalScriptIncome()` | Combined income of all running scripts. |
| `getTotalScriptExpGain()` | Combined exp gain of all running scripts. |

### Miscellaneous

| Method | Description |
|--------|-------------|
| `sleep(millis)` | Suspend script for N ms. Blocks concurrent calls. |
| `asleep(millis)` | Suspend for N ms. Does NOT block concurrent awaits. |
| `atExit(f, id?)` | Register a callback to run when the script dies. |
| `flags(schema)` | Parse command-line flags (typed, with defaults). |
| `getHostname()` | Hostname of the server this script is running on. |
| `getIP()` | IP address of the server this script is running on. |
| `dynamicImport(path)` | Dynamically import another script. Does not adjust RAM. |
| `sprintf(format, ...args)` | Format a string (printf-style). |
| `vsprintf(format, args)` | Format a string with an array of arguments. |

---

## Singularity Namespace (`ns.singularity`)

> ⚠️ **RAM cost multiplier without Source File 4:** All Singularity functions cost **16× their base RAM** until SF4 is obtained. This makes them unusable in most scripts before Singularity.

### RAM Cost Summary

| Condition | Multiplier |
|-----------|-----------|
| Before SF4 | ×16 |
| SF4 level 1 | ×16 |
| SF4 level 2 | ×4 |
| SF4 level 3 (max) | ×1 (normal cost) |

Functions are still callable before SF4 — they just cost 16× the RAM listed below.

### Key Functions Researched

These were researched for a planned "balanced mode faction rep check" in `gang.js`. All have a base cost of **5 GB** (×16 = **80 GB** each without SF4).

| Function | Base RAM | ×16 (pre-SF4) | Description |
|----------|----------|----------------|-------------|
| `ns.singularity.getFactionRep(faction)` | 5 GB | 80 GB | Returns current reputation with a faction |
| `ns.singularity.getAugmentationsFromFaction(faction)` | 5 GB | 80 GB | Returns list of augmentation names available from that faction |
| `ns.singularity.getAugmentationRepReq(augName)` | 5 GB | 80 GB | Returns reputation required to purchase a specific augmentation |
| `ns.singularity.getOwnedAugmentations(includeInstalled?)` | 5 GB | 80 GB | Returns list of augmentations owned (and optionally installed) |

**Total for all four calls: 20 GB base, 320 GB without SF4.** Not usable pre-Singularity.

### Deferred: Balanced Mode Reputation Check (gang.js)

The current `balanced` focus in `gang.js` splits earners 50/50 between respect and money tasks. A planned enhancement would:

1. Use `getAugmentationsFromFaction(faction)` to get available augments
2. Filter out already-owned augments using `getOwnedAugmentations()`
3. Find the most expensive unowned augment's rep requirement via `getAugmentationRepReq()`
4. Use `getFactionRep(faction)` to check current standing
5. Once rep ≥ threshold: switch from respect-focus to money-focus

**Implementation deferred until Singularity scripts are built.** Without SF4, the four calls would cost 320 GB combined — far too expensive to include in any practical script.

---

## HWGW Batcher Notes

### Thread count formula
```js
// CORRECT — money-independent:
const h = Math.ceil(f / ns.hackAnalyze(target));

// WRONG mid-cycle — divides by currentMoney, returns 2× when money = 50%:
const h = Math.ceil(ns.hackAnalyzeThreads(target, maxMoney * f));
```

### Timing ratios (single core, constants)
- `growTime = 3.2 × hackTime`
- `weakenTime = 4.0 × hackTime`
- `weaken reduces security by 0.05 per thread` (no API cost to hardcode this)
- `grow increases security by 0.004 per thread`
- `hack increases security by 0.002 per thread`

### Batch landing order (HWGW, gap = d ms)
```
H  lands at: weakenTime - d
W1 lands at: weakenTime
G  lands at: weakenTime + d
W2 lands at: weakenTime + 2d
```

### ns.share() — Faction Reputation Only
- `ns.share()` dedicates RAM to boosting faction reputation gain rate
- Does **not** affect hack income from servers
- `ns.getSharePower()` returns the current multiplier
- Useful when grinding faction rep; not useful when maximizing $/sec from hacking

---

## RAM Costs

### Worker script costs (confirmed)

| Script | RAM |
|--------|-----|
| hack.js worker | 1.70 GB |
| grow.js worker | 1.75 GB |
| weaken.js worker | 1.75 GB |

### Function costs (confirmed — partial list, not exhaustive)

These were verified in-game. RAM costs for unlisted functions are unknown.

| Function | RAM |
|----------|-----|
| Base cost (any script) | 1.60 GB |
| `exec` | 1.30 GB |
| `hackAnalyze` | 1.00 GB |
| `growthAnalyze` | 1.00 GB |
| `share` | 4.00 GB |
| `getServer` | 2.00 GB |
| `getPlayer` | 0.50 GB |
| `scp` | 0.60 GB |
| `scan` | 0.20 GB |
| `ps` | 0.20 GB |
| `fileExists` | 0.10 GB |
| `getServerNumPortsRequired` | 0.10 GB |
| `getServerMoneyAvailable` | 0.10 GB |
| `getServerMaxMoney` | 0.10 GB |
| `getServerSecurityLevel` | 0.10 GB |
| `getServerMinSecurityLevel` | 0.10 GB |
| `getScriptRam` | 0.10 GB |
| `getServerRequiredHackingLevel` | 0.10 GB |
| `brutessh` | 0.05 GB |
| `ftpcrack` | 0.05 GB |
| `relaysmtp` | 0.05 GB |
| `httpworm` | 0.05 GB |
| `sqlinject` | 0.05 GB |
| `hasRootAccess` | 0.05 GB |
| `nuke` | 0.05 GB |
| `getServerMaxRam` | 0.05 GB |
| `getServerUsedRam` | 0.05 GB |
| `getWeakenTime` | 0.05 GB |
| `getHackTime` | 0.05 GB |
| `getGrowTime` | 0.05 GB |
| `getHackingLevel` | 0.05 GB |

> **Note:** `growthAnalyze` costs 1.00 GB — not 1.75 GB. The 1.75 GB figure is the RAM cost of the grow.js worker *script*, not the API function.

### Formulas namespace (confirmed)

`ns.formulas.hacking.*` functions cost **0 GB RAM**. Access is gated by owning Formulas.exe, not by RAM allocation. This makes the entire Formulas API free to use in any script that already has Formulas.exe.

---

*Generated from dev branch. Re-fetch if API changes after a major update.*
