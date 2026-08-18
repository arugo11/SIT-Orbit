# SIT ORBITのアーキテクチャ

この文書は、SIT ORBITをScombZ上のChrome拡張機能から利用する構成と、AgentをAzureへ段階的に配置する方針を記録する。

調査時点は2026年8月14日である。

実装ブランチの順序と完了条件は[implementation-plan.md](./implementation-plan.md)に記録する。

ScombZ、SIT Portfolio、CAST、OPACなどの正式な連携は、大学の許可と仕様確認が完了するまで実装済みとは扱わない。

## 設計判断

SIT ORBITは、Chromeの標準Side Panelを入口にし、Agentの実行は既存のFastAPI境界の内側に置く。

この文書には次の開発スライスの設計を含めるが、現時点のリリース判定は既存のB1大宮fixtureとFastAPI閉ループで行う。

現在の実装では、独自のマルチエージェント基盤を追加せず、`AgentBackend`と決定的なFixtureAgentを使う。

Chatの複数ターン、構造化出力、線形なDeferred Tool再開が要件になったため、PydanticAIを`AgentBackend`の内側へ導入した。PydanticAIのmessage履歴は公開APIへ出さず、Tool待ちの短命runだけをAPIプロセス内に保持する。

Azureで長期セッションや管理されたAgentランタイムが必要になった場合は、Microsoft Agent FrameworkとMicrosoft Foundryを評価する。

この順序は、アプリケーションのデータ契約とAgentの判断を、特定のモデルやホスティングサービスから分離するためである。

## 全体構成

```text
ScombZページ
    │
    ▼
Content Script
    │  現在ページの表示内容を読み取る
    │  chrome.runtimeでメッセージを送る
    ▼
Extension Service Worker
    │  タブごとの有効化、キャッシュ、メッセージ routing
    ├──────────────┐
    ▼              ▼
Chrome UI           FastAPI Agent API
（Side Panel / 全画面タブ）
    │                    │
    │                    ├── FixtureAgent
    │                    ├── OpenAIAgent
    │                    ├── AzureOpenAIAgent（明示設定時のみ）
    │                    └── PydanticAI（導入条件を満たした後）
    │
    └── 利用者の承認
             │
             ▼
       完了イベントの記録
```

WebとMobileは既存のFastAPI OpenAPIから生成したTypeScript型を利用する。

Extensionは、ページから収集した情報をそのままAgentへ渡さず、最小限のページコンテキストへ変換する。

## Chrome拡張機能

### Side Panel

Chromeの`chrome.sidePanel` APIは、Webページの横に拡張機能のUIを表示し、タブ移動時にもパネルを維持できる。

特定サイトだけで有効にする場合は、`sidePanel.setOptions()`でタブごとに有効化する。

`sidePanel.open()`はユーザー操作への応答としてだけ呼び出せるため、ScombZを開いた時点で自動的に表示するとは限らない。

拡張機能アイコン、またはページ内の明示的なボタンを起点にパネルを開く。[Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)

Chromeの設定によってパネルの左右が変わるため、UIは右側に固定されることを前提にしない。

### 全画面ワークスペース

Side Panel右上の明示的なボタンから、同じExtension UIを通常のChromeタブへ開ける。全画面ワークスペースは自由入力チャットではなく、現在の「提案、承認、完了」ループを会話風タイムラインと下部操作バーで表示する。

Service Workerは、ボタンを押した時点のScombZタブを`sourceTabId`として固定し、全画面タブがアクティブになった後もそのタブへPage Contextを問い合わせる。接続元が閉じた、またはScombZ外へ遷移した場合、別のタブへ暗黙に切り替えない。

画面間の引継ぎには`chrome.storage.session`を使用する。保存対象はopaqueなsession ID、接続元と全画面のtab ID、最小化済みPage Context、提案・承認・完了の安定状態だけである。Agent Toolの実行中は全画面へ切り替えず、`pendingRunId`やDeferred Tool callは保存しない。全画面タブが操作主体の間、Side Panelは読み取り専用とし、二重のTool実行や完了記録を防ぐ。

拡張機能ページを`chrome.tabs.create()`で開くための`tabs`権限は追加しない。既存のScombZ host permissionと`storage`権限の範囲で実装する。[Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)

### 最小権限

初期版の権限は、ScombZの読み取りとパネル表示に限定する。

```json
{
  "manifest_version": 3,
  "permissions": [
    "sidePanel",
    "storage"
  ],
  "host_permissions": [
    "https://scombz.shibaura-it.ac.jp/*"
  ]
}
```

Side Panelのパスは、ScombZのタブを検出したService Workerが`sidePanel.setOptions()`へ渡す。全サイト共通の`default_path`は宣言しない。

`identity`はGoogle Calendarの読み取りに使用し、`storage`はGoogle Driveの選択メタデータをブラウザのセッション中だけ保持するために使用する。

`cookies`、`webRequest`、`browsingData`、`<all_urls>`は初期版で使用しない。

Chromeの権限は、処理に必要な範囲だけを宣言する。[Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)

### Content ScriptとService Worker

Content ScriptはScombZのDOMを読み取り、ページと拡張機能の間で必要な情報を受け渡す。

Content ScriptはページのJavaScript環境から分離されたIsolated Worldで動作し、Chrome APIの多くはService Workerとのメッセージ交換を経由して利用する。[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

Service Workerのメモリを長期状態の正本にしない。タブの現在状態はContent Scriptから再取得する。画面間の安定状態だけは`chrome.storage.session`へ保持し、ブラウザ再起動後の復元には使用しない。

## ScombZ Adapter

ScombZ Adapterは、ページごとのDOM構造をAgent向けの小さなデータへ変換する。

初期版では、次の情報だけを読み取る。

- 現在のコースまたは授業
- 課題とテストの締切
- お知らせ
- カレンダーとICS
- 現在ページのタイトルとURL
- ScombZから表示される関連リンク

セレクタは一つのAdapterへ閉じ込め、UIコンポーネントから直接DOMを参照しない。

ページ遷移で必要になった場合だけ、限定的な`MutationObserver`を使う。

ScombZ Utilitiesは、Plasmo、React、MUI、`chrome.storage.local`、runtime message router、ScombZページへのContent Scriptを組み合わせている。[ScombZ Utilitiesのリポジトリ](https://github.com/scombz-utilities/scombz-utilities-react)

SIT ORBITでは、同プロジェクトのDOM Adapter、キャッシュ、メッセージ交換の考え方を参考にする。

ただし、ScombZ Utilitiesはページ内へウィジェットを注入する構成であり、SIT ORBITのAgent UIはChrome標準Side Panelへ置く。

## Agentの境界

既存のPydanticモデルをAPI契約の正本とする。

初期版では、次の3モデルだけを利用する。

- `OrbitEvent`：何が起きたか
- `EvidenceLink`：提案の根拠となる資料や活動
- `ActionProposal`：次に提案する行動、理由、所要時間、承認要否

Agentの境界は次のProtocolで維持する。

```python
class AgentBackend(Protocol):
    async def propose_action(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
    ) -> ActionProposal: ...
```

### Backendの選択

`FixtureAgent`は、通常開発、CI、拡張機能のローカルデモで利用する。

`OpenAIAgent`は、環境変数が設定された場合だけ有効になるデモ用Adapterである。

Azureモデルを追加する場合も、アプリケーションへモデル名を埋め込まず、同じBackend境界へ追加する。

APIキーやモデルが設定されていない場合に、別Backendへ暗黙に切り替えない。

### PydanticAIとChatのAgent境界

PydanticAIは、Python、FastAPI、Pydantic、型付き出力、複数モデル対応の条件に合うため、最初に評価するAgent Frameworkである。[PydanticAI](https://github.com/pydantic/pydantic-ai)

Branch 7では、既存の`AgentBackend.propose_action`を維持したまま、OpenAI Responses APIの共有PydanticAI Agentへ置き換えた。モデル出力は内部`ActionDraft`またはChat用`ChatDraft`だけとし、`action_id`、message ID、EvidenceLinkはサーバーが正規化する。
`OpenAIResponsesModel`には`OpenAIProvider`または`AzureProvider`を渡し、`openai_store=False`を固定する。

外部Toolは引数なしの`scombz_page_summary` v1と`google_calendar_availability` v1である。実際に解析済みのSCombZページ、または接続中のCalendarだけをClientが明示広告したrunで公開する。Action runは従来どおり一回ずつの互換経路を維持し、Chat runは同一Toolの再利用を許し、1ターン最大8回の線形Deferred Toolとして実行する。Tool結果を受けた後は同じPydanticAI message historyを再開するが、その履歴はブラウザへ返さない。SCombZの結果はroute、3つの件数、現在コースの有無だけであり、DriveはこのChat branchのToolへ登録しない。

Chat APIは`POST /v1/chat/runs`と`POST /v1/chat/runs/{run_id}/tool-results`である。入力履歴は直近20件・64,000文字まで、サーバー保存はTool待ちの600秒だけに限定する。完了メッセージはMarkdownとサーバー解決済みEvidenceを返し、ActionProposalが含まれる場合も従来どおり明示承認を要求する。

Side Panelと全画面ワークスペースは共通のChat UIを使い、会話履歴は拡張機能originのIndexedDBへ保存する。保存対象は発言、回答、引用メタデータ、提案の承認状態だけであり、raw HTML、Tool生レスポンス、OAuth token、Cookie、PydanticAI message historyは保存しない。IndexedDBの履歴はChrome SyncやFastAPIへ送らず、利用者が会話単位または全履歴を削除できる。

run storeはAPIプロセスのメモリ内だけに置き、TTLは600秒、単一worker affinity、固定expiry、`pending/in_flight`のatomic claimを使う。provider/model await中にlockを保持せず、claim後の失敗はterminal tombstoneとする。未知・期限切れ・別worker・再利用済みrunは、プロセス再起動後も含めて410とする。

Microsoft Agent Frameworkは、Agents、Harness、Workflows、セッション状態、Middleware、MCPクライアントを提供するAzure寄りの選択肢である。[Microsoft Agent Framework概要](https://learn.microsoft.com/en-us/agent-framework/overview/)

Foundry Hosted Agentは、Agent FrameworkのAgentをコンテナ化し、セッション、スケール、ID、ライフサイクルをMicrosoft管理下へ置く選択肢である。

現在はPreviewのため、初期実装の必須依存にはしない。[Foundry Hosted Agents](https://learn.microsoft.com/en-us/agent-framework/hosting/foundry-hosted-agent)

LangGraphは、承認待ち、チェックポイント、停止後の再開が本当に必要になった場合だけ評価する。[LangGraph概要](https://docs.langchain.com/oss/python/langgraph/overview)

## Agentの閉ループ

初期Agentは、任意のWebサイトを巡回するBrowser Agentにしない。

最初の閉ループは、B1大宮の合成シナリオと、明示的に送信したChatの一ターンに限定する。

```text
campus_entered または課題ページを検出
    ↓
ScombZ Adapterがページコンテキストを作成
    ↓
EvidenceLinkを選択
    ↓
ActionProposalを生成
    ↓
Side Panelへ提案、理由、根拠を表示
    ↓
利用者が承認、変更、却下
    ↓
完了結果をaction_completedイベントとして記録
```

Chatでは次の線形ループを追加する。

```text
利用者がChatを送信
    ↓
Agentが必要なToolだけを要求
    ↓
Side Panelが許可済みの最小データを取得
    ↓
Tool結果を同じrunへ返してAgentを再開
    ↓
Markdown回答、引用、必要ならActionProposalを表示
```

外部サービスへの書き込みを含む提案は、必ず承認後に実行する。

## Connectorの境界

「ScombZへログインすれば関連サイトをすべて読める」とは扱わない。

ScombZのセッションは、ScombZの認証を成立させるだけであり、Google、Microsoft、SIT Portfolio、CAST、OPACの認証を代替しない。

Connectorは、接続状態と権限を表示する小さなAdapterとして実装する。

```text
not_connected
connected
reauth_required
unavailable
```

初期の接続順は次の通りである。

1. ScombZのDOM、ICS、公開リンク
2. Google Calendarの読み取り
3. Google Driveの利用者選択ファイルの読み取り
4. Microsoft Graphの明示的なOAuth接続
5. SIT Portfolio、CAST、OPACの正式APIまたは許可されたExport

GoogleやMicrosoftのデータは、それぞれのOAuth同意を取得してから読む。

OAuth token、Cookie、パスワードをFastAPIへ送信しない。

### Branch 4 Google Calendar読み取りの実装境界

ExtensionのSide Panelから、利用者が明示的に接続、更新、再認証、切断を押した場合だけ、Chrome Identity APIでGoogle Calendarの予定を読み取る。
予定取得は`primary`カレンダーの今日00:00から7日後00:00までに限定する。認証トークンはService Worker内に閉じ込め、通常の予定取得ではAuthorizationヘッダーにだけ使用する。利用者が切断を明示した場合に限り、同じService WorkerからGoogleのOAuth失効エンドポイントへ送信し、ローカルのキャッシュも削除する。
トークンをFastAPI、DOM、Extension storage、ログへ渡さず、予定の書き込みも行わない。OAuth失効以外の外部エンドポイントへトークンを送信しない。

通常のfixture CIにはGoogle OAuth client IDを含めない。
登録済みChrome拡張OAuth client IDは`ORBIT_GOOGLE_OAUTH_CLIENT_ID`のbuild-time設定として後から注入できるが、Calendar API有効化、同意設定、demo accountを含むProvider acceptanceが成立するまでは、実Google連携を成功済みとは扱わない。

### Branch 5 Google Drive選択ファイルの実装境界

Google Driveはファイル一覧を取得せず、利用者が選択した1ファイルを注入可能なProviderから受け取る境界だけを持つ。
ライブのGoogle Picker/OAuth Providerは、Service Worker内だけに認証情報を閉じ込める公式経路が確認できるまで利用不可として扱う。

選択結果はランダムな`selectionId`で管理し、実際のDrive file IDとの対応だけを`chrome.storage.session`へ保存する。
Side Panel、runtime message、Agent APIへはfile ID、ファイル内容、tokenを渡さない。
Service Worker再起動後に選択を自動取得せず、選択解除またはセッション終了で対応表も消える。

## Azure配置

Azure Student Offerの残額と有効期限はAzure Portalを正本とする。

公開ページの無料枠や対象サービスは変更されるため、設計へ固定値を埋め込まない。[Azure for Students](https://azure.microsoft.com/ja-jp/free/students)

### 推奨する段階構成

| 用途 | サービス | 導入時期 |
| --- | --- | --- |
| Web | Static Web Apps Free | Webが静的出力で足りる段階 |
| API | Container Apps Consumption | デモAPIを外部公開する段階 |
| 定期処理 | Azure Functions Timer | Daily Briefなどが必要になった段階 |
| ファイル | Blob Storage | 公開資料、合成fixtureの保存 |
| 検索 | Azure AI Search Free | ローカル検索で足りなくなった段階 |
| LLM | Azure AI FoundryまたはAzure OpenAI | Portalでモデルとクォータを確認した後 |
| インフラログ | Application Insights | Azureへ配置した段階 |

Static Web Apps Freeは、静的ホスティング、GitHub連携、SSL、管理されたFunctions APIを提供する。[Static Web Appsのプラン](https://learn.microsoft.com/en-us/azure/static-web-apps/plans)

Container Apps Consumptionは、利用量に応じた課金とscale-to-zeroを利用できるため、常時稼働の仮想マシンよりデモ向きである。[Container Appsの環境](https://learn.microsoft.com/en-us/azure/container-apps/environment)

Azure Functions Timerは、短時間でステートレスな定期処理に使う。

長時間処理や永続状態をFunctionsへ集約しない。[Azure Functionsのベストプラクティス](https://learn.microsoft.com/en-us/azure/azure-functions/functions-best-practices)

Azure AI Search Freeは、デモ用の小規模Corpusに限定する。

Free tierには容量、サービス数、機能の制限があり、長期間使われないサービスが削除される可能性もある。[Azure AI Search Free](https://learn.microsoft.com/en-us/azure/search/search-try-for-free)

Azure OpenAIまたはFoundryのモデルは、モデル、リージョン、デプロイごとにTPMとRPMのクォータを持つ。

Student Offerの残額があっても、希望するモデルの利用可能性やクォータは別に確認する。[Foundryモデルクォータ](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota)

### 費用の扱い

通常開発とCIでは、外部LLMを呼び出さない。

デモ時だけ、公開資料と合成データを高品質モデルへ送る。

Azure Portalで予算、アラート、モデルクォータを確認してから有料リソースを作成する。

scale-to-zero、短期間のリソース利用、デモ終了後の停止または削除を前提にする。

無料枠をシステムの成立条件にしない。

## Observability

AzureのインフラログはApplication Insightsで扱い、Agentの入力、出力、token、cost、latencyは必要なデモだけW&B Weaveへ送る。

Weaveは、LLM呼び出しの入力、出力、trace、token、cost、latency、評価結果を記録できる。[W&B Weave概要](https://docs.wandb.ai/weave/concepts/what-is-weave)

計測するAgent境界は次の4つに限定する。

- `agent.handle_event`
- `agent.select_context`
- `agent.propose_action`
- `agent.verify_result`

W&Bへ送るデータは`synthetic`または`public`だけとする。

## 実装順序

### Phase 1：Side Panelの殻

- `apps/extension`を追加する
- Side Panel、Content Script、Service Workerを起動する
- 現在ページのタイトル、URL、ページ種別を表示する
- ローカルの静的fixtureを表示する（FastAPIやFixtureAgentへは接続しない）

### Phase 2：ScombZのB1シナリオ

- 課題、締切、お知らせ、ICSを読み取る
- EvidenceLinkを作る
- ActionProposalを表示する
- 承認、変更、却下を記録する
- 完了イベントを記録する

### Phase 3：Agent API

- 既存のAgentBackendを利用する
- OpenAIまたはAzure Adapterを明示的な設定で切り替える
- 必要条件を満たした後にPydanticAIを追加する
- W&B Weaveは合成デモだけで有効化する

### Phase 4：Connector

- Google Calendarを読み取り専用で接続する
- Google Driveは利用者が選択したファイルだけを読む
- Connectorごとの同意、再認証、切断を表示する
- 外部書き込みは承認後の提案として残す

### Phase 5：Azureデモ

- Static Web AppsまたはContainer Appsへ配置する
- 必要ならFunctions Timerを追加する
- Azureモデルのリージョンとクォータを確認する
- Azure Portalで予算と停止手順を確認する

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

これらは、現在のB1大宮シナリオを成立させるために必要な依存ではない。

必要性が実際に発生した段階で、個別の設計判断として追加する。
