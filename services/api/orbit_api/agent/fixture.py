from orbit_api.models import ActionProposal, EvidenceLink, OrbitEvent

PROMPT_VERSION = "fixture-b1-omiya-v1"


class FixtureAgent:
    """Deterministic backend for local development and CI."""

    async def propose_action(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
    ) -> ActionProposal:
        if event.event_type != "campus_entered" or event.campus != "omiya":
            raise ValueError("The fixture backend currently supports only B1 Omiya campus entry.")

        return ActionProposal(
            action_id=f"act-{event.event_id}",
            title="次の授業までに合成関数の微分を2問確認する",
            reason=(
                "次の授業まで18分あり、明日の課題に必要な合成関数の微分で"
                "直近の誤答が記録されているためです。"
            ),
            duration_minutes=12,
            evidence=context,
            external_action="checklist_update",
            requires_confirmation=True,
            prompt_version=PROMPT_VERSION,
        )
