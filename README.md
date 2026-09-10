# pi-xcode-loop

Evidence-first status receipts for Pi sessions running through Xcode Coding Intelligence.

`pi-xcode-loop` observes Xcode Coding Assistant logs, Git state, and optional Xcode result bundles. It reports whether a turn is completed, failed, blocked, or still unknown without controlling Xcode, Git, or the user's terminal session.

The first release will provide:

- a read-only `xcode-loop status` CLI
- a `/xcode-loop` Pi command
- deterministic JSON receipts
- fixture coverage for completed, cancelled, protocol-error, zero-test, and missing-evidence cases

This project is experimental and under active development.

## Safety boundary

The observer does not edit source, run Git mutations, resume agents, drive Xcode, control Herdr panes, or submit broker/release actions. It reports evidence so an existing coordinator can decide what to do next.

## Pi extension

Install this package in Pi 0.85.1 or newer, then run `/xcode-loop status`. The
command reads the current Pi working directory and session by default. Safe
absolute paths may be supplied with `--workspace`, `--session`, or
`--result-bundle`; `--expect-tests N` and `--json` are also supported. It never
executes a command supplied through an argument and reports concise evidence
when a session is unavailable, cancelled, or times out.

The default Pi session adapter reads only bounded JSONL message metadata and
maps the latest assistant stop reason to completion, cancellation, or failure.
It does not infer test execution from Pi messages; an Xcode JSONL log or result
bundle is required for test evidence.

## License

MIT
