# Property catalog: world simulation v2

Scope: the v2 live-slice harness in this tree, specified by
[ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007). Records
follow `docs/properties/METHOD.md`. The spec names its full catalog at
`research/sim-design/property-catalog-sim-v2.md` (2026-10-12 revision); that
file is unavailable, so these records are reconstructed from the condensed
index in the spec body. Every record is PROPOSED: `Exercised: not yet` and
`Confidence: low`, because no harness surface exists to verify against.

Stable ids: `SIM-P01` to `SIM-P77` carry the spec's proposed records, and
`SIM-L01` to `SIM-L03` carry the liveness bounds OQ-6 asked for and M0
pre-registers. Each id is the slug prefix and opens the `Guarantee:` line.

## Reachability classes

- `default-production`: a default tier run with no scheduled faults reaches the
  surface.
- `explicit-config-only`: the surface runs only when a tier schedules faults,
  the counterfactual arm, or two host clients on one daemon.
- `test-only`: no record uses it; every surface runs in real tier runs.

`scripts/check-catalog.ts` checks the record schema and field order against
`METHOD.md`, the index against the records, and one evidence file per record.

## Index

| Id | Slug | Type | Check | Reachability | Milestone |
| --- | --- | --- | --- | --- | --- |
| SIM-P01 | [sim-p01-scenario-compile-is-deterministic](#sim-p01-scenario-compile-is-deterministic) | safety | `always` | default-production | M2 |
| SIM-P02 | [sim-p02-paired-arms-share-event-prefix](#sim-p02-paired-arms-share-event-prefix) | safety | `always` | default-production | M6 |
| SIM-P03 | [sim-p03-divergence-is-recorded-never-hidden](#sim-p03-divergence-is-recorded-never-hidden) | safety | `always` | default-production | M6 |
| SIM-P04 | [sim-p04-divergence-occurs-in-campaign](#sim-p04-divergence-occurs-in-campaign) | reachability | `sometimes` | default-production | M6 |
| SIM-P05 | [sim-p05-scheduled-events-identical-across-arms](#sim-p05-scheduled-events-identical-across-arms) | safety | `always` | default-production | M2 |
| SIM-P06 | [sim-p06-items-issue-in-scenario-order-after-conveyance](#sim-p06-items-issue-in-scenario-order-after-conveyance) | safety | `always` | default-production | M4 |
| SIM-P07 | [sim-p07-probe-text-never-announces-probe](#sim-p07-probe-text-never-announces-probe) | safety | `always(!X)` | default-production | M2 |
| SIM-P08 | [sim-p08-cue-and-probe-are-lexically-dissimilar](#sim-p08-cue-and-probe-are-lexically-dissimilar) | safety | `always` | default-production | M2 |
| SIM-P09 | [sim-p09-tier-has-forced-p90-sessions](#sim-p09-tier-has-forced-p90-sessions) | safety | `always` | default-production | M2 |
| SIM-P10 | [sim-p10-user-sim-event-mix-matches-distribution-bounds](#sim-p10-user-sim-event-mix-matches-distribution-bounds) | safety | `always` | default-production | M6 |
| SIM-P11 | [sim-p11-scenario-time-is-monotone](#sim-p11-scenario-time-is-monotone) | safety | `always` | default-production | M4 |
| SIM-P12 | [sim-p12-clock-advances-only-when-idle](#sim-p12-clock-advances-only-when-idle) | safety | `always` | default-production | M4 |
| SIM-P13 | [sim-p13-background-job-holds-clock](#sim-p13-background-job-holds-clock) | reachability | `sometimes` | default-production | M4 |
| SIM-P14 | [sim-p14-idle-jump-lands-on-next-event](#sim-p14-idle-jump-lands-on-next-event) | safety | `always` | default-production | M4 |
| SIM-P15 | [sim-p15-proxy-record-carries-both-times](#sim-p15-proxy-record-carries-both-times) | safety | `always` | default-production | M3 |
| SIM-P16 | [sim-p16-faketime-verified-per-binary-before-start](#sim-p16-faketime-verified-per-binary-before-start) | safety | `always-or-unreached` | default-production | M4 |
| SIM-P17 | [sim-p17-long-idle-gaps-reached](#sim-p17-long-idle-gaps-reached) | reachability | `sometimes` | default-production | M2 |
| SIM-P18 | [sim-p18-sleep-fault-is-event-free-jump](#sim-p18-sleep-fault-is-event-free-jump) | safety | `always` | explicit-config-only | M4 |
| SIM-P19 | [sim-p19-wall-clock-distortion-recorded](#sim-p19-wall-clock-distortion-recorded) | safety | `always` | default-production | M3 |
| SIM-P20 | [sim-p20-tape-replays-while-context-matches](#sim-p20-tape-replays-while-context-matches) | safety | `always` | default-production | M6 |
| SIM-P21 | [sim-p21-tape-goes-live-only-after-divergence](#sim-p21-tape-goes-live-only-after-divergence) | safety | `always` | default-production | M6 |
| SIM-P22 | [sim-p22-each-ledger-fact-conveyed-once-in-assigned-manner](#sim-p22-each-ledger-fact-conveyed-once-in-assigned-manner) | safety | `always` | default-production | M6 |
| SIM-P23 | [sim-p23-user-sim-and-judge-calls-tagged-and-separated](#sim-p23-user-sim-and-judge-calls-tagged-and-separated) | safety | `always` | default-production | M3 |
| SIM-P24 | [sim-p24-paste-turn-provenance](#sim-p24-paste-turn-provenance) | safety | `always` | default-production | M6 |
| SIM-P25 | [sim-p25-pushback-label-per-turn](#sim-p25-pushback-label-per-turn) | safety | `always` | default-production | M6 |
| SIM-P26 | [sim-p26-user-sim-noise-floor-run-is-paired](#sim-p26-user-sim-noise-floor-run-is-paired) | safety | `always` | default-production | M6 |
| SIM-P27 | [sim-p27-every-request-yields-one-record](#sim-p27-every-request-yields-one-record) | safety | `always` | default-production | M3 |
| SIM-P28 | [sim-p28-component-classification-is-total](#sim-p28-component-classification-is-total) | safety | `always` | default-production | M3 |
| SIM-P29 | [sim-p29-finish-reason-recorded](#sim-p29-finish-reason-recorded) | safety | `always` | default-production | M3 |
| SIM-P30 | [sim-p30-no-unscheduled-fault](#sim-p30-no-unscheduled-fault) | safety | `always(!X)` | explicit-config-only | M3 |
| SIM-P31 | [sim-p31-fault-counts-only-when-observed-at-target](#sim-p31-fault-counts-only-when-observed-at-target) | safety | `always` | explicit-config-only | M3 |
| SIM-P32 | [sim-p32-missed-fault-excludes-run-from-fault-metrics](#sim-p32-missed-fault-excludes-run-from-fault-metrics) | safety | `always` | explicit-config-only | M7 |
| SIM-P33 | [sim-p33-missed-fault-occurs](#sim-p33-missed-fault-occurs) | reachability | `sometimes` | explicit-config-only | M3 |
| SIM-P34 | [sim-p34-each-fault-kind-triggers](#sim-p34-each-fault-kind-triggers) | reachability | `reachable` | explicit-config-only | M3 |
| SIM-P35 | [sim-p35-transcript-store-reads-observed-not-blocked](#sim-p35-transcript-store-reads-observed-not-blocked) | safety | `always` | default-production | M8 |
| SIM-P36 | [sim-p36-transcript-search-occurs](#sim-p36-transcript-search-occurs) | reachability | `sometimes` | default-production | M8 |
| SIM-P37 | [sim-p37-transcript-read-latency-stays-in-host-cost](#sim-p37-transcript-read-latency-stays-in-host-cost) | safety | `always` | default-production | M7 |
| SIM-P38 | [sim-p38-cost-conserves-by-component](#sim-p38-cost-conserves-by-component) | safety | `always` | default-production | M7 |
| SIM-P39 | [sim-p39-hang-is-derived-from-call-silence](#sim-p39-hang-is-derived-from-call-silence) | safety | `always` | default-production | M5 |
| SIM-P40 | [sim-p40-grade-inputs-are-artefacts-only](#sim-p40-grade-inputs-are-artefacts-only) | safety | `always` | default-production | M5 |
| SIM-P41 | [sim-p41-first-attempt-snapshot-set-once](#sim-p41-first-attempt-snapshot-set-once) | safety | `always` | default-production | M5 |
| SIM-P42 | [sim-p42-grade-is-versioned-not-overwritten](#sim-p42-grade-is-versioned-not-overwritten) | safety | `always` | default-production | M5 |
| SIM-P43 | [sim-p43-judge-hygiene-on-p7-only](#sim-p43-judge-hygiene-on-p7-only) | safety | `always` | default-production | M5 |
| SIM-P44 | [sim-p44-p7-human-check-sample](#sim-p44-p7-human-check-sample) | safety | `always` | default-production | M5 |
| SIM-P45 | [sim-p45-issued-items-stay-in-denominator](#sim-p45-issued-items-stay-in-denominator) | safety | `always` | default-production | M5 |
| SIM-P46 | [sim-p46-failed-turn-item-is-not-a-grade](#sim-p46-failed-turn-item-is-not-a-grade) | safety | `always` | default-production | M5 |
| SIM-P47 | [sim-p47-fold-event-yields-p13-record](#sim-p47-fold-event-yields-p13-record) | safety | `always` | default-production | M5 |
| SIM-P48 | [sim-p48-fold-observed-in-campaign](#sim-p48-fold-observed-in-campaign) | reachability | `sometimes` | default-production | M5 |
| SIM-P49 | [sim-p49-p1-control-instance-paired](#sim-p49-p1-control-instance-paired) | safety | `always` | default-production | M2 |
| SIM-P50 | [sim-p50-p11-false-positive-weight-applied](#sim-p50-p11-false-positive-weight-applied) | safety | `always` | default-production | M5 |
| SIM-P51 | [sim-p51-gate-reads-completed-pairs-only](#sim-p51-gate-reads-completed-pairs-only) | safety | `always` | default-production | M7 |
| SIM-P52 | [sim-p52-gate-carries-preregistered-mde](#sim-p52-gate-carries-preregistered-mde) | safety | `always` | default-production | M0 |
| SIM-P53 | [sim-p53-parity-never-emitted](#sim-p53-parity-never-emitted) | safety | `always(!X)` | default-production | M0 |
| SIM-P54 | [sim-p54-pairing-by-item-identity](#sim-p54-pairing-by-item-identity) | safety | `always` | default-production | M7 |
| SIM-P55 | [sim-p55-early-stop-records-cause](#sim-p55-early-stop-records-cause) | safety | `always-or-unreached` | default-production | M7 |
| SIM-P56 | [sim-p56-failed-turn-claim-needs-six-paired-runs](#sim-p56-failed-turn-claim-needs-six-paired-runs) | safety | `always` | default-production | M7 |
| SIM-P57 | [sim-p57-leak-verdict-uses-fit-and-bound](#sim-p57-leak-verdict-uses-fit-and-bound) | safety | `always` | default-production | M7 |
| SIM-P58 | [sim-p58-harm-metric-direction](#sim-p58-harm-metric-direction) | safety | `always` | default-production | M7 |
| SIM-P59 | [sim-p59-internal-string-scan-on-user-visible-only](#sim-p59-internal-string-scan-on-user-visible-only) | safety | `always` | default-production | M7 |
| SIM-P60 | [sim-p60-journal-has-one-writer](#sim-p60-journal-has-one-writer) | safety | `always` | default-production | M4 |
| SIM-P61 | [sim-p61-journal-is-append-only-with-monotone-seq](#sim-p61-journal-is-append-only-with-monotone-seq) | safety | `always` | default-production | M4 |
| SIM-P62 | [sim-p62-resume-does-not-reissue-completed-items](#sim-p62-resume-does-not-reissue-completed-items) | safety | `always` | default-production | M4 |
| SIM-P63 | [sim-p63-in-flight-item-resolved-once-on-resume](#sim-p63-in-flight-item-resolved-once-on-resume) | safety | `always` | default-production | M4 |
| SIM-P64 | [sim-p64-interrupt-mid-turn-exercised](#sim-p64-interrupt-mid-turn-exercised) | reachability | `sometimes` | default-production | M4 |
| SIM-P65 | [sim-p65-resume-preserves-pairing](#sim-p65-resume-preserves-pairing) | safety | `always` | default-production | M4 |
| SIM-P66 | [sim-p66-every-observable-derives-from-journal](#sim-p66-every-observable-derives-from-journal) | safety | `always` | default-production | M7 |
| SIM-P67 | [sim-p67-incomplete-run-refuses-load](#sim-p67-incomplete-run-refuses-load) | safety | `always` | default-production | M4 |
| SIM-P68 | [sim-p68-clock-restored-on-resume](#sim-p68-clock-restored-on-resume) | safety | `always` | default-production | M4 |
| SIM-P69 | [sim-p69-cf-deletion-recorded-with-identity](#sim-p69-cf-deletion-recorded-with-identity) | safety | `always` | explicit-config-only | M9 |
| SIM-P70 | [sim-p70-cf-deletion-verified](#sim-p70-cf-deletion-verified) | safety | `always` | explicit-config-only | M9 |
| SIM-P71 | [sim-p71-cf-arm-paired-to-eidnara-until-deletion](#sim-p71-cf-arm-paired-to-eidnara-until-deletion) | safety | `always` | explicit-config-only | M9 |
| SIM-P72 | [sim-p72-cf-attribution-is-single-object](#sim-p72-cf-attribution-is-single-object) | safety | `always` | explicit-config-only | M9 |
| SIM-P73 | [sim-p73-cf-sample-is-preregistered](#sim-p73-cf-sample-is-preregistered) | safety | `always` | explicit-config-only | M2 |
| SIM-P74 | [sim-p74-cf-flip-occurs](#sim-p74-cf-flip-occurs) | reachability | `sometimes` | explicit-config-only | M9 |
| SIM-P75 | [sim-p75-arm-config-fixed-for-run](#sim-p75-arm-config-fixed-for-run) | safety | `always` | default-production | M8 |
| SIM-P76 | [sim-p76-kl-arm-has-host-compaction-on](#sim-p76-kl-arm-has-host-compaction-on) | safety | `always` | default-production | M8 |
| SIM-P77 | [sim-p77-two-hosts-one-store-attributed](#sim-p77-two-hosts-one-store-attributed) | safety | `always` | explicit-config-only | M10 |
| SIM-L01 | [sim-l01-turn-ends-within-turn-deadline](#sim-l01-turn-ends-within-turn-deadline) | liveness | `always` | default-production | M4 |
| SIM-L02 | [sim-l02-background-job-ends-within-job-deadline](#sim-l02-background-job-ends-within-job-deadline) | liveness | `always` | default-production | M4 |
| SIM-L03 | [sim-l03-tier-completes-within-wall-budget](#sim-l03-tier-completes-within-wall-budget) | liveness | `always` | default-production | M4 |

## Scheduler and pairing

### sim-p01-scenario-compile-is-deterministic

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M2 (#1026); nothing constructs
it yet
Guarantee: SIM-P01: Compiling a scenario twice from the same seed, tier,
generator version, and corpus manifest yields byte-identical event lists and an
equal `scenario_hash`, across processes.
Check: `always` - two `CompileScenario(seed, tier)` runs in separate processes
produce equal bytes and equal `scenario_hash`; every compile must agree, so a
single disagreement is a violation.
Fault/timing angle: none - compilation is offline and single-threaded.
Required faults and enabling state: two compiler processes on one input tuple; a
corpus manifest with at least one entry per sampled quantity.
Confidence: low -
[evidence](evidence/sim-p01-scenario-compile-is-deterministic.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: Arms of one seed see different worlds and every paired comparison is
invalid.
Open questions: None.

### sim-p02-paired-arms-share-event-prefix

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P02: For arms A and B of one run and every `event_idx <
divergence_idx(A, B)`, the delivered user text, pasted bytes, and fault
parameters are byte-identical.
Check: `always` - for each pair of arms and each event index below the recorded
divergence index, compare delivered user text, paste bytes, and fault parameters
byte for byte; a pairing break at any index invalidates the pair.
Fault/timing angle: the user-sim tape lookup races the agent's last output; a
stale context hash serves the wrong tape entry.
Required faults and enabling state: two arms of one seed; a tape recorded by the
first arm; at least one paste and one scheduled fault before divergence.
Confidence: low -
[evidence](evidence/sim-p02-paired-arms-share-event-prefix.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: A measured effect is confounded with different user input.
Open questions:
- OQ-3 policy half is resolved in the M0 pre-registration: the divergence hash
  is the normalised last agent output. Whether that hash diverges too early on
  long tool output is measured at S (needs human input if it does).

### sim-p03-divergence-is-recorded-never-hidden

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P03: If the agent-visible context hash differs at `event_idx`
between two arms, a divergence record with that index and both hashes exists
before the next `IssueUserText` for either arm.
Check: `always` - for every event index where two arms' normalised context
hashes differ, a divergence record with that index and both hashes precedes the
next `IssueUserText` in journal order; the record must exist every time.
Fault/timing angle: the divergence check runs between `EndTurn` and the next
`IssueUserText`; a crash in that window must not drop the record.
Required faults and enabling state: two arms whose agent outputs differ after
normalisation.
Confidence: low -
[evidence](evidence/sim-p03-divergence-is-recorded-never-hidden.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: A diverged pair is analysed as paired and the report overstates pairing.
Open questions:
- Same as SIM-P02: the hash input is pre-registered in `divergence_policy`; the
  diagnostic full-prefix hash is recorded beside it.

### sim-p04-divergence-occurs-in-campaign

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P04: At least one arm pair diverges before the last event of its
run.
Check: `sometimes` - count pairs whose divergence index is below the run's last
event index; the count is at least one per campaign, since a campaign with no
divergence never exercises the live fallback path.
Fault/timing angle: none.
Required faults and enabling state: live models at production temperature; a run
long enough for outputs to differ.
Confidence: low - [evidence](evidence/sim-p04-divergence-occurs-in-campaign.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: The replay-to-live transition is never exercised and its defects stay
hidden.
Open questions: None.

### sim-p05-scheduled-events-identical-across-arms

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M2 (#1026); nothing constructs
it yet
Guarantee: SIM-P05: Scheduled event kinds, times, fault schedule, and
counterfactual deletion schedule are identical across all arms for the whole
run, independent of divergence.
Check: `always` - the per-arm scheduled event lists, fault schedule, and
deletion schedule are byte-identical for the whole run; divergence changes user
text only, so any schedule difference is a violation.
Fault/timing angle: a fault keyed on an observed event rather than a compiler
event would fire at different times per arm.
Required faults and enabling state: a compiled scenario with faults and, at L,
counterfactual deletions.
Confidence: low -
[evidence](evidence/sim-p05-scheduled-events-identical-across-arms.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Fault and recovery metrics compare arms under different conditions.
Open questions: None.

### sim-p06-items-issue-in-scenario-order-after-conveyance

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M4 (#1028); nothing constructs
it yet
Guarantee: SIM-P06: `BeginTurn` for a probe item occurs at `scenario_ms` at or
after the item's scheduled time and after every conveyance event the item
depends on has reached `EndTurn` in that arm.
Check: `always` - for each probe `BeginTurn`, check `scenario_ms >=
scheduled_ms` and that each dependency's conveyance `EndTurn` precedes it in
that arm's journal; an early probe measures nothing.
Fault/timing angle: a conveyance turn that fails or times out leaves the probe
without its fact.
Required faults and enabling state: a probe item with at least one conveyance
dependency; a conveyance turn that ends `failed`.
Confidence: low -
[evidence](evidence/sim-p06-items-issue-in-scenario-order-after-conveyance.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: A probe tests a fact that was never conveyed and is scored as a miss.
Open questions: None.

### sim-p07-probe-text-never-announces-probe

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M2 (#1026); nothing constructs
it yet
Guarantee: SIM-P07: No delivered user text contains a probe id, the word
`probe`, a ledger key name, or a grading hint from a fixed marker set.
Check: `always(!X)` - scan every delivered user text against the fixed marker
set; X is a marker hit, a forbidden state with no dedicated detection point, so
`always(!X)` and never `unreachable`.
Fault/timing angle: the user-sim may paraphrase a hidden script into an
announcing phrase at run time.
Required faults and enabling state: the compiled probe plan and the live
user-sim outputs for every probe turn.
Confidence: low -
[evidence](evidence/sim-p07-probe-text-never-announces-probe.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: The agent recognises the probe and the score measures test awareness.
Open questions: None.

### sim-p08-cue-and-probe-are-lexically-dissimilar

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M2 (#1026); nothing constructs
it yet
Guarantee: SIM-P08: For every cue and probe pair, the pre-registered BM25 and
embedding similarity are below threshold at compile, and the scores are
journaled.
Check: `always` - at compile, compute both similarity scores for every cue and
probe pair, assert each is below its threshold, and journal both; a single
similar pair turns recall into string matching.
Fault/timing angle: none - compile time.
Required faults and enabling state: the conveyance plan and probe plan with
their texts.
Confidence: low -
[evidence](evidence/sim-p08-cue-and-probe-are-lexically-dissimilar.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Recall is measured by lexical overlap and `grep` over a flat file wins.
Open questions: None.

### sim-p09-tier-has-forced-p90-sessions

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M2 (#1026); nothing constructs
it yet
Guarantee: SIM-P09: A compiled scenario has at least three sessions in the p90
request-count regime.
Check: `always` - count sessions whose request count is at or above the fitted
p90; at least three per compiled scenario, so folds and compactions occur in
every tier.
Fault/timing angle: none - compile time.
Required faults and enabling state: the fitted request-count distribution from
M1.
Confidence: low - [evidence](evidence/sim-p09-tier-has-forced-p90-sessions.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Fold and compaction paths are never exercised and P13 and P14 have no
items.
Open questions: None.

### sim-p10-user-sim-event-mix-matches-distribution-bounds

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P10: Pushback, interrupt, redirect, and abandon rates over the
run fall inside pre-registered tolerance bands around the fitted targets, and
the realised rates are journaled.
Check: `always` - compute each behaviour rate from turn labels over the run,
assert it lies in its band, and journal the realised rates; a rate outside the
band means the simulated user is not the fitted population.
Fault/timing angle: the live user-sim after divergence may drift outside the
band.
Required faults and enabling state: a full run with user-sim labels on every
turn.
Confidence: low -
[evidence](evidence/sim-p10-user-sim-event-mix-matches-distribution-bounds.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Results generalise to a user population the corpus does not describe.
Open questions: None.

## Clock

### sim-p11-scenario-time-is-monotone

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M4 (#1028); nothing constructs
it yet
Guarantee: SIM-P11: Within each arm, journal entries in sequence order have
non-decreasing `scenario_ms`; every arm's clock starts at 0.
Check: `always` - walk each arm's entries in `seq` order and assert
`scenario_ms` never decreases; one decrease reorders events and breaks every
age-dependent metric.
Fault/timing angle: resume after a crash restores the clock; a stale value would
move time backwards.
Required faults and enabling state: a run with an interrupt and resume.
Confidence: low - [evidence](evidence/sim-p11-scenario-time-is-monotone.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Age, idle-gap, and staleness metrics are computed on a reordered
timeline.
Open questions: None.

### sim-p12-clock-advances-only-when-idle

Type: safety
Reachability: default-production
Status: active
Exercised: partial - `src/run/scheduler.test.ts` (Clock refuses to advance
while busy; every scheduler run asserts an empty busy set at each
`AdvanceClock`) and the live witness (`tests/witness-faults.ts`, `checkJournal`
`advance_while_busy`) establish the jump clause; the wall-speed clause (an
open interval's `scenario_ms` moves only by wall-clock progression) has no
check yet; see `evidence/sim-p12-clock-advances-only-when-idle.md`
Guarantee: SIM-P12: Every `AdvanceClock` entry is preceded by `busy_set` empty
at the same sequence, and between a `BeginTurn` or `RegisterJob` and the
matching `EndTurn` or `EndJob` `scenario_ms` moves only at wall speed.
Check: `always` - for each `AdvanceClock`, assert the busy set is empty at that
`seq`, and for each open turn or job interval assert `scenario_ms` changes only
by wall-clock progression; a jump mid-turn shows a turn a time it never lived
through.
Fault/timing angle: a background job registered from a proxy observation can
arrive after the scheduler decided to jump.
Required faults and enabling state: a turn followed by a fold or memory-capture
job that outlives the turn.
Confidence: medium - [evidence](evidence/sim-p12-clock-advances-only-when-idle.md).
M4 (#1028) implements the surface; the unit tests and the live witness named
under Existing check construct the record, and a default tier run reaches it.
Existing check: `src/run/scheduler.test.ts` (`Clock` refuses `advanceTo` while
busy; `invariants()` asserts an empty busy set at every `AdvanceClock`),
`src/run/journal-check.ts` `advance_while_busy` (run by `tests/witness-faults.ts`)
Impact: A fold or capture job sees a simulated gap mid-execution and its timing
metrics are invalid.
Open questions:
- OQ-2: busy-set membership for daemon-internal work with no proxy call. The M4
  ticket resolves it as daemon CPU time above a pre-registered threshold; the
  threshold value is unresolved, needs the M4 sampler data.

### sim-p13-background-job-holds-clock

Type: reachability
Reachability: default-production
Status: active
Exercised: yes - `src/run/scheduler.test.ts` (a job registered after a turn
holds the clock) and the live witness (`checkJournal` `jobs_held_after_turn`,
required non-empty); see `evidence/sim-p13-background-job-holds-clock.md`
Guarantee: SIM-P13: A background job is in `busy_set` while no turn is in
`busy_set`.
Check: `sometimes` - observe at least one journal state where the busy set holds
a job and no turn; this situation must occur in the campaign, since only then
does the job hold the clock on its own.
Fault/timing angle: none.
Required faults and enabling state: a fold or memory-capture job that outlives
its triggering turn.
Confidence: medium - [evidence](evidence/sim-p13-background-job-holds-clock.md).
M4 (#1028) implements the surface; the unit tests and the live witness named
under Existing check construct the record, and a default tier run reaches it.
Existing check: `src/run/scheduler.test.ts` ("a background job registered after a
turn ends holds the clock until it ends"), `src/run/journal-check.ts`
`jobs_held_after_turn`, required non-empty by `tests/witness-faults.ts`
Impact: The job-holds-clock branch is never exercised and SIM-P12's job half is
untested.
Open questions: None.

### sim-p14-idle-jump-lands-on-next-event

Type: safety
Reachability: default-production
Status: active
Exercised: yes - `src/run/scheduler.test.ts` (each jump lands on the next
event) and the live witness (`checkJournal` `off_schedule_jumps`); see
`evidence/sim-p14-idle-jump-lands-on-next-event.md`
Guarantee: SIM-P14: After `AdvanceClock`, `scenario_ms` equals the earliest
scheduled event time greater than the previous value.
Check: `always` - for each `AdvanceClock`, assert the new `scenario_ms` equals
the minimum scheduled event time above the old value; a jump past an event skips
it.
Fault/timing angle: a laptop-sleep fault inserts a jump of its own duration.
Required faults and enabling state: a scenario with idle gaps between events.
Confidence: medium - [evidence](evidence/sim-p14-idle-jump-lands-on-next-event.md).
M4 (#1028) implements the surface; the unit tests and the live witness named
under Existing check construct the record, and a default tier run reaches it.
Existing check: `src/run/scheduler.test.ts` (every jump lands on the next
event), `src/run/journal-check.ts` `off_schedule_jumps` and
`jump_origin_mismatch` (run by `tests/witness-faults.ts`)
Impact: Events are skipped or issued late and the scenario differs from its
compiled plan.
Open questions: None.

### sim-p15-proxy-record-carries-both-times

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P15: Every call record has `scenario_ms` equal to the clock at
receipt and a `wall_ms`, and `wall_ms` is non-decreasing in sequence order.
Check: `always` - for each call record, compare `scenario_ms` to the journaled
clock at its `seq` and assert `wall_ms` is present and non-decreasing; every
record needs both times.
Fault/timing angle: a call that arrives during an `AdvanceClock` must take one
value consistently.
Required faults and enabling state: proxy traffic during and around an idle
jump.
Confidence: low -
[evidence](evidence/sim-p15-proxy-record-carries-both-times.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: Latency and age cannot be reconstructed for a call.
Open questions: None.

### sim-p16-faketime-verified-per-binary-before-start

Type: safety
Reachability: default-production
Status: active
Exercised: yes - `src/run/time.test.ts` (per-binary interception) and the run
command's `Preflight` journal entry before `StartRun`, which the live witness
requires with every binary intercepted; see
`evidence/sim-p16-faketime-verified-per-binary-before-start.md`
Guarantee: SIM-P16: `StartRun` is preceded by a journaled interception test per
host binary (Pi, OpenCode, daemon) that read a faked time; a failure records the
binary wall-clock-only or refuses the run.
Check: `always-or-unreached` - for each `StartRun`, assert one interception-test
entry per binary precedes it, and a failing binary is marked wall-clock-only;
`always-or-unreached` because a run that never starts never needs the test.
Fault/timing angle: the setuid sandbox boundary strips `LD_*`, so injection must
follow privilege drop.
Required faults and enabling state: the real sandbox launcher, the interposer on
a kept mount, and each host binary.
Confidence: medium - [evidence](evidence/sim-p16-faketime-verified-per-binary-before-start.md).
M4 (#1028) implements the surface; the unit tests and the live witness named
under Existing check construct the record, and a default tier run reaches it.
OQ-9 (whether the Bun-compiled OpenCode binary reads time through libc) is
closed: the 2026-10-16 live witness's `Preflight` entries record OpenCode
1.18.22 as intercepted.
Existing check: `src/run/time.test.ts` (per-binary interception), the
`Preflight` journal entry `src/run/run.ts` writes before `StartRun`, required
by `tests/witness-faults.ts` with `pi`, `opencode`, and `daemon` intercepted
Impact: A binary silently runs on wall time and every scenario-time claim about
it is false.
Open questions: None.

### sim-p17-long-idle-gaps-reached

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M2 (#1026); nothing constructs
it yet
Guarantee: SIM-P17: An idle gap longer than 5 minutes and a gap longer than 1
hour occur in scenario time.
Check: `sometimes` - observe at least one `AdvanceClock` of more than 5 minutes
and one of more than 1 hour per campaign; the idle tail is a situation the
campaign must produce.
Fault/timing angle: none.
Required faults and enabling state: the fitted idle-gap distribution with its
tail.
Confidence: low - [evidence](evidence/sim-p17-long-idle-gaps-reached.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Resume-after-gap behaviour (P6) is never exercised.
Open questions: None.

### sim-p18-sleep-fault-is-event-free-jump

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial - `src/run/scheduler.test.ts` (one fault-tagged jump onto
the session's first event with no event inside) and the live witness
(`checkJournal` `events_inside_sleep`, `repeated_sleeps`, one tagged jump per
arm and sleep); the 2026-10-16 witness run predates the current jump shape;
see `evidence/sim-p18-sleep-fault-is-event-free-jump.md`
Guarantee: SIM-P18: A laptop-sleep fault produces exactly one `AdvanceClock`,
carrying the fault id, that spans the idle gap before its session with
`busy_set` empty and no events inside the gap.
Check: `always` - for each sleep fault, assert one `AdvanceClock` carrying its
id that lands on the session's first event, an empty busy set at that `seq`,
and no event with `scenario_ms` inside the gap.
Fault/timing angle: a sleep scheduled while a job is busy must wait for the job.
Required faults and enabling state: a scheduled laptop-sleep fault.
Confidence: low - [evidence](evidence/sim-p18-sleep-fault-is-event-free-jump.md).
M4 (#1028) implements the surface; the unit tests and the live witness named
under Existing check construct the record, and the 2026-10-16 live witness predates the current sleep-jump shape, so a new run must confirm it; reached only when the tier schedules faults or the counterfactual arm.
Existing check: `src/run/scheduler.test.ts` ("a laptop sleep is one event-free
jump"), `src/run/journal-check.ts` `events_inside_sleep`, `repeated_sleeps`,
`sleep_jump_faults`, required per arm and sleep by `tests/witness-faults.ts`
Impact: The sleep fault tests a different condition than the one scheduled.
Open questions: None.

### sim-p19-wall-clock-distortion-recorded

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P19: The run header records that provider-side time is
wall-clock, and each call record carries cache read and write tokens so
prompt-cache warmth is reconstructible.
Check: `always` - assert the run header carries the wall-clock provider-time
statement and every call record carries cache read and write token fields; each
run must disclose the distortion.
Fault/timing angle: none.
Required faults and enabling state: any run with provider calls.
Confidence: low -
[evidence](evidence/sim-p19-wall-clock-distortion-recorded.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: A reader attributes prompt-cache effects to scenario time.
Open questions: None.

## User-sim and tape

### sim-p20-tape-replays-while-context-matches

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P20: A sibling arm in `replaying` mode receives the tape's text
for `event_idx` when its context hash equals the tape's recorded hash, and no
user-sim model call is made for that event.
Check: `always` - for each replayed event, assert the delivered text equals the
tape entry and no user-sim call record exists for that arm and event; a live
call during a match breaks pairing.
Fault/timing angle: the hash comparison races the agent's final output flush.
Required faults and enabling state: two arms of one seed with matching outputs
at least once.
Confidence: low -
[evidence](evidence/sim-p20-tape-replays-while-context-matches.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: Paired arms receive different user text before divergence.
Open questions:
- OQ-3: see SIM-P02.

### sim-p21-tape-goes-live-only-after-divergence

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P21: The first user-sim model call for a sibling arm at
`event_idx` has a divergence record with index at most `event_idx`.
Check: `always` - for each sibling arm's first user-sim call, assert a
divergence record exists with index at most that event; going live early breaks
pairing.
Fault/timing angle: none.
Required faults and enabling state: a sibling arm that diverges.
Confidence: low -
[evidence](evidence/sim-p21-tape-goes-live-only-after-divergence.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: Paired arms receive different user text before divergence.
Open questions: None.

### sim-p22-each-ledger-fact-conveyed-once-in-assigned-manner

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P22: For every ledger fact, exactly one conveyance event with the
compiled manner and session is journaled as delivered; reversal facts have
exactly two, the statement and the reversal.
Check: `always` - for each ledger fact, count delivered conveyance events and
compare manner and session to the compiled plan; one per fact, two for
reversals.
Fault/timing angle: a conveyance turn that fails is retried by the user-sim and
conveys twice.
Required faults and enabling state: the conveyance plan with every manner,
including stated-then-reversed facts.
Confidence: low -
[evidence](evidence/sim-p22-each-ledger-fact-conveyed-once-in-assigned-manner.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Recall is measured on facts conveyed a different number of times than
planned.
Open questions: None.

### sim-p23-user-sim-and-judge-calls-tagged-and-separated

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P23: Every user-sim and judge call record has component
`user-sim` or `judge`, and `CostByComponent` excludes them from agent, capture,
summarizer, and title cost.
Check: `always` - assert every harness-originated call carries an asserted
`user-sim` or `judge` tag and that cost by component excludes them from the four
product components.
Fault/timing angle: none.
Required faults and enabling state: user-sim and judge calls through the proxy.
Confidence: low -
[evidence](evidence/sim-p23-user-sim-and-judge-calls-tagged-and-separated.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Eidnara's cost ratio includes the harness's own model spend.
Open questions: None.

### sim-p24-paste-turn-provenance

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P24: A paste turn's record names its corpus item id and byte
length, and the bytes delivered equal the corpus bytes.
Check: `always` - for each paste turn, assert the record names a corpus id and
length and the delivered bytes equal the corpus item's bytes.
Fault/timing angle: none.
Required faults and enabling state: a scenario with paste turns.
Confidence: low - [evidence](evidence/sim-p24-paste-turn-provenance.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: A paste carries unlicensed or altered content.
Open questions: None.

### sim-p25-pushback-label-per-turn

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P25: Every user-sim turn carries a label in task, pushback,
interrupt, redirect, abandon, clarify, or paste, and P14 derives from labels
only.
Check: `always` - assert every user-sim turn has exactly one label from the
fixed set and that P14's inputs are labels only.
Fault/timing angle: none.
Required faults and enabling state: a run with user-sim turns.
Confidence: low - [evidence](evidence/sim-p25-pushback-label-per-turn.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: P14 reads transcript text and grades by self-report.
Open questions: None.

### sim-p26-user-sim-noise-floor-run-is-paired

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M6 (#1031); nothing constructs
it yet
Guarantee: SIM-P26: The same-config paired run shares `scenario_hash` and arm
config and differs only in user-sim seed, and the report names its disagreement
rate.
Check: `always` - for the noise-floor pair, assert equal `scenario_hash` and arm
config, different user-sim seeds, and a reported disagreement rate.
Fault/timing angle: none.
Required faults and enabling state: an A/A run per tier.
Confidence: low -
[evidence](evidence/sim-p26-user-sim-noise-floor-run-is-paired.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: The user-sim's own noise is read as a treatment effect.
Open questions: None.

## Capture proxy and faults

### sim-p27-every-request-yields-one-record

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P27: Proxy requests received equal call records journaled per
arm, including refused requests recorded as `rejected`.
Check: `always` - compare the proxy's received-request counter to journaled call
records per arm, counting `rejected` records; attempted and acknowledged counts
are tracked separately per METHOD's effect accounting.
Fault/timing angle: a client disconnect mid-stream must still yield one record.
Required faults and enabling state: a run with a refused request and a client
disconnect.
Confidence: low -
[evidence](evidence/sim-p27-every-request-yields-one-record.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: Cost and fault evidence silently drop calls.
Open questions: None.

### sim-p28-component-classification-is-total

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P28: Every record has exactly one component in the fixed set, and
unknown shapes map to `other`, never dropped.
Check: `always` - assert every call record carries exactly one component from
the fixed set; an unknown shape is `other`.
Fault/timing angle: none.
Required faults and enabling state: traffic from every component, plus one
unrecognised request shape.
Confidence: low -
[evidence](evidence/sim-p28-component-classification-is-total.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: Cost by component does not sum to the total.
Open questions: None.

### sim-p29-finish-reason-recorded

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P29: Every forwarded record carries the provider `finish_reason`
or an explicit `stream_cut` marker.
Check: `always` - assert each forwarded record has `finish_reason` or
`stream_cut`; a record with neither hides a truncated response.
Fault/timing angle: a stream cut mid-body has no provider finish reason.
Required faults and enabling state: a truncated-stream fault.
Confidence: low - [evidence](evidence/sim-p29-finish-reason-recorded.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: The fold-lag and truncation failure classes cannot be told apart.
Open questions: None.

### sim-p30-no-unscheduled-fault

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P30: Every record with `fault_ref` set names a fault instance in
state `armed` or `triggered` at that sequence.
Check: `always(!X)` - X is a record whose `fault_ref` names no armed or
triggered instance; a forbidden state checked over every record, so
`always(!X)`.
Fault/timing angle: a fault decorator left armed after its window injects into
later calls.
Required faults and enabling state: a fault schedule with windows that close.
Confidence: low - [evidence](evidence/sim-p30-no-unscheduled-fault.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and reached only when the tier
schedules faults or the counterfactual arm.
Existing check: none
Impact: Faults the schedule did not plan corrupt both arms' metrics.
Open questions: None.

### sim-p31-fault-counts-only-when-observed-at-target

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P31: A fault instance is `triggered` only with evidence: for
provider faults, a call record from the target component carrying `fault_ref`;
for infrastructure faults, the observing oracle's record from the target
component.
Check: `always` - for each `triggered` instance, assert injection evidence and
target-component observation both exist; one witness is not enough.
Fault/timing angle: provider faults enter downstream of the proxy retry; the
host SDK must see them.
Required faults and enabling state: each fault kind with its target component
active.
Confidence: low -
[evidence](evidence/sim-p31-fault-counts-only-when-observed-at-target.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and reached only when the tier
schedules faults or the counterfactual arm.
Existing check: none
Impact: A fault that never reached its target is counted as survived.
Open questions:
- OQ-8: the evidence shape proving a SIGKILL landed inside an in-progress fold.
  Candidate: a summarizer call record in flight at the kill wall time.
  Unresolved, needs the daemon's fold-start signal (needs human input).

### sim-p32-missed-fault-excludes-run-from-fault-metrics

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P32: If any fault instance ends `missed`,
`FaultMetricsEligible(run)` is false and fault metrics in the report omit the
run with the fault id listed.
Check: `always` - for each run with a `missed` instance, assert fault metrics
omit it and the report lists the fault id.
Fault/timing angle: none.
Required faults and enabling state: a scheduled fault whose target never runs.
Confidence: low -
[evidence](evidence/sim-p32-missed-fault-excludes-run-from-fault-metrics.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and reached only when the tier
schedules faults or the counterfactual arm.
Existing check: none
Impact: Recovery is reported for faults that never happened.
Open questions: None.

### sim-p33-missed-fault-occurs

Type: reachability
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P33: A scheduled fault ends `missed` at least once per campaign.
Check: `sometimes` - observe at least one `missed` instance in the campaign; the
missed path is a situation, and only a real miss exercises SIM-P32.
Fault/timing angle: none.
Required faults and enabling state: a fault keyed on a component event that does
not occur in its window.
Confidence: low - [evidence](evidence/sim-p33-missed-fault-occurs.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and reached only when the tier schedules faults or the
counterfactual arm.
Existing check: none
Impact: The exclusion path of SIM-P32 is never exercised.
Open questions: None.

### sim-p34-each-fault-kind-triggers

Type: reachability
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M3 (#1027); nothing constructs
it yet
Guarantee: SIM-P34: Each fault kind triggers at least once: 429, 5xx, timeout,
`finish_reason=length`, silent cut, empty content, schema-wrong tool call, slow
stream, SIGKILL mid-fold, restart between sessions, ENOSPC, plugin reload, host
upgrade, model switch, two clients on one daemon, and laptop sleep.
Check: `reachable` - for each fault kind, the injection code point for that kind
executes with a `triggered` outcome; `reachable` is per-kind location coverage.
Fault/timing angle: SIGKILL must land inside an in-progress fold.
Required faults and enabling state: the full fault catalogue scheduled across M,
L, and XL.
Confidence: low - [evidence](evidence/sim-p34-each-fault-kind-triggers.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and reached only when the tier
schedules faults or the counterfactual arm.
Existing check: none
Impact: A fault kind's recovery path is never tested.
Open questions:
- OQ-8: see SIM-P31 for the mid-fold SIGKILL evidence shape.

### sim-p35-transcript-store-reads-observed-not-blocked

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M8 (#1034); nothing constructs
it yet
Guarantee: SIM-P35: A read under `~/.pi/agent/sessions` or `opencode.db` by the
`host` arm produces a read observation, and the read succeeds with command exit
and bytes unaffected.
Check: `always` - for each host-arm read of the transcript store, assert one
read observation and an unaffected command exit and byte count; observation
never blocks.
Fault/timing angle: host upgrades may move the store; the path table is verified
per host version at run start.
Required faults and enabling state: a host-arm session that searches its own
transcript.
Confidence: low -
[evidence](evidence/sim-p35-transcript-store-reads-observed-not-blocked.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: The control arm is handicapped or its transcript search goes
unattributed.
Open questions:
- OQ-7: the transcript-store path table per host version. Unresolved, needs
  verification at each run start.
- OQ-13: whether host transcript timestamps persisted under a scenario jump
  affect D2 attribution or session ordering. Unresolved, measured after the
  first S run.

### sim-p36-transcript-search-occurs

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M8 (#1034); nothing constructs
it yet
Guarantee: SIM-P36: The `host` arm reads its transcript store during an item
window at least once per campaign.
Check: `sometimes` - observe at least one transcript read by the host arm inside
an item window; only a real read exercises SIM-P35 and SIM-P37.
Fault/timing angle: none.
Required faults and enabling state: a host arm facing a cross-session probe.
Confidence: low - [evidence](evidence/sim-p36-transcript-search-occurs.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: The D2 attribution split is never exercised.
Open questions: None.

### sim-p37-transcript-read-latency-stays-in-host-cost

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P37: Tokens and latency of turns containing transcript reads are
attributed to the `host` arm's cost and latency metrics, with no exclusion.
Check: `always` - assert turns with transcript reads appear in the host arm's
cost and latency aggregates; excluding them flatters the control arm.
Fault/timing angle: none.
Required faults and enabling state: a host-arm turn with a transcript read.
Confidence: low -
[evidence](evidence/sim-p37-transcript-read-latency-stays-in-host-cost.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: The cost and latency comparison understates the host arm's effort.
Open questions: None.

### sim-p38-cost-conserves-by-component

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P38: Per-arm total tokens equal the sum of per-component tokens,
and per-component cost uses the journaled price table version.
Check: `always` - assert per-arm token totals equal the per-component sum and
each cost cites the journaled price table version.
Fault/timing angle: none.
Required faults and enabling state: a run with every component active.
Confidence: low - [evidence](evidence/sim-p38-cost-conserves-by-component.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Cost ratios are computed on tokens that do not add up.
Open questions: None.

### sim-p39-hang-is-derived-from-call-silence

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M5 (#1029); nothing constructs
it yet
Guarantee: SIM-P39: A turn is `hang` iff its wall duration exceeds 5 minutes
with no call record from the agent's component in that window, or a completed
model call is followed by no persistence or tool execution within the bound; the
turn ends `failed` with cause `hang`.
Check: `always` - for each turn, compute call silence and post-call inactivity
windows and assert the `hang` label matches the definition in both directions.
Fault/timing angle: the observed Pi hang had a completed model call.
Required faults and enabling state: a turn with a completed call and no
follow-up.
Confidence: low -
[evidence](evidence/sim-p39-hang-is-derived-from-call-silence.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: The intermittent Pi hang goes undetected or a slow turn is mislabelled.
Open questions: None.

## Graders

### sim-p40-grade-inputs-are-artefacts-only

Type: safety
Reachability: default-production
Status: active
Exercised: partial - the M5 grading unit (#1029) exercises the grader on
recorded fixtures in `src/grade/probes.test.ts`; run and report wiring lands in
later units
Guarantee: SIM-P40: Each grade record lists its input artefact ids, every id is
of class diff, command-log, test-result, workspace-state, or proxy-call, and
classes transcript and agent self-report never appear.
Check: `always` - for each grade record, assert every input id is of an allowed
artefact class.
Fault/timing angle: none.
Required faults and enabling state: grades for every programmatic probe type.
Confidence: low -
[evidence](evidence/sim-p40-grade-inputs-are-artefacts-only.md). PROPOSED:
reconstructed from the condensed index in spec #1007; the M5 grading unit
(#1029) implements the grader and run and report wiring is still absent, and a
default tier run reaches it.
Existing check: `src/grade/probes.test.ts`, grading harness: a snapshot carrying
a transcript artefact is refused, and every fixture grade lists exactly the
artefact ids its grader read; status unaudited
Impact: A system that restates a rule and then violates it scores as compliant.
Open questions: None.

### sim-p41-first-attempt-snapshot-set-once

Type: safety
Reachability: default-production
Status: active
Exercised: partial - the M5 grading unit (#1029) exercises the grader on
recorded fixtures in `src/grade/probes.test.ts`; run and report wiring lands in
later units
Guarantee: SIM-P41: `SnapshotArtefacts` appears exactly once per item and arm,
at the first `EndTurn` of the probe task, and grades reference that snapshot id.
Check: `always` - count `SnapshotArtefacts` per item and arm, assert exactly one
at the first `EndTurn`, and assert grades cite it.
Fault/timing angle: a user-sim pushback after the probe turn lets the agent
retry.
Required faults and enabling state: a probe turn followed by pushback.
Confidence: low -
[evidence](evidence/sim-p41-first-attempt-snapshot-set-once.md). PROPOSED:
reconstructed from the condensed index in spec #1007; the M5 grading unit
(#1029) implements the grader and run and report wiring is still absent, and a
default tier run reaches it.
Existing check: `src/grade/probes.test.ts`, grading harness: only the first
attempt is graded and later snapshots are counted; status unaudited
Impact: A later corrected attempt is graded as the first.
Open questions: None.

### sim-p42-grade-is-versioned-not-overwritten

Type: safety
Reachability: default-production
Status: active
Exercised: partial - the M5 grading unit (#1029) exercises the grader on
recorded fixtures in `src/grade/probes.test.ts`; run and report wiring lands in
later units
Guarantee: SIM-P42: For an item and arm, grade versions are strictly increasing,
the report names the version used, and no journal entry rewrites an earlier
version.
Check: `always` - assert grade versions per item and arm strictly increase, no
entry rewrites one, and the report names its version.
Fault/timing angle: none.
Required faults and enabling state: a regrade after a grader fix.
Confidence: low -
[evidence](evidence/sim-p42-grade-is-versioned-not-overwritten.md). PROPOSED:
reconstructed from the condensed index in spec #1007; the M5 grading unit
(#1029) implements the grader and run and report wiring is still absent, and a
default tier run reaches it.
Existing check: `src/grade/probes.test.ts`, grading harness: grade versions for
one item and arm strictly increase and an out-of-order version is refused;
status unaudited
Impact: A report silently uses a different grade than the one recorded.
Open questions: None.

### sim-p43-judge-hygiene-on-p7-only

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M5 (#1029); nothing constructs
it yet
Guarantee: SIM-P43: Every judge call has `component = judge`, a model family
that differs from the agent model, no arm label in the prompt, both position
orders per item, and the calibration digest recorded.
Check: `always` - for each judge call, assert the component tag, model family
difference, blinding, both orders, and calibration digest; every condition must
hold for every P7 item.
Fault/timing angle: none.
Required faults and enabling state: P7 items with a calibration set.
Confidence: low - [evidence](evidence/sim-p43-judge-hygiene-on-p7-only.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: The P7 judge identifies arms or prefers its own family.
Open questions: None.

### sim-p44-p7-human-check-sample

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M5 (#1029); nothing constructs
it yet
Guarantee: SIM-P44: A 10% sample of P7 items per tier is journaled as
`human_check_pending` before the tier verdict, and the verdict names the sample.
Check: `always` - assert the sample size is at least 10% of P7 items rounded up
and the entries precede the verdict.
Fault/timing angle: none.
Required faults and enabling state: a tier with P7 items.
Confidence: low - [evidence](evidence/sim-p44-p7-human-check-sample.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Judge calibration drifts with no human anchor.
Open questions: None.

### sim-p45-issued-items-stay-in-denominator

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M5 (#1029); nothing constructs
it yet
Guarantee: SIM-P45: Every item that reached `issued` appears in exactly one of
graded, failed, or excluded with a reason; abstention (P9) and over-application
(P2, P10, P11) are grades, not exclusions.
Check: `always` - for each issued item, assert exactly one terminal class and
that abstention and over-application appear as grades.
Fault/timing angle: an interrupt mid-item must resolve to one class.
Required faults and enabling state: a run with an interrupt and abstentions.
Confidence: low -
[evidence](evidence/sim-p45-issued-items-stay-in-denominator.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: Denominators shrink to flatter an arm.
Open questions: None.

### sim-p46-failed-turn-item-is-not-a-grade

Type: safety
Reachability: default-production
Status: active
Exercised: partial - the M5 grading unit (#1029) exercises the grader on
recorded fixtures in `src/grade/probes.test.ts`; run and report wiring lands in
later units
Guarantee: SIM-P46: An item whose probe turn ended `failed` has no grade version
and is counted in dependability metrics; recall and harm rates name their
excluded-failed count.
Check: `always` - for each failed probe turn, assert no grade version exists,
the item counts in dependability, and rates report the excluded-failed count.
Fault/timing angle: provider faults fail turns.
Required faults and enabling state: a provider fault during a probe turn.
Confidence: low -
[evidence](evidence/sim-p46-failed-turn-item-is-not-a-grade.md). PROPOSED:
reconstructed from the condensed index in spec #1007; the M5 grading unit
(#1029) implements the grader and run and report wiring is still absent, and a
default tier run reaches it.
Existing check: `src/grade/probes.test.ts`, grading harness: a probe turn that
failed has no grade, before any grader is selected; status unaudited
Impact: An arm is penalised in recall for provider faults it did not cause, or
failures vanish.
Open questions:
- OQ-5 is resolved in the M0 pre-registration: failed-turn items are excluded
  from recall denominators with the excluded count named per arm.

### sim-p47-fold-event-yields-p13-record

Type: safety
Reachability: default-production
Status: active
Exercised: partial - the M5 grading unit (#1029) exercises item-level P13
grading on recorded fixtures in `src/grade/probes.test.ts`; one record per fold
and run wiring
remain open
Guarantee: SIM-P47: Every observed fold or host compaction event, a
`history_summarizer` or `native_compaction` call followed by a context-size
drop, yields one P13 record naming the event.
Check: `always` - for each such event in the proxy records, assert exactly one
P13 record cites it.
Fault/timing angle: a fold killed mid-way yields a partial event.
Required faults and enabling state: a p90 session.
Confidence: low - [evidence](evidence/sim-p47-fold-event-yields-p13-record.md).
PROPOSED:
reconstructed from the condensed index in spec #1007; the M5 grading unit
(#1029) implements the grader and run and report wiring is still absent, and a
default tier run reaches it.
Existing check: `src/grade/probes.test.ts`, recorded fixtures: the P13 fixtures
grade one record per item from the folds in its range and count them in
`P13.folds`; one record per fold, naming the fold event, remains untested;
status unaudited
Impact: Fold fidelity is measured on a subset of folds.
Open questions: None.

### sim-p48-fold-observed-in-campaign

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M5 (#1029); nothing constructs
it yet
Guarantee: SIM-P48: A fold or host compaction occurs at least once per campaign.
Check: `sometimes` - observe at least one fold or compaction event; without one
P13 and SIM-P47 are vacuous.
Fault/timing angle: none.
Required faults and enabling state: forced p90 sessions.
Confidence: low - [evidence](evidence/sim-p48-fold-observed-in-campaign.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Fold fidelity is never measured.
Open questions: None.

### sim-p49-p1-control-instance-paired

Type: safety
Reachability: default-production
Status: active
Exercised: partial - the M5 grading unit (#1029) exercises the grader on
recorded fixtures in `src/grade/probes.test.ts`; run and report wiring lands in
later units
Guarantee: SIM-P49: Every P1 item has a no-cue control instance with the same
task, and the report pairs them.
Check: `always` - for each P1 item, assert a control instance with the same task
exists and the report pairs them.
Fault/timing angle: none.
Required faults and enabling state: a probe plan with P1 items.
Confidence: low - [evidence](evidence/sim-p49-p1-control-instance-paired.md).
PROPOSED:
reconstructed from the condensed index in spec #1007; the M5 grading unit
(#1029) implements the grader and run and report wiring is still absent, and a
default tier run reaches it.
Existing check: `src/grade/probes.test.ts`, grading harness: P1 and its control
are paired by fact under separate metrics; status unaudited
Impact: P1 compliance cannot be separated from the task's base rate.
Open questions: None.

### sim-p50-p11-false-positive-weight-applied

Type: safety
Reachability: default-production
Status: active
Exercised: partial - the M5 grading unit (#1029) exercises the grader on
recorded fixtures in `src/grade/probes.test.ts`; run and report wiring lands in
later units
Guarantee: SIM-P50: The P11 harm score weights a false positive at twice a hit,
and the weight is in the pre-registration record.
Check: `always` - assert the P11 score formula uses the pre-registered weight of
two.
Fault/timing angle: none.
Required faults and enabling state: P11 items.
Confidence: low -
[evidence](evidence/sim-p50-p11-false-positive-weight-applied.md). PROPOSED:
reconstructed from the condensed index in spec #1007; the M5 grading unit
(#1029) implements the grader and run and report wiring is still absent, and a
default tier run reaches it.
Existing check: `src/grade/probes.test.ts`, grading harness: P11 scores a hit +1
and a false-positive injection minus the pre-registered weight; status unaudited
Impact: Wrong-project injection is under-penalised.
Open questions: None.

## Metrics and gates

### sim-p51-gate-reads-completed-pairs-only

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P51: `EvaluateGate` input set equals `CompletedPairs(tier)` at
`journal_seq_at_eval`, and the verdict carries excluded-pair count and ids.
Check: `always` - recompute completed pairs at the recorded `seq` and compare to
the gate's input set; assert excluded count and ids are present.
Fault/timing angle: a gate evaluated while items are in flight.
Required faults and enabling state: a tier with an in-flight item at evaluation.
Confidence: low -
[evidence](evidence/sim-p51-gate-reads-completed-pairs-only.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: A gate passes on a selected subset of pairs.
Open questions: None.

### sim-p52-gate-carries-preregistered-mde

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M0 (#1024); nothing constructs
it yet
Guarantee: SIM-P52: A verdict records MDE, n, and the pre-registration hash
journaled at `StartRun`, and the hash matches the pre-registration file.
Check: `always` - for each verdict, assert MDE and n are present and the hash
equals both the journaled hash and the file's digest; `checkReport` refuses a
report with a missing family by name.
Fault/timing angle: none.
Required faults and enabling state: a tier report and its pre-registration file.
Confidence: low -
[evidence](evidence/sim-p52-gate-carries-preregistered-mde.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: `src/prereg/validate.test.ts`, report check: a report missing a
family, under another pre-registration hash, or with a verdict the family's
claim does not allow is refused by name; status unaudited
Impact: A gate is passed under an analysis chosen after seeing the data.
Open questions: None.

### sim-p53-parity-never-emitted

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M0 (#1024); nothing constructs
it yet
Guarantee: SIM-P53: The verdict vocabulary is better, worse,
no-difference-above-X-pp-detectable-at-n, failed-gate(metric, items),
inconclusive, insufficient-runs, and descriptive, and the string `parity` is
absent from every report.
Check: `always(!X)` - X is the token `parity` in any report; a forbidden state
scanned over the whole report, so `always(!X)`.
Fault/timing angle: none.
Required faults and enabling state: any tier report.
Confidence: low - [evidence](evidence/sim-p53-parity-never-emitted.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: `src/prereg/validate.test.ts`, report check: the token `parity`
anywhere in a report, in any case, is refused; status unaudited
Impact: A null at small n is read as equivalence.
Open questions:
- The verdict vocabulary adds three kinds to the spec index's four:
  `inconclusive` from the M7 statistics ticket (#1032), `insufficient-runs` from
  SIM-P56, and `descriptive` for a family the pre-registration does not gate.
  Whether the spec index should list them is a design decision (needs human
  input).

### sim-p54-pairing-by-item-identity

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P54: McNemar and bootstrap pairs are keyed by `item_id` across
arms, never by position.
Check: `always` - assert every pair's two outcomes share `item_id`; positional
pairing breaks after any exclusion.
Fault/timing angle: an exclusion in one arm shifts positions.
Required faults and enabling state: a run with one excluded item in one arm.
Confidence: low - [evidence](evidence/sim-p54-pairing-by-item-identity.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Discordance is computed on mismatched items.
Open questions: None.

### sim-p55-early-stop-records-cause

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P55: A CUSUM early stop journals the metric, the item ids in the
stopping window, and `journal_seq_at_eval`, and items already issued continue to
terminal state.
Check: `always-or-unreached` - for each early stop, assert the three fields and
that issued items reach terminal state; `always-or-unreached` because a tier may
never stop early.
Fault/timing angle: a stop arrives while items are in flight.
Required faults and enabling state: a harm or futility signal in a sequence.
Confidence: low - [evidence](evidence/sim-p55-early-stop-records-cause.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: An early stop hides its cause or abandons issued items.
Open questions: None.

### sim-p56-failed-turn-claim-needs-six-paired-runs

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P56: A dependability verdict on failed turns or hangs is emitted
only with at least six paired runs; below that the verdict is
`insufficient-runs(k)`.
Check: `always` - assert a dependability verdict with a paired interval cites at
least six paired runs and otherwise reads `insufficient-runs(k)`; the
pre-registration validator refuses a run-level gate with a paired interval below
six, and a bound gate that compares each run to a fixed value carries no paired
claim.
Fault/timing angle: none.
Required faults and enabling state: a tier with fewer than six paired runs.
Confidence: low -
[evidence](evidence/sim-p56-failed-turn-claim-needs-six-paired-runs.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: `src/prereg/validate.test.ts`: the validator refuses a run-level
gate with a paired interval below six paired runs, and the report check refuses
any verdict but `insufficient-runs` below the family's floor; status unaudited
Impact: A run-level claim is made from one or two runs.
Open questions:
- The S tier gates failed turns, internal-string hits, and p95 latency delta as
  `zero-tolerance` and `threshold` families, each comparing every run to a fixed
  bound with no paired interval, because the S ticket (#1034) stops the pipeline
  on any of them. The validator exempts such bound gates from the six-run floor
  and refuses them a paired interval method. Whether a bound gate at S fits the
  spec's "S and M run-level numbers are descriptive" is a design decision (needs
  human input).

### sim-p57-leak-verdict-uses-fit-and-bound

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P57: The leak verdict reports slope, R squared, and the
inequality `RSS(T) < 2 * RSS(0) + N_sessions * c` with `c` from the
pre-registration, and samples every 10 seconds of wall time carry scenario and
wall time.
Check: `always` - assert the verdict carries slope, R squared, and the bound
with the pre-registered `c`, and samples are at the pre-registered interval with
both times.
Fault/timing angle: warmup and cooldown phases distort a naive slope.
Required faults and enabling state: a soak run with sampler output.
Confidence: low -
[evidence](evidence/sim-p57-leak-verdict-uses-fit-and-bound.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: The observed linear RSS growth is missed or misreported.
Open questions: None.

### sim-p58-harm-metric-direction

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P58: "Memory made it worse" is set iff some harm metric has
`eidnara < host` with the paired CI excluding zero, and the metric and CI are
named.
Check: `always` - assert the worse flag matches the Holm-corrected harm results
in both directions and names metric and CI.
Fault/timing angle: none.
Required faults and enabling state: harm family results.
Confidence: low - [evidence](evidence/sim-p58-harm-metric-direction.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Harm is reported in the wrong direction or not at all.
Open questions: None.

### sim-p59-internal-string-scan-on-user-visible-only

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P59: The internal-string regex set runs over agent output
delivered to the user-sim and over tool output shown to the agent, each hit is
journaled by source, and the S gate requires zero hits.
Check: `always` - assert the scan covers both user-visible sources, every hit is
journaled with its source, and the S gate fails on any hit.
Fault/timing angle: none.
Required faults and enabling state: a mutant fixture with an internal string.
Confidence: low -
[evidence](evidence/sim-p59-internal-string-scan-on-user-visible-only.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Leaked internal text reaches users unreported.
Open questions: None.

## Journal and resumability

### sim-p60-journal-has-one-writer

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M4 (#1028); nothing constructs
it yet
Guarantee: SIM-P60: A run directory holds one exclusive claim, and a second
`StartRun` or `ResumeRun` on the same directory is refused before any write.
Check: `always` - attempt a second start on a claimed directory and assert
refusal with no journal change.
Fault/timing angle: two harness processes started near-simultaneously.
Required faults and enabling state: a live claim and a second process.
Confidence: low - [evidence](evidence/sim-p60-journal-has-one-writer.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Two writers interleave sequence numbers and corrupt the journal.
Open questions: None.

### sim-p61-journal-is-append-only-with-monotone-seq

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M4 (#1028); nothing constructs
it yet
Guarantee: SIM-P61: Entries have strictly increasing `seq`, no entry is
rewritten, and a partial trailing entry is detected on load.
Check: `always` - assert strictly increasing `seq`, byte-stable prefixes across
loads, and detection of a truncated last line.
Fault/timing angle: a kill mid-write leaves a partial line.
Required faults and enabling state: a harness kill during a journal append.
Confidence: low -
[evidence](evidence/sim-p61-journal-is-append-only-with-monotone-seq.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Resume reads a corrupt entry as valid.
Open questions: None.

### sim-p62-resume-does-not-reissue-completed-items

Type: safety
Reachability: default-production
Status: active
Exercised: partial - `src/run/scheduler.test.ts` (resume reissues no completed
event) and the live witness `resume` run (no turn rebilled, call `seq`
contiguous) cover the reissue half; call records carry no `call_id`, so the
repeated-`call_id` half is not yet representable; see
`evidence/sim-p62-resume-does-not-reissue-completed-items.md`
Guarantee: SIM-P62: After `ResumeRun`, no `BeginTurn` appears for an item
already terminal, and no call record repeats a pre-interrupt `call_id`.
Check: `always` - after resume, assert no `BeginTurn` for terminal items and no
duplicate `call_id`.
Fault/timing angle: an interrupt between `EndTurn` and its journal entry.
Required faults and enabling state: a harness kill at varied points.
Confidence: low - [evidence](evidence/sim-p62-resume-does-not-reissue-completed-items.md).
M4 (#1028) implements the surface; the unit tests and the live witness named
under Existing check construct the record, and the repeated-`call_id` half has no check yet; a default tier run reaches it.
Existing check: `src/run/scheduler.test.ts` (resume reissues no completed
event), `tests/witness-faults.ts` `resume` (no turn rebilled, contiguous call
`seq`); none for the repeated-`call_id` half
Impact: Completed items are re-billed and double-counted.
Open questions: None.

### sim-p63-in-flight-item-resolved-once-on-resume

Type: safety
Reachability: default-production
Status: active
Exercised: yes - `src/run/scheduler.test.ts` (one `failed(interrupted)` marker
and `Event` per interrupted turn, idempotent across a second resume) and the
live witness `resume` run (exactly one of each for `e-000007`); see
`evidence/sim-p63-in-flight-item-resolved-once-on-resume.md`
Guarantee: SIM-P63: An item `issued` but not `attempted` at interrupt becomes
exactly one of `failed(interrupted)` or `reissued(marker)`, and its
pre-interrupt calls are billed once.
Check: `always` - for each in-flight item at interrupt, assert exactly one
resolution and single billing of its calls.
Fault/timing angle: the interrupt lands mid-turn.
Required faults and enabling state: a harness kill while an item is issued.
Confidence: medium - [evidence](evidence/sim-p63-in-flight-item-resolved-once-on-resume.md).
M4 (#1028) implements the surface; the unit tests and the live witness named
under Existing check construct the record, and a default tier run reaches it.
Existing check: `src/run/scheduler.test.ts` ("a second resume does not repeat an
earlier resume's recovery entries"), `tests/witness-faults.ts` `resume`
(exactly one `ItemState failed(interrupted)` and one `Event` for `e-000007`)
Impact: An interrupted item is counted twice or vanishes.
Open questions:
- OQ-1 is resolved in the M0 pre-registration: an in-flight item at interrupt is
  `failed(interrupted)`, excluded from recall denominators, and counted in
  dependability.

### sim-p64-interrupt-mid-turn-exercised

Type: reachability
Reachability: default-production
Status: active
Exercised: yes - the live witness `resume` run kills the harness while
`e-000007` has `BeginTurn` and no `EndTurn` (`mid_turn` required); see
`evidence/sim-p64-interrupt-mid-turn-exercised.md`
Guarantee: SIM-P64: A harness kill lands while an item is `issued` at least once
per campaign.
Check: `sometimes` - observe at least one interrupt with an issued item; only
then does SIM-P63 run.
Fault/timing angle: none.
Required faults and enabling state: a scheduled harness kill.
Confidence: medium - [evidence](evidence/sim-p64-interrupt-mid-turn-exercised.md).
M4 (#1028) implements the surface; the unit tests and the live witness named
under Existing check construct the record, and a default tier run reaches it.
Existing check: `tests/witness-faults.ts` `resume` (SIGKILL while `e-000007` has
`BeginTurn` and no `EndTurn`, `mid_turn` required)
Impact: The in-flight resolution path is never exercised.
Open questions: None.

### sim-p65-resume-preserves-pairing

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M4 (#1028); nothing constructs
it yet
Guarantee: SIM-P65: A resumed sibling arm replays the same `tape_id` and reports
the same divergence index for all events before the interrupt.
Check: `always` - compare `tape_id` and pre-interrupt divergence indices before
and after resume.
Fault/timing angle: resume rebuilds tape state from disk.
Required faults and enabling state: an interrupt in a sibling arm.
Confidence: low - [evidence](evidence/sim-p65-resume-preserves-pairing.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Pairing breaks silently after resume.
Open questions: None.

### sim-p66-every-observable-derives-from-journal

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M7 (#1032); nothing constructs
it yet
Guarantee: SIM-P66: Proxy records, grades, gate verdicts, resource samples, and
reports regenerated from the journal alone equal the on-disk observables.
Check: `always` - regenerate every observable from the journal and compare byte
for byte.
Fault/timing angle: none.
Required faults and enabling state: a completed run.
Confidence: low -
[evidence](evidence/sim-p66-every-observable-derives-from-journal.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and a default tier run reaches it.
Existing check: none
Impact: A report depends on state the journal does not hold.
Open questions: None.

### sim-p67-incomplete-run-refuses-load

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M4 (#1028); nothing constructs
it yet
Guarantee: SIM-P67: `LoadRun` refuses an arm with fewer terminal items than
scheduled or without a done marker, and the error names the arm and counts.
Check: `always` - load an incomplete arm and assert refusal naming the arm and
counts.
Fault/timing angle: none.
Required faults and enabling state: a run interrupted without resume.
Confidence: low - [evidence](evidence/sim-p67-incomplete-run-refuses-load.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: A partial run is analysed as complete.
Open questions: None.

### sim-p68-clock-restored-on-resume

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M4 (#1028); nothing constructs
it yet
Guarantee: SIM-P68: After `ResumeRun`, `scenario_ms` equals the last journaled
clock value and `busy_set` is empty.
Check: `always` - after resume, compare the clock to the last journaled value
and assert an empty busy set.
Fault/timing angle: none.
Required faults and enabling state: an interrupt and resume.
Confidence: low - [evidence](evidence/sim-p68-clock-restored-on-resume.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Resume moves time or holds stale busy entries.
Open questions: None.

## Counterfactual arm

### sim-p69-cf-deletion-recorded-with-identity

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M9 (#1035); nothing constructs
it yet
Guarantee: SIM-P69: Every `DeleteMemoryObject` journals `object_id`, object
kind, `scenario_ms`, and `target_item_id`, and precedes the target item's
`BeginTurn`.
Check: `always` - for each deletion, assert the four fields and ordering before
the target's `BeginTurn`.
Fault/timing angle: none.
Required faults and enabling state: an L run with the `eidnara-cf` arm.
Confidence: low -
[evidence](evidence/sim-p69-cf-deletion-recorded-with-identity.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and reached only when the tier schedules faults or the
counterfactual arm.
Existing check: none
Impact: Attribution cannot name the deleted object.
Open questions:
- OQ-4 is resolved: deletion only in the first scope; alteration is out of
  scope.

### sim-p70-cf-deletion-verified

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M9 (#1035); nothing constructs
it yet
Guarantee: SIM-P70: A deletion record carries a verification observation, object
absent from the store or a store API ack; an unknown outcome marks the target
item `excluded(cf-unverified)`.
Check: `always` - for each deletion, assert a verification observation or the
exclusion of its target.
Fault/timing angle: the store may reject or defer the deletion.
Required faults and enabling state: a deletion against a live daemon.
Confidence: low - [evidence](evidence/sim-p70-cf-deletion-verified.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and reached only when the tier
schedules faults or the counterfactual arm.
Existing check: none
Impact: A flip is attributed to a deletion that did not happen.
Open questions: None.

### sim-p71-cf-arm-paired-to-eidnara-until-deletion

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M9 (#1035); nothing constructs
it yet
Guarantee: SIM-P71: `eidnara-cf` shares tape and event prefix with `eidnara`,
and its divergence index is at or after the first deletion's event index.
Check: `always` - assert shared tape id and that the divergence index is at
least the first deletion's index.
Fault/timing angle: none.
Required faults and enabling state: an L run with both arms.
Confidence: low -
[evidence](evidence/sim-p71-cf-arm-paired-to-eidnara-until-deletion.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and reached only when the tier
schedules faults or the counterfactual arm.
Existing check: none
Impact: The counterfactual differs from the treatment for reasons other than the
deletion.
Open questions: None.

### sim-p72-cf-attribution-is-single-object

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M9 (#1035); nothing constructs
it yet
Guarantee: SIM-P72: An attribution record, a P1 pass flipped by deletion, exists
only when exactly one deletion lies between the pair's last common event and the
target item; otherwise the item is unattributed.
Check: `always` - for each attribution record, count deletions in the window and
assert exactly one.
Fault/timing angle: none.
Required faults and enabling state: targets with one and with several deletions.
Confidence: low -
[evidence](evidence/sim-p72-cf-attribution-is-single-object.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and reached only when the tier schedules faults or the
counterfactual arm.
Existing check: none
Impact: A flip is attributed to the wrong object.
Open questions: None.

### sim-p73-cf-sample-is-preregistered

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M2 (#1026); nothing constructs
it yet
Guarantee: SIM-P73: The 20% sample of P1, P3, and P5 items for the
counterfactual arm is derived from the seed at compile and journaled before
`StartRun`.
Check: `always` - recompute the sample from the seed and compare; assert its
journal entry precedes `StartRun`.
Fault/timing angle: none.
Required faults and enabling state: an L scenario compile.
Confidence: low - [evidence](evidence/sim-p73-cf-sample-is-preregistered.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and reached only when the tier
schedules faults or the counterfactual arm.
Existing check: none
Impact: The counterfactual sample is chosen after seeing outcomes.
Open questions: None.

### sim-p74-cf-flip-occurs

Type: reachability
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M9 (#1035); nothing constructs
it yet
Guarantee: SIM-P74: At least one P1 pass in `eidnara` is a fail in `eidnara-cf`
on a sampled item.
Check: `sometimes` - observe at least one flip per campaign; without one the
attribution path is never exercised.
Fault/timing angle: none.
Required faults and enabling state: an L run with sampled P1 items.
Confidence: low - [evidence](evidence/sim-p74-cf-flip-occurs.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and reached only when the tier schedules faults or the
counterfactual arm.
Existing check: none
Impact: Memory attribution is never demonstrated.
Open questions: None.

## Arms and hosts

### sim-p75-arm-config-fixed-for-run

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M8 (#1034); nothing constructs
it yet
Guarantee: SIM-P75: The run header records each arm's host, plugin presence,
`compaction.enabled`, agent model, and capture model, and no arm's config
changes except by a scheduled model-switch fault.
Check: `always` - compare each arm's observed config at every turn to its header
and assert changes coincide with scheduled model switches.
Fault/timing angle: a plugin reload may reset config.
Required faults and enabling state: a run with a model switch.
Confidence: low - [evidence](evidence/sim-p75-arm-config-fixed-for-run.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: Arms differ in more than the treatment.
Open questions: None.

### sim-p76-kl-arm-has-host-compaction-on

Type: safety
Reachability: default-production
Status: active
Exercised: not yet - the harness surface lands in M8 (#1034); nothing constructs
it yet
Guarantee: SIM-P76: `eidnara-kl` runs with Eidnara's `compaction.enabled=false`
and host compaction enabled, and at least one `native_compaction` call record
exists in a p90 session.
Check: `always` - assert the arm config and at least one `native_compaction`
record in a p90 session.
Fault/timing angle: none.
Required faults and enabling state: a p90 session in the `eidnara-kl` arm.
Confidence: low - [evidence](evidence/sim-p76-kl-arm-has-host-compaction-on.md).
PROPOSED: reconstructed from the condensed index in spec #1007; no
implementation exists to verify against, and a default tier run reaches it.
Existing check: none
Impact: The knowledge-layer comparison arm is not the configuration it claims.
Open questions: None.

### sim-p77-two-hosts-one-store-attributed

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet - the harness surface lands in M10 (#1036); nothing
constructs it yet
Guarantee: SIM-P77: With two host clients on one daemon, every call record and
transcript read names its host pid and arm, and store-level observations are
attributed to the writer pid.
Check: `always` - assert host pid and arm on every record during the two-client
window and writer pid on store observations.
Fault/timing angle: the instance lock admits one daemon per data directory.
Required faults and enabling state: two host clients attached to one daemon.
Confidence: low -
[evidence](evidence/sim-p77-two-hosts-one-store-attributed.md). PROPOSED:
reconstructed from the condensed index in spec #1007; no implementation exists
to verify against, and reached only when the tier schedules faults or the
counterfactual arm.
Existing check: none
Impact: Effects of one client are attributed to the other.
Open questions:
- OQ-10: whether two host clients can attach to one daemon concurrently and
  whether the plugin reconnects after SIGKILL without a host restart.
  Unresolved, observed at L and XL (needs human input).

## Liveness

### sim-l01-turn-ends-within-turn-deadline

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet - the scheduler that enforces the bound lands in M4 (#1028)
Guarantee: SIM-L01: A turn that begins ends, `completed` or `failed`, within the
pre-registered turn deadline of 15 minutes of wall time.
Check: `always` - fault-free window: drive turns under load, stop injecting
faults, then assert every open turn reaches `EndTurn` within 15 minutes of wall
time from its `BeginTurn`; the bound is the pre-registered `turn_deadline_ms`.
Fault/timing angle: the bound is measured in wall time because turns and jobs
run in wall time; scenario time does not advance while either is busy.
Required faults and enabling state: a fault-free window after load; the
pre-registered `liveness_bounds` for the tier.
Confidence: low -
[evidence](evidence/sim-l01-turn-ends-within-turn-deadline.md). PROPOSED: the
bound is the pre-registered starting value from OQ-6, resolved in M0.
Existing check: none
Impact: A stuck turn or job holds the clock forever and the tier never
completes.
Open questions:
- Whether the starting value is tight enough to catch the intermittent Pi hang
  before the tier budget runs out. Unresolved, needs the S run.

### sim-l02-background-job-ends-within-job-deadline

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet - the scheduler that enforces the bound lands in M4 (#1028)
Guarantee: SIM-L02: A background job registered in the busy set ends within the
pre-registered job deadline of 20 minutes of wall time.
Check: `always` - fault-free window: after the last turn of a session, assert
every registered job reaches `EndJob` within 20 minutes of wall time from
`RegisterJob`; the bound is the pre-registered `job_deadline_ms`.
Fault/timing angle: the bound is measured in wall time because turns and jobs
run in wall time; scenario time does not advance while either is busy.
Required faults and enabling state: a fault-free window after load; the
pre-registered `liveness_bounds` for the tier.
Confidence: low -
[evidence](evidence/sim-l02-background-job-ends-within-job-deadline.md).
PROPOSED: the bound is the pre-registered starting value from OQ-6, resolved in
M0.
Existing check: none
Impact: A stuck turn or job holds the clock forever and the tier never
completes.
Open questions:
- Whether the starting value is tight enough to catch the intermittent Pi hang
  before the tier budget runs out. Unresolved, needs the S run.

### sim-l03-tier-completes-within-wall-budget

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet - the scheduler that enforces the bound lands in M4 (#1028)
Guarantee: SIM-L03: A tier run completes within its pre-registered wall budget:
S 2 hours, M 10 hours, L 30 hours, XL 96 hours.
Check: `always` - from `StartRun` to the last arm's done marker, assert elapsed
wall time is at most the tier's `tier_wall_budget_ms`; the bound is per tier and
explicit.
Fault/timing angle: the bound is measured in wall time because turns and jobs
run in wall time; scenario time does not advance while either is busy.
Required faults and enabling state: a fault-free window after load; the
pre-registered `liveness_bounds` for the tier.
Confidence: low -
[evidence](evidence/sim-l03-tier-completes-within-wall-budget.md). PROPOSED: the
bound is the pre-registered starting value from OQ-6, resolved in M0.
Existing check: none
Impact: A stuck turn or job holds the clock forever and the tier never
completes.
Open questions:
- Whether the starting value is tight enough to catch the intermittent Pi hang
  before the tier budget runs out. Unresolved, needs the S run.

## Relationship map

- Pairing: SIM-P02, P03, P20, P21, and P65 share the divergence record; P05
  and P71 share the schedule identity.
- Clock: SIM-P11, P12, P14, P18, and P68 read the same `scenario_ms` and busy
  set; P13 and P17 are their coverage records; L01 and L02 bound the busy set.
- Faults: SIM-P30 to P34 share the fault instance lifecycle; P32 consumes P31's
  `missed` state and P33 covers it.
- Grading: SIM-P40, P41, P42, P45, and P46 share the grade record; P47 and P48
  feed P13; P43 and P44 gate P7.
- Gates: SIM-P51 to P58 consume the pre-registration; P52 and P53 are checked
  at M0 by `checkReport`; P56 is also enforced by the pre-registration
  validator.
- Journal: SIM-P60 to P68 share the sequence authority; P66 regenerates every
  observable from it.
- Counterfactual: SIM-P69 to P74 share the deletion record; P73 is fixed at
  compile.
