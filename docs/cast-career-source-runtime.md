# CAST Career Source Runtime

This runtime reads the authenticated CAST origin only after an explicit Chat
request. It keeps the browser session and the parsed DOM inside the CAST
content-script boundary; the service worker receives typed local cards only.

## Allowlisted source paths

| Surface | Entry/result path | Additional read |
| --- | --- | --- |
| 求人 | `/career/job_offer_search` → `/career/job_offer_search/search` | none |
| インターン | `/career/internship_search` | none |
| 会社説明会 | `/career/company_session_search` | none |
| 企業 | `/career/company_search` → `/career/company_search/search` | observed company-detail form |
| 採用実績 | `/career/adopters_search` → `/career/adopters_search/search` | company detail → `/career/get/employmentSub` |
| 選考記録 | company-detail relation link | company detail → `/career/get/companyExamSub` |
| 相談枠 | `https://shibaura.pita.services/career/consultation_reservation` | read-only slot grid |
| 録画 | CAST top → fixed CAST-linked Notion root | temporary inactive tab |
| キャリアイベント | CAST top → fixed CAST-linked Notion root | temporary inactive tab |

The exact Notion roots are discovered from the authenticated CAST top page and
then checked against a fixed allowlist. An agent cannot supply a URL, form
action, field name, company code, hidden value, or POST body.

## Bounds and failure handling

- Search forms are fetched before every POST so hidden state and observed form
  controls stay in the CAST content script.
- A normal surface reads one result page; an explicit exhaustive request is
  bounded to 100 pages. Company detail follow-up is capped at five references.
- Login pages, redirects to an unexpected path, 404, 429, 5xx, and structure
  changes produce an explicit status and reason code. They are never converted
  to an empty successful result.
- Consultation rows are read only. Reservation links are not clicked.
- Notion extraction removes links, scripts, forms, meeting identifiers, and
  staff/contact details before a local snapshot is returned.

## Data boundary

`CastCareerSourceItem` is a local-only card. Company names and official local
open links may be displayed in the extension. Company codes, hidden fields,
cookies, tokens, raw HTML, and student/person names never cross the runtime
message boundary. The high-level Agent projection is implemented separately
and must contain aggregates and opaque evidence IDs only.
