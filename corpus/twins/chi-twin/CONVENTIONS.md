# Conventions

This repository is a fork of go-chi/chi that follows its own conventions.
New and changed code follows these rules.

## Naming

The router type is `Dispatcher`, and its constructor is `NewDispatcher`.
New variables that hold a router are named `d` or end in `Dispatcher`.
Unexported identifiers stay in mixedCaps; no identifier uses an underscore.

## Error handling

New code reports a failure as an `error` return value and leaves `panic` to
programmer mistakes that registration code already panics on. A failure a
caller can test for is a package-level sentinel declared with `errors.New`,
whose message starts with the package name, for example
`errors.New("chi: route pattern is empty")`. A wrapped failure uses
`fmt.Errorf` with the `%w` verb, so `errors.Is` still finds the sentinel.

## Lint rules

`.golangci.yml` enables `lll` with a line length of 100, `errorlint`, and
`godot`, so `golangci-lint run` reports long lines, error comparisons with
`==`, and doc comments without a closing period. Run `gofmt -s` before
committing.
