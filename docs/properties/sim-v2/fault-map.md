# Fault map: world simulation v2

| Fault class | Layer | Availability | Records |
| --- | --- | --- | --- |
| Provider 429, 5xx, timeout | proxy sink, downstream of proxy retry | lands in M3 (#1027) | SIM-P30, P31, P34 |
| Truncated stream, with and without `finish_reason=length` | proxy sink | lands in M3 | SIM-P29, P34 |
| Empty content, schema-wrong tool call, slow stream | proxy sink | lands in M3 | SIM-P34 |
| Daemon SIGKILL on an observed summarizer call | scheduler | lands in M4 (#1028) | SIM-P31, P34, P47 |
| Daemon restart between sessions | scheduler | lands in M4 | SIM-P34 |
| Store filesystem full (loop mount) | scheduler | lands in M4 | SIM-P34 |
| Plugin reload, model switch | scheduler | lands in M4 | SIM-P34, P75 |
| Host upgrade | scheduler | lands in M10 (#1036) | SIM-P34, P35 |
| Two host clients on one daemon | scheduler | lands in M10 | SIM-P34, P77 |
| Laptop sleep (event-free clock jump) | clock | lands in M4 | SIM-P18, P34 |
| Harness kill mid-event | journal | lands in M4 | SIM-P61 to P65, P68 |
| Counterfactual memory deletion | scheduler | lands in M9 (#1035) | SIM-P69 to P74 |

Leverage: the proxy sink faults have the cheapest valid oracle, a call record
carrying `fault_ref` from the target component (SIM-P31). The mid-fold
SIGKILL has the most expensive, since its evidence shape is open (OQ-8).
