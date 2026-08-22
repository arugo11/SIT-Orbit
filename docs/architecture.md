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

初期版の権限は、ScombZの読み取り、パネル表示、利用者が開始した読み取りToolに限定する。

```json
{
  "manifest_version": 3,
  "permissions": [
    "sidePanel",
    "identity",
    "storage",
    "scripting",
    "unlimitedStorage"
  ],
  "host_permissions": [
    "https://scombz.shibaura-it.ac.jp/*",
    "https://syllabus.sic.shibaura-it.ac.jp/*"
  ],
  "optional_host_permissions": ["https://*/*", "http://*/*"]
}
```

Side Panelのパスは、ScombZのタブを検出したService Workerが`sidePanel.setOptions()`へ渡す。全サイト共通の`default_path`は宣言しない。

`identity`はGoogle Calendarの読み取りに使用し、`storage`はGoogle Driveの選択メタデータをブラウザのセッション中だけ保持するために使用する。

`debugger`、`cookies`、`history`、`webRequest`、`browsingData`は使用しない。任意ホスト権限は、ユーザーがChat内の許可操作を押した場合だけ要求する。

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

外部Toolは`scombz_read`、`google_calendar_availability`、公式`syllabus_search`、許可済みURLの`browser_read_url`である（互換の`scombz_page_summary`も残す）。Tool引数と結果は厳格なSchemaで検証し、Chat runは同一Toolの再利用を許し、1ターン最大8回の線形Deferred Toolとして実行する。Web Readerは非アクティブな一時タブへページを開き、表示本文30,000文字・リンク50件までを抽出して閉じる。script、style、hidden要素、フォーム、Cookie、パスワードは除外し、ページ内の命令はデータとして扱う。Tool結果を受けた後は同じPydanticAI message historyを再開するが、その履歴はブラウザへ返さない。

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

### ChatのアクセスモードとBrowser Reader

Composerでは`Ask every time`を既定にし、未許可ホストの読み取り前に今回のみ許可・サイトを常に許可・拒否を表示する。`Full access`はユーザーがChromeのoptional host permissionを明示的に付与した場合だけ有効になるが、読み取り専用であり、提出・送信・更新・削除・ダウンロード・アップロードは常に確認対象である。成績、出欠、個人評価のURLは、サイト許可済みでもAskでは毎回確認する。

`browser_read_url`はService Workerが許可済みURLを非アクティブタブへ開き、`scripting.executeScript`で`browser-reader.js`をIsolated Worldへ注入する。抽出結果は表示本文、最大50リンク、opaqueな引用情報だけをAgentへ渡し、結果取得後にタブを閉じる。一般Webの検索やGoogle検索画面のスクレイピングへはfallbackしない。公式シラバス検索は`syllabus.sic.shibaura-it.ac.jp/namazu/`だけを対象とする。

### Branch 1 公開図書館ディスカバリー

Branch 1では、公開ページの検索・閲覧だけを4つのChat client tool（`library_catalog_search`、`library_item_read`、`library_catalog_browse`、`library_discovery_search`）として扱う。個人My Libraryは次節の明示接続・同意境界で別に扱う。OPACは確認済みの`https://library.shibaura-it.ac.jp/opc/`、レコードは`/opc/recordID/catalog.bib/<record>`、新着図書と貸出ランキングはそれぞれ確認済みの`/cgi-bin/nbk/nbk_seek.cgi?ulang=jpn`と`/cgi-bin/loan_best10/loan_best10.cgi?ulang=jpn`だけを使う。SIT SearchはOPACから到達する`https://slib.shibaura-it.ac.jp/sublib/`だけを使い、表示された書誌メタデータとリンク以外（契約本文、ダウンロード、保存）は扱わない。

現在のChatターンで図書館利用が明示された場合だけ該当Toolを広告する。optional host permissionが未付与でもTool要求までは進め、読み取り直前にChat内でサイト単位の許可を求める。許可後、Service Workerは公式ページを非アクティブな一時タブで開き、`chrome.scripting.executeScript`のIsolated Worldで可視DOMを抽出し、完了後にタブを閉じる。OPAC検索は可視フォームを送信し、SIT Searchも可視フォームを送信する。内部AJAX、推測URL、Google検索スクレイピング、Cookie・session token・material/copy IDの利用は行わない。origin、path、フォーム、DOM、ログイン・エラー状態が一致しない場合やavailabilityがloadingのままの場合は、空の成功ではなく`unavailable`を返す。

書誌レコードの`resource_ref`は安定した公開レコードIDから導出したopaque値であり、元IDはService Workerの短命なメモリ対応表にだけ保持する。対応表が失われた再起動後や衝突検出時は解決せず、推測で読み替えない。Holdingは表示されたcampus、location、call number、status、due date、reservation countだけを返し、未表示の値は`unknown`または`null`とする。Evidenceは`source_type=library`、`classification=public`、`orbit-library://public/` locatorに限定する。

### Azure一般Web検索

`ORBIT_WEB_SEARCH=azure`かつ`ORBIT_AGENT_BACKEND=azure_openai`の場合だけ、Chat Agentへサーバー内部の`general_web_search`を追加する。検索専用のPydanticAI runはAzure Responsesの`NativeTool(WebSearchTool)`を使用し、Grounding with Bingへ渡す入力を検証済みの検索語だけに限定する。親Chatの履歴、SCombZ、成績、学内Tool結果は検索runへ渡さない。

検索結果は要約と最大10件の公開URLへ正規化し、`web-search-v1-*` Evidenceとして元のChatへ戻す。URL本文がさらに必要な場合だけ既存`browser_read_url`を使用する。検索も既存の1ターン最大8 Toolに含め、Azure側で利用できない場合は別Providerや検索画面スクレイピングへfallbackしない。

### SITRUS成績通知書の参照

SITRUSの成績は、実在する画面を利用者が開いている場合だけ、専用の`sitrus_read` Toolで参照する。Service Workerは接続元タブが同じorigin・pathnameであることを確認する。優先する`/SITRUS/login/ShutokuTaniShukei.html`では、`MAIN` worldから可視のHTML表を読み、判定・評価・科目名だけをメモリ上で投影する。表にない科目コードや単位数は`null`とし、推測しない。`/SITRUS/login/SeisekiTsutiSho.html`では、表が使えない場合に限り認証済みPDF.jsのテキスト層をメモリ上で処理する。PDFファイル、Base64、学籍番号、認証情報を保存・ダウンロード・APIログへ渡さず、取得できた科目名、科目コード、成績、単位、年度・期・ターム、再履修フラグ、累積GPAだけへ投影する。

成績値は個人情報のため、都度の利用者確認を必須とする。現行のAgent契約ではこの結果を外部LLMやW&Bへ送らず、`fixture` BackendのローカルChatでのみ回答に使う。ページが閉じた、別URLへ遷移した、またはPDF.jsを利用できない場合は成功扱いにしない。

### SIT Moodleダッシュボードの参照

`moodle_read`は、確認済みの正規origin `moodle.sic.shibaura-it.ac.jp`と`/moodle/my/`だけを対象にする。利用者がChatまたは接続設定から明示的に実行した場合だけ、既に開かれているダッシュボードをIsolated Worldで読み取る。未認証時は`/moodle/login/index.php`を開くが、資格情報の入力や保存は行わない。未知のpath、404、ログイン画面、構造不一致を空データの成功として扱わない。

コース名、活動・課題名、期限は拡張機能のReact stateにだけ保持し、同じToolタイムラインへ端末内詳細として表示する。IndexedDB、`chrome.storage`、FastAPI、W&Bには保存しない。Agentへ送る`MoodleReadResult`は、コース数、直近項目数、延滞数、最短期限、未読通知数だけである。送信前には、Full accessでもrunごとに確認し、Evidence locatorは`orbit-moodle://summary/<opaque>`へ置き換える。

`my_library_read`は、利用者が接続設定で明示的に接続・許可した後、確認済みの正規入口`library.shibaura-it.ac.jp/portal/portal/selectLogin/?lang=ja`から、指定された一つのscopeだけを読む。scopeは`current_loans`（menu ID 5）、`reservations`（6）、`loan_history`（7）、`purchase_requests`（3）、`interlibrary_requests`（2）であり、その他のmenu IDやURLを推測しない。status pathは確認済みの`/portal/admin/selectMenu/doSelectPublicUseMainMenu`だけとする。貸出・予約はそれぞれ可視の`#lendList`・`#reservationList`、履歴・購入・ILLは表示されたtable見出しを検証して読む。hidden要素やinputのvalueは読まず、origin・path・table構造・見出しが一致しない場合や、非空行を一件でも解析できない場合はfail closedで`unavailable`を返す。資格情報の入力、貸出延長、予約取消、購入・ILL申請は行わない。

各要求は`scope`、任意の`query`（最大200文字）、`offset`（0〜1000）、`limit`（1〜20）を持ち、DOM全件を拡張機能内で検索・ページングしてから最大20件だけを返す。`MyLibraryReadResult`のitemはopaqueな`resource_ref`、表示された書名・著者・状態・返却期限・延長可否・活動日・申請種別だけで、`total_count`と`next_offset`を添える。scope外で読んでいない集計値は0ではなく`null`にする。従来の貸出・予約集計shapeは後方互換のため残す。資料ID、請求記号、氏名、学籍番号、メールアドレス、SSO URLのtoken/query/fragment、フォーム値、購入理由、連絡事項、整理番号にはAPI Schema上の表現を与えない。表示セルから取得した元のmaterial/request IDはService Workerの短命なメモリ対応表にだけ保持し、hidden/inputの値は読まない。`createLibraryResourceRef`相当のopaque化で衝突を検出した場合、またはIDが表示されない場合はactionを推測せずfail closedし、再起動後も解決しない。

接続後は会話ごとの再確認を行わず、最初の明示的な接続・許可時だけ`chrome.storage.session`へAIへのタイトル等共有を許可するsession consentフラグを保存する。Full accessだけではこの同意を代用しない。タイトル等の回答に現れた項目は拡張機能originのローカルChat履歴へ保存され、利用者が会話単位または全件で削除できることを接続設定Drawerに表示する。raw snapshotはReactのメモリだけに置き、IndexedDB・`chrome.storage`・API・W&Bへ保存しない。切断またはChromeセッション終了時にconsentを無効化する。

### CASTトップ画面の参照

`cast_read`は、SCombZ掲載の正規入口`https://shibaura.pita.services/career`と、実ログイン環境で確認した`/career/top/student`だけを対象にする。利用者が明示的に実行した場合だけ、既に開かれているトップ画面をIsolated Worldで読み取る。セッション切れでは正規入口を開くが、資格情報の入力・保存や、予約履歴・応募履歴など別画面への遷移は行わない。未知のpath、404、ログイン画面、件数selectorの構造不一致を空データの成功として扱わない。

お知らせの件名と掲載日、新着求人・インターン・会社説明会の件数、個人向け通知領域に表示された相談予約の有無は、拡張機能のReact stateにだけ保持する。Agentへ渡す`CastReadResult`はお知らせ件数、各新着件数、相談予約の有無、直近掲載日だけで、Evidence locatorは`orbit-cast://summary/<opaque>`とする。進路希望、自己PR、応募履歴、氏名、前回ログイン、提出内容にはAPI Schema上の表現を与えない。

### CAST求人・インターン検索の参照

求人は実ログイン環境で確認した`https://shibaura.pita.services/career/job_offer_search/search`、インターンは`https://shibaura.pita.services/career/internship_search`だけを許可する。検索結果カードの確認済みの`panel-heading`、`cell-th`/`cell-td`行、`linkTo`企業リンクだけをtyped snapshotへ変換し、検索フォームの送信、詳細画面への推測遷移、ページング、応募操作は行わない。query、fragment、未知origin、404、ログイン画面、構造変更は成功扱いしない。

カードの企業名、仕事内容、職種、勤務地、対象学科、締切、CAST上の関連表示は端末内の`CastOpportunityLocalSnapshot`にだけ保持する。Agentへ渡す`CastOpportunityAgentProjection`は求人・インターンの件数、状態別件数、最短締切、状態コードだけで、企業名、仕事内容、企業コード、求人番号、raw HTMLは表現できない。projectionをPseudonymization Gateway以外の経路からモデルへ渡さない。PDF、添付、フォーム値、法人番号は抽出しない。

### CAST採用実績・選考記録の参照

採用実績と選考記録は、実ログイン環境で確認した企業詳細`https://shibaura.pita.services/career/company_detail_view`の`#employment`、`#company_exam_entry`、`#company_obog`領域だけをread-onlyで読む。企業コードは端末内のローカルID生成にだけ使い、応募、OB・OG名簿の閲覧要求、添付・PDF取得、`published_company_exam_view`への推測遷移は行わない。ログイン画面、未知のpath、query/fragment、必須sectionやtableの構造不一致は成功扱いしない。

企業名、卒業年月、学科、職種、採用形態、選考記録の概要は端末内`CastHistoryLocalSnapshot`に保持する。行中の氏名・指導教員など人物らしい値はPseudonymization Gatewayへ渡し、Career Vaultで対応表を暗号化したうえでmission固有の別名へ置換する。Prompt projectionから元の氏名、企業コード、内部local_id、report href、raw HTML、フォーム値を除外し、外部Providerへ送る経路はこのprojectionに与えない。OB・OG名簿は有無だけを扱い、名簿本文や直接連絡先は取得しない。

### CAST支援リソースの参照

CASTトップ`https://shibaura.pita.services/career/top/student`に表示されたお知らせ、録画・講座、会社説明会・会社見学会、カウンセラー予定表、キャリアサポート課スタッフ紹介のリンクだけをカテゴリ付きSnapshotへ変換する。CASTのnotice detailはお知らせとして扱い、リソース一覧へ重複登録しない。外部リンクは実画面で確認したNotion、大学公式、SPIのoriginだけを許可し、本文の巡回、連絡先の推測、予約操作は行わない。

支援リソースのタイトル・URL・掲載日は端末内に保持し、Agentへはお知らせ数、動画・イベント・相談・サポーターの件数、最終お知らせ日だけをprojectionする。外部ProviderへURL、タイトル、利用者名、CAST内部ID、raw HTML、フォーム値を送らない。top構造、件数selector、ログイン状態が確認できない場合は成功扱いしない。

外部サービスへの書き込みを含む提案は、必ず承認後に実行する。

### CAST Career Agentのプライバシー境界

CASTを横断する検索、比較、ES、OB・OG支援は、個人情報を含むTyped SnapshotをPseudonymization Gatewayへ通してから実行する。Gatewayは氏名の表記揺れ、メール、電話、学籍番号、CAST内部ID、SSO token、URL query/fragment、自由記述中の署名や連絡先を検出し、内部人物ID、ミッション固有の別名、一般化属性へ変換する。これは対応表で復元可能な仮名化であり、完全匿名化とは扱わない。

内部人物IDと元の氏名の対応表は、Argon2idとAES-256-GCMを用いるCareer Vaultの暗号化レコードだけに保存する。鍵は`chrome.storage.session`とメモリに限り、15分の無操作またはChrome終了で破棄する。FastAPI、Azure、W&B、Chat履歴、ログ、runtime messageには、元の氏名、内部人物ID、対応表、HMAC、raw HTML、tokenを渡さない。外部別名はmission nonceから生成し、同一mission内だけで安定させる。

個人・第三者のCAST記録はChrome Prompt APIのオンデバイス実行へ固定し、APIが利用できない場合にAzureへfallbackしない。Azureへ送れるのは公開情報、匿名集計、一般化属性だけである。Context Manifestで処理先と送信payloadを表示し、外部書込み、応募、予約、添付、Calendar登録はpreview後の本人確認を必須とする。個人情報を安全に仮名化できない自由記述は送信せず、端末内で停止する。

### CAST横断検索

`cast-cross-search.ts`は、求人・インターン、採用実績・選考記録、支援リソースのtyped Snapshotを一つの端末内コーパスへまとめる。自然言語の質問はChrome Prompt APIへ質問文だけを渡して、検索語・必須語・勤務地・技術領域・職種・年度・OB・OG条件へ構造化する。Snapshotや人物情報をこのPromptへ渡す経路は用意しない。

構造化後はMiniSearch 7.2のBM25+ランキングを使い、完全一致のフィルタ（種別、年度、勤務地、技術領域、職種、OB・OG条件）を先に適用し、prefix・fuzzy検索を補助的に使う。結果カードの詳細は端末内のlocal payloadから表示し、検索結果をAzureやChat履歴へ送らない。意味埋め込み、外部検索API、常時索引、推測URL、フォーム送信はこの段階では追加しない。

### CAST差分表示

`CastChangeFeed`は、利用者が同じCAST情報を再確認した時だけ、暗号化Career Vaultに保存した前回Snapshotと今回Snapshotを比較する。配列は`local_id`、URL、タイトルなどのローカル安定キーで対応づけ、締切、インターン、採用・選考記録、支援リソースのfield差分を生成する。初回はbaseline、同一Snapshotは差分なしとする。

差分UIへ渡す`CastLocalChange`は端末内の詳細表示に限り、Agentへ渡す`CastChangeAgentProjection`は追加・削除・変更の件数とカテゴリ別件数だけにする。VaultのレコードIDはsource keyそのものではなくVault HMACから生成し、定期巡回や差分の外部保存は行わない。

### Career Evidence Bank

`CareerEvidenceBank`は、授業、研究、PBL、サークル、アルバイト、個人開発などを「主張、状況、行動、結果、裏付け資料」の単位で保存する端末内の証拠バンクである。記録の構造はW3C PROVのEntity・Activity・生成結果という概念を参考にするが、RDF、Graph Database、外部検索索引は追加しない。[W3C PROV-O](https://www.w3.org/TR/prov-o/)

記録は`draft`または`confirmed`で管理し、利用者が確認した記録だけをローカルPrompt API向けのallowlist projectionへ変換する。projectionには主張、状況、行動、結果、出典種別、裏付け資料の件数だけを含め、`person_ref`、資料locator、元ファイル、更新時刻、内部対応表は含めない。結果欄の数値や成果は入力された表現をそのまま保持し、Agentが補間・水増ししない。

Career Vaultの暗号化レコードを正本とし、Career Evidence BankからFastAPI、Azure、W&B、Chat履歴へ直接送る経路は設けない。外部Providerが必要な場合は、別途Pseudonymization GatewayとContext Manifestで許可された公開・一般化データだけを使用し、個人証拠はオンデバイス処理に固定する。

### Evidence-grounded ES

ES下書きは、利用者が`confirmed`にしたCareer Evidence Bankのprojectionだけを入力にして、Chrome Prompt APIで端末内生成する。モデルの各文は`evidence_id`と、対応するclaim・context・action・resultからの短い`grounding_quote`を必須とし、未知のEvidence ID、引用に存在しない文言、根拠にない数値を決定的に拒否する。生成物には文単位のEvidence IDと検証済みの引用を保持し、どの経験から構成されたかを端末内で追跡できる。

ES生成はAzure、FastAPI、W&Bへ送信せず、Chrome Prompt APIが利用できない場合に別Providerへfallbackしない。材料のlocator、ファイル本体、`person_ref`、対応表、tokenはPrompt入力と生成結果へ含めない。応募先や応募目的の自由記述に連絡先・学籍番号・credentialらしい値が含まれる場合は、モデル呼び出し前に停止する。

### OBOGコンシェルジュ

`buildObogCandidateProjections`は、確認済みの企業詳細Snapshotに含まれる人物をPseudonymization Gatewayへ渡し、同じミッション内だけで使う別名、一般化した卒業年、企業、技術領域、職種を作る。元の氏名、CAST内部識別子、連絡先、選考記録URLはPrompt入力へ入れない。候補と支援リソースの参照は端末内の番号へ置き換え、依頼文や面談後のお礼文の下書きはキャリアサポート課を経由する内容に限定する。

`planObogConcierge`はChrome Prompt APIを一度だけ実行し、候補別名、面談目的、優先度付き質問、面談前の確認事項、依頼文、お礼文をstrict schemaで受け取る。未知の候補・支援リソース、連絡先やURL、元の人物名、credentialらしい文字列が応答へ出た場合は採用しない。Prompt APIが利用できない場合にAzureや別Providerへfallbackせず、連絡先の推測、CASTへの自動送信、予約、提出は行わない。

面談後の知見は利用者が明示的に保存した場合だけ、`ObogMeetingMemoStore`を通じてCareer Vaultへ暗号化保存する。メモの本文、候補別名、目的、次の行動はIndexedDBの暗号文以外へ出さず、Chat履歴、FastAPI、Azure、W&B、runtime messageへ送信しない。直接連絡先を扱う正式なCAST APIまたは大学側の許可が得られるまでは、コンシェルジュは下書きと確認案内で停止する。

### 応募準備ミッション

`ApplicationMissionStore`は、確認済みCASTのlocal IDを対象に、`requirements`→`history`→`evidence`→`es`→`counseling`→`calendar`の順で応募準備の状態だけを追跡する。締切、必要書類、Evidence参照、ES下書き、相談枠参照はCareer Vaultの暗号化レコードへ保存し、元HTML、人物名、URL、token、提出物本体は保存しない。状態は`active`、`blocked`、`ready_for_confirmation`、`completed`、`cancelled`を持ち、阻害理由を暗黙の再試行で消費しない。

`calendar-previewed`はCalendar登録案を`ready_for_confirmation`として表示するだけで、外部書込みを行わない。`calendar-confirmed`を利用者が明示した場合だけ完了状態へ遷移する。応募、予約、添付、送信、Calendar登録の実行はこのreducerに実装せず、後続Action Adapterがpreviewと本人確認を担当する。ReActが示す計画・観測・例外の分離は状態イベントへ反映するが、モデルの自由な推論履歴を保存しない。[ReAct](https://arxiv.org/abs/2210.03629)

実装は既存の小さなtyped reducerとCareer Vaultを再利用する。XStateは調査したが、現段階の線形な6段階と明示イベントには既存境界より大きな依存・抽象化を追加するため採用しない。[XState](https://stately.ai/docs)

### CAST Action Adapter

`CastActionAdapter`は、応募、キャリア相談依頼、添付、Calendar登録を同じpreview／confirmation境界で扱う。previewはローカルのopaque reference、表示ラベル、締切・書類件数・予約枠・Calendar項目のallowlist済み要約だけを持ち、CASTの未確認書込みURL、フォーム値、ファイル本体、OAuth tokenを生成しない。既定executorは`institutional_write_not_configured`を返し、未確認の大学側APIやDOM書込みを成功扱いしない。

通常操作は「実行を確認」の一段階、推薦応募は同じpreviewに対して一次確認後に「推薦応募を実行する」の赤色二次確認を要求する。確認前のexecutor呼出し、期限切れpreviewの実行、replay、拒否済みpreviewの再利用を防ぐ。実行は後続branchで正式なCAST API、test account、確認済みwrite pathが揃った場合にだけ注入できる。Chrome拡張のメッセージ／権限境界を越える実装は追加せず、既存のcontent-scriptとService Workerの確認経路へ接続する。[Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)

### 多視点キャリアレビュー

`reviewCareerDraft`は、Evidence-grounded ESの下書きと確認済みEvidence projectionだけを入力にして、人事、技術部門、芝浦卒業生、初見の第三者という4つの視点をそれぞれ独立したChrome Prompt API sessionで実行する。各sessionへ他の視点の結果や人物対応表、`person_ref`、資料locator、raw HTML、tokenを渡さない。Prompt APIが利用できない場合はAzureや別Providerへfallbackせず、レビューを未実行として端末内で停止する。

各レビューは`clear`、`needs_revision`、`insufficient_evidence`の判定と、ES文・Evidence IDに紐づくstrength／gapだけを返す。総合点、順位、採用確率は生成しない。視点間で判定が分かれた場合は`disagreements`へそのまま保持し、単一の結論へ統合しない。数値は引用したEvidenceまたは対象文に存在するものだけを許可し、未知の文・Evidence ID、根拠のない数値、credentialらしい文字列は決定的に拒否する。これは位置バイアスを扱う研究の知見を踏まえ、順序依存の一回判定を避けつつ、判断の違いを利用者へ可視化するためである。[Judging the Judges](https://aclanthology.org/2025.ijcnlp-long.18/)

### CAST Decision Room

`buildCastDecisionRoom`は、求人またはインターンと、同一企業として確認できた採用実績・選考記録・OB・OG表示を端末内で比較する。技術領域、勤務地、職種、採用実績、選考記録、OB・OG支援、締切、不足情報を独立した判断軸として返し、単一の相性点や順位は生成しない。

各軸は`match`、`partial`、`mismatch`、`unknown`のいずれかと、要約、ローカルEvidence ID、不足項目を持つ。企業名とCASTのlocal IDを含む`subject`、求人の締切、表示件数などの詳細は拡張機能のメモリ内UI専用であり、FastAPI、Azure、W&B、Chat履歴へ送らない。別企業の履歴Snapshotは企業名一致を確認できない限り紐付けず、未知として扱う。

判断結果は、応募・予約・送信を実行する機能ではない。次の一歩は「不足情報を確認する」「締切と必要書類を本人が確認する」といった読み取り専用の案内に限定し、確定操作は後続のAction Adapterで本人確認を要求する。[Human and LLM-Based Resume Matching](https://aclanthology.org/2025.findings-naacl.270/)が示すLLM評価と人間評価の非互換性を踏まえ、説明可能な軸別Evidenceを優先し、総合スコアを採用しない。

### 芝浦キャリア地図

全画面ワークスペースのキャリア地図は、端末内へ取得済みのCAST求人・インターン、採用実績、科目・技術分野・職種のTyped Snapshotから表示用のノードとエッジを生成する。レンダリングにはCytoscape.jsを使うが、Graph Databaseや外部検索索引は追加しない。ノード種別は科目、技術分野、職種、企業、求人・インターン、匿名集計の進路に限定する。

個人、卒業生、担当者を表すノードは生成しない。進路の匿名集計は`count >= 5`だけを表示し、5未満の集計は端末内でもノード化しない。会社コード、求人番号、選考報告URL、raw HTML、tokenはグラフモデルへコピーしない。グラフは全画面表示の操作主体に限定し、外部Provider、FastAPI、Chat履歴、IndexedDBへ送信・保存しない。

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

外部公開したAgent APIは、`ORBIT_API_TOKEN`をContainer Apps Secretから設定し、`/v1/*`だけにBearer認証を要求する。`/health`はscale-to-zeroからの起動と監視に使うため公開のままにする。API側のCORSは`ORBIT_CORS_ORIGINS`へ明示した拡張機能originだけを許可し、ワイルドカードを使わない。拡張機能は明示的に許可したContainer Apps originだけへ接続し、endpointとtokenを`chrome.storage.session`で共有する。通常のローカル開発とCIでは`ORBIT_API_TOKEN`と`ORBIT_CORS_ORIGINS`を設定しない。

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
