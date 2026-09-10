# pi-xcode-loop contributor instructions

This repository provides a read-only evidence observer for Xcode Coding Assistant sessions.

- Preserve the read-only boundary: no Xcode control, Git mutation, pane control, agent resume, or external send in production code.
- Treat session logs as untrusted input. Bound file reads, reject path traversal, avoid emitting prompt or tool-output contents by default, and redact local paths in shareable fixtures.
- A completed session is not proof that tests executed. Report session, Git, test, review, integration, and serving evidence separately.
- Keep the core receipt logic independent of Pi, Xcode UI, Herdr, Chughy, and Deja. Integrations adapt to the core.
- Add fixture-driven behavior tests for parser and classification changes.
- Use one writer per worktree and a distinct reviewer before integration.
