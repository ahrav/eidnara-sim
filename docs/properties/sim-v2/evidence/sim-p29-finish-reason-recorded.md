# sim-p29-finish-reason-recorded

Evidence status: PROPOSED. SIM-P29, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every forwarded record carries the provider `finish_reason` or an explicit
`stream_cut` marker.

No harness code, test, or run exists yet. The surface lands in M3
(#1027).

M3 (#1027) records `finish_reason` from the stream's `messageStop` or the
response's `stopReason`, `stream_cut` when a stream ends without `messageStop`
and `metadata`, and `null` when the call had no answer; the writer refuses a
record without the field. Tests check `end_turn` on a forwarded call,
`max_tokens` on an injected truncation, and `stream_cut` on a forwarded stream
that stops early.

## Failure scenario

The fold-lag and truncation failure classes cannot be told apart.

## Timing windows and dependencies

A stream cut mid-body has no provider finish reason.

## What a test must construct

A truncated-stream fault.

## Investigation log

No open questions.
