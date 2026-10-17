# sim-p35-transcript-store-reads-observed-not-blocked

Evidence status: PROPOSED. SIM-P35, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A read under `~/.pi/agent/sessions` or `opencode.db` by the `host` arm produces
a read observation, and the read succeeds with command exit and bytes
unaffected.

The read-observation surface lands in M8 (#1034); no code observes or
attributes transcript-store reads yet, so nothing constructs this record.

M4 (#1028) keeps a per-host-version table of transcript-store paths and refuses
at preflight a host version with no row; a test checks the known versions and
the refusal.

The host driver (#1028, unit 3) checks after each arm's first session that
every resolved path in the table exists, writes the result to
`<arm>/transcripts.json`, and stops the run otherwise; a test covers the
check and the refusal. The unit's author reported that a smoke run on
2026-10-16 found `$PI_CODING_AGENT_DIR/sessions` for Pi 0.80.2; that run's
`transcripts.json` is not retained in this tree, so the report stands as
unverified here, and the OpenCode rows have no report.

## Failure scenario

The control arm is handicapped or its transcript search goes unattributed.

## Timing windows and dependencies

Host upgrades may move the store; the path table is verified per host version at
run start.

## What a test must construct

A host-arm session that searches its own transcript.

## Investigation log

### Q: OQ-7
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files;
  `src/hosts/driver.ts` (`checkTranscripts`) and its test in
  `src/hosts/driver.test.ts`; `docs/hosts.md` (Transcript-store check).
- Findings: OQ-7: the transcript-store path table per host version. The driver
  verifies each resolved path after the arm's first session and stops the run
  on a gap. The author's report of a 2026-10-16 smoke run naming the Pi 0.80.2
  path has no retained artifact; the OpenCode rows have no report.
- Missing evidence: a retained `transcripts.json` from a run per host version.
- Conclusion: unresolved, needs a retained harness run per host version

### Q: OQ-13
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-13: whether host transcript timestamps persisted under a scenario jump
  affect D2 attribution or session ordering. Unresolved, measured after the
  first S run.
- Missing evidence: a harness run that exercises the record.
- Conclusion: unresolved, needs a harness run
