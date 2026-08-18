# SIT ORBIT実装計画

この文書は、SIT ORBITの開発を実装ブランチ単位へ分割し、各ブランチの責務と完了条件を定める。

設計の正本は[architecture.md](./architecture.md)と[data-policy.md](./data-policy.md)に置く。

実装Loopの状態、Agentの役割、失敗時の戻り先、PRとCIの扱いは
[implementation-loop.md](./implementation-loop.md)に置く。

## 実装方針

一つのブランチは、一つのユーザー体験が動く縦方向のまとまりとして扱う。

各ブランチは、外部APIを使わないfixtureまたは公開データで検証できる状態でPRを作成する。

現在のB1大宮fixtureとFastAPI閉ループを壊さないことを、すべてのブランチに共通する条件とする。

Agent Framework、Azureサービス、外部Connectorは、必要性が確認された段階で追加する。

## ブランチの依存関係

```text
codex/document-agent-architecture
        │
        ▼
codex/extension-shell
        │
        ▼
codex/scombz-context-adapter
        │
        ▼
codex/sidepanel-agent-loop
        │
        ▼
codex/google-calendar-readonly
        │
        ▼
codex/google-drive-picker
        │
        ▼
codex/azure-demo-runtime
        │
        ▼
codex/pydantic-ai-adapter（導入条件を満たした場合）
```

`codex/document-agent-architecture`は、設計文書を保存するための現在のブランチである。

次に作成する実装ブランチは`codex/extension-shell`とする。

## Branch 1：拡張機能の殻

### ブランチ

`codex/extension-shell`

### 目的

Chrome上でSIT ORBITのSide Panelを開き、ScombZページと拡張機能の通信経路を確立する。

### 実装範囲

- Manifest V3
- Chrome Side Panel
- Content Script
- Extension Service Worker
- ReactによるSide Panel画面
- ScombZ以外でのSide Panel無効化
- 現在ページのタイトル、URL、ページ種別の表示
- Fixtureを利用したローカル表示

### 実装しない範囲

- LLM API呼び出し
- ScombZの詳細解析
- Google OAuth
- Azure配置
- 外部サービスへの書き込み

### 完了条件

- ChromeのLoad unpackedで拡張機能を起動できる
- 拡張機能アイコンからSide Panelを開ける
- ScombZページでだけSide Panelが有効になる
- ページ遷移後もSide Panelが動作する
- APIなしでFixture画面が表示される

## Branch 2：ScombZコンテキストAdapter

### ブランチ

`codex/scombz-context-adapter`

### 目的

ScombZの表示情報を、Agentが扱えるページコンテキストへ変換する。

### 実装範囲

- ホーム画面の読み取り
- 課題、テスト、締切の読み取り
- お知らせの読み取り
- カレンダーとICSの読み取り
- 現在のコース情報
- ScombZから表示される関連リンク
- DOM構造をページコンテキストへ変換するAdapter
- ScombZのHTML fixture
- Vitestによる抽出テスト

### 完了条件

同じfixtureを与えた場合に、同じページコンテキストを生成できる。

このブランチではAgent APIを呼び出さない。

```text
ScombZ DOM
    ↓
ScombZAdapter
    ↓
PageContext
```

## Branch 3：Side Panel Agent閉ループ

### ブランチ

`codex/sidepanel-agent-loop`

### 目的

既存のFastAPI Agent APIとSide Panelを接続し、B1大宮シナリオを一つの流れとして動かす。

### 実装範囲

- OpenAPI生成クライアントの利用
- `OrbitEvent`の送信
- `EvidenceLink`の送信
- `ActionProposal`の表示
- 提案理由と根拠の表示
- 承認、変更、却下
- 完了結果の送信
- `action_completed`イベントの表示
- B1大宮fixtureによる閉ループテスト
- 必要なAgent境界のWeave trace

### 完了条件

```text
ScombZ fixture
    ↓
OrbitEvent
    ↓
ActionProposal
    ↓
Side Panelへ表示
    ↓
利用者が承認
    ↓
action_completed
```

このブランチを、最初の利用可能なSIT ORBITとする。

既存の`FixtureAgent`を標準Backendとし、通常開発で外部LLMを呼び出さない。

## Branch 4：Google Calendar読み取り

### ブランチ

`codex/google-calendar-readonly`

### 目的

学生の予定を読み取り、課題や授業前の提案に利用できるようにする。

### 実装範囲

- Google OAuth同意画面
- 必要最小限の読み取りスコープ
- 今日と直近の予定取得
- 利用可能時間の表示
- Connector接続状態
- 再認証と切断
- 合成アカウントまたはデモアカウントによるテスト

### 実装しない範囲

- 予定の自動作成
- 予定の変更、削除
- 全カレンダーの無差別取得
- OAuth tokenのFastAPI送信

### 完了条件

利用者が明示的に接続した場合だけ、カレンダーを読み取れる。

## Branch 5：Google Drive選択ファイル

### ブランチ

`codex/google-drive-picker`

### 目的

Google Drive全体ではなく、利用者が選択したファイルだけをEvidenceとして扱う。

### 実装範囲

- Google Drive OAuth
- ファイル選択
- 選択済みファイルの一覧
- 選択ファイルの読み取り
- Agent向けEvidenceLinkへの変換
- 選択解除
- 取得元と更新日時の表示

### 完了条件

利用者が選択していないDriveファイルを、Agentが参照できない。

CalendarとDriveは権限とデータ特性が異なるため、別ブランチに分ける。

## Branch 6：Azureデモランタイム

### ブランチ

`codex/azure-demo-runtime`

### 目的

Azure Student Offerを利用して、公開データと合成データだけでデモAPIを動かす。

### 実装範囲

- Azure Container AppsまたはStatic Web Appsへの配置設定
- FastAPI APIのデプロイ
- Azureモデル用Adapter
- モデル名とEndpointの環境変数化
- `/health`確認
- デモ用の公開、合成データ利用
- 予算と利用状況の確認手順
- scale-to-zeroまたは停止手順

### 推奨サービス

| 用途 | サービス |
| --- | --- |
| Web | Static Web Apps Free |
| API | Container Apps Consumption |
| 定期処理 | Azure Functions Timer |
| ファイル | Blob Storage |
| インフラログ | Application Insights |
| LLM | Azure AI FoundryまたはAzure OpenAI |

### 完了条件

- Azure上のAPIが起動する
- Fixtureまたは公開データで1回のデモが通る
- 開発時に外部APIを呼び出さない
- Azure Portalで利用額を確認できる
- デモ終了後に停止できる

Azure AI Searchは、このブランチの必須条件に含めない。

## Branch 7：PydanticAI Adapter

### ブランチ

`codex/pydantic-ai-adapter`

### 位置づけ

CalendarのDeferred Toolと構造化出力を導入する要件が成立したため、既存の`AgentBackend`境界を保ったままPydanticAIへ移行する。

### 実装範囲

- PydanticAIの依存追加
- `AgentBackend`内部の共有PydanticAI Agent
- `OpenAIResponsesModel`、OpenAI/Azure Provider、`openai_store=False`
- 内部`ActionDraft`とサーバー側のID/Evidence正規化
- `google_calendar_availability` v1のDeferred Tool
- 600秒TTLのプロセスメモリrun storeと再開API
- 厳格なdiscriminated API envelopeと最小Calendar availability schema
- Extensionの明示クリック、非対話refresh、Tool結果の再開表示

### 実装しない範囲

- APIモデルの全面置換
- マルチエージェント化
- LangGraphの同時導入
- Microsoft Agent Frameworkとの二重実装
- Google Drive Tool登録
- OAuth token、raw Calendar event、永続run store

## Branch 8：Azureモデル選定の比較評価

### ブランチ

`codex/model-selection-eval`

### 目的

Terra、Luna、Solなど、Azure側で明示したdeploymentを同じ16件の合成・公開ケースで比較し、通常デモのPrimary候補を実測で見直せるようにする。

### 暫定判断

実測前はAzure OpenAI GPT-5.6 TerraをPrimary、GPT-5.6 Solを品質重視デモ、GPT-5.6 Lunaを低コストchallenger候補とする。
この順位は確定モデルではなく、hard failure、token、latency、best-effort costの測定後に再評価する。

Gemini 3.7 Flash Paidは将来の他社challenger候補であり、このbranchではGoogle Adapter、依存、モデルルーターを追加しない。
比較する場合もsynthetic/public dataだけに限定する。

### 実装範囲

- `evals/model_selection_cases.jsonl`の16ケース
- `evals.run_model_selection`の明示的な`--role ROLE=DEPLOYMENT`入力
- 既存`AzureOpenAIAgent`とDeferred Calendar経路の再利用
- ケースごとのCalendar Tool挙動、Evidence、case-defined unsupported fact trap、confirmation、structured output、所要時間上限のhard failure分類
- PydanticAI usage callbackによるinput/output/cache tokenとbest-effort costの集計
- ケース・roleごとの提案本文を含むJSONレポートと非ゼロ終了
- hard failure 0を必要条件とした人手レビュー
- オフラインUnit Test

### 実装しない範囲

- 通常の`run_eval`やCIへのlive model追加
- LLM Judge、W&B評価、Leaderboard、総合スコア
- Gemini依存、Google Adapter、モデルルーター
- 実学生データ、実Calendar派生値、私的資料の送信

Azure Standard Globalの暫定単価は入力／出力100万tokenあたりTerra $2／$12、Luna $0.20／$1.20、Sol $5／$30とする。
Global deploymentは複数リージョンで処理され得るため、実データ利用時はdeployment typeとデータ処理条件を別途確認する。

参考：
[Microsoft FoundryのGPT-5.6発表](https://azure.microsoft.com/en-us/blog/gpt-5-6-now-available-in-microsoft-foundry/)、
[Azureのデータ処理方針](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy)、
[Google公式リリースノート](https://ai.google.dev/gemini-api/docs/changelog)、
[Gemini API料金表](https://ai.google.dev/gemini-api/docs/pricing)、
[PydanticAI Googleモデル](https://pydantic.dev/docs/ai/models/google/)。

## 将来ブランチ

次の機能は、現在のコンペMVPとは分離する。

- `codex/microsoft-graph-readonly`
- `codex/sit-portfolio-integration`
- `codex/azure-ai-search`
- `codex/foundry-hosted-agent`
- `codex/langgraph-approval-workflow`
- `codex/chrome-store-release`

これらは、正式API、大学の許可、実際の利用要件が確認されてから作成する。

## ブランチ運用

各ブランチは、次の条件を満たした時点でPRを作成する。

- 一つのユーザー体験を説明できる
- 既存のfixtureで検証できる
- 外部APIなしでテストできる
- 既存のMVPを壊さない
- 変更範囲をPR本文で説明できる

ブランチは長期間保持せず、PRをマージした後に次のブランチを`main`から作成する。

Branch 1〜6は、現在のMVPへ無条件に組み込む機能一覧ではなく、ユーザーが承認した段階的なroadmapである。

Google、Azureなどのprovider branchは、各段階で現在の要件、利用者の同意、外部サービスの権限を確認する。

条件を満たせない場合は、fixtureによる成功を実連携成功と扱わず、当該branchを`BLOCKED`として停止する。

通常開発では、次のコマンドを最小確認として利用する。

```bash
uv run pytest
pnpm test
pnpm typecheck
pnpm build
```

外部API、Azureリソース、W&B認証が必要な確認は、通常のCIから分離する。

## 初期版で作らないもの

- Graph Database
- Message Broker
- マルチエージェント
- 全Webサイトを対象とするBrowser Agent
- 独自Policy Engine
- 常時位置情報の保存
- Cookieや認証情報の収集
- 無許可のScombZ API利用
- SIT PortfolioやCASTへの無許可書き込み
- 課題提出、メール送信、成績変更の自動実行

これらは、B1大宮シナリオを成立させるための依存ではない。

必要性が実際に発生した段階で、個別の設計判断として追加する。
