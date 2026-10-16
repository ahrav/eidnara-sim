# sim-p43-judge-hygiene-on-p7-only

Evidence status: PROPOSED. SIM-P43, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every judge call has `component = judge`, a model family that differs from the
agent model, no arm label in the prompt, both position orders per item, and the
calibration digest recorded.

Before M5 (#1029) no harness code, test, or run existed; the surface landed
with M5.

M5 (#1029) sends judge calls through the proxy as component `judge`, refuses a judge from the agent model's family, refuses an answer that names an arm, judges both orders, and records the prompt, rubric, and calibration digests on each P7 grade; tests cover each refusal, and a live run on 2026-10-16 graded the P7 fixtures through the gateway with `global.openai.gpt-5.6-luna` (run data under `runs/judge-smoke/`).

## Failure scenario

The P7 judge identifies arms or prefers its own family.

## Timing windows and dependencies

None.

## What a test must construct

P7 items with a calibration set.

## Investigation log

No open questions.
