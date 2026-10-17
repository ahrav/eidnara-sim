# Existing checks: world simulation v2

The M5 grading unit is the one v2 harness surface with checks in this tree;
they are listed under their own heading below. The v1 harness in the eidnara
repository (`packages/e2e-tests/src/ab-eval/`, read at `bb866266c`) holds the
closest prior art for the rest. Each analog is `unaudited`; none
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

Checks in this tree that enforce records at M5 (the grading unit, #1029):

| Check | Records | Status |
| --- | --- | --- |
| `src/grade/probes.test.ts`: transcript artefact refused and exact input ids per fixture, first attempt only, strictly increasing grade versions, no grade for a failed turn, P13 fixtures, P1/control pairing by fact, P11 false-positive weight | SIM-P40, P41, P42, P46, P47, P49, P50 | unaudited |

None found: user-sim, tape, clock, and counterfactual checks.
