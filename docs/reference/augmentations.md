# Bitburner Augmentation Reference

Source: `src/Augmentation/Augmentations.ts`, `Enums.ts`, `CircadianModulator.ts` — tag **v3.0.1** (github.com/bitburner-official/bitburner-src). Fetched 2026-07-06.

**137 augmentations**, verified 1:1 against the `AugmentationName` enum (no gaps, no extras). Prices/rep are BASE values (live game inflates prices ~1.9× per purchase within a run). Multiplier names are game-source names (`hacking`, `hacking_speed`, `faction_rep`, …). Machine-readable form in `augmentations.json`.

| Name | Factions | Base Cost | Base Rep | Prereqs | Effects | Notes |
|---|---|---|---|---|---|---|
| ADR-V1 Pheromone Gene | Tian Di Hui, The Syndicate, NWO, MegaCorp, Four Sigma | $17.5m | 3.75k | — | charisma_exp +5%, faction_rep +10%, company_rep +10% |  |
| ADR-V2 Pheromone Gene | Silhouette, Four Sigma, Bachman & Associates, Clarke Incorporated | $550m | 62.5k | — | charisma +10%, faction_rep +20%, company_rep +20% |  |
| Artificial Bio-neural Network Implant | BitRunners, Fulcrum Secret Technologies | $3b | 275k | — | hacking +12%, hacking_speed +3%, hacking_money +15% |  |
| Artificial Synaptic Potentiation | The Black Hand, NiteSec | $80m | 6.25k | — | hacking_exp +5%, hacking_speed +2%, hacking_chance +5% |  |
| Augmented Targeting I | Slum Snakes, The Dark Army, The Syndicate, Sector-12, Ishima, OmniTek Incorporated, Kuai Gong International, Blade Industries | $15m | 5k | — | dexterity +10% |  |
| Augmented Targeting II | The Dark Army, The Syndicate, Sector-12, OmniTek Incorporated, Kuai Gong International, Blade Industries | $42.5m | 8.75k | Augmented Targeting I | dexterity +20% |  |
| Augmented Targeting III | The Dark Army, The Syndicate, OmniTek Incorporated, Kuai Gong International, Blade Industries, The Covenant | $115m | 27.5k | Augmented Targeting II, Augmented Targeting I | dexterity +30% |  |
| BigD's Big ... Brain | — | $inft | infm | — | hacking +100%, hacking_exp +100%, hacking_speed +100%, hacking_money +100%, hacking_grow +100%, hacking_chance +100%, strength +100%, strength_exp +100%, defense +100%, defense_exp +100%, dexterity +100%, dexterity_exp +100%, agility +100%, agility_exp +100%, charisma +100%, charisma_exp +100%, faction_rep +100%, company_rep +100%, crime_success +100%, crime_money +100%, work_money +100%, hacknet_node_money +100%, hacknet_node_purchase_cost -50%, hacknet_node_ram_cost -50%, hacknet_node_core_cost -50%, hacknet_node_level_cost -50%, bladeburner_max_stamina +100%, bladeburner_stamina_gain +100%, bladeburner_analysis +100%, bladeburner_success_chance +100% | Special augmentation Grants starting money: 1e12 Grants programs: bruteSsh, ftpCrack, relaySmtp, httpWorm, sqlInject, deepScan1, deepScan2, serverProfiler, autoLink, formulas |
| Bionic Arms | Tetrads | $275m | 62.5k | — | strength +30%, dexterity +30% |  |
| Bionic Legs | Speakers For The Dead, The Syndicate, Kuai Gong International, OmniTek Incorporated, Blade Industries | $375m | 150k | — | agility +60% |  |
| Bionic Spine | Speakers For The Dead, The Syndicate, Kuai Gong International, OmniTek Incorporated, Blade Industries | $125m | 45k | — | strength +15%, defense +15%, dexterity +15%, agility +15% |  |
| BitRunners Neurolink | BitRunners | $4.38b | 875k | — | hacking +15%, hacking_exp +20%, hacking_chance +10%, hacking_speed +5% | Grants programs: FTPCrack.exe, relaySMTP.exe |
| BitWire | CyberSec, NiteSec | $10m | 3.75k | — | hacking +5% |  |
| Blade's Runners | Bladeburners | $8.25b | 20k | — | agility +5%, bladeburner_max_stamina +5%, bladeburner_stamina_gain +5% | isSpecial (Bladeburner) |
| BLADE-51b Tesla Armor | Bladeburners | $1.38b | 12.5k | — | strength +4%, defense +4%, dexterity +4%, agility +4%, bladeburner_stamina_gain +2%, bladeburner_success_chance +3% | isSpecial (Bladeburner); base of the BLADE-51b Tesla Armor upgrade chain |
| BLADE-51b Tesla Armor: Energy Shielding Upgrade | Bladeburners | $5.5b | 21.2k | BLADE-51b Tesla Armor | defense +5%, bladeburner_success_chance +6% | Special augmentation |
| BLADE-51b Tesla Armor: IPU Upgrade | Bladeburners | $1.1b | 15k | BLADE-51b Tesla Armor | bladeburner_analysis +15%, bladeburner_success_chance +2% | Special augmentation |
| BLADE-51b Tesla Armor: Omnibeam Upgrade | Bladeburners | $27.5b | 62.5k | BLADE-51b Tesla Armor: Unibeam Upgrade | bladeburner_success_chance +10% | Special augmentation |
| BLADE-51b Tesla Armor: Power Cells Upgrade | Bladeburners | $2.75b | 18.8k | BLADE-51b Tesla Armor | bladeburner_max_stamina +5%, bladeburner_stamina_gain +2%, bladeburner_success_chance +5% | Special augmentation |
| BLADE-51b Tesla Armor: Unibeam Upgrade | Bladeburners | $16.5b | 31.2k | BLADE-51b Tesla Armor | bladeburner_success_chance +8% | Special augmentation |
| BrachiBlades | The Syndicate | $90m | 12.5k | — | strength +15%, defense +15%, crime_success +10%, crime_money +15% |  |
| CashRoot Starter Kit | Sector-12 | $125m | 12.5k | — | — | Grants starting money: 1e6 Grants programs: bruteSsh |
| Combat Rib I | Slum Snakes, The Dark Army, The Syndicate, Volhaven, Ishima, OmniTek Incorporated, Kuai Gong International, Blade Industries | $23.8m | 7.5k | — | strength +10%, defense +10% |  |
| Combat Rib II | The Dark Army, The Syndicate, Volhaven, OmniTek Incorporated, Kuai Gong International, Blade Industries | $65m | 18.8k | Combat Rib I | strength +14%, defense +14% |  |
| Combat Rib III | The Dark Army, The Syndicate, OmniTek Incorporated, Kuai Gong International, Blade Industries, The Covenant | $120m | 35k | Combat Rib II, Combat Rib I | strength +18%, defense +18% |  |
| CordiARC Fusion Reactor | MegaCorp | $5b | 1.12m | — | strength +35%, strength_exp +35%, defense +35%, defense_exp +35%, dexterity +35%, dexterity_exp +35%, agility +35%, agility_exp +35% |  |
| Cranial Signal Processors - Gen I | CyberSec, NiteSec | $70m | 10k | — | hacking +5%, hacking_speed +1% |  |
| Cranial Signal Processors - Gen II | CyberSec, NiteSec | $125m | 18.8k | Cranial Signal Processors - Gen I | hacking +7%, hacking_speed +2%, hacking_chance +5% |  |
| Cranial Signal Processors - Gen III | NiteSec, The Black Hand, BitRunners | $550m | 50k | Cranial Signal Processors - Gen II, Cranial Signal Processors - Gen I | hacking +9%, hacking_speed +2%, hacking_money +15% |  |
| Cranial Signal Processors - Gen IV | The Black Hand, BitRunners | $1.1b | 125k | Cranial Signal Processors - Gen III, Cranial Signal Processors - Gen II, Cranial Signal Processors - Gen I | hacking_speed +2%, hacking_money +20%, hacking_grow +25% |  |
| Cranial Signal Processors - Gen V | BitRunners | $2.25b | 250k | Cranial Signal Processors - Gen IV, Cranial Signal Processors - Gen III, Cranial Signal Processors - Gen II, Cranial Signal Processors - Gen I | hacking +30%, hacking_money +25%, hacking_grow +75% |  |
| CRTX42-AA Gene Modification | NiteSec | $225m | 45k | — | hacking +8%, hacking_exp +15% |  |
| DataJack | BitRunners, The Black Hand, NiteSec, Chongqing, NewTokyo | $450m | 112k | — | hacking_money +25% |  |
| DermaForce Particle Barrier | Volhaven | $50m | 15k | — | defense +40%, charisma +5% |  |
| ECorp HVMind Implant | ECorp | $5.5b | 1.5m | — | hacking_grow +200% |  |
| Eloquence Module | Speakers For The Dead | $250m | 25k | — | charisma +5%, crime_success +10%, work_money +20% |  |
| Embedded Netburner Module | BitRunners, The Black Hand, NiteSec, ECorp, MegaCorp, Fulcrum Secret Technologies, NWO, Blade Industries | $250m | 15k | — | hacking +8% |  |
| Embedded Netburner Module Analyze Engine | ECorp, MegaCorp, Fulcrum Secret Technologies, NWO, Daedalus, The Covenant, Illuminati | $6b | 625k | Embedded Netburner Module | hacking_speed +10% |  |
| Embedded Netburner Module Core Implant | BitRunners, The Black Hand, ECorp, MegaCorp, Fulcrum Secret Technologies, NWO, Blade Industries | $2.5b | 175k | Embedded Netburner Module | hacking +7%, hacking_exp +7%, hacking_speed +3%, hacking_money +10%, hacking_chance +3% |  |
| Embedded Netburner Module Core V2 Upgrade | BitRunners, ECorp, MegaCorp, Fulcrum Secret Technologies, NWO, Blade Industries, OmniTek Incorporated, Kuai Gong International | $4.5b | 1m | Embedded Netburner Module Core Implant, Embedded Netburner Module | hacking +8%, hacking_exp +15%, hacking_speed +5%, hacking_money +30%, hacking_chance +5% |  |
| Embedded Netburner Module Core V3 Upgrade | ECorp, MegaCorp, Fulcrum Secret Technologies, NWO, Daedalus, The Covenant, Illuminati | $7.5b | 1.75m | Embedded Netburner Module Core V2 Upgrade, Embedded Netburner Module Core Implant, Embedded Netburner Module | hacking +10%, hacking_exp +25%, hacking_speed +5%, hacking_money +40%, hacking_chance +10% |  |
| Embedded Netburner Module Direct Memory Access Upgrade | ECorp, MegaCorp, Fulcrum Secret Technologies, NWO, Daedalus, The Covenant, Illuminati | $7b | 1m | Embedded Netburner Module | hacking_money +40%, hacking_chance +20% |  |
| EMS-4 Recombination | Bladeburners | $275m | 2.5k | — | bladeburner_stamina_gain +2%, bladeburner_analysis +5%, bladeburner_success_chance +3% | Special augmentation |
| Enhanced Myelin Sheathing | Fulcrum Secret Technologies, BitRunners, The Black Hand | $1.38b | 100k | — | hacking +8%, hacking_exp +10%, hacking_speed +3% |  |
| Enhanced Social Interaction Implant | Bachman & Associates, NWO, Clarke Incorporated, OmniTek Incorporated, Four Sigma | $1.38b | 375k | — | charisma +60%, charisma_exp +60% |  |
| EsperTech Bladeburner Eyewear | Bladeburners | $165m | 1.25k | — | dexterity +5%, bladeburner_success_chance +3% | Special augmentation |
| FocusWire | Bachman & Associates, Clarke Incorporated, Four Sigma, Kuai Gong International | $900m | 75k | — | hacking_exp +5%, strength_exp +5%, defense_exp +5%, dexterity_exp +5%, agility_exp +5%, charisma_exp +5%, company_rep +10%, work_money +20% |  |
| Glibness Enhancement | Tetrads, Bladeburners | $2.5b | 40.5k | — | charisma_exp +20%, company_rep +10% |  |
| Golden Tongue Module | Speakers For The Dead | $125m | 125k | — | charisma +10%, charisma_exp +30% |  |
| GOLEM Serum | Bladeburners | $11b | 31.2k | — | strength +7%, defense +7%, dexterity +7%, agility +7%, bladeburner_stamina_gain +5% | Special augmentation |
| Graphene Bionic Arms Upgrade | The Dark Army | $3.75b | 500k | Bionic Arms | strength +85%, dexterity +85% |  |
| Graphene Bionic Legs Upgrade | MegaCorp, ECorp, Fulcrum Secret Technologies | $4.5b | 750k | Bionic Legs | agility +150% |  |
| Graphene Bionic Spine Upgrade | Fulcrum Secret Technologies, ECorp | $6b | 1.62m | Bionic Spine | strength +60%, defense +60%, dexterity +60%, agility +60% |  |
| Graphene Bone Lacings | Fulcrum Secret Technologies, The Covenant | $4.25b | 1.12m | — | strength +70%, defense +70% |  |
| Graphene BrachiBlades Upgrade | Speakers For The Dead | $2.5b | 225k | BrachiBlades | strength +40%, defense +40%, crime_success +10%, crime_money +30% |  |
| Hacknet Node Cache Architecture Neural-Upload | Netburners | $5.5m | 2.5k | — | hacknet_node_money +10%, hacknet_node_level_cost -15% |  |
| Hacknet Node Core Direct-Neural Interface | Netburners | $60m | 12.5k | — | hacknet_node_money +45% |  |
| Hacknet Node CPU Architecture Neural-Upload | Netburners | $11m | 3.75k | — | hacknet_node_money +15%, hacknet_node_purchase_cost -15% |  |
| Hacknet Node Kernel Direct-Neural Interface | Netburners | $40m | 7.5k | — | hacknet_node_money +25% |  |
| Hacknet Node NIC Architecture Neural-Upload | Netburners | $4.5m | 1.88k | — | hacknet_node_money +10%, hacknet_node_purchase_cost -10% |  |
| HemoRecirculator | Tetrads, The Dark Army, The Syndicate | $45m | 10k | — | strength +8%, defense +8%, dexterity +8%, agility +8%, charisma +8% |  |
| Hydroflame Left Arm | NWO | $2.5t | 1.25m | — | strength +180% |  |
| Hyperion Plasma Cannon V1 | Bladeburners | $2.75b | 12.5k | — | bladeburner_success_chance +6% | Special augmentation |
| Hyperion Plasma Cannon V2 | Bladeburners | $5.5b | 25k | Hyperion Plasma Cannon V1 | bladeburner_success_chance +8% | Special augmentation |
| HyperSight Corneal Implant | Blade Industries, Kuai Gong International | $2.75b | 150k | — | hacking_speed +3%, hacking_money +10%, dexterity +40%, charisma +3% |  |
| I.N.T.E.R.L.I.N.K.E.D | Bladeburners | $5.5b | 25k | — | strength_exp +5%, defense_exp +5%, dexterity_exp +5%, agility_exp +5%, bladeburner_max_stamina +10% | Special augmentation |
| INFRARET Enhancement | Ishima | $30m | 7.5k | — | dexterity +10%, crime_success +25%, crime_money +10% |  |
| LuminCloaking-V1 Skin Implant | Slum Snakes, Tetrads | $5m | 1.5k | — | agility +5%, charisma +3%, crime_money +10% |  |
| LuminCloaking-V2 Skin Implant | Slum Snakes, Tetrads | $30m | 5k | LuminCloaking-V1 Skin Implant | defense +10%, agility +10%, charisma_exp +10%, crime_money +25% |  |
| Magnetism Amplifier | The Black Hand, The Dark Army | $250m | 15k | — | charisma +5%, company_rep +10% |  |
| Nanofiber Weave | The Dark Army, The Syndicate, OmniTek Incorporated, Blade Industries, Tian Di Hui, Speakers For The Dead, Fulcrum Secret Technologies | $125m | 37.5k | — | strength +20%, defense +20%, charisma +5% |  |
| NEMEAN Subdermal Weave | The Syndicate, Fulcrum Secret Technologies, Illuminati, Daedalus, The Covenant | $3.25b | 875k | — | defense +120% |  |
| Neotra | Blade Industries | $2.88b | 562k | — | strength +55%, defense +55%, charisma +55% |  |
| Neural Accelerator | BitRunners | $1.75b | 200k | — | hacking +10%, hacking_exp +15%, hacking_money +20% |  |
| Neural Wit Amplifier | Slum Snakes, BitRunners | $10m | 5k | — | charisma +3%, charisma_exp +5%, company_rep +5% |  |
| Neural-Retention Enhancement | NiteSec | $250m | 20k | — | hacking_exp +25% |  |
| Neuralstimulator | The Black Hand, Chongqing, Sector-12, NewTokyo, Aevum, Ishima, Volhaven, Bachman & Associates, Clarke Incorporated, Four Sigma | $3b | 50k | — | hacking_exp +12%, hacking_speed +2%, hacking_chance +10% |  |
| Neuregen Gene Modification | Chongqing | $375m | 37.5k | — | hacking_exp +40% |  |
| NeuroFlux Governor | — | $750k | 500 | — | hacking +1%, hacking_exp +1%, hacking_speed +1%, hacking_money +1%, hacking_grow +1%, hacking_chance +1%, strength +1%, strength_exp +1%, defense +1%, defense_exp +1%, dexterity +1%, dexterity_exp +1%, agility +1%, agility_exp +1%, charisma +1%, charisma_exp +1%, crime_success +1%, crime_money +1%, faction_rep +1%, company_rep +1%, hacknet_node_money +1%, work_money +1%, work_rep +1%, work +1% | Infinitely repeatable (+1%/level). Infinitely repeatable (+1% per level, modified by CONSTANTS.Donations) |
| Neuronal Densification | Clarke Incorporated | $1.38b | 188k | — | hacking +15%, hacking_exp +10%, hacking_speed +3% |  |
| Neuroreceptor Management Implant | Tian Di Hui | $550m | 75k | — | — | Removes the penalty for not being focused while working (faction/company work at full rate without focus). No stat multipliers. |
| Neurotrainer I | CyberSec, Aevum | $4m | 1k | — | hacking_exp +10%, strength_exp +10%, defense_exp +10%, dexterity_exp +10%, agility_exp +10%, charisma_exp +10% |  |
| Neurotrainer II | BitRunners, NiteSec | $45m | 10k | — | hacking_exp +15%, strength_exp +15%, defense_exp +15%, dexterity_exp +15%, agility_exp +15%, charisma_exp +15% |  |
| Neurotrainer III | NWO, Four Sigma | $130m | 25k | — | hacking_exp +20%, strength_exp +20%, defense_exp +20%, dexterity_exp +20%, agility_exp +20%, charisma_exp +20% |  |
| nextSENS Gene Modification | Clarke Incorporated | $1.93b | 438k | — | hacking +20%, strength +20%, defense +20%, dexterity +20%, agility +20%, charisma +20% |  |
| Nuoptimal Nootropic Injector Implant | Tian Di Hui, Volhaven, NewTokyo, Chongqing, Clarke Incorporated, Four Sigma, Bachman & Associates | $20m | 5k | — | charisma +3%, company_rep +20% |  |
| NutriGen Implant | NewTokyo | $2.5m | 6.25k | — | strength_exp +20%, defense_exp +20%, dexterity_exp +20%, agility_exp +20% |  |
| OmniTek InfoLoad | OmniTek Incorporated | $2.88b | 625k | — | hacking +20%, hacking_exp +25% |  |
| ORION-MKIV Shoulder | Bladeburners | $550m | 6.25k | — | strength +5%, defense +5%, dexterity +5%, bladeburner_success_chance +4% | Special augmentation |
| PC Direct-Neural Interface | Four Sigma, OmniTek Incorporated, ECorp, Blade Industries | $3.75b | 375k | — | hacking +8%, company_rep +30% |  |
| PC Direct-Neural Interface NeuroNet Injector | Fulcrum Secret Technologies | $7.5b | 1.5m | PC Direct-Neural Interface | hacking +10%, hacking_speed +5%, company_rep +100% |  |
| PC Direct-Neural Interface Optimization Submodule | Fulcrum Secret Technologies, ECorp, Blade Industries | $4.5b | 500k | PC Direct-Neural Interface | hacking +10%, company_rep +75% |  |
| PCMatrix | Aevum | $2b | 100k | — | charisma +7.77%, charisma_exp +7.77%, faction_rep +7.77%, company_rep +7.77%, crime_success +7.77%, crime_money +7.77%, work_money +77.7% | Grants programs: deepScan1, autoLink |
| Photosynthetic Cells | Kuai Gong International | $2.75b | 562k | — | strength +40%, defense +40%, agility +40%, charisma +20% |  |
| Power Recirculation Core | Tetrads, The Dark Army, The Syndicate, NWO | $180m | 25k | — | hacking +5%, hacking_exp +10%, strength +5%, strength_exp +10%, defense +5%, defense_exp +10%, dexterity +5%, dexterity_exp +10%, agility +5%, agility_exp +10%, charisma +5%, charisma_exp +10% |  |
| QLink | Illuminati | $25t | 1.88m | — | hacking +75%, hacking_speed +100%, hacking_chance +150%, hacking_money +300% |  |
| SmartJaw | Bachman & Associates | $2.75b | 375k | — | charisma +50%, charisma_exp +50%, faction_rep +25%, company_rep +25% |  |
| SmartSonar Implant | Slum Snakes | $75m | 22.5k | — | dexterity +10%, dexterity_exp +15%, crime_money +25% |  |
| SoA - Beauty of Aphrodite | Shadows of Anarchy | $1m | 10k | — | charisma +10% | Special augmentation |
| SoA - Chaos of Dionysus | Shadows of Anarchy | $1m | 10k | — | — | Special augmentation |
| SoA - Flood of Poseidon | Shadows of Anarchy | $1m | 10k | — | — | Special augmentation |
| SoA - Hunt of Artemis | Shadows of Anarchy | $1m | 10k | — | — | Special augmentation |
| SoA - Knowledge of Apollo | Shadows of Anarchy | $1m | 10k | — | — | Special augmentation |
| SoA - Might of Ares | Shadows of Anarchy | $1m | 10k | — | — | Special augmentation |
| SoA - phyzical WKS harmonizer | Shadows of Anarchy | $1m | 10k | — | — | isSpecial (Shadows of Anarchy infiltration): makes infiltration easier/more productive — longer timers, higher rewards, reduced damage. |
| SoA - Trickery of Hermes | Shadows of Anarchy | $1m | 10k | — | — | Special augmentation |
| SoA - Wisdom of Athena | Shadows of Anarchy | $1m | 10k | — | — | Special augmentation |
| Social Dynamics Processor | MegaCorp, ECorp, OmniTek Incorporated | $1.2b | 225k | — | charisma +10%, company_rep +30% |  |
| Social Negotiation Assistant (S.N.A) | Tian Di Hui | $30m | 6.25k | — | charisma_exp +15%, faction_rep +15%, company_rep +15%, work_money +10% |  |
| Speech Enhancement | Tian Di Hui, Speakers For The Dead, Four Sigma, Kuai Gong International, Clarke Incorporated, Bachman & Associates | $12.5m | 2.5k | — | charisma +10%, company_rep +10% |  |
| Speech Processor Implant | Tian Di Hui, Chongqing, Sector-12, NewTokyo, Aevum, Ishima, Volhaven, Silhouette | $50m | 7.5k | — | charisma +20% |  |
| SPTN-97 Gene Modification | The Covenant | $4.88b | 1.25m | — | hacking +15%, strength +75%, defense +75%, dexterity +75%, agility +75% |  |
| Stanek's Gift - Awakening | ChurchOfTheMachineGod | $0 | 1m | Stanek's Gift - Genesis | — | Special augmentation Stanek's Gift augmentation Stanek's Gift aug: applies a small PENALTY multiplier (~0.9–1.0x, value shown as 'withGift / withoutGift' in source) to nearly all stats — the tradeoff for the Stanek grid. Not a normal-buy aug. |
| Stanek's Gift - Genesis | ChurchOfTheMachineGod | $0 | 0 | — | hacking -10%, hacking_exp -10%, hacking_speed -10%, hacking_money -10%, hacking_grow -10%, hacking_chance -10%, strength -10%, strength_exp -10%, defense -10%, defense_exp -10%, dexterity -10%, dexterity_exp -10%, agility -10%, agility_exp -10%, charisma -10%, charisma_exp -10%, faction_rep -10%, company_rep -10%, crime_success -10%, crime_money -10%, work_money -10%, hacknet_node_money -10%, hacknet_node_purchase_cost +10%, hacknet_node_ram_cost +10%, hacknet_node_core_cost +10%, hacknet_node_level_cost +10% | Special augmentation Stanek's Gift augmentation |
| Stanek's Gift - Serenity | ChurchOfTheMachineGod | $0 | 100m | Stanek's Gift - Awakening, Stanek's Gift - Genesis | — | Special augmentation Stanek's Gift augmentation Stanek's Gift aug: applies a small PENALTY multiplier (~0.9–1.0x, value shown as 'withGift / withoutGift' in source) to nearly all stats — the tradeoff for the Stanek grid. Not a normal-buy aug. |
| Synaptic Enhancement Implant | CyberSec, Aevum | $7.5m | 2k | — | hacking_speed +3% |  |
| Synfibril Muscle | Kuai Gong International, Fulcrum Secret Technologies, Speakers For The Dead, NWO, The Covenant, Daedalus, Illuminati, Blade Industries | $1.12b | 438k | — | strength +30%, defense +30% |  |
| Synthetic Heart | Kuai Gong International, Fulcrum Secret Technologies, Speakers For The Dead, NWO, The Covenant, Daedalus, Illuminati | $2.88b | 750k | — | strength +50%, agility +50%, charisma +30% |  |
| The B00ts of Perseus | — | $1m | 10k | The W1ngs of Icarus | dexterity +6%, charisma +6% | Special augmentation |
| The B1ade of Solomonoff | — | $1m | 10k | The L4w of Bayes | hacking +10%, charisma +10%, company_rep +10% | Special augmentation |
| The Black Hand | The Black Hand | $550m | 100k | — | hacking +10%, hacking_speed +2%, hacking_money +10%, strength +15%, dexterity +15% |  |
| The Blade's Simulacrum | Bladeburners | $150b | 1.25k | — | — | Special augmentation |
| The H4mmer of Daedalus | — | $1m | 10k | The B00ts of Perseus | strength +10%, charisma +7% | Special augmentation |
| The Illustrated Primer | The Dark Army, The Syndicate | $3.38b | 188k | — | charisma +10%, charisma_exp +40% |  |
| The L4w of Bayes | — | $1m | 10k | The St4ff of Asclepius | charisma +9%, company_rep +5% | Special augmentation |
| The Red Pill | Daedalus | $0 | 2.5m | — | — | Special augmentation |
| The Shadow's Simulacrum | The Syndicate, The Dark Army, Speakers For The Dead | $400m | 37.5k | — | faction_rep +15%, company_rep +15% |  |
| The St4ff of Asclepius | — | $1m | 10k | The H4mmer of Daedalus | defense +10%, charisma_exp +10% | Special augmentation |
| The W1ngs of Icarus | — | $1m | 10k | — | agility +10%, charisma +5% | Special augmentation |
| TITN-41 Gene-Modification Injection | Silhouette | $190m | 25k | — | charisma +15%, charisma_exp +15% |  |
| Unstable Circadian Modulator | Speakers for the Dead | $5b | 362k | — | — | Time-based: grants ONE randomly-rotating bonus set (changes hourly) from 7 possibilities (hacking, hacking-skill, combat, charisma, hacknet, work/rep, or crime). Effect is unpredictable — not a reliable priority pick. |
| Vangelis Virus | Bladeburners | $2.75b | 18.8k | — | dexterity_exp +10%, charisma_exp +10%, bladeburner_analysis +10%, bladeburner_success_chance +4% | Special augmentation |
| Vangelis Virus 3.0 | Bladeburners | $11b | 37.5k | Vangelis Virus | defense_exp +10%, dexterity_exp +10%, charisma_exp +10%, bladeburner_analysis +15%, bladeburner_success_chance +5% | Special augmentation |
| violet Congruity Implant | — | $50t | infm | — | — | Removes Entropy virus |
| Wired Reflexes | Tian Di Hui, Slum Snakes, Sector-12, Volhaven, Aevum, Ishima, The Syndicate, The Dark Army, Speakers For The Dead | $2.5m | 1.25k | — | dexterity +5%, agility +5% |  |
| Xanipher | NWO | $4.25b | 875k | — | hacking +20%, hacking_exp +15%, strength +20%, strength_exp +15%, defense +20%, defense_exp +15%, dexterity +20%, dexterity_exp +15%, agility +20%, agility_exp +15%, charisma +20%, charisma_exp +15% |  |
| Z.O.Ë. | — | $1t | infm | — | — | Special augmentation |
