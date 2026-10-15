# Issue Tracker

## Backend

GitHub Issues in `ahrav/eidnara`. Every command below carries
`-R ahrav/eidnara`.

## Read Operations

Read a specification or ticket, including comments:

`gh issue view -R ahrav/eidnara <number-or-url> --comments`

Use `--json title,body,comments,labels,state,url` when structured output is
needed.

Find an issue by its work-item marker, including closed issues:

`gh issue list -R ahrav/eidnara --state all --search "in:body $MARKER" --json number,title,url,createdAt`

GitHub search can lag after creation. An empty result does not prove absence.

Every created body ends with:

`Work item: <spec-or-ticket-slug>-<UUIDv4>`

Generate one UUID per item with `uuidgen` or
`python3 -c 'import uuid; print(uuid.uuid4())'`. Show every marker in the
mutation preview. Before approval, search for each marker and require zero
hits. Never reuse a marker across items or approval rounds.

## Create A Specification

Create a temporary body file outside the worktree:

`BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/issue-body.XXXXXX")`

Write the approved body, ending with its work-item marker, to `$BODY_FILE`.
Hold the approved title in `TITLE`, then run:

`gh issue create -R ahrav/eidnara --title "$TITLE" --body-file "$BODY_FILE"`

Capture the issue URL printed by the command as the stable reference. Remove
`$BODY_FILE` on every success, failure, or ambiguous exit path.

## Create An Implementation Ticket

Create blockers before blocked tickets so later bodies can link their issue
URLs.

For each approved ticket, create a fresh temporary body file:

`BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/issue-body.XXXXXX")`

Write the approved body, ending with its work-item marker, to `$BODY_FILE`.
Hold the approved title in `TITLE`, then run:

`gh issue create -R ahrav/eidnara --title "$TITLE" --body-file "$BODY_FILE"`

Capture the printed issue URL as the stable reference. Remove `$BODY_FILE` on
every exit path.

## Update Existing Items

Title and body updates require approval of an exact preview: issue numbers and
URLs, current title/body hashes, replacement titles, full body diffs, preserved
state, labels, relationships and work-item markers, and execution order.
Approval covers only that unchanged set. Apply serially and read each issue back
to verify approved content and preserved metadata. Stop on the first failure,
concurrent edit, or unknown outcome. Reconcile by exact issue number and readback;
never retry blindly. Re-preview and obtain approval for the remaining set before
resuming. Keep temporary manifests and journals outside the worktree and remove
them after reconciliation. Do not edit comments.

## Parent Relationship

Every implementation ticket body contains:

`## Parent Specification`

`<specification issue URL>`

## Blocking Relationship

Every implementation ticket body contains:

`## Blocked By`

Use one blocker issue URL per bullet, or:

`None (can start immediately)`

## Agent-Ready State

Every implementation ticket body contains:

`**Status:** ready-for-agent`

No GitHub readiness label is configured. Setup and publishing workflows must
not create one.

## Mutation Gate

Before any create command, show every title, complete body including its
work-item marker, parent link, blocker edge, and execution order. Require one
explicit user approval for that exact mutation set.

A reference to an item in the same set does not exist before publication.
Show it as `<ref: <marker>>`, where `<marker>` is the referenced item's
work-item marker. Approval covers replacing exactly that placeholder with the
created issue URL. Any other body change requires fresh approval.

## Failure Recovery

After any partial failure, stop. Report every created issue URL, every
uncreated item, and every item whose outcome is unknown. A timeout, lost
connection, or successful exit without a printed URL produces an unknown
outcome. Never retry creation blindly.

Resolve each unknown item by its exact marker:

1. Run the marker search from Read Operations. One hit resolves the item to
   that URL. Two or more hits mean the marker was reused; report every URL and
   ask the user which issue to keep.
2. Zero hits do not prove failure because GitHub search lag has no documented
   bound. Also run:

   `gh issue list -R ahrav/eidnara --state all --author @me --limit 20 --json number,title,url,createdAt,body`

   Resolve only an issue whose body contains the exact marker line. Matching
   title or creation time alone is insufficient.
3. If both checks fail, report the marker, exact title, and attempt time.
   Keep the outcome unknown. Recreate only after the user inspects the
   repository and confirms the issue is absent.

Resume only after every unknown outcome is resolved, the remaining mutation
set is recomputed, and the user approves that remaining set. Never repeat the
full create loop.
