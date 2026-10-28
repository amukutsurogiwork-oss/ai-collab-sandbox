# AI Collaboration Sandbox

A synthetic, dependency-free Node.js example for testing the workflow:

**Claude Code Cloud → GitHub pull request → Codex review → Claude PR Auto-fix.**

This repository contains no production code, credentials, or user data.

## Policy

- No deployment, external services, auto-merge, or production modifications.
- Changes require a PR. Protect `main` with GitHub settings where supported.
- Only Claude makes code changes. Codex is used for independent review comments.
- Use the accompanying `CLAUDE.md` and `AGENTS.md` as guidance. They are not a technical enforcement mechanism.

## Run tests

Node.js >= 20; no third-party dependencies.

```sh
npm test
```

## Domain rule

`canReadDocument(viewer, document)` allows access if and only if the document is public, or the signed-in viewer owns the document. Other signed-in users must not access someone else's private document.

## Why this example?

The baseline source code is correct. A dedicated test PR will deliberately introduce a **synthetic** authorization regression that the initial unit-test suite misses. The reviewer should independently detect the regression. Never reuse the intentionally broken candidate in real software.
