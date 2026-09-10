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

## License

MIT
