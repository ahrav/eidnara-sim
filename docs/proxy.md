# Capture proxy

`src/proxy/gateway.ts` is the Bedrock Converse proxy every arm's model calls
pass through. It listens on 127.0.0.1 with an HTTP/1.1 server and a cleartext
HTTP/2 server (`Gateway.urls`), forwards `POST /model/<id>/converse` and
`POST /model/<id>/converse-stream` to an `Upstream`, records each call, and
injects scheduled provider faults at the response edge. `bedrockUpstream`
sends to Bedrock through the AWS SDK with the profile and region from
`sim.config.json`; blob fields (image and document bytes) pass through as the
base64 strings the wire format carries in both directions, and a failure
mid-stream reaches the host as an event stream message: a modeled exception
framed as `exception` under its wire member name (`modelStreamErrorException`)
with its own fields (for example `originalStatusCode`),
any other throw as an `error` with its code and message, so the host's SDK
raises the same failure, and an error before any answer carries the same
fields in its JSON body. String header values are cut to the format's
32,767-byte limit on a code point boundary. `Gateway.stop()`
closes every connection, then stops both listeners, and waits up to five
seconds in all for in-flight requests, counted from the moment their headers
arrive, to write their records; the
run then calls `RecordWriter.close()` to release the journal descriptor. A
throw from the `observe` callback lands in `Gateway.failures` and leaves the
answer untouched. Each call draws its backoff jitter from its own
generator seeded from the run's `rng` at receipt, so concurrent calls keep one
seed to one backoff sequence.

## Call records

`RecordWriter` appends one record per request to a JSONL file and keeps them
in memory unless `retain: false`, which a run-long writer passes since its
records live on disk and in the run's call index. The journal opens with
`O_NOFOLLOW` on the normalized path after checking that its parent directory
resolves without a link, so a symlink in any component or anything other than
a regular file is refused. A fresh journal is created exclusively, so an
existing path is refused; `resume: true`, which the run's call log and the
grader's judge log pass, reopens an existing journal, drops a line a kill cut
mid-append, and continues the sequence after the last complete record. A
record enters memory only after its line reached the file. A
failed append is truncated back to the bytes that reached the file, and when
that truncation fails too the writer refuses every later record, so the
journal never carries a partial line followed by a whole one.
Requests the gateway rejects (an unknown route, a method other than `POST`, an
`Expect` header other than `100-continue`, a body that is not a JSON object, a
body over 32 MiB, a malformed path, an upload the client abandoned) and requests whose handling throws, including a
throw from the scheduler's `scope()` or clock callback, still get a record. The gateway retains at most 32 MiB of a request body and counts the
rest. The writer refuses a record that lacks any field below.

| Field | Contents |
|---|---|
| `seq` | Write order |
| `arm`, `session`, `turn` | The scheduler's scope at receipt |
| `component`, `componentSource` | The calling component and whether the caller `asserted` it or the proxy `inferred` it |
| `model`, `status`, `error` | Model id, the HTTP status the gateway sent (0 when it sent none, including when the client disconnected before the answer), and the error text or `null` |
| `finish_reason` | The stream's `messageStop.stopReason` or the response's `stopReason`; `stream_cut` when the answer carried no stop reason, including a stream that ended or failed before both `messageStop` and `metadata` arrived, and a stream the client left before it ended (relaying stops at the first event the client cannot receive, and the record holds the text delivered up to it; a non-streaming reply the client left before is recorded with `client disconnected before the response was delivered` and no text); `null` when the call had no answer |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | Provider usage |
| `started_wall_ms`, `wall_ms` | Receipt time, and write time clamped so it never decreases in `seq` order and never precedes the record's own receipt (SIM-P15) |
| `scenario_ms` | The scheduler's clock at receipt (SIM-P15) |
| `first_byte_ms` | Milliseconds from receipt to the first answer byte the transport accepted for the host, after any `slow_stream` delay and including an injected fault's answer; `null` for a rejected request and when the host left first |
| `proxy_retries` | Retries the proxy itself made upstream |
| `fault_ref` | The injected fault episode, or `null` |
| `stripped` | Request fields the proxy removed, keyed by path; present only when it removed one |

## Component tags

A harness caller (the user simulator or the judge) asserts its component with
the `x-sim-component` header. The gateway trusts the header from any local
caller; the hosts under test send no such header, and the listener binds to
127.0.0.1 with no authentication, so any local process can spend the
configured AWS profile. Every other call is inferred from the request
body, with the v1 A/B harness rules: the title generator, Eidnara's memory
capture, memory classifier, context researcher, and history summarizer
prompts, a tool-free summarization prompt as native compaction, a request
offering the `bash` tool as the agent, and `other` for the rest. A request
the gateway refuses is `rejected`.

`GatewayOptions.observe` receives a `call_started` event with the component
when the gateway classifies a call, before it forwards or faults the call, so
a call that upstream refuses is observed too. The run uses the
`history_summarizer` event to fire the mid-fold SIGKILL (OQ-8, observation
half) and every background component's event to register a job that holds
the clock until the call's record is written.

## Sampling fields

Claude 5.5 models on Bedrock refuse two fields Eidnara's history summarizer
sends. In the first live runs every summarizer call to Opus 5.5 failed with
HTTP 400: ``temperature` may only be set to 1 when thinking is enabled`, and,
with the temperature removed, `"thinking.type.enabled" is not supported for
this model`. A direct `aws bedrock-runtime converse` call with
`temperature: 0` returned ``temperature` is deprecated for this model` from
both Haiku 5.5 and Opus 5.5. For a request whose model id names a Claude 5.5
model, the gateway removes `inferenceConfig.temperature` and an
`additionalModelRequestFields.thinking` of type `enabled` before forwarding
and records the removed values in `stripped`, so the model samples with its
defaults and each changed call is visible. Requests to every other model pass
unchanged. The v1 A/B gateway removed the same `thinking` field.

## Upstream retry

`sendWithRetry` retries a 429 or 5xx from upstream with backoff
`min(60 s, 2 s * 2^min(attempt, 5)) * (0.5 + jitter)`, while the delay ends
before the request deadline (`requestDeadlineMs`, default 15 minutes). The
same deadline aborts the upstream call and stream in progress, so a provider
that accepts a connection and answers nothing still yields a record. The
jitter draws from the `rng` the run passes in, so one seed gives one backoff
sequence.

## Host connections

Pi reaches the proxy over HTTP/2 and OpenCode over HTTP/1.1. The HTTP/2
server reports each session error, frame error, GOAWAY, and stream reset
on the host side through the `downstream` option, and the run appends
them to `downstream.jsonl` with `h2_session`, the connection's number in
the run, and the arm, session, and turn in scope when the stream opened or
the connection event fired. A
host turn that ends with a socket error while its call record shows a
complete upstream stream reads its connection's events there.

## Fault injection

`FaultInjector` holds the scenario's proxy-sink episodes. The scheduler calls
`arm(id)` when an episode's trigger event occurs and `disarm(id)` at the end
of a persistent episode's session. While armed, an episode replaces agent
calls' answers by strategy:

| Strategy | Calls faulted |
|---|---|
| single | The next agent call |
| burst | The next 3 agent calls |
| intermittent | Each of the next 10 agent calls with probability 0.3, drawn from the injector's `rng` |
| persistent | Every agent call until `disarm` |

Each fault type answers as follows. For every type except `slow_stream` the
injected answer goes to the host without an upstream call, so the host's SDK,
not the proxy's retry, handles it, and the record's `proxy_retries` is 0.
`slow_stream` forwards the real upstream answer, so the proxy's own retry can
run first and the record counts it. A record carries `fault_ref` only when the
transport accepted the answer's status; a timeout's silence counts. A
`slow_stream` delay that runs past the request deadline ends the call with the
timeout instead of the delayed answer.

| Type | Host-visible answer |
|---|---|
| `provider_429` | HTTP 429, `ThrottlingException` |
| `provider_5xx` | HTTP 503, `ServiceUnavailableException` |
| `provider_timeout` | No bytes for `timeout_ms` (default 120 s), then the connection closes. Bun's HTTP/1.1 server reports no client abort, so the gateway holds the connection for the full `timeout_ms` even after the host gives up |
| `truncated_length` | A partial text block and `messageStop` with `stopReason: max_tokens` |
| `truncated_no_length` | A partial text block, then the stream ends with no `messageStop` or metadata; on `converse`, the first half of the JSON body |
| `empty_content` | `messageStop` with `end_turn` and no content block |
| `schema_wrong_tool_call` | A `toolUse` block for the request's first tool whose input is not JSON; on `converse`, an input object that gives each typed required property of the tool's schema a value of another type, or a bare string, which a `type: object` schema rejects, when the schema has none |
| `slow_stream` | The provider's answer, with `delay_ms` (default 2 s) before each event; on `converse`, before the body. The record carries `fault_ref` only once the delayed answer reached the transport, so an upstream that fails before answering, or a client that leaves during the delay, leaves the episode untriggered and clears its pending witness |

## Witnesses

For each episode, `FaultInjector.report()` returns whether it was armed, the
`seq` of every injected record, the `seq` of the first later agent call that
started within the window after each injection (host-observed; a faulted
retry under a persistent or burst episode counts; an agent call that starts
after the window closes the injection's wait), and whether the proxy
retried. An episode is `fired` only with both an injected record
and a host-observed call (SIM-P31); otherwise it is `untriggered`, and
`excludedFromFaultMetrics` reports that the run leaves fault metrics
(SIM-P32).

## Tests

`src/proxy/gateway.test.ts` runs every provider fault type under every
strategy on both routes against a scripted upstream and a host stand-in that
issues one call at a time with its own timeout. Each case checks that the host saw the
fault, that every injected record has `proxy_retries` 0, and that the host's
next call started within the window. The tests also cover records, tags,
rejected requests, untriggered witnesses, and the seeded backoff sequence.
