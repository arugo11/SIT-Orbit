# SIT ORBITのアーキテクチャ

この文書は、SIT ORBITをScombZ上のChrome拡張機能から利用する構成と、AgentをAzureへ段階的に配置する方針を記録する。

調査時点は2026年8月14日である。

実装ブランチの順序と完了条件は[implementation-plan.md](./implementation-plan.md)に記録する。

ScombZ、SIT Portfolio、CAST、OPACなどの正式な連携は、大学の許可と仕様確認が完了するまで実装済みとは扱わない。

## 設計判断

SIT ORBITは、Chromeの標準Side Panelを入口にし、Agentの実行は既存のFastAPI境界の内側に置く。

この文書には次の開発スライスの設計を含めるが、現時点のリリース判定は既存のB1大宮fixtureとFastAPI閉ループで行う。

現在の実装では、独自のマルチエージェント基盤を追加せず、`AgentBackend`と決定的なFixtureAgentを使う。

複数のツール呼び出し、構造化出力、会話状態が実際に必要になった時点で、PydanticAIを`AgentBackend`の内側へ導入する。

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
Chrome Side Panel   FastAPI Agent API
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

Service Workerのメモリを長期状態の正本にしない。Branch 1ではタブの現在状態をContent Scriptから再取得できるため、`chrome.storage`によるキャッシュも持たない。

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

### Agent Frameworkの導入条件

PydanticAIは、Python、FastAPI、Pydantic、型付き出力、複数モデル対応の条件に合うため、最初に評価するAgent Frameworkである。[PydanticAI](https://github.com/pydantic/pydantic-ai)

ただし、単一の提案生成だけなら現在のAdapterで足りる。

次のいずれかが必要になった時点で導入する。

- 複数の読み取りツールを順序付きで呼ぶ
- ツール結果を構造化出力へ統合する
- 同一利用者の会話状態を複数ターン保持する
- Tool呼び出しをテスト用Modelで再現する

Microsoft Agent Frameworkは、Agents、Harness、Workflows、セッション状態、Middleware、MCPクライアントを提供するAzure寄りの選択肢である。[Microsoft Agent Framework概要](https://learn.microsoft.com/en-us/agent-framework/overview/)

Foundry Hosted Agentは、Agent FrameworkのAgentをコンテナ化し、セッション、スケール、ID、ライフサイクルをMicrosoft管理下へ置く選択肢である。

現在はPreviewのため、初期実装の必須依存にはしない。[Foundry Hosted Agents](https://learn.microsoft.com/en-us/agent-framework/hosting/foundry-hosted-agent)

LangGraphは、承認待ち、チェックポイント、停止後の再開が本当に必要になった場合だけ評価する。[LangGraph概要](https://docs.langchain.com/oss/python/langgraph/overview)

## Agentの閉ループ

初期Agentは、任意のWebサイトを巡回するBrowser Agentにしない。

最初の閉ループは、B1大宮の合成シナリオに限定する。

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
