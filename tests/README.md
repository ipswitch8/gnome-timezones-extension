# Tests

Plain-GJS assertion harness. No test framework, no npm.

## Running

From the extension root:

```sh
gjs -m tests/run-tests.js
```

Exits `0` on success, `1` if any test fails. Each test prints a
`PASS:`/`FAIL:` line, followed by a summary count and (on failure) a
list of failing test names.

## Adding tests

Add new `test('name', () => { ... })` calls to `run-tests.js`, using
`assertEqual`/`assertTrue`/`assertFalse` for assertions. Never delete,
skip, or weaken an existing test to make the suite pass -- fix the
implementation instead.
