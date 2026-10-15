# Conventions

This repository is a fork of tokio-rs/mini-redis that follows its own
conventions. New and changed code follows these rules.

## Naming

The key-value store type is `Keyspace`, and its shutdown guard is
`KeyspaceDropGuard`. New variables that hold a keyspace are named `keyspace`.

## Error handling

Library code returns `crate::Result` and propagates failures with `?`.
Library code calls neither `unwrap()` nor `expect()`; tests may call both.
Every error message starts with the lowercase name of the failing operation,
for example `"set: value too large"`.

## Lint rules

`rustfmt.toml` sets `max_width = 80`. Run `cargo fmt` before committing.
`Cargo.toml` sets `clippy::unwrap_used = "warn"`, so `cargo clippy` reports
every `unwrap()` call.
