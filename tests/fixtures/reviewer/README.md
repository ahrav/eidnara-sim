# Memory reviewer request fixtures

`requests.json` holds one request of each stage of Eidnara's memory reviewer
(`eval/w9`), in the shape the daemon's child Pi 0.80.2 sends it: a system
text, one user message, an output cap, and no cache point.

- `stage1.system` is `system_text()` of
  `crates/daemon/src/memory_reviewer/stage_one.rs`; its SHA-256 is
  `dffaac456bc96ea71b6f8c3efcacc03a4d87ad0e89a2e17ca7ae515fece34b61`, the
  digest that file's test `the_system_text_is_the_measured_wording` pins.
  `stage1.messages` is the review state of its golden request
  (`classifier_request.golden.json`, member `state`), as `state_json()`
  writes it.
- `stage2.system` is the memory-statement template (`broker.rs`), a blank
  line, and the step instructions of a memory review (`coordinator.rs`,
  `step_instructions`). `stage2.messages` frames the same statement and its
  references as `push_labeled` does: `[ref-N <token>]`, the text,
  `[/ref-N <token>]`, with the `linked references:` notice after the memory.

Both system texts equal, byte for byte, the ones recorded from live reviewer
requests of the `eval/w9` build.
