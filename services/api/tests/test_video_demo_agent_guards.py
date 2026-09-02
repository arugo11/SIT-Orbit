from __future__ import annotations

import pytest
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.models import ChatHistoryMessage, EvidenceLink
from pydantic_ai import ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel


def _backend() -> OpenAIAgent:
    return OpenAIAgent(api_key="synthetic-key", model="synthetic-model")


def _chat_model() -> TestModel:
    return TestModel(
        call_tools=[],
        custom_output_args={
            "content_markdown": "確認しました。",
            "evidence_ids": [],
        }
    )


@pytest.mark.asyncio
async def test_capability_question_has_no_client_or_internal_public_tools(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    backend = _backend()
    model = _chat_model()
    backend.model = model  # type: ignore[assignment]
    backend.web_search_executor = object()  # type: ignore[assignment]
    backend.book_discovery_executor = object()  # type: ignore[assignment]

    result = await backend.start_chat(
        conversation_id="video-capabilities",
        message="何ができるの？",
        history=[],
        advertised_tools={"scombz_course_list", "cast_search"},
    )

    assert result.draft is not None
    assert model.last_model_request_parameters is not None
    assert model.last_model_request_parameters.declared_function_tools == []


@pytest.mark.asyncio
async def test_book_recommendation_exposes_public_search_and_discovery(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    backend = _backend()
    model = _chat_model()
    backend.model = model  # type: ignore[assignment]
    backend.web_search_executor = object()  # type: ignore[assignment]
    backend.book_discovery_executor = object()  # type: ignore[assignment]

    result = await backend.start_chat(
        conversation_id="video-book-recommendation",
        message="理解の助けになる入門書を、3冊候補にして。",
        history=[],
        advertised_tools=set(),
    )

    assert result.draft is not None
    assert model.last_model_request_parameters is not None
    names = {
        tool.name for tool in model.last_model_request_parameters.declared_function_tools
    }
    assert names == {"general_web_search", "related_book_discovery"}


@pytest.mark.asyncio
async def test_existing_three_books_holding_check_does_not_rediscover_books(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    backend = _backend()
    model = _chat_model()
    backend.model = model  # type: ignore[assignment]
    backend.web_search_executor = object()  # type: ignore[assignment]
    backend.book_discovery_executor = object()  # type: ignore[assignment]

    result = await backend.start_chat(
        conversation_id="video-library-check",
        message="その3冊、芝浦で今借りられる？",
        history=[],
        advertised_tools={"library_catalog_search", "library_item_read"},
    )

    assert result.draft is not None
    assert model.last_model_request_parameters is not None
    names = {
        tool.name for tool in model.last_model_request_parameters.declared_function_tools
    }
    assert names == {"library_catalog_search", "library_item_read"}


@pytest.mark.asyncio
async def test_fresh_course_and_syllabus_reads_fail_closed_before_discovery(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    course_tools: list[str] = []

    def course_first(_: list, info: AgentInfo) -> ModelResponse:
        course_tools.extend(tool.name for tool in info.function_tools)
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "scombz_course_read",
                    {"course_refs": ["orbit-scombz://course/not-yet-known"]},
                    tool_call_id="course-read-first",
                )
            ]
        )

    course_backend = _backend()
    course_backend.model = FunctionModel(course_first, model_name="course-order")  # type: ignore[assignment]
    with pytest.raises(RuntimeError, match="(?:not advertised|exceeded max retries)"):
        await course_backend.start_chat(
            conversation_id="video-course-order",
            message="人工知能の授業では、どんなことを学ぶの？",
            history=[],
            advertised_tools={"scombz_course_list", "scombz_course_read"},
        )
    assert course_tools
    assert set(course_tools) == {"scombz_course_list"}

    syllabus_tools: list[str] = []

    def syllabus_first(_: list, info: AgentInfo) -> ModelResponse:
        syllabus_tools.extend(tool.name for tool in info.function_tools)
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "syllabus_read",
                    {"syllabus_ref": "orbit-syllabus://not-yet-known"},
                    tool_call_id="syllabus-read-first",
                )
            ]
        )

    syllabus_backend = _backend()
    syllabus_backend.model = FunctionModel(  # type: ignore[assignment]
        syllabus_first, model_name="syllabus-order"
    )
    with pytest.raises(RuntimeError, match="(?:not advertised|exceeded max retries)"):
        await syllabus_backend.start_chat(
            conversation_id="video-syllabus-order",
            message="強化学習はどのあたり？ 授業全体での位置づけも知りたい。",
            history=[],
            advertised_tools={"syllabus_search", "syllabus_read"},
        )
    assert syllabus_tools
    assert set(syllabus_tools) == {"syllabus_search"}


@pytest.mark.asyncio
async def test_stale_other_course_evidence_does_not_waive_fresh_discovery(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    stale_context = [
        EvidenceLink(
            evidence_id="scombz-course-list-v1-staleothercourse0001",
            title="別科目の過去Evidence",
            source_type="scombz",
            locator="orbit-scombz://read/staleothercourse0001",
            data_classification="personal",
        ),
        EvidenceLink(
            evidence_id="syllabus-search-v1-staleothercourse0001",
            title="別科目の過去シラバスEvidence",
            source_type="syllabus",
            locator="orbit-syllabus://search/staleothercourse0001",
            data_classification="public",
        ),
    ]

    course_backend = _backend()
    course_model = _chat_model()
    course_backend.model = course_model  # type: ignore[assignment]
    course_result = await course_backend.start_chat(
        conversation_id="video-stale-course",
        message="人工知能の授業では、どんなことを学ぶの？",
        history=[],
        context=stale_context,
        advertised_tools={"scombz_course_list", "scombz_course_read"},
    )
    assert course_result.draft is not None
    assert course_model.last_model_request_parameters is not None
    assert {
        tool.name
        for tool in course_model.last_model_request_parameters.declared_function_tools
    } == {"scombz_course_list"}

    syllabus_backend = _backend()
    syllabus_model = _chat_model()
    syllabus_backend.model = syllabus_model  # type: ignore[assignment]
    syllabus_result = await syllabus_backend.start_chat(
        conversation_id="video-stale-syllabus",
        message="強化学習はどのあたり？ 授業全体での位置づけも知りたい。",
        history=[],
        context=stale_context,
        advertised_tools={"syllabus_search", "syllabus_read"},
    )
    assert syllabus_result.draft is not None
    assert syllabus_model.last_model_request_parameters is not None
    assert {
        tool.name
        for tool in syllabus_model.last_model_request_parameters.declared_function_tools
    } == {"syllabus_search"}


@pytest.mark.asyncio
async def test_natural_current_work_experience_requires_internship_search(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")

    def model_function(_: list, __: AgentInfo) -> ModelResponse:
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "cast_search",
                    {
                        "kind": "internship",
                        "filters": {"include_closed": False},
                        "sort": None,
                        "cursor": None,
                        "exhaustive": False,
                    },
                    tool_call_id="internship-search",
                )
            ]
        )

    backend = _backend()
    backend.model = FunctionModel(model_function, model_name="cast-intent")  # type: ignore[assignment]
    result = await backend.start_chat(
        conversation_id="video-cast-natural-language",
        message="それを仕事として体験するなら、今参加できるものはある？",
        history=[
            ChatHistoryMessage(role="user", content="強化学習のシラバスを確認して")
        ],
        advertised_tools={"cast_search"},
    )

    assert result.deferred is not None
    assert result.deferred.tool_name == "cast_search"
    assert result.deferred.arguments["kind"] == "internship"
    assert result.deferred.arguments["filters"]["include_closed"] is False
