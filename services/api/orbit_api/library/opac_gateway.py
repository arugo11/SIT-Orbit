# ruff: noqa: E501
"""A bounded server-side adapter for the public SIT OPAC.

The OPAC does not publish a standalone API.  Its public search/detail pages
declare the exact availability endpoint and a short-lived page token in the
official Drupal settings.  This adapter follows that page contract, validates
every URL against the fixed official origin, and returns only the existing
public library projection.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime
from html import unescape
from typing import Any, Literal
from urllib.parse import quote, unquote, urlencode, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from orbit_api.models import (
    ChatLibraryContextRecord,
    LibraryBibliographicRecord,
    LibraryCatalogSearchResult,
    LibraryHoldingSummary,
    LibraryItemReadResult,
)

OPAC_ORIGIN = "https://library.shibaura-it.ac.jp"
SEARCH_PREFIX = "/opc/xc/search/"
RECORD_PREFIX = "/opc/recordID/catalog.bib/"
NCIP_MULTI_PATH = "/opc/xc_search/ajax/ncip_multi_info"
NCIP_FULL_PATH = "/opc/xc_search/ajax/ncip_info_full"
MAX_HTML_BYTES = 1_000_000
MAX_JSON_BYTES = 2_000_000
MAX_UPSTREAM_BIBS = 256
_RECORD_ID = re.compile(r"^/opc/recordID/catalog\.bib/([^/?#\s]{1,200})$")
_RESOURCE_REF = re.compile(r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$")
logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)


class OpacGatewayError(RuntimeError):
    """Safe, stable failure reason exposed to the Agent/UI."""

    def __init__(self, reason_code: str, *, retryable: bool = False) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.retryable = retryable


@dataclass(frozen=True)
class _Page:
    response: httpx.Response
    soup: BeautifulSoup
    settings: dict[str, Any]
    kind: Literal["search", "record", "unknown"]


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _normalized_text(value: str | None, limit: int = 300) -> str:
    if not value:
        return ""
    text = re.sub(r"\s+", " ", unescape(value)).strip()
    return text[:limit]


def _match_text(value: str | None) -> str:
    """Normalize public title/author text for strict record binding."""

    return re.sub(r"[^\w]+", "", _normalized_text(value, 300).casefold())


def _record_matches(expected: LibraryBibliographicRecord, actual: LibraryBibliographicRecord) -> bool:
    if expected.isbn and actual.isbn and _match_text(expected.isbn) != _match_text(actual.isbn):
        return False
    expected_title = _match_text(expected.title)
    actual_title = _match_text(actual.title)
    if not expected_title or not actual_title:
        return False
    if expected_title != actual_title:
        expected_main = _match_text(expected.title.split("=", 1)[0])
        actual_main = _match_text(actual.title.split("=", 1)[0])
        if not expected_main or expected_main != actual_main:
            return False
    if expected.authors and actual.authors:
        expected_authors = {_match_text(item) for item in expected.authors if _match_text(item)}
        actual_authors = {_match_text(item) for item in actual.authors if _match_text(item)}
        if expected_authors and actual_authors and not expected_authors & actual_authors:
            return False
    return True


def _resource_ref(record_path: str) -> str:
    """Derive the same opaque reference as the extension.

    The browser connector intentionally hashes only the public record identifier
    (not the URL, query, or fragment).  Keep the two 32-bit FNV-style lanes in
    lock-step with ``createLibraryResourceRef`` so a server search result can be
    read by the following turn without exposing the underlying identifier.
    """

    match = _RECORD_ID.fullmatch(record_path)
    if match is None:
        raise OpacGatewayError("opac_contract_changed")
    normalized = unquote(match.group(1))
    if (
        not normalized
        or len(normalized) > 200
        or any(character in "/?#" or character.isspace() for character in normalized)
    ):
        raise OpacGatewayError("opac_contract_changed")
    first = 0x811C9DC5
    second = 0x9E3779B9
    for character in normalized:
        code = ord(character)
        first = ((first ^ code) * 0x01000193) & 0xFFFFFFFF
        second = ((second ^ (code + 0x9E3779B9)) * 0x01000193) & 0xFFFFFFFF
    opaque = f"{first:08x}{second:08x}"
    return f"orbit-library://record/{opaque}"


def _canonical_url(record_path: str) -> str:
    return urljoin(OPAC_ORIGIN, record_path)


def _safe_url(value: str, allowed_paths: tuple[str, ...]) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.netloc != urlparse(OPAC_ORIGIN).netloc
        or parsed.query
        or parsed.fragment
        or not any(parsed.path == path or parsed.path.startswith(path) for path in allowed_paths)
    ):
        raise OpacGatewayError("opac_redirect_rejected")
    return value


def _retry_after(response: httpx.Response) -> float:
    value = response.headers.get("retry-after", "")
    try:
        return max(0.0, min(float(value), 30.0))
    except ValueError:
        return 0.0


def _settings_from_html(soup: BeautifulSoup) -> dict[str, Any]:
    for script in soup.find_all("script"):
        text = script.string or script.get_text()
        if "Drupal.settings" not in text or "xc_search" not in text:
            continue
        start = text.find("jQuery.extend(Drupal.settings,")
        if start < 0:
            continue
        payload = text[start + len("jQuery.extend(Drupal.settings,") :]
        closing = payload.rfind("});")
        if closing >= 0:
            payload = payload[: closing + 1]
        else:
            payload = payload.rstrip().rstrip(";")
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            continue
    raise OpacGatewayError("opac_token_missing")


def _status(value: str) -> Literal["available", "unavailable", "unknown"]:
    lowered = value.lower()
    if any(token in lowered for token in ("貸出中", "利用不可", "unavailable", "checked out")):
        return "unavailable"
    if any(token in lowered for token in ("貸出可", "利用可", "available", "on shelf")):
        return "available"
    return "unknown"


def _campus(value: str) -> Literal["toyosu", "omiya", "unknown"]:
    if "豊洲" in value:
        return "toyosu"
    if "大宮" in value:
        return "omiya"
    return "unknown"


def _date(value: str | None) -> str | None:
    if not value:
        return None
    match = re.search(r"(20\d{2})[/-](\d{1,2})[/-](\d{1,2})", value)
    if not match:
        return None
    return f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"


def _holding_from_text(text: str) -> LibraryHoldingSummary:
    normalized = _normalized_text(text, 500)
    status = _status(normalized)
    location_text = normalized
    location_text = re.sub(
        r"^\s*(?:貸出中|貸出可|利用不可|利用可|checked\s+out|available|unavailable)\s*[,、:：]?\s*",
        "",
        location_text,
        count=1,
        flags=re.IGNORECASE,
    )
    call = None
    call_match = re.search(
        r"\b\d{3}(?:\.\d+)?\s*(?:/\s*[A-Za-z0-9][A-Za-z0-9/ -]{0,30}|\s+[A-Za-z][A-Za-z0-9/ -]{0,30})",
        location_text,
    )
    if call_match:
        call = _normalized_text(call_match.group(0), 100)
        location_text = location_text[: call_match.start()].rstrip(" ,、")
    return LibraryHoldingSummary(
        campus=_campus(location_text or normalized),
        location=location_text or None,
        call_number=call,
        status=status,
        due_date=_date(normalized),
    )


def _holding_from_detail_row(row: Any) -> LibraryHoldingSummary:
    """Project one official detail-table row without copy/material IDs."""

    status_node = row.select_one(".bkAva")
    location_node = row.select_one(".bkLoc dd")
    call_node = row.select_one(".bkCnu .spDisInl") or row.select_one(".bkCnu .xc-call-number")
    due_node = row.select_one(".bkDue dd")
    location = _normalized_text(location_node.get_text(" ") if location_node else "", 200)
    status_text = _normalized_text(status_node.get_text(" ") if status_node else row.get_text(" "), 120)
    call_number = _normalized_text(call_node.get_text(" ") if call_node else "", 100) or None
    due_date = _date(due_node.get_text(" ") if due_node else None)
    due_text = _normalized_text(due_node.get_text(" ") if due_node else "", 80)
    reservation_match = re.search(r"予約数\s*[:：]?\s*(\d+)", due_text)
    return LibraryHoldingSummary(
        campus=_campus(location),
        location=location or None,
        call_number=call_number,
        status=_status(status_text),
        due_date=due_date,
        reservation_count=int(reservation_match.group(1)) if reservation_match else None,
    )


def _settings_xc(settings: dict[str, Any]) -> dict[str, Any]:
    value = settings.get("xc_search")
    if not isinstance(value, dict):
        raise OpacGatewayError("opac_contract_changed")
    return value


def _record_path(value: str) -> str | None:
    parsed = urlparse(value)
    if parsed.netloc and parsed.netloc != urlparse(OPAC_ORIGIN).netloc:
        return None
    match = _RECORD_ID.fullmatch(parsed.path)
    if match is None:
        return None
    decoded = unquote(match.group(1))
    if (
        not decoded
        or len(decoded) > 200
        or any(character in "/?#" or character.isspace() for character in decoded)
    ):
        return None
    return parsed.path


def _record_from_node(node: Any) -> tuple[str, str, list[str], str | None, int | None, str | None]:
    link = node.select_one(".xc-title a[href]") or node.select_one("a[href*='/recordID/catalog.bib/']")
    if link is None:
        raise OpacGatewayError("opac_contract_changed")
    path = _record_path(link.get("href", ""))
    if path is None:
        raise OpacGatewayError("opac_redirect_rejected")
    title = _normalized_text(link.get_text(" "), 300)
    title = re.sub(r"^\s*\d+\s*[.)]?\s*", "", title).lstrip(". ")
    author_nodes = node.select(".xc-author a, .xc-authors a, [class*='author'] a")
    authors = [_normalized_text(item.get_text(" "), 200) for item in author_nodes]
    raw_text = _normalized_text(node.get_text(" "), 1200)
    isbn = None
    isbn_match = re.search(r"(?:ISBN\s*[:：]?\s*)?(97[89]\d{10}|\d{9}[\dX])", raw_text)
    if isbn_match:
        isbn = isbn_match.group(1)
    year = None
    year_match = re.search(r"\b(19\d{2}|20\d{2})\b", raw_text)
    if year_match:
        year = int(year_match.group(1))
    return path, title, authors[:20], isbn, year, raw_text


def _record_from_detail(soup: BeautifulSoup, path: str) -> tuple[str, list[str], str | None, int | None, str | None]:
    heading = soup.select_one("h3.node-title, h1, h2, .xc-title")
    title = _normalized_text(heading.get_text(" ") if heading else "", 300)
    if not title:
        meta_title = soup.select_one('meta[name="title"], meta[property="og:title"]')
        meta_value = meta_title.get("content") if meta_title else ""
        title = _normalized_text(meta_value if isinstance(meta_value, str) else "", 300)
    title = re.sub(r"^\s*\d+\s*[.)]?\s*", "", title).lstrip(". ")
    authors = [_normalized_text(item.get_text(" "), 200) for item in soup.select("[class*='author'] a")]
    if not authors:
        meta_author = soup.select_one('meta[name="author"]')
        if meta_author is not None:
            meta_value = meta_author.get("content")
            authors = [_normalized_text(meta_value if isinstance(meta_value, str) else "", 300)]
    text = _normalized_text(soup.get_text(" "), 2500)
    isbn_match = re.search(r"(97[89]\d{10}|\d{9}[\dX])", text)
    year_match = re.search(r"\b(19\d{2}|20\d{2})\b", text)
    return title, authors[:20], isbn_match.group(1) if isbn_match else None, int(year_match.group(1)) if year_match else None, text


class _MemoryCache:
    def __init__(self, limit: int = 256) -> None:
        self._values: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self.limit = limit

    def get(self, key: str, ttl: float) -> Any | None:
        if ttl <= 0:
            return None
        value = self._values.get(key)
        if value is None:
            return None
        timestamp, payload = value
        if time.monotonic() - timestamp > ttl:
            self._values.pop(key, None)
            return None
        self._values.move_to_end(key)
        return payload

    def put(self, key: str, payload: Any) -> None:
        self._values[key] = (time.monotonic(), payload)
        self._values.move_to_end(key)
        while len(self._values) > self.limit:
            self._values.popitem(last=False)


class OpacGateway:
    """Rate-limited, in-memory, public-only OPAC client."""

    def __init__(self) -> None:
        self.base_url = os.getenv("ORBIT_OPAC_BASE_URL", OPAC_ORIGIN).rstrip("/")
        if self.base_url != OPAC_ORIGIN:
            raise RuntimeError("ORBIT_OPAC_BASE_URL must be the official SIT OPAC origin.")
        transport = os.getenv("ORBIT_OPAC_TRANSPORT", "off")
        if transport not in {"off", "server"}:
            raise RuntimeError("ORBIT_OPAC_TRANSPORT must be either 'off' or 'server'.")
        self.enabled = transport == "server"
        self.min_interval = max(0.0, int(os.getenv("ORBIT_OPAC_MIN_INTERVAL_MS", "10000")) / 1000)
        self.search_ttl = max(0.0, float(os.getenv("ORBIT_OPAC_SEARCH_CACHE_TTL_SECONDS", "300")))
        self.detail_ttl = max(0.0, float(os.getenv("ORBIT_OPAC_DETAIL_CACHE_TTL_SECONDS", "30")))
        self._upstream_lock = asyncio.Lock()
        self._last_page_started = 0.0
        self._cache = _MemoryCache()

    async def _wait_turn(self) -> None:
        delay = self.min_interval - (time.monotonic() - self._last_page_started)
        if delay > 0:
            await asyncio.sleep(delay)
        self._last_page_started = time.monotonic()

    async def _get_same_origin(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        params: Any = None,
        redirect_path: str | None = None,
    ) -> httpx.Response:
        """Follow only same-origin redirects before exposing response data."""

        current = url
        current_params = params
        for _ in range(4):
            response = await client.get(
                current,
                params=current_params,
                follow_redirects=False,
            )
            if response.status_code not in {301, 302, 303, 307, 308}:
                return response
            location = response.headers.get("location")
            if not location:
                raise OpacGatewayError("opac_redirect_rejected")
            next_url = urljoin(current, location)
            parsed = urlparse(next_url)
            if (
                parsed.scheme != "https"
                or parsed.netloc != urlparse(OPAC_ORIGIN).netloc
                or (
                    redirect_path is not None
                    and (
                        parsed.path != redirect_path
                        or parsed.fragment
                    )
                )
            ):
                raise OpacGatewayError("opac_redirect_rejected")
            current = next_url
            # Query parameters belong to the original request.  A redirect
            # Location is already an absolute URL and must not receive them a
            # second time.
            current_params = None
        raise OpacGatewayError("opac_redirect_rejected")

    async def _get_page(self, client: httpx.AsyncClient, url: str) -> _Page:
        response: httpx.Response | None = None
        for attempt in range(2):
            try:
                response = await self._get_same_origin(client, url)
            except httpx.TimeoutException as error:
                logger.info("opac_upstream_exception phase=page kind=timeout type=%s", type(error).__name__)
                if attempt == 0:
                    await self._wait_turn()
                    continue
                raise OpacGatewayError("opac_timeout", retryable=True) from error
            except httpx.HTTPError as error:
                logger.info("opac_upstream_exception phase=page kind=http type=%s", type(error).__name__)
                if attempt == 0:
                    await self._wait_turn()
                    continue
                raise OpacGatewayError("opac_upstream_error", retryable=True) from error
            if response.status_code in {429, 502, 503, 504}:
                if attempt == 0:
                    await asyncio.sleep(_retry_after(response))
                    await self._wait_turn()
                    continue
                raise OpacGatewayError(
                    "opac_rate_limited" if response.status_code == 429 else "opac_upstream_error",
                    retryable=True,
                )
            break
        if response is None:
            raise OpacGatewayError("opac_upstream_error", retryable=True)
        if response.status_code >= 400:
            logger.info("opac_upstream_response phase=page status_class=%d", response.status_code // 100)
            raise OpacGatewayError("opac_upstream_error")
        if len(response.content) > MAX_HTML_BYTES:
            raise OpacGatewayError("opac_contract_changed")
        content_type = response.headers.get("content-type", "")
        if "text/html" not in content_type:
            raise OpacGatewayError("opac_contract_changed")
        final_url = str(response.url)
        parsed = urlparse(final_url)
        if (
            parsed.scheme != "https"
            or parsed.netloc != urlparse(OPAC_ORIGIN).netloc
            or parsed.fragment
        ):
            raise OpacGatewayError("opac_redirect_rejected")
        soup = BeautifulSoup(response.content, "html.parser")
        if "/recordID/catalog.bib/" in parsed.path:
            kind: Literal["search", "record", "unknown"] = "record"
        elif parsed.path.startswith(SEARCH_PREFIX):
            kind = "search"
        else:
            kind = "unknown"
        if kind == "unknown":
            raise OpacGatewayError("opac_redirect_rejected")
        try:
            settings = _settings_from_html(soup)
        except OpacGatewayError:
            # A genuine zero-result search page intentionally has no
            # ``xc_search`` token block.  Keep the page so the caller can
            # distinguish that normal result from a login/error page.
            if kind != "search":
                raise
            settings = {}
        return _Page(response=response, soup=soup, settings=settings, kind=kind)

    async def _availability(
        self,
        client: httpx.AsyncClient,
        settings: dict[str, Any],
        *,
        detail: bool,
        node_id: str | None,
        provider: str | None,
        bib_ids: list[str],
    ) -> dict[str, Any]:
        xc = _settings_xc(settings)
        raw_url = xc.get("ncip_url") if detail else xc.get("multi_ncip_url")
        expected = NCIP_FULL_PATH if detail else NCIP_MULTI_PATH
        if not isinstance(raw_url, str):
            raise OpacGatewayError("opac_token_missing")
        parsed = urlparse(raw_url)
        if (
            parsed.scheme != "https"
            or parsed.netloc != urlparse(OPAC_ORIGIN).netloc
            or parsed.path != expected
            or parsed.query
            or parsed.fragment
        ):
            raise OpacGatewayError("opac_redirect_rejected")
        token = xc.get("token")
        if not isinstance(token, str) or not token or len(token) > 256:
            raise OpacGatewayError("opac_token_missing")
        if detail:
            # The official JavaScript passes an array under the unbracketed
            # ``bib_ids`` key.  The OPAC endpoint treats ``bib_ids[]`` as a
            # different parameter and returns a misleading valid-but-empty
            # response, so preserve the exact public form contract here.
            params = {"provider_id": provider or "", "bib_ids": bib_ids, "token": token}
        else:
            params = {
                "ncip_id": provider or xc.get("ncip_id", ""),
                "bib_id": ",".join(bib_ids),
                "token": token,
                "node_id": node_id or "",
            }
        response: httpx.Response | None = None
        for attempt in range(2):
            try:
                response = await self._get_same_origin(
                    client,
                    raw_url,
                    params=params,
                    redirect_path=expected,
                )
            except httpx.TimeoutException as error:
                logger.info("opac_upstream_exception phase=availability kind=timeout type=%s", type(error).__name__)
                if attempt == 0:
                    await self._wait_turn()
                    continue
                raise OpacGatewayError("opac_availability_failed", retryable=True) from error
            except httpx.HTTPError as error:
                logger.info("opac_upstream_exception phase=availability kind=http type=%s", type(error).__name__)
                if attempt == 0:
                    await self._wait_turn()
                    continue
                raise OpacGatewayError("opac_availability_failed", retryable=True) from error
            if response.status_code in {429, 502, 503, 504} and attempt == 0:
                await asyncio.sleep(_retry_after(response))
                await self._wait_turn()
                continue
            break
        if response is None:
            raise OpacGatewayError("opac_availability_failed", retryable=True)
        if response.status_code >= 400 or len(response.content) > MAX_JSON_BYTES:
            logger.info(
                "opac_upstream_response phase=availability status_class=%d oversized=%s",
                response.status_code // 100,
                len(response.content) > MAX_JSON_BYTES,
            )
            raise OpacGatewayError(
                "opac_availability_failed",
                retryable=response.status_code in {429, 502, 503, 504},
            )
        content_type = response.headers.get("content-type", "")
        if "json" not in content_type.lower():
            raise OpacGatewayError("opac_availability_failed")
        final = urlparse(str(response.url))
        if (
            final.scheme != "https"
            or final.netloc != urlparse(OPAC_ORIGIN).netloc
            or final.path != expected
            or final.fragment
        ):
            raise OpacGatewayError("opac_redirect_rejected")
        try:
            payload = response.json()
        except ValueError as error:
            raise OpacGatewayError("opac_availability_failed") from error
        if not isinstance(payload, dict):
            raise OpacGatewayError("opac_availability_failed")
        if detail:
            valid_shape = any(
                isinstance(payload.get(key), str) for key in ("content", "availability")
            )
        else:
            # ``ncip_multi_info`` is keyed by public bibliographic IDs; each
            # value is an availability object or rendered HTML fragment.
            valid_shape = any(
                isinstance(value, (dict, str)) for value in payload.values()
            )
        if not valid_shape:
            raise OpacGatewayError("opac_availability_failed")
        return payload

    @staticmethod
    def _holdings_from_availability(payload: Any) -> list[LibraryHoldingSummary]:
        holdings: list[LibraryHoldingSummary] = []
        if isinstance(payload, dict) and isinstance(payload.get("content"), str):
            fragment = BeautifulSoup(payload["content"], "html.parser")
            detail_rows = fragment.select("#detail_table tbody tr")
            cells = detail_rows or fragment.select("td.xc-availability") or fragment.select("tr")
            for row in cells:
                holding = (
                    _holding_from_detail_row(row)
                    if row.select_one(".bkLoc") is not None
                    else _holding_from_text(row.get_text(" "))
                )
                if holding.campus != "unknown" or holding.location:
                    holdings.append(holding)
        elif isinstance(payload, dict) and isinstance(payload.get("availability"), str):
            fragment = BeautifulSoup(payload["availability"], "html.parser")
            # The availability value contains a wrapper ``div`` and a table
            # whose first row also contains the "other N holdings" controls.
            # Read only the leaf availability cells; parsing the wrapper or
            # parent row would merge campuses and count the same holding twice.
            cells = fragment.select("td.xc-availability") or fragment.select("tr")
            for cell in cells:
                text = cell.get_text(" ")
                if "豊洲" in text or "大宮" in text:
                    holdings.append(_holding_from_text(text))
        unique: dict[tuple[str, str | None, str | None, str], LibraryHoldingSummary] = {}
        for item in holdings:
            key = (item.campus, item.location, item.call_number, item.status)
            unique.setdefault(key, item)
        return list(unique.values())[:20]

    @staticmethod
    def _record_from_search_node(node: Any, availability: Any) -> LibraryBibliographicRecord:
        path, title, authors, isbn, year, raw = _record_from_node(node)
        holdings = OpacGateway._holdings_from_availability(availability)
        return LibraryBibliographicRecord(
            resource_ref=_resource_ref(path),
            title=title or "書誌情報",
            authors=authors,
            isbn=isbn,
            publication_year=year,
            campus="any",
            url=_canonical_url(path),
            holdings=holdings or [LibraryHoldingSummary(campus="unknown", location=None, status="unknown")],
        )

    async def search(
        self,
        *,
        query: str,
        author: str | None = None,
        subject: str | None = None,
        isbn: str | None = None,
        pub_year: int | None = None,
        campus: str = "any",
        format: str = "any",
        limit: int = 10,
    ) -> LibraryCatalogSearchResult:
        if not self.enabled:
            return LibraryCatalogSearchResult(status="unavailable", query=query, reason_code="opac_disabled")
        normalized = _normalized_text(query, 200)
        if not normalized:
            raise ValueError("OPAC query must not be empty.")
        limit = max(1, min(limit, 10))
        cache_input = json.dumps(
            {
                "query": normalized.casefold(),
                "author": _normalized_text(author, 200).casefold(),
                "subject": _normalized_text(subject, 200).casefold(),
                "isbn": _normalized_text(isbn, 32).casefold(),
                "pub_year": pub_year,
                "campus": campus,
                "format": format,
                "limit": limit,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        key = hashlib.sha256(cache_input.encode()).hexdigest()
        cached = self._cache.get(f"search:{key}", self.search_ttl)
        if isinstance(cached, LibraryCatalogSearchResult):
            return cached.model_copy(deep=True)
        started = time.monotonic()
        async with self._upstream_lock:
            cached = self._cache.get(f"search:{key}", self.search_ttl)
            if isinstance(cached, LibraryCatalogSearchResult):
                return cached.model_copy(deep=True)
            await self._wait_turn()
            params: dict[str, str] = {"os[keys]": normalized}
            for name, value in (("auth", author), ("subject", subject), ("isbn", isbn)):
                normalized_value = _normalized_text(value, 200 if name != "isbn" else 32)
                if normalized_value:
                    params[f"os[{name}]"] = normalized_value
            if pub_year is not None:
                params["os[pubYearFrom]"] = str(pub_year)
                params["os[pubYearTo]"] = str(pub_year)
            if campus in {"toyosu", "omiya"}:
                params["os[location]"] = "Toyosu" if campus == "toyosu" else "Omiya"
            if format in {"book", "journal"}:
                params["os[format]"] = "Book" if format == "book" else "Journal"
            url = (
                f"{OPAC_ORIGIN}{SEARCH_PREFIX}{quote(normalized, safe='')}"
                f"?{urlencode(params)}"
            )
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(20.0),
                    headers={"Accept": "text/html"},
                    max_redirects=3,
                ) as client:
                    page = await self._get_page(client, url)
                    if page.kind == "record":
                        path = _record_path(str(page.response.url))
                        if path is None:
                            raise OpacGatewayError("opac_redirect_rejected")
                        item = await self._read_page_record(client, page, path)
                        result = LibraryCatalogSearchResult(status="known", query=normalized, items=[item])
                    else:
                        rows = page.soup.select(".result-row")
                        if not rows and not page.soup.select_one("#xc-search-no-result"):
                            raise OpacGatewayError("opac_contract_changed")
                        if not rows:
                            result = LibraryCatalogSearchResult(
                                status="known", query=normalized, items=[]
                            )
                            self._cache.put(f"search:{key}", result)
                            return result.model_copy(deep=True)
                        items: list[LibraryBibliographicRecord] = []
                        xc = _settings_xc(page.settings)
                        ncip_info = xc.get("ncip_info")
                        if not isinstance(ncip_info, dict) or not ncip_info:
                            raise OpacGatewayError("opac_token_missing")
                        ordered_bibs: list[tuple[str, str]] = []
                        provider_entries = ncip_info.items()
                        for _provider, provider_values in provider_entries:
                            if not isinstance(provider_values, list):
                                continue
                            for node_values in provider_values:
                                if not isinstance(node_values, dict):
                                    continue
                                for node_id, bib_values in node_values.items():
                                    for bib in bib_values if isinstance(bib_values, list) else [bib_values]:
                                        if len(ordered_bibs) >= MAX_UPSTREAM_BIBS:
                                            break
                                        ordered_bibs.append((str(node_id), str(bib)))
                                    if len(ordered_bibs) >= MAX_UPSTREAM_BIBS:
                                        break
                                if len(ordered_bibs) >= MAX_UPSTREAM_BIBS:
                                    break
                            if len(ordered_bibs) >= MAX_UPSTREAM_BIBS:
                                break
                        if len(ordered_bibs) >= MAX_UPSTREAM_BIBS:
                            ordered_bibs = ordered_bibs[:MAX_UPSTREAM_BIBS]
                        availability_map: dict[str, Any] = {}
                        if ordered_bibs:
                            provider = next(iter(ncip_info), "")
                            payload = await self._availability(
                                client,
                                page.settings,
                                detail=False,
                                node_id=",".join(node for node, _ in ordered_bibs),
                                provider=provider,
                                bib_ids=[bib for _, bib in ordered_bibs],
                            )
                            if isinstance(payload, dict):
                                availability_map = payload
                        bib_by_node_id = {node_id: bib for node_id, bib in ordered_bibs}
                        for index, node in enumerate(rows[:limit]):
                            path, *_ = _record_from_node(node)
                            row_input = node.select_one("input.num-checkbox[value]")
                            raw_attribute = row_input.get("value") if row_input else None
                            raw_value = raw_attribute if isinstance(raw_attribute, str) else ""
                            row_node_id = raw_value.split("|", 1)[0]
                            bib = bib_by_node_id.get(row_node_id)
                            if bib is None and index < len(ordered_bibs):
                                # The current OPAC emits rows and ncip_info in
                                # the same order. Keep that compatibility path
                                # only when the row carries no public node key;
                                # a mismatched explicit key must fail closed.
                                if row_node_id:
                                    raise OpacGatewayError("opac_contract_changed")
                                bib = ordered_bibs[index][1]
                            items.append(
                                self._record_from_search_node(
                                    node,
                                    availability_map.get(bib or "", {}),
                                )
                            )
                        result = LibraryCatalogSearchResult(status="known", query=normalized, items=items)
            except OpacGatewayError as error:
                result = LibraryCatalogSearchResult(status="unavailable", query=normalized, reason_code=error.reason_code)
            except ValueError:
                result = LibraryCatalogSearchResult(
                    status="unavailable",
                    query=normalized,
                    reason_code="opac_contract_changed",
                )
            if result.status == "known":
                self._cache.put(f"search:{key}", result)
            logger.info(
                "opac_search status=%s reason=%s item_count=%d elapsed_ms=%d",
                result.status,
                result.reason_code or "none",
                len(result.items),
                int((time.monotonic() - started) * 1000),
            )
            return result.model_copy(deep=True)

    async def _read_page_record(self, client: httpx.AsyncClient, page: _Page, path: str) -> LibraryBibliographicRecord:
        title, authors, isbn, year, _ = _record_from_detail(page.soup, path)
        xc = _settings_xc(page.settings)
        bibs = xc.get("ncip_bibs")
        provider = None
        bib_ids: list[str] = []
        if isinstance(bibs, dict):
            for key, value in bibs.items():
                provider = str(key)
                if isinstance(value, list):
                    bib_ids = [str(item) for item in value]
                elif isinstance(value, str):
                    bib_ids = [value]
                break
        elif isinstance(bibs, list):
            bib_ids = [str(item) for item in bibs]
        if not bib_ids:
            raise OpacGatewayError("opac_token_missing")
        availability = await self._availability(client, page.settings, detail=True, node_id=None, provider=provider, bib_ids=bib_ids)
        holdings = self._holdings_from_availability(availability)
        return LibraryBibliographicRecord(
            resource_ref=_resource_ref(path),
            title=title or "書誌情報",
            authors=authors,
            isbn=isbn,
            publication_year=year,
            campus="any",
            url=_canonical_url(path),
            holdings=holdings or [LibraryHoldingSummary(campus="unknown", status="unknown")],
        )

    async def read(self, *, resource_ref: str, presentation: str = "summary", records: list[ChatLibraryContextRecord]) -> LibraryItemReadResult:
        if presentation not in {"summary", "location"}:
            raise ValueError("Library item presentation must be summary or location.")
        if not _RESOURCE_REF.fullmatch(resource_ref):
            raise ValueError("Invalid library resource reference.")
        matching = next((record for record in records if record.resource_ref == resource_ref), None)
        if matching is None:
            return LibraryItemReadResult(status="unavailable", resource_ref=resource_ref, reason_code="resource_ref_mismatch")
        if not self.enabled:
            return LibraryItemReadResult(status="unavailable", resource_ref=resource_ref, reason_code="opac_disabled")
        path = urlparse(matching.record.url).path
        if not _RECORD_ID.fullmatch(path):
            raise OpacGatewayError("resource_ref_mismatch")
        if _resource_ref(path) != resource_ref:
            raise OpacGatewayError("resource_ref_mismatch")
        key = hashlib.sha256(f"{resource_ref}:{presentation}".encode()).hexdigest()
        cached = self._cache.get(f"detail:{key}", self.detail_ttl)
        if isinstance(cached, LibraryItemReadResult):
            return cached.model_copy(deep=True)
        started = time.monotonic()
        async with self._upstream_lock:
            await self._wait_turn()
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(20.0),
                    headers={"Accept": "text/html"},
                    max_redirects=3,
                ) as client:
                    page = await self._get_page(client, _canonical_url(path))
                    item = await self._read_page_record(client, page, path)
                    if not _record_matches(matching.record, item):
                        raise OpacGatewayError("resource_ref_mismatch")
                    result = LibraryItemReadResult(status="known", resource_ref=resource_ref, item=item)
            except OpacGatewayError as error:
                result = LibraryItemReadResult(status="unavailable", resource_ref=resource_ref, reason_code=error.reason_code)
            except ValueError:
                result = LibraryItemReadResult(
                    status="unavailable",
                    resource_ref=resource_ref,
                    reason_code="opac_contract_changed",
                )
            if result.status == "known":
                self._cache.put(f"detail:{key}", result)
            logger.info(
                "opac_read status=%s reason=%s item_count=%d elapsed_ms=%d",
                result.status,
                result.reason_code or "none",
                1 if result.item is not None else 0,
                int((time.monotonic() - started) * 1000),
            )
            return result.model_copy(deep=True)


_shared_gateway: OpacGateway | None = None
_shared_gateway_config: tuple[str, ...] | None = None


def get_shared_opac_gateway() -> OpacGateway:
    """Return the process-local gateway shared by routes and server tools.

    The configuration tuple allows isolated tests to change OPAC settings
    without retaining a gateway created under a previous environment. In a
    running Container App the tuple is stable, so all Agent runs share one
    upstream queue and bounded caches.
    """

    global _shared_gateway, _shared_gateway_config
    config = (
        os.getenv("ORBIT_OPAC_TRANSPORT", "off"),
        os.getenv("ORBIT_OPAC_BASE_URL", OPAC_ORIGIN),
        os.getenv("ORBIT_OPAC_MIN_INTERVAL_MS", "10000"),
        os.getenv("ORBIT_OPAC_SEARCH_CACHE_TTL_SECONDS", "300"),
        os.getenv("ORBIT_OPAC_DETAIL_CACHE_TTL_SECONDS", "30"),
    )
    if _shared_gateway is None or config != _shared_gateway_config:
        _shared_gateway = OpacGateway()
        _shared_gateway_config = config
    return _shared_gateway


__all__ = ["OpacGateway", "OpacGatewayError", "get_shared_opac_gateway"]
