# Capture proxy

`src/proxy/gateway.ts` is the Bedrock Converse proxy every arm's model calls
pass through. It listens on 127.0.0.1 with an HTTP/1.1 server and a cleartext
HTTP/2 server (`Gateway.urls`), forwards `POST /model/<id>/converse` and
`POST /model/<id>/converse-stream` to an `Upstream`, records each call, and
injects scheduled provider faults at the response edge. `bedrockUpstream`
sends to Bedrock through the AWS SDK with the profile and region from
`sim.config.json`.

## Call records

`RecordWriter` appends one record per request to a JSONL file and keeps them
in memory. Requests the gateway rejects (an unknown route, a body that is not
a JSON object, a body over 32 MiB, a malformed path) and requests whose
handling throws still get a record. The writer refuses a record that lacks
any field below.

| Field | Contents |
|---|---|
| `seq` | Write order |
| `arm`, `session`, `turn` | The scheduler's scope at receipt |
| `component`, `componentSource` | The calling component and whether the caller `asserted` it or the proxy `inferred` it |
| `model`, `status`, `error` | Model id, the HTTP status the gateway sent (0 when it sent none), and the error text or `null` |
| `finish_reason` | The stream's `messageStop.stopReason` or the response's `stopReason`; `stream_cut` when a stream ended without `messageStop` and `metadata`; `null` when the call had no answer |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | Provider usage |
| `started_wall_ms`, `wall_ms` | Receipt time, and write time clamped so it never decreases in `seq` order (SIM-P15) |
| `scenario_ms` | The scheduler's clock at receipt (SIM-P15) |
| `first_byte_ms` | Milliseconds from receipt to the first answer byte, or `null` |
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
before the request deadline. The jitter draws from the `rng` the run passes
in, so one seed gives one backoff sequence.

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

Each fault type answers as follows. The injected answer goes to the host
without an upstream call, so the host's SDK, not the proxy's retry, handles
it, and the record's `proxy_retries` is 0.

| Type | Host-visible answer |
|---|---|
| `provider_429` | HTTP 429, `ThrottlingException` |
| `provider_5xx` | HTTP 503, `ServiceUnavailableException` |
| `provider_timeout` | No bytes for `timeout_ms` (default 120 s), then the connection closes. Bun's HTTP/1.1 server reports no client abort, so the gateway holds the connection for the full `timeout_ms` even after the host gives up |
| `truncated_length` | A partial text block and `messageStop` with `stopReason: max_tokens` |
| `truncated_no_length` | A partial text block, then the stream ends with no `messageStop` or metadata; on `converse`, the first half of the JSON body |
| `empty_content` | `messageStop` with `end_turn` and no content block |
| `schema_wrong_tool_call` | A `toolUse` block for the request's first tool whose input is not JSON; on `converse`, an input object with an argument the tool's schema lacks |
| `slow_stream` | The provider's answer, with `delay_ms` (default 2 s) before each event; on `converse`, before the body |

## Witnesses

For each episode, `FaultInjector.report()` returns whether it was armed, the
`seq` of every injected record, the `seq` of the first later agent call that
started within the window after each injection (host-observed; a faulted
retry under a persistent or burst episode counts), and whether the proxy
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
