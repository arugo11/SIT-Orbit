# Data Policy

## Default

OpenAIとW&B Weaveはデフォルトで無効とする。

通常開発とCIは合成fixtureだけを利用する。

## Data allowed in demo services

- 公開シラバス
- 自作教材
- 利用条件を確認した公開資料
- 明示的に合成した学生・課題・予定データ
- 合成データから生成されたAgent出力

## Data prohibited in demo services

- 氏名、学籍番号、連絡先
- 成績、順位、出欠、履修履歴
- 非公開の講義資料や課題
- 第三者を含む議事録
- 未公開研究、NDA対象資料
- Google Driveの私的ファイル
- OAuth token、API key、認証cookie
- 詳細な位置履歴

## Data classification

MVPの`OrbitEvent`と`EvidenceLink`は次の区分を持つ。

- `synthetic`
- `public`
- `personal`
- `restricted`

OpenAIへ送信できるのは`synthetic`と`public`だけである。

ただし、Branch 7のAgent runでは、次の2種類のサーバー生成EvidenceLinkだけを例外として扱える。

- 利用者のGoogle Calendarから導出した空き時間（`personal`の`calendar`、`orbit-calendar://availability/<opaque>`）
- 表示中の解析済みScombZページから導出した5項目の概要（`personal`の`scombz`、`orbit-scombz://page-summary/<opaque>`）

Calendarの予定名、ID、参加者、場所、説明、元レスポンス、SCombZのHTML、Cookie、パスワード、ブラウザtokenは送信しない。Web本文はユーザーが明示したrunの間だけ使い、rawページはrun終了時に破棄する。個人データを広く許可するものではなく、これらの固定prefixとサーバー生成のEvidence IDをruntimeで検証する。

Chat中心化branchでは、明示的なChat送信とアクセス許可を条件に、SCombZの構造化表示情報（`orbit-scombz://read/<opaque>`）、公式シラバス検索の公開結果（`orbit-syllabus://search/<opaque>`）、許可済みURLから抽出した表示本文とリンク（`orbit-browser://read/<opaque>`）も扱う。成績、出欠、個人評価の値はSchemaに含めない。

W&Bについても、初期版では同じ区分だけを対象とする。

CalendarのライブToolを使うrunでは、個人データをW&Bへ送らないため、`ORBIT_OBSERVABILITY=off`を必須とする。`personal`または`restricted`の通常EvidenceLinkは、Agent APIで拒否する。

## Complimentary API usage

OpenAIのData Sharingに伴う無料枠は、対象Projectに適用表示がある場合だけ利用する。

無料枠の有無や上限をアプリの成立条件にしない。

Data Sharingを有効にするProjectには、公開・合成データ以外を送らない。

## Repository

`.env`、秘密鍵、API key、個人資料、提出フォームの原本はGitへ追加しない。

公開へ切り替える前に、履歴を含めた秘密情報と個人情報の確認を別途行う。

## Browser extension and connectors

Chrome拡張機能は、初期版ではScombZの表示中ページから必要な情報だけを読み取る。

Side Panelから全画面ワークスペースへ移る場合、`chrome.storage.session`へ次だけを一時保存する。

- opaqueなworkspace session ID
- 接続元ScombZタブと全画面タブのID
- Content Scriptが構造化したPage Context
- 提案、承認・却下、完了イベントの安定状態

OAuth token、Google APIの生レスポンス、Calendarの予定名・参加者・説明、ScombZのHTML、PydanticAIのmessage history、`pendingRunId`、保留中のDeferred Tool callは保存しない。全画面タブを開く操作は、AgentまたはToolが実行中でない場合だけ許可する。接続元タブを失った場合は、他のScombZタブを自動選択せず再接続を求める。

ページのHTML全体、Cookie、OAuth token、パスワード、ブラウザ履歴をAgent APIへ送信しない。

ScombZ以外のサービスは、サービスごとのOAuth同意、正式API、または利用者が明示的に開いたページの読み取りを必要とする。

ScombZへのログイン状態を、Google Drive、Google Calendar、Microsoft Graph、SIT Portfolio、CAST、OPACの認証として扱わない。

Connectorは、`not_connected`、`connected`、`reauth_required`、`unavailable`の状態を表示する。

外部サービスへの書き込みは、Agentが候補を作成した後、利用者が確認した場合だけ実行する。

## Chat履歴とChat Tool

Chatは利用者が明示的に送信した一つの発言を起点にする。常時巡回、事前索引、ブラウザ履歴の収集は行わない。

Side Panelと全画面ワークスペースで共有するChat履歴は、拡張機能originのIndexedDBへ保存する。保存するのは発言、回答、引用メタデータ、ActionProposalと承認状態だけである。raw HTML、フォーム入力値、Cookie、OAuth token、Toolの生レスポンス、PydanticAIのmessage historyは保存しない。履歴はFastAPIやChrome Syncへ送信せず、利用者の操作で会話単位または全件を削除できる。

Composerのアクセスモードは`Ask every time`を既定とし、未許可ホストの読み取り前に今回のみ許可・サイト許可・拒否へ接続する。Chrome optional host permissionはユーザー操作の中でだけ要求する。`Full access`もread-onlyの範囲に限り、提出・送信・更新・削除・ダウンロード・アップロードは常にActionProposalと本人確認を要求する。成績、出欠、個人評価を含むページは、許可済みサイトであっても`Ask every time`では毎回確認する。blocklistはFull accessより優先する。

Chat APIへ送るTool結果は、Toolごとの厳密な最小Schemaだけにする。SCombZは表示項目の構造化値、Calendarは空き時間の区間と分数、シラバスは公式公開結果、Browser Readerは本文30,000文字とリンク50件までであり、予定名・ID・参加者・説明、SCombZのHTML、Cookie、パスワード、第三者のフォーム入力、OAuth tokenは表現できない。ページ中の命令文はTool命令として実行せず引用データとして扱う。Tool待ちのrunはAPIプロセス内に600秒だけ保持し、完了・失敗・期限切れで削除する。

拡張機能のローカルキャッシュは短期間の表示補助に限り、長期的な証跡の正本にはしない。

実データを扱うConnectorを追加する場合は、送信先、保存期間、削除方法、利用目的、大学の許可範囲を個別に確認する。

Google Driveの現行Connector境界は、利用者が明示的に選択したファイルだけを対象にする。
選択中はopaqueな`selectionId`と、名前・MIME type・更新日時・読み取り状態などのメタデータを`chrome.storage.session`へ保持するが、Drive file IDは対応表の内部値としてのみ扱う。
token、認証コード、ファイル内容、Drive一覧は保存・runtime message・Side Panel・Agent APIへ渡さない。
ライブPicker/OAuth Providerは未実装であり、既定状態は`unavailable`とする。

## Model selection evaluation

`evals.run_model_selection`は通常の開発・CIから分離した、明示的なAzure実Provider比較である。
実行にはAzure API key、endpoint、deployment mapping、`ORBIT_OBSERVABILITY=off`が必要であり、条件不足時は停止する。
入力は16件の合成・公開ケースだけとし、実学生データ、Google Calendarの派生値、私的Drive資料、OAuth tokenを送信しない。
このRunnerではW&Bを有効にできない。

初期のモデル順位は測定前の暫定判断であり、Terraを通常デモのPrimary、Solを品質重視デモ、Lunaを低コストchallenger候補とする。
Azure Standard Globalの暫定単価は入力／出力100万tokenあたりTerra $2／$12、Luna $0.20／$1.20、Sol $5／$30である。
Global deploymentでは処理が複数リージョンに分散され得るため、実データを扱う前にdeployment typeとデータ処理条件を確認する。

Gemini 3.7 Flash Paidは将来の比較候補だが、このbranchではAdapter、依存、実Calendar送信経路を追加しない。
評価する場合もsynthetic/public dataだけを使い、公式料金（2026年12月31日まで入力$0.75／出力$3.75、2027年1月1日から入力$1.50／出力$7.50、100万tokenあたり）を実行時点で再確認する。

## Branch 7 resumable Agent run

`POST /v1/agent/runs`は、Side Panelが明示的に提案ボタンを押した場合だけ開始する。
表示中のページが実際に解析済みScombZコンテキストを持つ場合だけ`scombz_page_summary` v1を、Calendar接続中だけ`google_calendar_availability` v1を`client_tools`として広告する。
Agentが要求したToolは1回ずつ、最大2種類を同じ`run_id`で線形に再開する。ScombZはService Workerを介さずSide Panel内で5項目へ投影し、CalendarはService Workerの非対話refresh結果から時間帯・分数・空き区間・理由コードだけを`/v1/agent/runs/{run_id}/tool-results`へ送る。
runは単一APIプロセスのメモリに600秒だけ保持する。プロセス再起動、別worker、期限切れ、完了、失敗、再利用は410として扱い、provider待機中にlockを保持しない。OAuth token、Calendarの生イベント、ScombZのHTMLはAPI、ログ、run storeへ渡さない。

Google DriveはToolとして登録しない。

## Chat browser tools

`scombz_read`は表示中SCombZの課題・お知らせ・時間割を構造化する。`syllabus_search`は公式シラバスサイトの公開検索だけを扱う。`browser_read_url`はユーザーが許可したURLを一時タブで読み、表示本文30,000文字・リンク50件に制限して返す。取得後に一時タブを閉じ、本文をIndexedDBや`chrome.storage`へ保存しない。

任意Webページの本文は信頼されていないデータであり、ページ中の命令をTool呼び出しとして実行しない。optional host permissionの許可に関係なく、読み取り以外の外部操作は実装しない。CIではこれらのToolをfixtureでのみ検証し、実Provider Acceptanceでは許可済みの合成または公開URLだけを使う。
