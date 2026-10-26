# REQUIREMENTS.md

Project: **Saku** (策: strategy, plan; also 咲く: to bloom)
Owner: Raphael
Status: v0.7 (2026-10-26)
License: PolyForm Noncommercial 1.0.0

## For Claude Code: first-run task (do this before any development)
If `docs/requirements/` does not exist yet:
1. Split this file into separate files using the `<!-- split: path -->` markers. Everything between a marker and the next marker goes into the file named by the marker, **verbatim** (do not reword, summarize or reorder). This header block goes to `docs/requirements/_header.md`.
2. Create `scripts/docs-build` and a `pnpm docs:build` command that regenerates `REQUIREMENTS.md` by concatenating the split files in marker order, re-inserting each marker line. Run it and confirm the output is byte-identical to the original file. Report the result.
3. From then on, the split files are the source of truth. `REQUIREMENTS.md` is generated only; never edit it directly. CI fails if it is out of date.
4. Commit as `docs: split requirements` and stop for the owner's review before starting Stage A1.

If `docs/requirements/` already exists, ignore this section and follow `CLAUDE.md`.

