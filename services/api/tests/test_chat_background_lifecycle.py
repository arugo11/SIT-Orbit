import asyncio
from unittest.mock import AsyncMock, Mock

import pytest
from orbit_api.agent import chat
from orbit_api.models import ChatRunRequest


async def test_abandoned_background_work_expires_without_status_polling(monkeypatch) -> None:
    monkeypatch.setattr(chat, "CHAT_RUN_TTL_SECONDS", 0.02)
    cancelled = asyncio.Event()

    async def never_finishes(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    service = chat.ChatRunService(backend_factory=Mock())
    monkeypatch.setattr(service, "_start_sync", AsyncMock(side_effect=never_finishes))
    started = await service.start(
        ChatRunRequest(
            conversation_id="background-expiry",
            message="Synthetic request",
            execution_mode="background",
        )
    )
    assert started.status == "background"
    run_id = started.run_id
    state = service._background[run_id]
    assert state.task is not None
    await asyncio.wait_for(state.task, timeout=1)

    assert cancelled.is_set()
    assert state.done
    assert state.wake.is_set()
    assert run_id not in service._background
    with pytest.raises(chat.ChatRunExpiredError):
        service.background_status(run_id)


async def test_clearing_background_work_wakes_open_event_stream(monkeypatch) -> None:
    entered = asyncio.Event()

    async def never_finishes(*args, **kwargs):
        entered.set()
        await asyncio.Event().wait()

    service = chat.ChatRunService(backend_factory=Mock())
    monkeypatch.setattr(service, "_start_sync", AsyncMock(side_effect=never_finishes))
    started = await service.start(
        ChatRunRequest(
            conversation_id="background-clear",
            message="Synthetic request",
            execution_mode="background",
        )
    )
    assert started.status == "background"
    state = service._background[started.run_id]
    await entered.wait()
    stream = service.background_events(started.run_id)
    waiting = asyncio.create_task(anext(stream, None))
    await asyncio.sleep(0)
    service.clear_background()

    assert await asyncio.wait_for(waiting, timeout=1) is None
    assert state.done
    assert state.error == "background_run_cancelled"


async def test_upstream_timeout_is_a_failure_before_the_run_deadline(monkeypatch) -> None:
    service = chat.ChatRunService(backend_factory=Mock())
    monkeypatch.setattr(service, "_start_sync", AsyncMock(side_effect=TimeoutError))
    started = await service.start(
        ChatRunRequest(
            conversation_id="background-upstream-timeout",
            message="Synthetic request",
            execution_mode="background",
        )
    )
    assert started.status == "background"
    state = service._background[started.run_id]
    assert state.task is not None
    await state.task

    with pytest.raises(RuntimeError, match="background_run_failed"):
        service.background_status(started.run_id)
