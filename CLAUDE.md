# Claude Code instructions: collaboration sandbox

- This is a synthetic, public-only experiment. Do not add credentials, personally identifying information, private repository contents, or real project code.
- Limit work to this repository. Do not access, configure, or modify UtaMIX, yuhi-colorsing-system, pokopoko-colorsing-system, or production systems.
- Claude is the only code-editing agent. Codex is an independent reviewer, not a co-editor.
- Use a feature branch and PR; do not push to `main`, merge, or deploy.
- Do not purchase credits, enable paid APIs, add new GitHub apps to unrelated repositories, or broaden repository permissions.
- The test PR may intentionally contain a synthetic regression for a one-time review-trigger exercise. Do not use it outside this sandbox.
- After the Codex review is posted, evaluate findings independently and add a regression test before correcting the issue.
- Do not presume a missing reaction means bot comments are unsupported. Check review type, Auto-fix status, GitHub events, and the Claude session record.
- At most two attempted fix cycles are *requested* for this trial. This is a soft instruction, not a guaranteed enforcement limit. Stop monitoring after the first verified repair if possible.
- Report timestamps, PR link, the review author's account, review/comment format, Auto-fix activation, Claude response, commit changes, CI evidence, and uncertainty.

## One-entry protocol (sandbox only)

- For a task whose entry point is the user talking to Mona, follow `docs/MONE_SINGLE_ENTRY_PROTOCOL_20261028.md`.
- Do not assume that opening a draft PR pauses Codex review: past sandbox PR #2 was reviewed while still draft.
- Create the PR, **verify Auto-fix is ON**, then inspect whether a *formal* Codex review was posted after Auto-fix activation. If not, request `@codex review` once as a top-level PR comment; never request it repeatedly.
- Distinguish GitHub bot review, Claude session notification, and Claude edits as separate evidence. A bot comment alone does not prove Auto-fix received it.
- Do not enable Claude paid Code Review, paid APIs, auto-merge, broad GitHub access, or production deploys. No repository outside this sandbox.
- Stop after one clear fix cycle, on ambiguity, or if the required event was not delivered. Final report should state which steps are independently verifiable.
