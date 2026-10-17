# Pre-registration to eval-core mapping

Each `prereg/<tier>.json` field below maps to its counterpart in the
`eval-core` contracts the eidnara repository documents in `docs/evaluator.md`
at `bb866266c` (sections Paired statistics, Manifest `eval-manifest/v9`, and
Residual judge and the live slice). The harness consumes those contracts and
never redefines them. A field with no counterpart carries an extension note
naming the protocol version the counterpart would need; no extension is made
here, since every one is a versioned change in the eidnara repository.

`scripts/eval-core-mapping.test.ts` fails when a pre-registration field has no
row here.

Status values: `mapped` (the counterpart holds the same value), `partial` (the
counterpart holds part of the value; the note names the rest), `extension`
(no counterpart).

## Counterparts

- `CampaignProfile`: `noninferiority_margin`, `harm_bound`,
  `floor_threshold`, `miss_asymmetry_bound` (canonical decimals in `[0, 1]`),
  `liveness_bounds` (four counts in subsystem units).
- `AnalysisFamily` (`eval-analysis-family/v2`): `endpoints` (exactly the three
  gates), `families`, `exclusions`, `stopping_rule` (`fixed_n`),
  `multiplicity_correction` (`none` accepted), `profile`, `interval_method`
  (`cluster_bootstrap`), `item_count_threshold` (at least 300),
  `bootstrap_replicates` (40 to 10,000), `bootstrap_seed`, `trials_k`,
  `icc_pilot`, `transfer_criterion`.
- `Manifest` (`eval-manifest/v9`): `analysis_family_digest`, `claim_boundary`,
  `run_identity`, `sample_ids`.
- `LiveSettings` (`eval-live-settings/v1`): `providers`, `k`, `repeats`,
  `tasks`, `calibration`, `sampling`.

## Field table

| Field | Counterpart | Status | Note |
| --- | --- | --- | --- |
| `schema` | `AnalysisFamily.schema` | partial | `sim-prereg/v1` names this file; a frozen family under `eval-analysis-family/v3` would carry the projected values. |
| `tier` | none | extension | eval-core has no tier; `eval-analysis-family/v3` would name a campaign stage. One family per tier is the projection. |
| `revision` | `FrozenFamily` digest | partial | A revision bump changes the digest; eval-core has no revision counter. |
| `frozen` | `FrozenFamily::freeze` | partial | eval-core freezes by digest at `StartRun`; this flag records intent and the journaled hash is the authority. |
| `arms` | `Manifest.arm_rates` keys | partial | eval-core pairs exactly `aged` and `fresh`; three or four arms need `eval-manifest/v10` with named arms. |
| `arms.default` | none | extension | D1's declared default arm has no counterpart; `eval-manifest/v10`. Every gate contrasts this arm against `host`; `eidnara-kl` and `eidnara-cf` are comparison arms with no registered gate contrast. |
| `arms.run` | `Manifest.arm_rates` keys | partial | See `arms`. |
| `arms.order_by_seed` | `Manifest.sample_order` | partial | eval-core records an execution order over samples; the arm order per seed needs `eval-manifest/v10` run identity. The order is a Latin square at M; S, L, and XL have fewer seeds than arms, so their orders are partial rotations (`eidnara` is never first at S, `eidnara-cf` is never first at L, and XL has one seed). |
| `hosts` | `LiveSettings.providers` | partial | Providers are model profiles; the host binary is a run identity component. `eval-live-settings/v2` would add host binaries. |
| `seeds` | `run_identity` root seed; `ClusterKey.world_seed` | mapped | One root seed per paired run. |
| `scenario` | `component_versions.generator` | partial | The generator version is in the identity; scenario sizes are generator inputs with no field. `eval-manifest/v10`. |
| `scenario.simulated_days` | none | extension | `eval-manifest/v10` generator parameters. |
| `scenario.sessions_per_project` | none | extension | As above. |
| `scenario.forced_p90_sessions` | none | extension | As above (SIM-P09). |
| `scenario.cue_probe_similarity` | none | extension | Compile-time thresholds for SIM-P08, added in revision 2 before any run. `eval-manifest/v10` generator parameters. |
| `scenario.cue_probe_similarity.bm25_max` | none | extension | Highest permitted BM25 ratio of a probe against its cue. |
| `scenario.cue_probe_similarity.cosine_max` | none | extension | Highest permitted embedding cosine of a probe against its cue. |
| `scenario.cue_probe_similarity.embedding_model` | none | extension | The embedding model the thresholds apply to; the scenario manifest records the model it used. |
| `stopping_rule` | `AnalysisFamily.stopping_rule` | partial | `fixed_n` maps; CUSUM does not. |
| `stopping_rule.kind` | `StoppingRule::FixedN` | mapped | |
| `stopping_rule.paired_items_per_probe_type` | `FixedN { pairs }` | partial | Pooled over the tier's paired runs. eval-core fixes one pair count per family; the count times the number of probe types is the projected `pairs`. |
| `stopping_rule.cusum` | none | extension | eval-core refuses any stop before `pairs`. CUSUM harm and futility stops need `eval-analysis-family/v3` with a `cusum_harm_futility` stopping rule that yields no pass claim. |
| `stopping_rule.cusum[].kind` | none | extension | As above. |
| `stopping_rule.cusum[].metric` | none | extension | As above. |
| `stopping_rule.cusum[].k` | none | extension | As above. |
| `stopping_rule.cusum[].statistic` | none | extension | The monitored sequence, one value per completed paired item in issue order. |
| `stopping_rule.cusum[].sd_source` | none | extension | The A/A pairs whose spread standardises `k` and `h`; L uses M's. |
| `stopping_rule.cusum[].h` | none | extension | As above. |
| `missingness_policy` | `AnalysisFamily.exclusions` | partial | eval-core records exclusions as text; the policy fields are their structured form. |
| `missingness_policy.in_flight_at_interrupt` | `ArmResult::Censored` | partial | eval-core resolves a censored arm least favourably; v2 excludes `failed(interrupted)` items from recall and counts them in dependability (OQ-1). `eval-analysis-family/v3` would add the exclusion class. |
| `missingness_policy.failed_turn_items` | `exclusions` | partial | OQ-5: excluded from recall with the count named per arm. |
| `missingness_policy.excluded_counts_reported_per_arm` | `Manifest.arm_rates` | partial | eval-core reports miss and refusal rates per arm; excluded counts need `eval-manifest/v10`. |
| `missingness_policy.failed_items_counted_in` | none | extension | Dependability is not an eval-core endpoint; see `families`. |
| `divergence_policy` | none | extension | eval-core replays a choice tape with no live divergence; the live slice needs `eval-live-settings/v2` with a divergence hash rule. |
| `divergence_policy.hash_input` | none | extension | OQ-3: normalised last agent output. |
| `divergence_policy.normalisation` | none | extension | ISO timestamps, durations, PIDs, temp paths, run ids. |
| `divergence_policy.diagnostic_hash` | none | extension | The full agent-visible prefix hash, recorded for diagnosis. |
| `divergence_policy.on_divergence` | none | extension | Record then fall through to live. |
| `liveness_bounds` | `CampaignProfile.liveness_bounds` | partial | eval-core bounds are counts in subsystem units and never wall clock; v2 bounds are wall-clock deadlines (OQ-6). `eval-analysis-family/v3` would add wall-clock liveness beside the four counts. |
| `liveness_bounds.turn_deadline_ms` | none | extension | 15 minutes; SIM-L01. |
| `liveness_bounds.job_deadline_ms` | none | extension | 20 minutes; SIM-L02. |
| `liveness_bounds.tier_wall_budget_ms` | none | extension | S 2 h, M 10 h, L 30 h, XL 96 h; SIM-L03. |
| `liveness_bounds.daemon_busy_cpu_fraction` | none | extension | Daemon CPU time per wall second above which the M4 sampler holds the scenario clock (OQ-2), added in revision 3 before any run. `eval-analysis-family/v3`, beside the wall-clock liveness bounds of the parent row. |
| `grading` | none | extension | The M5 probe grading rules, added in revision 4 before any run. eval-core grades with deterministic oracles and has no probe rules; `eval-manifest/v10` would add them. |
| `grading.first_attempt_only` | none | extension | A grade reads the first probe turn's artefacts only (SIM-P41). |
| `grading.lookup_match` | none | extension | P8 matches the value as a whole word, the v1 A/B rule. |
| `grading.abstain_rule` | none | extension | P9 abstains with a first line of `UNKNOWN` alone or abstention wording with no guessed value, the v1 A/B rule. |
| `grading.p11_false_positive_weight` | none | extension | A P11 false-positive injection counts this many times a hit in `P11.weighted_score` (SIM-P50); `P11.harm` stays binary. |
| `grading.p13_reduction_ratio` | none | extension | Summary output tokens per summarized input token a P13 fold must fall between. |
| `grading.p13_reduction_ratio.min` | none | extension | Lower bound, a decimal in (0, 1). |
| `grading.p13_reduction_ratio.max` | none | extension | Upper bound, a decimal in (0, 1). |
| `grading.judge` | `JudgeIdentity`, `SamplingPlan`, `PermutationCheck` | partial | The P7 judge settings. The calibration set the sim validates (`sim-judge-calibration/v1`) carries the judge identity, a label per pair, and the human-labelled pair ids; eval-core's `CalibrationSet` (`eval-judge/v1`) holds human labels alone with the floor from `SamplingPlan`. `eval-judge/v2` would carry the judge identity and per-pair labels. |
| `grading.judge.model` | `JudgeIdentity` provider profile | partial | The P7 judge model (D4). |
| `grading.judge.cross_judge` | none | extension | The model that re-judges the calibration set (D4); `eval-judge/v2` would add a second judge identity. |
| `grading.judge.calibration_min_pairs` | `HUMAN_SAMPLE_MIN_PAIRS` | mapped | The calibration floor of 20 pairs. |
| `grading.judge.human_sample_percent` | `HUMAN_SAMPLE_FLOOR_PERCENT` | mapped | The 10% human sample. |
| `grading.judge.arm_identification_ceiling_percent` | `ARM_IDENTIFICATION_CEILING_PERCENT` | mapped | The 60% arm-identification ceiling, correct or inverted. |
| `oracles` | none | extension | Failure-class oracle thresholds, added in revision 5 before any tier run, after the `grade-2` smoke run had shown the eidnara arm at 1.53 times the host arm's tokens; eval-core's oracles run over deterministic traces, and `eval-manifest/v10` would add live-log thresholds. |
| `oracles.hang_quiet_ms` | none | extension | F4: five minutes of quiet after a completed model call, with no tool run, model call, or turn end, is a hang (SIM-P39). |
| `oracles.cost_ratio_max` | none | extension | F6: an arm whose tokens exceed 1.5 times the host arm's activates the cost oracle. |
| `user_sim` | none | extension | The simulated user (M6), added in revision 6 before any tier run; eval-core replays recorded traces and has no live user. |
| `user_sim.model` | none | extension | The user simulator's model, Haiku 5.5 (spec section 3.3). |
| `user_sim.max_tokens` | none | extension | The output bound on one user-sim reply. |
| `user_sim.rates` | none | extension | Targets for pushback and interrupt per user turn and redirect and abandon per session; pushback and interrupt are the SWE-chat paper's 45.7% and 4.5%, and redirect and abandon sit inside the ticket's 5 to 8% and 5 to 7%. |
| `user_sim.bands` | none | extension | Tolerance bands a realised rate must fall inside (SIM-P10); a run outside one is flagged. |
| `user_sim.rates.pushback_per_turn` | none | extension | Target for pushback per user turn, SWE-chat's 45.7%. |
| `user_sim.rates.interrupt_per_turn` | none | extension | Target for hard interrupts per user turn, SWE-chat's 4.5%. |
| `user_sim.rates.redirect_per_session` | none | extension | Target for sessions with one redirect, inside the ticket's 5 to 8%. |
| `user_sim.rates.abandon_per_session` | none | extension | Target for sessions the user abandons, inside the ticket's 5 to 7%. |
| `user_sim.bands.pushback_per_turn` | none | extension | The tolerance band for `pushback_per_turn`. |
| `user_sim.bands.pushback_per_turn.min` | none | extension | Its lower bound. |
| `user_sim.bands.pushback_per_turn.max` | none | extension | Its upper bound. |
| `user_sim.bands.interrupt_per_turn` | none | extension | The tolerance band for `interrupt_per_turn`. |
| `user_sim.bands.interrupt_per_turn.min` | none | extension | Its lower bound. |
| `user_sim.bands.interrupt_per_turn.max` | none | extension | Its upper bound. |
| `user_sim.bands.redirect_per_session` | none | extension | The tolerance band for `redirect_per_session`. |
| `user_sim.bands.redirect_per_session.min` | none | extension | Its lower bound. |
| `user_sim.bands.redirect_per_session.max` | none | extension | Its upper bound. |
| `user_sim.bands.abandon_per_session` | none | extension | The tolerance band for `abandon_per_session`. |
| `user_sim.bands.abandon_per_session.min` | none | extension | Its lower bound. |
| `user_sim.bands.abandon_per_session.max` | none | extension | Its upper bound. |
| `user_sim.interrupt_after_ms` | none | extension | The range a hard interrupt's delay after the prompt is drawn from. |
| `user_sim.interrupt_after_ms.min` | none | extension | The shortest interrupt delay. |
| `user_sim.interrupt_after_ms.max` | none | extension | The longest interrupt delay. |
| `bootstrap` | `AnalysisFamily.bootstrap_*` | mapped | |
| `bootstrap.replicates` | `bootstrap_replicates` | mapped | 2,000 lies inside 40 to 10,000. |
| `bootstrap.seed` | `bootstrap_seed` | mapped | |
| `leak_bound` | none | extension | Resource soak is outside eval-core; `envelope_bounds` declares bounds but no slope verdict. `eval-manifest/v10` would add a soak verdict. |
| `leak_bound.c_bytes_per_session` | `envelope_bounds` | partial | `c` in `RSS(T) < 2 * RSS(0) + N_sessions * c` (SIM-P57). |
| `leak_bound.r2_threshold` | none | extension | As `leak_bound`. |
| `leak_bound.sample_interval_ms` | none | extension | 10 s sampler (SIM-P57). |
| `families` | `AnalysisFamily.endpoints`, `families` | partial | eval-core endpoints are exactly `quality_loss`, `harm`, `floor`. v2's twenty families need `eval-analysis-family/v3` with a declared endpoint set. The projection takes `eidnara` as eval-core's `aged` arm and `host` as `fresh`: the harm family maps to `quality_loss = (b - c) / n`, the paired difference by which `eidnara` does worse, against `noninferiority_margin`; the S P8/P9 threshold maps to `floor`. eval-core's `harm = b / n` is a one-sided rate, not a difference, so no v2 family supplies `harm_bound`; P1 superiority has no gate counterpart, since eval-core gates are noninferiority only. |
| `families[].id` | `AnalysisFamily.families` entry | partial | eval-core families are task families; v2 ids are metric families. |
| `families[].metrics` | `endpoints` | partial | See `families`. A gate family passes when every metric passes at the family's `alpha` under its `multiplicity`; one failing metric fails the gate and is named in the verdict (`failed-gate`). |
| `families[].outcome` | `ArmResult` | partial | `binary` maps to pass and fail; `graded`, `count`, and `slope` need `eval-analysis-family/v3`. |
| `families[].treatment_unit` | none | extension | The arm is applied per run; eval-core has no treatment-unit field. |
| `families[].analysis_unit` | `ClusterKey` granularity | partial | `item` maps to one pair; `run` needs `eval-analysis-family/v3`. |
| `families[].cluster_key` | `ClusteringUnit` (`family`, `world_seed`) | partial | A v2 run is one (seed, host) pair, so M's six paired runs are three seeds on two hosts; `world_seed` alone merges each seed's two host runs, and `run` needs a host-aware unit in `eval-analysis-family/v3`, as does `ledger_fact_id`. |
| `families[].direction` | gate verdicts | partial | `noninferiority` maps to `quality_loss` against `noninferiority_margin`; `threshold` maps to `floor`; the others need `eval-analysis-family/v3`. |
| `families[].margin` | `CampaignProfile` rates | partial | |
| `families[].margin.value` | `noninferiority_margin`, `floor_threshold` | partial | The harm family's 10 pp margin projects to `noninferiority_margin = "0.1"`; the S P8/P9 floor to `floor_threshold = "0.9"`. Margins in ms, bytes, ratios, and counts need `eval-analysis-family/v3`. |
| `families[].margin.scale` | none | extension | eval-core rates are always proportions. |
| `families[].mde` | `IccPilot.required_n_for_margin` | partial | eval-core fixes a required n for one margin; v2 fixes the planning MDE per family before data (D5, SIM-P52), computed for binary superiority families from the paired sample size at planning discordance 0.25, two-sided alpha 0.05, power 0.8, with no design effect, so the effective MDE grows by the square root of the design effect over ledger-fact clusters. For the noninferiority harm family it is the planned true difference of 0, and `power` is what the registered n reaches at one-sided alpha 0.01, the Holm first step over five metrics: 0.44 at M and 0.54 at L's planning count, so the L re-sizing must raise L's n. For an `at-most` family it is the planned true value; power at six paired runs is a target the M pilot checks. `eval-analysis-family/v3` would add a per-endpoint MDE. |
| `families[].mde.value` | none | extension | As `families[].mde`. |
| `families[].mde.scale` | none | extension | As `families[].margin.scale`. |
| `families[].power` | none | extension | eval-core has no power target field; `eval-analysis-family/v3`. |
| `families[].alpha` | none | extension | eval-core gates compare point rates and intervals to bounds with no alpha. `eval-analysis-family/v3` would add per-family alpha. |
| `families[].interval_method` | `IntervalMethod::ClusterBootstrap` | partial | The cluster bootstrap part of `exact-mcnemar-newcombe-cluster-bootstrap` maps; McNemar, Newcombe, BCa, negative binomial, sign test, and slope bootstrap need `eval-analysis-family/v3`. |
| `families[].multiplicity` | `MultiplicityCorrection` | partial | `none` maps; `holm` is declared in eval-core but refused as `UnsupportedMultiplicity`, so the harm family needs `eval-analysis-family/v3` to accept Holm. |
| `families[].claim` | none | extension | eval-core reports every endpoint as a gate. |
| `families[].min_paired_runs` | `item_count_threshold` | partial | eval-core's item floor is at least 300 items, which S and M probe counts do not reach; v2 floors run-level claims at six paired runs. `eval-analysis-family/v3` would add a run floor and a per-tier item floor. |
| `resizing` | `AnalysisFamily.icc_pilot` | partial | The M discordance pilot re-sizes L as the ICC pilot sizes a plan; eval-core's pilot reports ICC, not discordance. `eval-analysis-family/v3` would add a discordance pilot. |
| `resizing.planning_paired_items_per_probe_type` | `IccPilot.required_n_for_margin` | partial | 150 per probe type until M measures discordance (OQ-12). |
| `resizing.source_tier` | `IccPilot.pilot_run_id` | partial | The M runs are the pilot. |
| `resizing.rule` | `IccPilot` design effect | partial | The paired sample-size rule with the design effect over ledger-fact clusters, whose ICC deflation mirrors eval-core's `1 + (m - 1) ICC`; eval-core checks a plan against a pilot but does not compute n. |
| `aa_controls` | none | extension | A/A controls at S and M (host/host, eidnara/eidnara; M repeats five times before a pipeline false-positive rate is claimed). eval-core pairs `aged` and `fresh` only; `eval-manifest/v10` would name same-arm pairs. |
| `aa_controls.pairs` | none | extension | As `aa_controls`. |
| `aa_controls.repeats` | none | extension | As `aa_controls`. |
| `load_stress` | none | extension | The concurrent-arms profile (OQ-11) has no counterpart; `eval-manifest/v10` would record start skew. |
| `load_stress.arms_concurrent` | none | extension | L only. |
| `load_stress.record_start_skew` | none | extension | L only. |
| `load_stress.margins_family` | none | extension | Uses the dependability family's margins. |

## Projection

The fields marked `mapped` and `partial` project into one `CampaignProfile`
and one `AnalysisFamily` per tier. That projection does not validate today.
Two refusals block it:

1. `AnalysisFamily::validate` refuses any endpoint list other than the three
   gates (`UnsupportedEndpoints`) and any multiplicity other than `none`
   (`UnsupportedMultiplicity`). v2's families and Holm need
   `eval-analysis-family/v3`.
2. `item_count_threshold` below 300 is `ItemCountThresholdBelowFloor`. Every
   tier's registered probe count is below it (S 24, M 120, L 150 before
   re-sizing, XL 60), so no tier's probe family projects until
   `eval-analysis-family/v3` adds a per-tier item floor; L projects only if the
   M re-sizing raises its count to at least 300.

Required eval-core fields also lack a v2 source:

- `CampaignProfile.harm_bound`: see the `families` row.
- `CampaignProfile.miss_asymmetry_bound`: v2 has no cassette, so no miss rate;
  the fault-asymmetric stratum is its nearest analogue.
- `CampaignProfile.liveness_bounds`: the four counts in subsystem units; v2
  bounds are wall-clock deadlines.
- `AnalysisFamily.exclusions`: projectable as text from `missingness_policy`.
- `AnalysisFamily.trials_k`: `1`, since grades use the first attempt only.
- `AnalysisFamily.icc_pilot`: a required field; the M runs are the pilot for
  L. S and M have no pilot, so their projection lacks the field, and a
  placeholder pilot fails `PilotInconsistent`.
- `AnalysisFamily.transfer_criterion`: `None`.

The live-slice report (`eval-live-slice/v1`) and the residual report
(`eval-residual-report/v1`) are consumed unchanged by the P7 judge path in M5;
their settings need the host and divergence additions noted above in
`eval-live-settings/v2`.

## Scenario fault schedule

The scenario file's `faults` list (`src/scenario/faults.ts`, `FaultEpisode`)
is a scenario-local schedule: fault type, strategy, compiler-chosen trigger,
parameters, and the seam-table entry for the proxy sink, scheduler, or clock
layer the harness injects through. eval-core's `FaultEpisode` is the Suite C
record `(trigger, scope, action, heal)` over the daemon's own store seams,
whose `FaultAction` is a closed set of in-process hooks. The two share the
type name and a `trigger` field name; the scenario trigger is a compiler-owned
event (session start, Nth user turn, first summarizer call of a session) and
eval-core's is a drive step, so a conversion translates or rejects the shape,
and the remaining fields have no counterpart. The harness seams have no
eval-core counterpart; the
runner (M4) journals each scenario episode with its trigger event, both
times, and fired and observed evidence (SIM-P31), and the report (M7) reads
that journal. An eval-core counterpart would need a `FaultAction` family for
harness seams and a scope outside `StoreFamily` in the Suite C fault contract
(`eval-suite-c-fault-report/v3`); no extension is made here.
