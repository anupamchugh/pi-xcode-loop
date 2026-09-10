# pi-xcode-loop

Evidence-first status receipts for Pi sessions running through Xcode Coding Intelligence.

`pi-xcode-loop` observes Xcode Coding Assistant logs, Git state, and optional Xcode result bundles. It reports whether a turn is completed, failed, blocked, or still unknown without controlling Xcode, Git, or the user's terminal session.

The package provides:

- a read-only `xcode-loop status` CLI
- a `/xcode-loop` Pi command
- deterministic JSON receipts
- fixture coverage for completed, cancelled, protocol-error, zero-test, and missing-evidence cases

This project is experimental and under active development.

## Safety boundary

The observer does not edit source, run Git mutations, resume agents, drive Xcode, control Herdr panes, or submit broker/release actions. It reports evidence so an existing coordinator can decide what to do next.

## Pi extension

Install the package into Pi 0.85.1 or newer with `pi install npm:pi-xcode-loop`.
Then run `/xcode-loop status`; the command reads the current Pi working
directory and session by default. Safe absolute paths may be supplied with
`--workspace`, `--session`, or `--result-bundle`; `--expect-tests N` and
`--json` are also supported. Remove the package with
`pi remove npm:pi-xcode-loop` when it is no longer needed. The command never
executes a command supplied through an argument and reports concise evidence
when a session is unavailable, cancelled, or times out.

Pi cancels an in-flight status request when the host aborts the command (for
example, Pi's command cancellation); there is no separate `/xcode-loop cancel`
slash command. Cancellation stops publication of a late receipt, including
while the bounded session file read is in progress.

The default Pi session adapter reads only bounded JSONL message metadata and
maps the latest assistant stop reason to completion, cancellation, or failure.
It does not infer test execution from Pi messages; an Xcode JSONL log or result
bundle is required for test evidence.

## License

MIT
