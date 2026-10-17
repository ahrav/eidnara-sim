# Existing checks: world simulation v2

No check in this tree exercises a v2 harness surface yet. The v1 harness in
the eidnara repository (`packages/e2e-tests/src/ab-eval/`, read at
`bb866266c`) holds the closest prior art. Each analog is `unaudited`; none
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

Checks in this tree that enforce records at M7:

| Check | Records | Status |
| --- | --- | --- |
| `src/stats/gate.test.ts`: excluded and fault-asymmetric pairs leave the analysis and are counted; an evaluation without a journal sequence is refused | SIM-P51 | unaudited |
| `src/stats/gate.test.ts`: every verdict carries the pre-registration digest, MDE, margin, n, and resolution ratio; no fixture verdict contains `parity` | SIM-P52, P53 | unaudited |
| `src/stats/gate.test.ts`: pairs join by item id in issue order | SIM-P54 | unaudited |
| `src/stats/gate.test.ts`: a CUSUM stop records kind, signal index, and window, and withholds the pass | SIM-P55 | unaudited |
| `src/stats/gate.test.ts`: `insufficient-runs(k)` below the family's registered floor | SIM-P56 | unaudited |
| `src/stats/gate.test.ts`: `memory_made_it_worse` names the Holm-adjusted `worse` harm metrics | SIM-P58 | unaudited |

None found: user-sim, tape, clock, counterfactual, and grading checks.
