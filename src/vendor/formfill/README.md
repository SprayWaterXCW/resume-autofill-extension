# Reused form-fill code

Source: the user's separately maintained plugin, `FORMFILL_RESEARCH/1lck/AI-Resume-Form-Filling-Assistant-master/shared`. Snapshot copied 2026-10-04. The original files remain unchanged.

- `resume-schema.js`: profile fields, list definitions, normalization and catalog. Converted from a browser global to an ES module.
- `dropdown-select.js`: component selectors and option aliases/scoring. Converted from UMD to an ES module. Runtime restricts these helpers to the bound field and rejects ambiguous choices.
- `write-fixes.js`: award/competition bullet parser. Converted from UMD to an ES module; only parsing helpers are used by the Agent. Agent 0.7.1 consistently removes the bullet marker for a single bullet record and preserves its multi-line description, keeping metadata attached when the final remaining entry is retained. The original plugin is unchanged.
- `LICENSE`: original GPL-3.0 license text.

New runtime writes are independently verified. Generic submit/save/script/CDP actions are not exposed.
