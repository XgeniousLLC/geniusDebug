---
name: verify-against-srs
description: Use when implementing, reviewing, or verifying any geniusDebug feature to map it to the SRS requirement IDs (FR-*/NFR-*) and check coverage. Trigger on "does this meet the spec", implementing a numbered requirement, PR/code review, or acceptance checks.
---

# Verify against the SRS

The authoritative spec is `docs/geniusDebug-SRS.md`. Every feature traces to one or more requirement IDs like `FR-ING-3`, `FR-WRK-5`, `NFR-PERF-1`.

## How to use
1. **Find the relevant IDs.** Grep the SRS for the area you're touching, e.g. `grep -nE "FR-(ING|WRK)-" docs/geniusDebug-SRS.md` for ingest/workers, `FR-UI-` for dashboard, `FR-MAP-` for source maps, `FR-GH-` for GitHub, `FR-RPL-` replay, `FR-TRC-` traces, `FR-ALR-` alerts, `NFR-` for non-functional.
2. **Read the full text** of each ID (definition lines are bold, e.g. `**FR-ING-3 [M]**`). Note priority: `[M]` must, `[S]` should, `[C]` could, `[v2]` deferred.
3. **Check coverage.** For each ID in scope: is it implemented, partially, or missing? Does the code contradict it?
4. **Guard the golden rules** (CLAUDE.md): performance isolation (Section 6.1), cheap ingest hot path (FR-ING-3), pinned envelope contract (FR-SDK-10), platform-agnostic pipeline (FR-WRK-7), secrets server-side (NFR-SEC-5), cost discipline (FR-RET-*).
5. **Report** as a short table: `ID | requirement | status (met/partial/missing) | note`. Cite IDs in the PR description and commit message.

## Acceptance smoke (the reference incident)
The end-to-end path in SRS Section 9 must work: a `TypeError: Cannot read properties of undefined (reading 'json')` from Taskip should appear as a grouped Issue, symbolicate to `./stores/inbox/useInboxConversations.ts`, show Highlights (handled/level/transaction/url/trace), link to trace + replay, deep-link to GitHub, and fire a de-duplicated email alert.

## Don't
- Don't invent requirements — if something isn't in the SRS, flag it as a spec gap and ask.
- Don't mark `[v2]` items (Laravel/PHP, Section 12) as v1 work.
