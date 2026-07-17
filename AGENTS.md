Never push (Git) unless explicitly asked for.

Every requirement requires at least one automated test.

## Validation

* Pre-land/pre-commit code changes: mandatory fresh $autoreview until no accepted/actionable findings remain. If findings want refactor, refactor; no ugly fixes.
* Autoreview uncommitted changes: --mode uncommitted; no dirty mode.
* Autoreview staged/uncommitted diff: use --mode uncommitted; no staged mode.
