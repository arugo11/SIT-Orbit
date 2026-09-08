from __future__ import annotations

import pytest
from orbit_api.agent.chat import ChatRunService, ChatRunStore, FixtureChatBackend
from orbit_api.agent.pydantic_ai_backend import (
    CAST_SEARCH_TOOL_NAME,
    CAST_TOOL_NAME,
    DeferredChatRun,
)
from orbit_api.models import (
    CastSearchAppliedFilters,
    CastSearchCoverage,
    CastSearchResult,
    ChatClientTool,
    ChatHistoryMessage,
    ChatRunCompleted,
    ChatRunRequest,
    ChatToolResultRequest,
    EvidenceLink,
)
from pydantic import ValidationError


def _evidence() -> EvidenceLink:
    return EvidenceLink(
        evidence_id="synthetic-evidence",
        title="合成根拠",
        source_type="assignment",
        locator="demo://assignment/1",
        data_classification="synthetic",
    )


@pytest.mark.asyncio
async def test_fixture_chat_never_selects_tools_from_natural_language() -> None:
    service = ChatRunService(backend_factory=FixtureChatBackend)
    for message in (
        "去年の情報工学科で卒業した人の就職先",
        "それを仕事として体験するなら今参加できるもの",
        "CASTとの連携機能では何ができる？",
        "ロボットの本を探して",
        "未知の言い換え入力",
    ):
        response = await service.start(
            ChatRunRequest(
                conversation_id=f"fixture-{len(message)}",
                message=message,
                history=[],
                client_tools=[
                    ChatClientTool(name=CAST_SEARCH_TOOL_NAME, version=1),
                    ChatClientTool(name=CAST_TOOL_NAME, version=1),
                ],
            )
        )
        assert isinstance(response, ChatRunCompleted)
        assert response.message.content_markdown == FixtureChatBackend._MESSAGE
        assert response.message.evidence == []


@pytest.mark.asyncio
async def test_fixture_resume_is_explicitly_unavailable() -> None:
    backend = FixtureChatBackend()
    deferred = DeferredChatRun(
        messages=[],
        tool_call_id="call-1",
        conversation_id="fixture-resume",
        tool_name=CAST_SEARCH_TOOL_NAME,
    )
    with pytest.raises(ValueError, match="fixtureでは一般的なTool選択"):
        await backend.resume_chat(
            deferred=deferred,
            tool_result=object(),
            context=[],
            advertised_tools={CAST_SEARCH_TOOL_NAME},
        )


def test_chat_run_store_preserves_native_tool_search_state() -> None:
    store = ChatRunStore()
    deferred = DeferredChatRun(
        messages=[],
        tool_call_id="cast-search-1",
        conversation_id="native-state",
        tool_name=CAST_SEARCH_TOOL_NAME,
        selected_client_tools=frozenset({CAST_SEARCH_TOOL_NAME, CAST_TOOL_NAME}),
        eligible_catalog_snapshot=(CAST_TOOL_NAME, CAST_SEARCH_TOOL_NAME),
        discovered_tool_names=frozenset({CAST_SEARCH_TOOL_NAME}),
        unused_search_tools=frozenset({CAST_TOOL_NAME}),
        tool_call_fingerprints=frozenset({"fingerprint-1"}),
    )
    run_id = store.put(
        backend_name="azure_openai",
        conversation_id="native-state",
        deferred=deferred,
        context=[_evidence()],
        advertised_tools=[
            ChatClientTool(name=CAST_SEARCH_TOOL_NAME, version=1),
            ChatClientTool(name=CAST_TOOL_NAME, version=1),
        ],
    )
    claimed = store.claim(
        run_id,
        tool_call_id="cast-search-1",
        tool_name=CAST_SEARCH_TOOL_NAME,
        tool_version=1,
    )
    next_deferred = DeferredChatRun(
        messages=[],
        tool_call_id="cast-read-1",
        conversation_id="native-state",
        tool_name=CAST_TOOL_NAME,
        selected_client_tools=deferred.selected_client_tools,
        eligible_catalog_snapshot=deferred.eligible_catalog_snapshot,
        discovered_tool_names=frozenset({CAST_SEARCH_TOOL_NAME, CAST_TOOL_NAME}),
        unused_search_tools=frozenset(),
        tool_call_fingerprints=frozenset({"fingerprint-1", "fingerprint-2"}),
        tool_call_count=2,
    )
    store.continue_run(
        run_id,
        deferred=next_deferred,
        context=claimed.context,
        generation=claimed.generation,
        claimed_call_id=claimed.deferred.tool_call_id,
    )
    saved = store.peek(run_id)
    assert saved.deferred.eligible_catalog_snapshot == deferred.eligible_catalog_snapshot
    assert saved.deferred.discovered_tool_names == {
        CAST_SEARCH_TOOL_NAME,
        CAST_TOOL_NAME,
    }
    assert saved.deferred.unused_search_tools == frozenset()
    assert saved.deferred.tool_call_fingerprints == {
        "fingerprint-1",
        "fingerprint-2",
    }


def test_chat_run_store_rejects_deferred_tool_outside_snapshot() -> None:
    store = ChatRunStore()
    deferred = DeferredChatRun(
        messages=[],
        tool_call_id="unknown-1",
        conversation_id="native-invalid",
        tool_name=CAST_SEARCH_TOOL_NAME,
        eligible_catalog_snapshot=(CAST_TOOL_NAME,),
        discovered_tool_names=frozenset({CAST_SEARCH_TOOL_NAME}),
    )
    with pytest.raises(ValueError, match="outside the eligible catalog"):
        store.put(
            backend_name="azure_openai",
            conversation_id="native-invalid",
            deferred=deferred,
            context=[],
            advertised_tools=[ChatClientTool(name=CAST_SEARCH_TOOL_NAME, version=1)],
        )


def test_chat_public_contract_rejects_removed_openai_backend() -> None:
    with pytest.raises(ValidationError):
        ChatRunRequest(
            conversation_id="removed-openai",
            message="質問",
            history=[ChatHistoryMessage(role="user", content="質問")],
            client_tools=[],
            backend="openai",  # type: ignore[call-arg]
        )


def test_chat_tool_result_request_still_keeps_public_shape() -> None:
    request = ChatToolResultRequest(
        tool_call_id="cast-1",
        name=CAST_SEARCH_TOOL_NAME,
        version=1,
        result=CastSearchResult(
            status="known",
            applied_filters=CastSearchAppliedFilters(kind="hiring_record", filters={}),
            total_count=0,
            returned_count=0,
            anonymous_aggregates=[],
            evidence_ids=[],
            reason_code=None,
            coverage=CastSearchCoverage(mode="complete", page_size=20, fetched_pages=1),
        ),
    )
    assert request.name == CAST_SEARCH_TOOL_NAME
