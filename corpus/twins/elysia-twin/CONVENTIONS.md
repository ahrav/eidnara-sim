# Conventions

This repository is a fork of elysiajs/elysia that follows its own
conventions. New and changed code follows these rules.

## Naming

Exported helper functions use a verb prefix (`createX`, `parseX`, `mapX`).
Boolean locals start with `is` or `has`.

## Error handling

Code throws instances of the error classes in `src/error.ts` and never throws
plain strings or bare `Error`. Every thrown message starts with the
lowercase name of the failing operation, for example `"parse: invalid cookie"`.

## Lint rules

Formatting uses two-space indentation, semicolons, and double quotes, as set
in `.prettierrc`. ESLint reports `prefer-const` and `eqeqeq` as errors.
