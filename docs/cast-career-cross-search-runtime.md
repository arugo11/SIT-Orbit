# CAST Career Cross-Search Runtime

`cast_career_search` is the high-level read-only Tool for one natural-language
question spanning the nine CAST surfaces:

`job`, `internship`, `company_session`, `company`, `hiring_record`,
`selection_report`, `recording`, `career_event`, and `counseling`.

## Boundary

The model receives only semantic arguments:

```text
query
surfaces
filters
limit
exhaustive
```

URLs, form field names, hidden values, company codes, POST bodies, and cursors
are rejected before a deferred call is created. The CAST content script reads
each selected surface serially using the source runtime's allowlists. A normal
run reads at most three result pages per search surface and five company detail
references. `exhaustive=true` uses the existing bounded 100-page path and is
never implied by a natural-language ranking request.

## Two projections

The content script and service worker keep a local `CastCareerLocalResult` for
the timeline cards. It may contain company names, deadlines, source links, and
surface-specific detail, but it never leaves the extension context beyond the
typed local message used to render the UI.

The API receives `CastCareerSearchResult` only. It contains surface coverage,
counts, reason codes, and aggregate cells with a minimum count of five. It has
no company name, person name, date, URL, internal identifier, or raw HTML field.
The server issues the opaque `cast-career-search-v1-*` evidence ID after the
tool result arrives; local evidence IDs are discarded before provider resume.

## Ranking

`rankCastCareerItems` builds a transient MiniSearch 7.2 index from the local
cards. Exact filters are applied first, then BM25/prefix/limited fuzzy ranking
orders the mixed result cards. The index is run-scoped and is not persisted.
Chrome Prompt API is used only for optional query structuring; deterministic
cards and matching reasons remain available when that API is unavailable.

## Partial results

Each surface carries its own status, count, page coverage, and reason code.
When one surface fails, successful surfaces remain visible and the overall
status becomes `partial`. A partial read is never described as an exhaustive
ranking, and a failed surface is never treated as an empty successful result.

Company relation flags are derived from observed CAST result links. Alumni
names, contact details, identifiers, hidden form values, cookies, tokens, and
raw HTML stay inside the local authenticated page boundary. This branch does
not submit applications, book consultations, edit favorites, or register
calendar events.
