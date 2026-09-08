from typing import Any, cast

import pytest
from orbit_api.agent.pydantic_ai_backend import BROWSER_READ_TOOL_NAME
from orbit_api.agent.tool_catalog import TOOL_SPEC_BY_NAME
from orbit_api.models import BrowserReadResult, ChatToolResultRequest
from pydantic import ValidationError


def test_browser_result_rejects_raw_markup_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        BrowserReadResult(
            status="known",
            url="https://example.com",
            text="<script>alert(1)</script>",
        )
    with pytest.raises(ValidationError):
        ChatToolResultRequest(
            tool_call_id="call-1",
            name=BROWSER_READ_TOOL_NAME,
            version=1,
            result=cast(
                Any,
                {
                    "status": "known",
                    "url": "https://example.com",
                    "text": "safe",
                    "unknown": "must-reject",
                },
            ),
        )
    with pytest.raises(ValidationError):
        BrowserReadResult(
            status="known",
            url="javascript:alert(1)",
            text="safe",
        )
    with pytest.raises(ValidationError):
        BrowserReadResult(
            status="known",
            url="https://example.com",
            text="safe",
            links=cast(Any, [{"label": "unsafe", "url": "javascript:alert(1)"}]),
        )


def test_browser_tool_catalog_is_deferred_and_describes_safe_scope() -> None:
    spec = TOOL_SPEC_BY_NAME[BROWSER_READ_TOOL_NAME]
    assert spec.executor == "client"
    assert spec.read_only is True
    assert "許可" in spec.model_description
