"""Process-memory action proposal lifecycle.

The MVP keeps action proposals and their completion receipts in the API
process.  The store is intentionally small and short lived: it is a
coordination boundary for the proposal/approval/completion request pair, not
durable student history or an external action provider.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime

from orbit_api.models import ActionProposal, OrbitEvent, VerifyActionRequest

ACTION_TTL_SECONDS = 24 * 60 * 60
ACTION_MAX_RECORDS = 256


class UnknownActionError(LookupError):
    """Raised when an action ID was never registered in this process."""


class ExpiredActionError(LookupError):
    """Raised when an action was registered but its short-lived record expired."""


class ActionConflictError(ValueError):
    """Raised when a request does not match the stored action context."""


class ActionAlreadyCompletedError(ActionConflictError):
    """Raised when a completed action is retried with a changed request."""


class ActionUnavailableError(ValueError):
    """Raised when completion would claim an unavailable provider-side write."""


@dataclass(frozen=True)
class StoredAction:
    action_id: str
    proposal: ActionProposal
    source_event: OrbitEvent
    expires_at: float
    verification: VerifyActionRequest | None = None
    completion: OrbitEvent | None = None


class ActionStore:
    """Bounded, process-local store for proposed actions and receipts.

    A completion receipt remains in the store for the same TTL as its
    proposal, allowing an exact client retry to receive the original event.
    Records are copied at the boundary so a caller cannot mutate the receipt
    or its source evidence after registration.
    """

    def __init__(
        self,
        *,
        ttl_seconds: int = ACTION_TTL_SECONDS,
        max_records: int = ACTION_MAX_RECORDS,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("Action store TTL must be positive.")
        if max_records <= 0:
            raise ValueError("Action store capacity must be positive.")
        self.ttl_seconds = ttl_seconds
        self.max_records = max_records
        self._clock = clock or time.monotonic
        self._active: OrderedDict[str, StoredAction] = OrderedDict()
        self._closed: OrderedDict[str, tuple[str, float]] = OrderedDict()
        self._lock = threading.Lock()

    def _remember_closed_locked(self, action_id: str, reason: str, now: float) -> None:
        self._closed.pop(action_id, None)
        self._closed[action_id] = (reason, now)
        while len(self._closed) > self.max_records:
            self._closed.popitem(last=False)

    def _cleanup_locked(self) -> None:
        now = self._clock()
        for action_id, record in list(self._active.items()):
            if record.expires_at <= now:
                del self._active[action_id]
                self._remember_closed_locked(action_id, "expired", now)
        for action_id, (_, closed_at) in list(self._closed.items()):
            if closed_at + self.ttl_seconds <= now:
                del self._closed[action_id]

    def _raise_missing_locked(self, action_id: str) -> None:
        closed = self._closed.get(action_id)
        if closed is not None and closed[0] == "expired":
            raise ExpiredActionError(action_id)
        raise UnknownActionError(action_id)

    def _get_locked(self, action_id: str) -> StoredAction:
        record = self._active.get(action_id)
        if record is None:
            self._raise_missing_locked(action_id)
            raise AssertionError("unreachable")
        return record

    @staticmethod
    def _copy_record(record: StoredAction) -> StoredAction:
        return StoredAction(
            action_id=record.action_id,
            proposal=record.proposal.model_copy(deep=True),
            source_event=record.source_event.model_copy(deep=True),
            expires_at=record.expires_at,
            verification=(
                record.verification.model_copy(deep=True)
                if record.verification is not None
                else None
            ),
            completion=(
                record.completion.model_copy(deep=True) if record.completion is not None else None
            ),
        )

    def register(self, proposal: ActionProposal, source_event: OrbitEvent) -> ActionProposal:
        """Register a proposal, preserving an identical prior registration.

        Providers may be retried for the same source event.  Re-registering
        the same action and source is therefore idempotent; reusing an action
        ID for different content fails closed instead of replacing evidence.
        """

        proposal_snapshot = proposal.model_copy(deep=True)
        event_snapshot = source_event.model_copy(deep=True)
        now = self._clock()
        with self._lock:
            self._cleanup_locked()
            existing = self._active.get(proposal.action_id)
            if existing is not None:
                if (
                    existing.proposal != proposal_snapshot
                    or existing.source_event != event_snapshot
                ):
                    raise ActionConflictError("The action ID is already bound to another proposal.")
                return existing.proposal.model_copy(deep=True)
            while len(self._active) >= self.max_records:
                evicted_id, _ = self._active.popitem(last=False)
                self._remember_closed_locked(evicted_id, "evicted", now)
            self._closed.pop(proposal.action_id, None)
            self._active[proposal.action_id] = StoredAction(
                action_id=proposal.action_id,
                proposal=proposal_snapshot,
                source_event=event_snapshot,
                expires_at=now + self.ttl_seconds,
            )
        return proposal_snapshot.model_copy(deep=True)

    def get(self, action_id: str) -> StoredAction:
        """Return a defensive snapshot for diagnostics and tests."""

        with self._lock:
            self._cleanup_locked()
            return self._copy_record(self._get_locked(action_id))

    @staticmethod
    def _verification_matches(
        left: VerifyActionRequest,
        right: VerifyActionRequest,
    ) -> bool:
        return (
            left.scenario_id == right.scenario_id
            and left.campus == right.campus
            and left.approved == right.approved
            and left.completed == right.completed
            and left.notes == right.notes
        )

    def complete(self, action_id: str, verification: VerifyActionRequest) -> OrbitEvent:
        """Record a local completion and make exact retries idempotent."""

        verification_snapshot = verification.model_copy(deep=True)
        with self._lock:
            self._cleanup_locked()
            record = self._get_locked(action_id)
            if record.completion is not None and record.verification is not None:
                if self._verification_matches(record.verification, verification_snapshot):
                    return record.completion.model_copy(deep=True)
                raise ActionAlreadyCompletedError(
                    "The action was already completed with different approval details."
                )

            if verification.scenario_id != record.source_event.scenario_id:
                raise ActionConflictError("The verification scenario does not match the action.")
            if verification.campus != record.source_event.campus:
                raise ActionConflictError("The verification campus does not match the action.")
            if not verification.approved:
                raise ValueError("An action cannot be completed without explicit approval.")
            if not verification.completed:
                raise ValueError("Only completed actions can produce a completion event.")
            if record.proposal.external_action == "library_write":
                raise ActionUnavailableError(
                    "Library writes require provider read-back before completion can be recorded."
                )

            completion = OrbitEvent(
                event_type="action_completed",
                scenario_id=record.source_event.scenario_id,
                occurred_at=datetime.now(UTC),
                campus=record.source_event.campus,
                data_classification=record.source_event.data_classification,
                payload={
                    "action_id": action_id,
                    "approved": True,
                    "completed": True,
                    "notes": verification.notes,
                    "evidence_ids": [item.evidence_id for item in record.proposal.evidence],
                    "source_event_id": record.source_event.event_id,
                },
            )
            self._active[action_id] = replace(
                record,
                verification=verification_snapshot,
                completion=completion,
            )
            return completion.model_copy(deep=True)

    def clear(self) -> None:
        """Clear process-local action state at app/test lifecycle boundaries."""

        with self._lock:
            self._active.clear()
            self._closed.clear()

    def __len__(self) -> int:
        with self._lock:
            self._cleanup_locked()
            return len(self._active)


__all__ = [
    "ACTION_MAX_RECORDS",
    "ACTION_TTL_SECONDS",
    "ActionAlreadyCompletedError",
    "ActionConflictError",
    "ActionStore",
    "ActionUnavailableError",
    "ExpiredActionError",
    "StoredAction",
    "UnknownActionError",
]
