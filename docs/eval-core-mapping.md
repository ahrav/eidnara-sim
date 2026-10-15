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
| `arms.default` | none | extension | D1's declared default arm has no counterpart; `eval-manifest/v10`. |
| `arms.run` | `Manifest.arm_rates` keys | partial | See `arms`. |
| `arms.order` | none | extension | Sequential arm order per seed; `eval-manifest/v10` run identity would record it. |
| `hosts` | `LiveSettings.providers` | partial | Providers are model profiles; the host binary is a run identity component. `eval-live-settings/v2` would add host binaries. |
| `seeds` | `run_identity` root seed; `ClusterKey.world_seed` | mapped | One root seed per paired run. |
| `scenario` | `component_versions.generator` | partial | The generator version is in the identity; scenario sizes are generator inputs with no field. `eval-manifest/v10`. |
| `scenario.simulated_days` | none | extension | `eval-manifest/v10` generator parameters. |
| `scenario.sessions_per_project` | none | extension | As above. |
| `scenario.forced_p90_sessions` | none | extension | As above (SIM-P09). |
| `stopping_rule` | `AnalysisFamily.stopping_rule` | partial | `fixed_n` maps; CUSUM does not. |
| `stopping_rule.kind` | `StoppingRule::FixedN` | mapped | |
| `stopping_rule.items_per_probe_type` | `FixedN { pairs }` | partial | eval-core fixes one pair count per family; the sum over probe types is the projected `pairs`. |
| `stopping_rule.cusum` | none | extension | eval-core refuses any stop before `pairs`. CUSUM harm and futility stops need `eval-analysis-family/v3` with a `cusum_harm_futility` stopping rule that yields no pass claim. |
| `stopping_rule.cusum[].kind` | none | extension | As above. |
| `stopping_rule.cusum[].metric` | none | extension | As above. |
| `stopping_rule.cusum[].k` | none | extension | As above. |
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
| `bootstrap` | `AnalysisFamily.bootstrap_*` | mapped | |
| `bootstrap.replicates` | `bootstrap_replicates` | mapped | 2,000 lies inside 40 to 10,000. |
| `bootstrap.seed` | `bootstrap_seed` | mapped | |
| `leak_bound` | none | extension | Resource soak is outside eval-core; `envelope_bounds` declares bounds but no slope verdict. `eval-manifest/v10` would add a soak verdict. |
| `leak_bound.c_bytes_per_session` | `envelope_bounds` | partial | `c` in `RSS(T) < 2 * RSS(0) + N_sessions * c` (SIM-P57). |
| `leak_bound.r2_threshold` | none | extension | As `leak_bound`. |
| `leak_bound.sample_interval_ms` | none | extension | 10 s sampler (SIM-P57). |
| `families` | `AnalysisFamily.endpoints`, `families` | partial | eval-core endpoints are exactly `quality_loss`, `harm`, `floor`. v2's twenty families need `eval-analysis-family/v3` with a declared endpoint set. The projection: P1 superiority maps to `quality_loss` (sign reversed), the harm family to `harm`, and the S P8/P9 threshold to `floor`. |
| `families[].id` | `AnalysisFamily.families` entry | partial | eval-core families are task families; v2 ids are metric families. |
| `families[].metrics` | `endpoints` | partial | See `families`. |
| `families[].outcome` | `ArmResult` | partial | `binary` maps to pass and fail; `graded`, `count`, and `slope` need `eval-analysis-family/v3`. |
| `families[].treatment_unit` | none | extension | The arm is applied per run; eval-core has no treatment-unit field. |
| `families[].analysis_unit` | `ClusterKey` granularity | partial | `item` maps to one pair; `run` needs `eval-analysis-family/v3`. |
| `families[].cluster_key` | `ClusteringUnit` (`family`, `world_seed`) | partial | `run` maps to `world_seed`; `ledger_fact_id` needs a third unit in `eval-analysis-family/v3`. |
| `families[].direction` | gate verdicts | partial | `noninferiority` maps to `quality_loss` against `noninferiority_margin`; `threshold` maps to `floor`; the others need `eval-analysis-family/v3`. |
| `families[].margin` | `CampaignProfile` rates | partial | |
| `families[].margin.value` | `noninferiority_margin`, `harm_bound`, `floor_threshold` | partial | The 10 pp harm margin projects to `noninferiority_margin = "0.1"`; the S P8/P9 floor to `floor_threshold = "0.9"`. Margins in ms, bytes, ratios, and counts need `eval-analysis-family/v3`. |
| `families[].margin.scale` | none | extension | eval-core rates are always proportions. |
| `families[].alpha` | none | extension | eval-core gates compare point rates and intervals to bounds with no alpha. `eval-analysis-family/v3` would add per-family alpha. |
| `families[].interval_method` | `IntervalMethod::ClusterBootstrap` | partial | The cluster bootstrap part of `exact-mcnemar-newcombe-cluster-bootstrap` maps; McNemar, Newcombe, BCa, negative binomial, sign test, and slope bootstrap need `eval-analysis-family/v3`. |
| `families[].multiplicity` | `MultiplicityCorrection` | partial | `none` maps; `holm` is declared in eval-core but refused as `UnsupportedMultiplicity`, so the harm family needs `eval-analysis-family/v3` to accept Holm. |
| `families[].claim` | none | extension | eval-core reports every endpoint as a gate. |
| `families[].min_paired_runs` | `item_count_threshold` | partial | eval-core's item floor is at least 300 items, which S and M probe counts do not reach; v2 floors run-level claims at six paired runs. `eval-analysis-family/v3` would add a run floor and a per-tier item floor. |
| `resizing` | `AnalysisFamily.icc_pilot` | partial | The M discordance pilot re-sizes L as the ICC pilot sizes a plan; eval-core's pilot reports ICC, not discordance. `eval-analysis-family/v3` would add a discordance pilot. |
| `resizing.planning_items_per_probe_type` | `IccPilot.required_n_for_margin` | partial | 150 per probe type until M measures discordance (OQ-12). |
| `resizing.source_tier` | `IccPilot.pilot_run_id` | partial | The M runs are the pilot. |
| `resizing.rule` | none | extension | The paired sample-size rule; eval-core checks a plan against a pilot but does not compute n. |
| `load_stress` | none | extension | The concurrent-arms profile (OQ-11) has no counterpart; `eval-manifest/v10` would record start skew. |
| `load_stress.arms_concurrent` | none | extension | L only. |
| `load_stress.record_start_skew` | none | extension | L only. |
| `load_stress.margins_family` | none | extension | Uses the dependability family's margins. |

## Projection

The fields marked `mapped` and `partial` project into one `CampaignProfile`
and one `AnalysisFamily` per tier. Two refusals block that projection today,
and each names the extension it needs:

1. `AnalysisFamily::validate` refuses any endpoint list other than the three
   gates (`UnsupportedEndpoints`) and any multiplicity other than `none`
   (`UnsupportedMultiplicity`). v2's families and Holm need
   `eval-analysis-family/v3`.
2. `item_count_threshold` below 300 is `ItemCountThresholdBelowFloor`. S and
   M probe counts are below it, so their probe families are descriptive or
   use the v2 run floor until `eval-analysis-family/v3` adds a per-tier item
   floor.

The live-slice report (`eval-live-slice/v1`) and the residual report
(`eval-residual-report/v1`) are consumed unchanged by the P7 judge path in M5;
their settings need the host and divergence additions noted above in
`eval-live-settings/v2`.
