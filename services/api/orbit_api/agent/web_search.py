"""Azure-native public web search boundary for Chat.

Only the validated query is sent to the search run.  Conversation history and
campus-tool results remain in the parent Chat run.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic_ai import Agent
from pydantic_ai.capabilities import NativeTool
from pydantic_ai.messages import NativeToolReturnPart, TextPart
from pydantic_ai.models.openai import OpenAIResponsesModel, OpenAIResponsesModelSettings
from pydantic_ai.native_tools import WebSearchTool

_EMAIL_PATTERN = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_STUDENT_ID_PATTERN = re.compile(r"(?<![A-Z0-9])[A-Z]{2}\d{5}(?![A-Z0-9])", re.IGNORECASE)
_SECRET_PATTERN = re.compile(
    r"(?:oauth|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|bearer)\s*[:=]?\s*\S+",
    re.IGNORECASE,
)
_OPAQUE_LOCATOR_PATTERN = re.compile(r"\borbit-[a-z0-9-]+://", re.IGNORECASE)
_PRIVATE_SIT_HOSTS = frozenset(
    {
        "scombz.shibaura-it.ac.jp",
        "sitrus.sic.shibaura-it.ac.jp",
        "moodle.sic.shibaura-it.ac.jp",
        "library.shibaura-it.ac.jp",
        "shibaura.pita.services",
    }
)
_TRACKING_PARAMETERS = frozenset(
    {"fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src"}
)


class WebSearchUnavailableError(RuntimeError):
    """Raised when Azure does not return a usable grounded search result."""


@dataclass(frozen=True)
class WebSearchSource:
    title: str
    url: str


@dataclass(frozen=True)
class WebSearchResponse:
    query: str
    summary: str
    sources: tuple[WebSearchSource, ...]


class WebSearchExecutor(Protocol):
    async def search(self, query: str) -> WebSearchResponse: ...


def validate_public_search_query(query: str) -> str:
    normalized = " ".join(query.split())
    if not 1 <= len(normalized) <= 200:
        raise ValueError("一般Web検索の検索語は1〜200文字で指定してください。")
    if _EMAIL_PATTERN.search(normalized):
        raise ValueError("メールアドレスを一般Web検索へ送ることはできません。")
    if _STUDENT_ID_PATTERN.search(normalized):
        raise ValueError("学籍番号を一般Web検索へ送ることはできません。")
    if _SECRET_PATTERN.search(normalized) or _OPAQUE_LOCATOR_PATTERN.search(normalized):
        raise ValueError("認証情報や内部locatorを一般Web検索へ送ることはできません。")
    lowered = normalized.lower()
    if any(host in lowered for host in _PRIVATE_SIT_HOSTS):
        raise ValueError("学内限定サービスのURLを一般Web検索へ送ることはできません。")
    return normalized


def normalize_public_source_url(raw_url: str) -> str | None:
    try:
        parsed = urlsplit(raw_url)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname in _PRIVATE_SIT_HOSTS:
        return None
    if hostname == "localhost" or hostname.endswith(".localhost"):
        return None
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return None
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in _TRACKING_PARAMETERS
    ]
    try:
        port = parsed.port
    except ValueError:
        return None
    netloc = hostname
    if port is not None:
        netloc = f"{hostname}:{port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path or "/", urlencode(query), ""))


def _candidate_sources(messages: list[Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for message in messages:
        for part in getattr(message, "parts", []):
            if isinstance(part, NativeToolReturnPart) and part.tool_name == "web_search":
                content = part.content
                if isinstance(content, dict) and isinstance(content.get("sources"), list):
                    candidates.extend(item for item in content["sources"] if isinstance(item, dict))
            if isinstance(part, TextPart):
                annotations = (part.provider_details or {}).get("annotations")
                if isinstance(annotations, list):
                    candidates.extend(item for item in annotations if isinstance(item, dict))
    return candidates


def _normalize_sources(messages: list[Any]) -> tuple[WebSearchSource, ...]:
    sources: list[WebSearchSource] = []
    seen_urls: set[str] = set()
    for candidate in _candidate_sources(messages):
        citation = candidate.get("url_citation")
        if isinstance(citation, dict):
            candidate = citation
        raw_url = candidate.get("url")
        if not isinstance(raw_url, str):
            continue
        url = normalize_public_source_url(raw_url)
        if url is None or url in seen_urls:
            continue
        title = candidate.get("title")
        sources.append(
            WebSearchSource(
                title=title.strip()[:300] if isinstance(title, str) and title.strip() else url,
                url=url,
            )
        )
        seen_urls.add(url)
        if len(sources) == 10:
            break
    return tuple(sources)


class AzureNativeWebSearchExecutor:
    """Run one query-only Azure Responses request with native web search."""

    def __init__(self, model: OpenAIResponsesModel) -> None:
        self.model = model

    async def search(self, query: str) -> WebSearchResponse:
        validated_query = validate_public_search_query(query)
        model_settings: OpenAIResponsesModelSettings = {
            "openai_store": False,
            "openai_include_web_search_sources": True,
            "openai_include_raw_annotations": True,
        }
        agent: Agent[None, str] = Agent(
            self.model,
            output_type=str,
            instructions=(
                "Search the public web for the supplied query. Return a concise Japanese "
                "summary grounded only in the search results. Do not infer private facts."
            ),
            capabilities=[
                NativeTool(
                    WebSearchTool(
                        search_context_size="medium",
                        user_location={"country": "JP"},
                        external_web_access=False,
                    )
                )
            ],
            model_settings=model_settings,
        )
        try:
            result = await agent.run(validated_query)
        except Exception as error:
            raise WebSearchUnavailableError(
                "Azureの一般Web検索を実行できませんでした。検索設定と課金状態を確認してください。"
            ) from error
        summary = result.output.strip()
        sources = _normalize_sources(result.all_messages())
        if not summary or not sources:
            raise WebSearchUnavailableError(
                "Azureの一般Web検索から引用可能な結果を取得できませんでした。"
            )
        return WebSearchResponse(query=validated_query, summary=summary, sources=sources)


__all__ = [
    "AzureNativeWebSearchExecutor",
    "WebSearchExecutor",
    "WebSearchResponse",
    "WebSearchSource",
    "WebSearchUnavailableError",
    "normalize_public_source_url",
    "validate_public_search_query",
]
