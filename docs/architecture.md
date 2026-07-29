# Architecture

## Foundation architecture

```text
Next.js Web ─┐
             ├── FastAPI ── AgentService ── FixtureAgent
Expo Mobile ─┘                         └── OpenAIAgent (demo only)
                   │
                   └── W&B Weave (optional, synthetic/public only)
```

Agentの正本はPython側に置く。

WebとMobileはFastAPIのOpenAPIから生成したTypeScript型を共有する。

## Domain models

### OrbitEvent

現実またはデモで発生した出来事を表す。

初期版では`campus_entered`と`action_completed`だけを扱う。

### EvidenceLink

提案に利用した情報の識別子、名称、種類、参照先を表す。

初期版は資料本文を保持せず、参照関係だけを扱う。

### ActionProposal

行動、理由、所要時間、証跡、外部操作、承認要否を表す。

外部操作を含む場合、`requires_confirmation`は必ず`true`となる。

## Agent backends

`FixtureAgent`は決定的であり、通常開発とCIで利用する。

`OpenAIAgent`はResponses APIとPydantic Structured Outputsを使うデモ専用Adapterである。

APIキーやモデルが設定されていない場合は明示的に失敗し、Fixtureへfallbackしない。

## Observability

W&B Weaveでは、次の粗い境界だけをtrace化する。

- `agent.select_context`
- `agent.propose_action`
- `agent.verify_result`

内部の小関数をすべてtrace化しない。

Weaveへ記録する入力と出力はpostprocessorで縮約し、イベントpayloadや自由記述をそのまま記録しない。

## Deferred decisions

永続Database、Google連携、図書館連携、Learner Twin、Knowledge Tracing、Evidence Graphは、それぞれのvertical sliceを実装するときに選定する。
