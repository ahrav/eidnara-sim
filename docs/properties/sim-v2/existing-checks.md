# Existing checks: world simulation v2

The checks in this tree that exercise a v2 harness surface are listed in
the M0, M5, M7, and arm-capability tables below; the rest of the surface has
none yet. The v1
harness in the eidnara repository (`packages/e2e-tests/src/ab-eval/`, read
at `bb866266c`) holds the closest prior art. Each analog is `unaudited`; none
removes a record, and none checks a v2 obligation as written.

| v1 check | Nearest records | Status |
| --- | --- | --- |
| `run-dir.test.ts`: the empty-directory run claim | SIM-P60, P61 | unaudited; v2 replaces the claim with a journal lease |
| `deadline.test.ts`: deadline abort and drain | SIM-L01, P39 | unaudited |
| `gateway.test.ts`: Bedrock gateway and sink | SIM-P27, P28, P29 | unaudited |
| `world.test.ts`: scripted world generation | SIM-P01 | unaudited; v2 samples the world instead of scripting it |
| `procs.test.ts`: process-tree stop and stall | SIM-P39 | unaudited |
| `sandbox.test.ts`: sandbox launcher and kept mounts | SIM-P16 | unaudited |

Checks in this tree that enforce records at M0:

| Check | Records | Status |
| --- | --- | --- |
| `src/prereg/validate.test.ts`: report refused by missing family name, hash mismatch, and the token `parity` | SIM-P52, P53 | unaudited |
| `src/prereg/validate.test.ts`: a run-level gate with a paired interval below six paired runs refused, and a report verdict below the family's floor other than `insufficient-runs` refused | SIM-P56 | unaudited |
| `src/prereg/validate.test.ts`: `grading.p11_false_positive_weight` required as a positive decimal in every tier file (each carries `"2"`), its removal refused by name | SIM-P50 | unaudited |

Checks in this tree that enforce records at M5 (the grading unit, #1029):

| Check | Records | Status |
| --- | --- | --- |
| `src/grade/probes.test.ts`: transcript artefact refused and exact input ids per fixture, first attempt only, strictly increasing grade versions, no grade for a failed turn, P13 fixtures, P1/control pairing by fact, P11 false-positive weight | SIM-P40, P41, P42, P46, P47, P49, P50 | unaudited |

Checks in this tree that enforce records at M7:

| Check | Records | Status |
| --- | --- | --- |
| `src/stats/gate.test.ts`: excluded and fault-asymmetric pairs leave the analysis and are counted; an evaluation without a journal sequence is refused | SIM-P51 | unaudited |
| `src/stats/gate.test.ts`: every verdict carries the pre-registration digest, MDE, margin, n, and resolution ratio; no fixture verdict contains `parity` | SIM-P52, P53 | unaudited |
| `src/stats/gate.test.ts`: pairs join by item id in issue order | SIM-P54 | unaudited |
| `src/stats/gate.test.ts`: a CUSUM stop records kind, signal index, and window, and withholds the pass | SIM-P55 | unaudited |
| `src/stats/gate.test.ts`: `insufficient-runs(k)` below the family's registered floor | SIM-P56 | unaudited |
| `src/stats/gate.test.ts`: `memory_made_it_worse` names the Holm-adjusted `worse` harm metrics | SIM-P58 | unaudited |

Checks in this tree that enforce arm capabilities (Workstream A S1):

| Check | Records | Status |
| --- | --- | --- |
| `src/run/capabilities.ts` `bootMismatches` (each `session_end`) and `armMismatches` (before `EndArm`): `eidnara-kl` plugin boots in compaction-off mode, no transform pass, no history summarizer call | SIM-P76 | unaudited |
| `src/hosts/arms.test.ts`: Pi and OpenCode `eidnara-kl` write host compaction on and Eidnara `compaction.enabled=false` | SIM-P76 | unaudited |

None found: user-sim, tape, clock, and counterfactual checks.
