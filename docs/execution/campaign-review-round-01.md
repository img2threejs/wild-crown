# Campaign state — Astra review round 01

Reviewer: active `openai-codex/gpt-6-astra` coordinator.
Author: `openai-codex/gpt-6-luna`, configured coder role.
Branch: `feat/campaign-state`.
Verdict at this revision: **SPEC_FAIL — returned to Luna; not published as accepted code.**

## Exercised evidence

Ran the package's actual `npm run typecheck && npm test && npm run scenario`. Typecheck/build passed and all eight initial tests passed. The compiled scenario ran and printed its outcomes. Those results did not cover the following defects.

A separate compiled-package smoke produced:

```text
canonical-leaders {
  sky: 'asha', canopy: 'luma', fang: 'ghor',
  pack: 'ruun', shadow: 'orun', crown: 'solkar'
}
koro-rejected Unknown leader: koro
obligation-count 5 ending true
exiled-solkar-as-representative-eligible true
replay-tag-through-real-import true
```

## Required corrections

1. **Canonical leadership:** replace incorrect arbitrary leader mapping. Koro/Asha/Ruun-or-Luma/Nyra/Solkar must retain their actual factions; Sky must not invent a tiger sovereign. Test the meaningful mapping/leadership transition, not only six unique identifiers.
2. **Ending obligations:** model the eight existing obligation facts across five regions, rather than selecting only one label per region. Bamboo snares, Nyra's truth and voluntary Sunmane governance must each independently block Living Pact when missing.
3. **Absence-safe representation:** an exiled/absent Solkar cannot satisfy Crown representation by leaving a `present:true` representative flag. A willing council can. Validate contradictory imports and preserve the political/companion distinction.
4. **Actual replay boundary:** reject replay origin at the real checkpoint import entry. A standalone always-reject helper does not protect another entry that accepts the same data with ignored replay metadata.
5. **Test quality:** remove incidental label-wording and constant-copy assertions; retain behavior and boundary coverage. Update all callers, scenario output and documentation cleanly.

## Review sweeps

- Persistence: this feature is an in-memory package with serialized checkpoint validation. No database/IndexedDB adapter exists; no durable persistence pass is claimed. Same-run checkpoint load was exercised and kept current Dominion history, but full external save-history import/export remains outside this package boundary.
- State lifetime: run-level Dominion ledger is separated from rewindable world state. New runs are isolated. Representation validity and replay-origin handling failed the boundary probes above.
- Checker narrowing: the existing replay test called an always-reject function rather than the real importer; it did not establish the required invariant. The replacement must exercise the actual entry used by consumers.

No commit/push of the campaign feature occurs until Luna repairs and Astra verifies these findings. Initial implementation usage is recorded separately from the repair round.
