# Capture proxy

`src/proxy/gateway.ts` is the Bedrock Converse proxy every arm's model calls
pass through. It listens on 127.0.0.1 with an HTTP/1.1 server and a cleartext
HTTP/2 server (`Gateway.urls`), forwards `POST /model/<id>/converse` and
`POST /model/<id>/converse-stream` to an `Upstream`, records each call, and
injects scheduled provider faults at the response edge. `bedrockUpstream`
sends to Bedrock through the AWS SDK with the profile and region from
`sim.config.json`.

## Call records

`RecordWriter` appends one record per request, including requests the
gateway rejects, to a JSONL file and keeps them in memory. It refuses a record
that lacks any field below.

| Field | Contents |
|---|---|
| `seq` | Write order |
| `arm`, `session`, `turn` | The scheduler's scope at receipt |
| `component`, `componentSource` | The calling component and whether the caller `asserted` it or the proxy `inferred` it |
| `model`, `status`, `error` | Model id, HTTP status the host saw, and the error text or `null` |
| `finish_reason` | The stream's `messageStop.stopReason` or the response's `stopReason`, or `null` when the answer had none |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | Provider usage |
| `started_wall_ms`, `wall_ms` | Receipt time, and write time clamped so it never decreases in `seq` order (SIM-P15) |
| `scenario_ms` | The scheduler's clock at receipt (SIM-P15) |
| `first_byte_ms` | Milliseconds from receipt to the first answer byte, or `null` |
| `proxy_retries` | Retries the proxy itself made upstream |
| `fault_ref` | The injected fault episode, or `null` |

## Component tags

A harness caller (the user simulator or the judge) asserts its component with
the `x-sim-component` header. Every other call is inferred from the request
body, with the v1 A/B harness rules: the title generator, Eidnara's memory
capture, memory classifier, context researcher, and history summarizer
prompts, a tool-free summarization prompt as native compaction, a request
offering the `bash` tool as the agent, and `other` for the rest. A request
the gateway refuses is `rejected`.

`GatewayOptions.observe` receives a `call_started` event with the component
when a call's first answer byte arrives. The M4 scheduler uses the
`history_summarizer` event to fire the mid-fold SIGKILL (OQ-8, observation
half) and the `memory_capture` event for capture-timed faults.

## Upstream retry

`sendWithRetry` retries a 429 or 5xx from upstream with backoff
`min(60 s, 2 s * 2^min(attempt, 5)) * (0.5 + jitter)`, while the delay ends
before the request deadline. The jitter draws from the `rng` the run passes
in, so one seed gives one backoff sequence.

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
| `provider_timeout` | No bytes for `timeout_ms` (default 120 s), then the connection closes |
| `truncated_length` | A partial text block and `messageStop` with `stopReason: max_tokens` |
| `truncated_no_length` | A partial text block, then the stream ends with no `messageStop` or metadata |
| `empty_content` | `messageStop` with `end_turn` and no content block |
| `schema_wrong_tool_call` | A `toolUse` block for the request's first tool whose input is not JSON |
| `slow_stream` | The provider's answer, with `delay_ms` (default 2 s) before each event |

## Witnesses

For each episode, `FaultInjector.report()` returns whether it was armed, the
`seq` of every injected record, the `seq` of the first agent call that
started within the window after each injection (host-observed), and whether
the proxy retried. An episode is `fired` only with both an injected record
and a host-observed call (SIM-P31); otherwise it is `untriggered`, and
`excludedFromFaultMetrics` reports that the run leaves fault metrics
(SIM-P32).

## Tests

`src/proxy/gateway.test.ts` runs every provider fault type under every
strategy against a scripted upstream and a host stand-in that issues one
call at a time with its own timeout. Each case checks that the host saw the
fault, that every injected record has `proxy_retries` 0, and that the host's
next call started within the window. The tests also cover records, tags,
rejected requests, untriggered witnesses, and the seeded backoff sequence.
