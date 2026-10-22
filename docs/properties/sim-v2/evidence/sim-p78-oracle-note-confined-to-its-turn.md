# sim-p78-oracle-note-confined-to-its-turn

Evidence status: Workstream A S5 record, written with the `host-oracle` arm.

## Discovery trigger

The S5 requalification compares automatic delivery, explicit search, and
directly supplied correct context. The third mode is a harness control: the
run supplies a probe's ground-truth source text in its prompt. A control that
reaches another arm, or a turn other than its own, confounds every
comparison against it.

## Evidence trail

`src/hosts/profiles.ts` declares `host-oracle` with role `oracle-context`, no
daemon, no plugin, host compaction on, and `delivery: "oracle-context"`.
`src/run/oracle-note.ts` `oracleBackground` quotes the probe's
`ground_truth.sources` events (user text in a blockquote, a committed file in
a fence longer than any backtick run in it, a removal by path) under the
sources' project name and ends with `My request now:`. `src/run/run.ts`
`oracleBackgrounds` builds one note per probe turn with sources, refuses a
scenario text that holds the opening and a note that carries a marker, and
the arm's `event` handler prefixes the note to the text the user-sim
delivered, after the pairing record of that text is written, and only on an
arm whose delivery is `oracle-context`; an abandoned turn gets none.

Before `EndArm`, `verifyArm` reads the arm's agent call records and
`requests.jsonl`. `observeDelivery` (`src/run/capabilities.ts`) rebuilds each
body, marks the owed notes (from delivered, unrecovered `UserTurn` rows) that
reached the prompt of their own turn, and lists requests that carry a note in
another session, before its turn, or an opening in the system or user text
that matches no owed note. `deliveryMismatches` fails the arm on any missing
or misplaced note or no owed note at all; on any other arm in such a run it
fails a request that carries a note; on every arm it reads, it fails an
unreadable body. The Pi smoke recorded in PR #32 (S seed 102, 32 events,
`host-oracle` and `host`) owed one note, delivered it, and found none on the
host arm.

`src/run/delivery.test.ts` covers each case with bodies written through
`RequestStore`.

## Failure scenario

The note reaches the `host` arm through a shared request path, or appears in
a turn before its probe, and the control's pass rate inflates the comparison.

## Timing windows and dependencies

The note stays in the session's history after its turn, as any earlier user
message does; the check admits it there and nowhere else. A resumed run reads
the owed notes from the journal, so a turn the resume recovered owes none.

## What a test must construct

A qualification run with `host-oracle` that delivers a probe turn with
sources, and a run order holding another arm.

## Investigation log

No open questions.
