# Repository context

This is an isolated test project with synthetic documents and no production data.

## Code Review Rules

### Private document authorization

- The function `canReadDocument(viewer, document)` must deny access to any private document when the viewer is authenticated but does not own it. Simply being logged in must never grant access. This is a security boundary, not a style preference.
- Identify regressions that accidentally permit another signed-in user to read private documents. Explain the triggering inputs and the potential exposure.

### Evidence and scope

- Prioritize actionable high-impact defects and missing tests that permit those defects. Do not request stylistic rewrites.
- Review only; do not modify files or submit commits as part of the review workflow.
