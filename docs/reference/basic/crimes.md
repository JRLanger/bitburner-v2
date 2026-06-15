# Crimes

Committing crimes is an active gameplay mechanic that allows the player to train their [Stats](stats.md) and potentially earn money. It also reduces your karma, and having low karma is a requirement of some factions.

The player can attempt to commit crimes by visiting `The Slums` through the `City` tab (Alt + w).
`The Slums` is available in every city.

## Basic Mechanics

When you visit `The Slums` you will see a list of buttons that show all of the available crimes.
Simply select one of the options to begin attempting that crime.
Attempting to commit a crime takes a certain amount of time.
This time varies between crimes.

While doing crimes, you can click `Do something else simultaneously` to be able to do things while you continue to do crimes in the background.
There is a 20% penalty to the related gains.
Clicking the `Focus` button under the overview will return you to the current task.

Crimes are not always successful.
Your rate of success is determined by your [Stats](stats.md) and [Augmentations](augmentations.md).
The odds can be seen on the crime-selection page.
If you are unsuccessful at committing a crime you will gain EXP, but you will not earn money.
If you are successful at committing the crime you will gain extra EXP (4x of what an unsuccessful attempt would give) and earn money.

Harder crimes are typically more profitable, and also give more EXP.

---

> Data extracted from `bitburner-official/bitburner-src`, dev branch (`src/Crime/Crimes.ts`, `src/Crime/Crime.ts`).

## Crime Data (from source)

| Crime | Time | Money | Difficulty | Raw $/sec |
|-------|------|-------|------------|-----------|
| **Heist** | 600s | $120,000,000 | 18 | **$200,000** |
| Assassination | 300s | $12,000,000 | 8 | $40,000 |
| Kidnap | 120s | $3,600,000 | 5 | $30,000 |
| Grand Theft Auto | 80s | $1,600,000 | 8 | $20,000 |
| Bond Forgery | 300s | $4,500,000 | 0.5 | $15,000 |
| Traffic Arms | 40s | $600,000 | 2 | $15,000 |
| Homicide | 3s | $45,000 | 1 | $15,000 |
| Deal Drugs | 10s | $120,000 | 1 | $12,000 |
| Mug | 4s | $36,000 | 0.2 | $9,000 |
| Larceny | 90s | $800,000 | 0.33 | $8,889 |
| Shoplift | 2s | $15,000 | 0.05 | $7,500 |
| Rob Store | 60s | $400,000 | 0.2 | $6,667 |

Raw $/sec assumes 100% success rate. Actual earnings = `money × successRate × Player.mults.crime_money`.

---

## Success Rate Formula (from `Crime.ts`)

```typescript
successRate(player): number {
  let chance =
    task.hacking_success_weight  * player.skills.hacking   +
    task.strength_success_weight * player.skills.strength  +
    task.defense_success_weight  * player.skills.defense   +
    task.dexterity_success_weight* player.skills.dexterity +
    task.agility_success_weight  * player.skills.agility   +
    task.charisma_success_weight * player.skills.charisma  +
    CONSTANTS.IntelligenceCrimeWeight * player.skills.intelligence;  // weight = 0.025

  chance /= CONSTANTS.MaxSkillLevel;   // 975
  chance /= task.difficulty;
  chance *= player.mults.crime_success;
  chance *= currentNodeMults.CrimeSuccessRate;
  chance *= calculateIntelligenceBonus(player.skills.intelligence, 1);

  return Math.min(chance, 1);
}
```

Key constants:
- `MaxSkillLevel = 975`
- `IntelligenceCrimeWeight = 0.025`
- Success is capped at 1.0 (100%)

---

## Most Lucrative Crime: Heist

**Heist** has a raw $/sec of $200,000 — 5× higher than second-place Assassination ($40,000/s).

Even with difficulty 18 (vs Assassination's 8), Heist only needs a **>20% success rate** to beat Assassination at 100% success:

```
Heist     at 20% success: 120,000,000 × 0.20 / 600 = $40,000/s  (tie)
Heist     at 25% success: 120,000,000 × 0.25 / 600 = $50,000/s  (wins)
```

For a player with crime_success augments (multiplier stacking), both crimes quickly reach near-100% success, and Heist dominates all others by a large margin.

### Early Game Exception

Before augments, if your stats are low enough that Heist success rate is under ~20%, Assassination or Kidnap may give better effective $/sec due to their lower difficulty. Once you have enough crime_success augments or high agility/dexterity, switch to Heist.

---

## Notes

- `Player.mults.crime_money` scales the final payout — augmentations that boost crime money directly improve income from player crimes.
- `Player.mults.crime_success` improves success rate — useful for reaching 100% success on harder crimes faster.
- **Neither of these multipliers affects gang member income** — they only apply when the player personally commits crimes via `ns.singularity.commitCrime()`.
- Intelligence provides a bonus to success rate via `calculateIntelligenceBonus(intelligence, 1)`, making it worth building for crime farming.
