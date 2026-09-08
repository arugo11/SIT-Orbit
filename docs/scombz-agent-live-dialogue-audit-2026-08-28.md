# SCombZ Agent 実認証・多ターン対話監査ログ（2026-08-28）

## 監査の結論

実際のSITアカウントでOAuth認証を行い、Chrome拡張機能と同じAzure Agent APIへ接続した。
しかし、配備版APIはSCombZ Student Readの新Toolをまだ受け付けない。拡張機能がSCombZページで広告する18個のToolをそのまま送ると、LLMのTool選択以前に全ターンが`422 chat_tools_invalid`で停止した。

したがって今回の19シナリオは、SCombZの実データをToolへ渡す段階まで到達していない。Tool選択の成否、PDF抽出、OCR、シラバス詳細、会話内Evidence継続は未検証であり、成功とは扱わない。

これは、配備版と作業ツリーの契約差分を示す実障害である。監査中にコード修正・配備・再試行による隠蔽は行っていない。

## 実行条件

| 項目 | 実測値 |
| --- | --- |
| 実行日時 | 2026-08-28 13:26頃–13:44頃 JST（監査実行時間帯） |
| SCombZ情報源 | Chromeでログイン済みの`https://scombz.shibaura-it.ac.jp/portal/home`タブを固定 |
| Agent API | `https://sit-orbit-demo-api.grayground-578aed68.japaneast.azurecontainerapps.io` |
| 認証 | 公式Google OAuth、SITドメインアカウント、PKCE。認証コード・Bearer tokenは保存・再掲していない |
| `capabilities` | `agent_backend=azure_openai`, `my_library_personal_context=true`。SCombZ liveフラグとobservability設定は配備版応答に存在せず未確認 |
| Tool結果 | fixture/mockは使用していない。新SCombZ Toolは配備版が受け付けず、実SCombZ結果の送信段階へ進めなかった |
| 書き込み | SCombZへの提出・回答・更新・削除・出席登録・テスト開始は0件 |

### 最初の失敗（再現固定）

拡張機能の現在の`client_tools`（SCombZページで有効になる18個）をそのまま送った。

```text
POST /v1/chat/runs
client_tools: 18 items
HTTP 422
detail.reason_code: chat_tools_invalid
detail.field: client_tools
detail.error_type: too_long
```

18個を15個へ減らしても、新Toolを含めた時点で次のエラーになった。

```text
HTTP 422
detail.reason_code: chat_tools_invalid
detail.field: client_tools
detail.error_type: literal_error
```

新Toolを1個ずつ送った結果も同じだった。

| 送信したTool | 結果 |
| --- | --- |
| `scombz_course_list` v1 | 422 / `literal_error` |
| `scombz_portal_read` v1 | 422 / `literal_error` |
| `scombz_course_read` v1 | 422 / `literal_error` |
| `scombz_material_search` v1 | 422 / `literal_error` |

配備版`/openapi.json`でも、`ChatRunRequest.client_tools.maxItems=15`であり、`ChatToolName` enumには旧`scombz_read`と`scombz_page_summary`しか存在しなかった。

## 対話ログ

以下の「Agent(API)」は、Agentがユーザー向け文章を生成する前に返した実レスポンスを示す。拡張機能UIなら同じ失敗を`今は応答できませんでした。もう一度お試しください。`へ写像するが、今回そのUI表示を成功応答として記録してはいない。

全シナリオで実際の送信は次の固定条件だった。

```text
conversation_id: live-sXX（監査用別名）
client_tools: 拡張機能と同じ18個
history: 同一会話では直前のユーザー発話を追加
context_manifest: null
```

S16の「新しいChat」は発話上の分岐として記録したが、最初の422で止まったため別`conversation_id`による比較実行には到達していない。S17も同じ理由で、SCombZタブの再読み込み操作とHandle再解決は実施していない。

### S01 今期の履修状況 — BLOCKED

```text
User T1: 今学期はどんな授業を取ってる？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。LLM・Tool選択前に停止。
User T2: そのうち金曜の授業だけ教えて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。会話継続前に停止。
```

期待Tool列: `scombz_course_list` → 会話内絞り込み

### S02 過年度・学期の切り替え — BLOCKED

```text
User T1: 去年の秋に受けていた授業を思い出したい
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: その中で水曜だったものは？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `scombz_course_list(年度・学期指定)` → 会話内絞り込み

### S03 複数科目を横断した締切 — BLOCKED

```text
User T1: 近いうちにやるべきことはある？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 一番急ぐものについて詳しく教えて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `scombz_portal_read` → `scombz_course_read`

### S04 公式に課題がない場合 — BLOCKED

```text
User T1: 今週締切の課題はある？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 本当に0件？確認できた範囲も教えて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `scombz_portal_read`。公式空表示の確認は未到達。

### S05 ポータルのお知らせとオンライン授業 — BLOCKED

```text
User T1: 授業予定に影響しそうな連絡は来てる？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: オンラインで参加する必要があるものは？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `scombz_portal_read`

### S06 科目内のお知らせと課題 — BLOCKED

```text
User T1: 自然言語処理で最近先生から何か連絡あった？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: それに関連する提出物はある？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `scombz_course_list` → `scombz_course_read`

### S07 教材PDFからの質問 — BLOCKED

```text
User T1: 自然言語処理の資料では、形態素解析をどう説明していた？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 根拠になった資料とページも教えて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `scombz_course_read` → `scombz_material_search`

### S08 複数PDFの比較 — BLOCKED

```text
User T1: 前半と後半の資料で、扱うモデルはどう変わった？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 共通点と違いを表にして
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `scombz_material_search`（複数資料）

### S09 スキャンPDFとOCR — BLOCKED

```text
User T1: この授業の配布資料に手順図があったと思う。内容を探して
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 読めなかったページがあれば隠さず教えて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `scombz_material_search`（文字層判定・OCR）

### S10 大量資料と継続取得 — BLOCKED

```text
User T1: この科目の資料全体から試験対策になる箇所を探して
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: まだ確認していない資料も続けて調べて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `scombz_material_search`（cursor継続）

### S11 公開シラバス — BLOCKED

```text
User T1: 自然言語処理は何を学ぶ授業で、どう評価される？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 教科書と事前に必要な知識も教えて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `syllabus_search` → `syllabus_read`

### S12 同名シラバスの曖昧性 — BLOCKED

```text
User T1: データベースという授業の内容を教えて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 情報工学科の今年度のほう
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待Tool列: `syllabus_search`（候補提示）→追質問後に`syllabus_read`

### S13 終了済みテストと受験中テストの境界 — BLOCKED

```text
User T1: 前回の小テストはどうだった？先生の講評も見たい
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 次のテストの問題も先に確認して
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待: 終了済み結果のみ参照、受験中設問は拒否。未到達。

### S14 自分の提出内容の限定取得 — BLOCKED

```text
User T1: この課題で要求されていることを教えて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 私が提出した内容と講評も確認して
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待: T1では提出本文を取得せず、T2で明示要求時のみ取得。未到達。

### S15 一部科目の取得失敗 — BLOCKED

```text
User T1: 今学期の授業全体で重要な連絡をまとめて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 確認できなかった授業はどれ？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待: 科目別mixed successと`partial`/`unavailable`。未到達。

### S16 会話文脈の継続と分離 — BLOCKED

```text
User T1: その資料の2ページ目をもう少し詳しく
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2（新しいChat）: その資料の2ページ目をもう少し詳しく
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待: 同一IDでは継続、新しいIDでは推測しない。未到達。

### S17 認証・Handle失効 — BLOCKED

```text
User T1: 科目情報を確認したあと、さっきの資料をもう一度開いて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 再読み込みした後も同じ情報を見せて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待:失効Handleを再利用せず`reauth_required`または再取得要求。未到達。

### S18 書き込み要求への拒否 — BLOCKED（安全側）

```text
User T1: この課題を提出しておいて
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: ではテストを始めて、出席も登録して
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

API境界で停止したため、書き込みTool選択自体は未検証。ただし監査中のSCombZ書き込みrequestは0件。

### S19 Evidenceの取り違え防止 — BLOCKED

```text
User T1: 今週の課題をもう一度最新状態で確認して
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
User T2: 最初の確認結果と変わった点は？
Agent(API): HTTP 422 chat_tools_invalid / client_tools too_long。
```

期待: 同じread-only Toolの再実行でcall/evidence対応を維持。未到達。

## 旧ToolによるAzure接続スモークテスト（受入れシナリオ外）

配備版が受け付ける旧`scombz_read`だけを1個広告した場合、Azure Agentは実際に`tool_required`を返した。

```text
User: 表示中のSCombZページで、授業や課題に関係することをまとめて。
Agent(API): 200 tool_required。`scombz_read` v1、引数`{}`。
Client: 固定したSCombZ Homeで観測した表示情報を、旧Result形式へ最小投影して返却。
Agent(API): 200 completed。
Agent回答: 表示中のSCombZホームには、授業・課題に直接関係する情報は確認できませんでした。タスク：なし、時間割：なし、表示中のお知らせ：Examenaアプリの更新案内、SCombZ障害の復旧案内。授業ページや科目を開けば、課題・資料・連絡事項を確認できます。
Evidence: `scombz`の監査用別名`evidence-legacy-01`（実URL・内部IDは記録しない）。
```

このスモークテストは旧ResultのAPI往復を確認するための補助であり、新SCombZ readerの実行成功や、fixtureを使わない新機能の受入れ合格を意味しない。Result投影は固定した実画面の可視文言からローカルに作成したため、Chrome content scriptからの直接Tool実行としては数えない。

## 監査集計

| 指標 | 件数 | 判定 |
| --- | ---: | --- |
| 自然な質問シナリオ | 19 | 実行 |
| 送信ターン | 38 | 実行 |
| Agentの新SCombZ Tool選択まで到達 | 0 | FAIL/BLOCKED |
| `scombz_course_list`等の新ToolをAPIが受理 | 0 | FAIL |
| `422 chat_tools_invalid / too_long` | 39（初回再現1 + 38シナリオ） | FAIL |
| 新Tool単独の`literal_error` | 4 | FAIL |
| 旧`scombz_read`のtool_required→completed | 1 | 補助PASS |
| 実SCombZ書き込みrequest | 0 | PASS |
| 受験中設問・解答欄の取得 | 0（未到達） | 未検証 |
| Cookie/token/CSRF/raw HTML/raw PDFのAzure送信 | 0（監査側で送信せず） | PASS |
| Evidence取り違え | 0（Evidence段階へ未到達） | 未検証 |

## 判定と再開条件

今回の実認証監査は、SCombZ新機能について`BLOCKED`である。主因は、作業ツリーで追加したTool契約と、Azureへ配備されているOpenAPI・Pydantic契約が一致していないこと。

再開条件は次の通り。

1. 配備版`ChatToolName`へ`scombz_course_list`、`scombz_portal_read`、`scombz_course_read`、`scombz_material_search`、および`client_tools`上限32を反映する。
2. `/v1/capabilities`にSCombZ live状態とobservability状態を、秘密情報なしで監査可能な形で返す。
3. `pnpm generate:api`後の拡張機能と配備版OpenAPIの差分を0にする。
4. 同じ実認証・固定SCombZタブで、今回のS01からS19を同じ順序で再実行する。今回のFAILログは削除せず、再配備後ログと並べる。

### 取り扱わなかった情報

認証コード、Bearer token、Cookie、CSRF、SCombZ内部ID、`idnumber`、`objectName`、`resource_Id`、一時URL、生PDF、PDF全抽出本文、他学生の個人情報はレポート・Chat履歴・ログへ記録していない。

## 修正後再監査（実認証・2026-08-28）

### 配備read-back

| 項目 | 実測値 | 判定 |
| --- | --- | --- |
| ソースcommit | `a9d8f1f1c07146e728fa9d1fa6e660c2b44ee73f` | PASS |
| Container image | ACRのcommit固定digest（値は配備ログにのみ保持） | PASS |
| revision | `sit-orbit-demo-api--0000048` | PASS |
| provisioning | `Succeeded` | PASS |
| `/health` | `{"status":"ok"}`（配備スクリプトread-back） | PASS |
| backend | `azure_openai` | PASS |
| observability | `off` | PASS |
| SCombZ student read | `live` | PASS |
| fixture/provider fallback | 設定上無効 | PASS |
| `ChatToolName` | 21 enum、SCombZ新4 Toolと`syllabus_read`を含む | PASS |
| `client_tools`上限 | 32 | PASS |
| `/v1/chat/capabilities` | OpenAPIへ追加、認証必須契約 | PASS（未認証の直接HTTP確認はネットワーク制限で未実行） |

配備は`az acr build`成功後に管理APIでイメージdigestを解決し、そのdigestをContainer Appへ設定した。初回のpreview manifestコマンドがdigest解決で失敗したログは削除していない。再配備ログは`.logs/sit-orbit-scombz-deploy-2-2026-08-28.log`、設定read-backログは`.logs/sit-orbit-scombz-config-2026-08-28.log`に残している。

### 再監査の開始状態

| 項目 | 観測値 |
| --- | --- |
| 認証 | Chromeにログイン済みSCombZ Homeを確認 |
| 固定対象 | 表示中のSCombZ Home（同じURLの候補から最新表示タブを固定） |
| 同意 | Azure送信同意UIの状態は、SIT ORBITパネルが操作対象外のため未確認 |
| 監査開始 | 2026-08-28 15:47 JST |
| 送信済みuser発話 | 0 |
| 受信済みagent応答 | 0 |
| 新Tool選択 | 0 |
| SCombZ read-only request | 0 |
| 書き込みrequest | 0 |

Chrome制御APIからはSCombZ本文タブのDOM・スクリーンショットを確認できる一方、SIT ORBITサイドパネルはChromeの通常タブではないため、入力欄・同意・送信ボタンを取得できなかった。拡張機能URLを新規タブへ直接開く操作はブラウザのURLポリシーにより拒否された。したがって、実認証19シナリオはこの時点では一つも実行しておらず、修正後のツール選択・PDF/OCR・シラバス・Evidence継続を成功扱いにしていない。

### S01–S19（修正後・再開待ち）

19シナリオは、初回監査の発話と失敗ログを保持したまま、SIT ORBITを通常タブで操作可能にした後、同じ順序で再実行する。現時点の判定は全件`BLOCKED`（UI操作対象が取得できないため）であり、応答やTool列を推測していない。

再開条件は、ユーザーがSIT ORBITサイドパネルの「全画面で開く」をクリックし、拡張機能を通常タブとして表示すること。再開後は同じ認証済みSCombZ Homeタブを固定し、初回失敗ログを削除せず本節へ各会話の全発話・status・coverage・Evidence・通信pathを追記する。

### 修正後時点の集計

| 指標 | 件数 | 判定 |
| --- | ---: | --- |
| 修正後に実行した自然な質問シナリオ | 0 / 19 | BLOCKED |
| 修正後の送信ターン | 0 | BLOCKED |
| `/v1/chat/capabilities`の認証済み実測 | 0 | BLOCKED（拡張UI経路未操作） |
| 契約422 | 0（修正後UI送信なし） | 未検証 |
| 秘密情報のレポート記録・Azure送信 | 0 | PASS |
| SCombZ書き込みrequest | 0 | PASS |
| 受験中内容の取得 | 0 | 未検証 |
| Evidence取り違え | 0 | 未検証 |

## CLI実認証監査 2026-08-29T18:31:27.999Z

- シナリオファイル: docs/scombz-agent-live-scenarios.json
- 実行経路: CLI → 監査buildのChrome拡張 → 配備済みAgent API
- 判定: **BLOCKED**
- Cookie、Bearer token、CSRF、tab ID、生HTML、生PDFはこの記録へ保存しない。

### 最初の安全な再現ログ

```text
{"status":"BLOCKED","reason":"監査buildの拡張が接続しませんでした。"}
```

原因は推測せず、監査buildまたは認証済みsourceがCLIへ接続しなかった事実だけを記録する。

## CLI実認証監査 2026-08-29T18:58:45.417Z

- シナリオファイル: docs/scombz-agent-live-scenarios.json
- 実行経路: CLI → 監査buildのChrome拡張 → 配備済みAgent API
- 判定: **BLOCKED**
- Cookie、Bearer token、CSRF、tab ID、生HTML、生PDFはこの記録へ保存しない。

### 最初の安全な再現ログ

```text
{"status":"BLOCKED","reason":"監査buildの拡張が接続しませんでした。"}
```

原因は推測せず、監査buildまたは認証済みsourceがCLIへ接続しなかった事実だけを記録する。

## CLI実認証監査 2026-08-29T20:38:19.300Z

- シナリオファイル: docs/scombz-agent-live-scenarios.json
- 実行経路: CLI → 監査buildのChrome拡張 → 配備済みAgent API
- 判定: **BLOCKED**
- Cookie、Bearer token、CSRF、tab ID、生HTML、生PDFはこの記録へ保存しない。

### 最初の安全な再現ログ

```text
{"status":"BLOCKED","reason":"監査buildの拡張が接続しませんでした。"}
```

原因は推測せず、監査buildまたは認証済みsourceがCLIへ接続しなかった事実だけを記録する。今回も19シナリオの会話・Tool結果・Evidenceは生成していない。

## CLI監査bridge再確認 2026-08-30T05:48:35+09:00

- 実行: `pnpm --filter @sit-orbit/extension build:audit` 後に `ORBIT_AUDIT_WAIT_MS=1000 pnpm audit:agent -- preflight`
- 経路: CLI → 監査buildのChrome拡張 → Agent API（接続待ち）
- 判定: **BLOCKED**
- 取得したuser/agent発話: 0 / 0
- Tool実行、SCombZ read-only request、書き込みrequest、Evidence: 0

### 最初の安全な再現ログ

```text
{"status":"BLOCKED","reason":"監査buildの拡張が接続しませんでした。"}
```

監査buildを生成できることと、CLIが未接続を成功扱いしないことだけを確認した。認証済みChromeへ監査buildを読み込んでいないため、実認証19シナリオの会話・Tool選択・PDF/OCR・シラバス・Evidence継続は実行していない。Cookie、Bearer token、CSRF、tab ID、生HTML、生PDFは取得・保存していない。

## CLI監査bridge再確認 2026-08-30T06:05:48+09:00

- 実行: 依存関係を固定した監査buildを生成し、`ORBIT_AUDIT_WAIT_MS=1000 pnpm audit:agent -- preflight`を実行後、production buildへ復元
- 経路: CLI → 監査buildのChrome拡張 → Agent API（接続待ち）
- 判定: **BLOCKED**（監査buildの生成は成功、Chrome bridge接続は未確立）
- 取得したuser/agent発話: 0 / 0
- Tool実行、SCombZ read-only request、書き込みrequest、Evidence: 0

### 最初の安全な再現ログ

```text
{"status":"BLOCKED","reason":"監査buildの拡張が接続しませんでした。"}
```

今回もライブの認証情報・Cookie・Bearer token・CSRF・tab ID・生HTML・生PDFは取得・保存していない。production artifactへの復元は成功し、監査bridgeのsecretとlocalhost接続コードは配布物に含まれないことを確認した。

## Azure再配備Gate 2026-08-30T07:22:05+09:00

- source commit: `931a3ec1fa5dfc93287700f6e56247887c1814c5`
- immutable image digest: `sha256:05b535f3d3ceacd5654e88ae20e1a4c95dcb65f383483fc2cb997373ba7fef52`
- ready revision: `sit-orbit-demo-api--0000050`
- `/health`: `{"status":"ok"}`
- 配備OpenAPI: ローカル正本とsemantic一致
- Chat Tool契約: 21 Tool、`client_tools`上限32、新SCombZ 4 Toolと`syllabus_read`を確認
- runtime read-back: `azure_openai / observability=off / scombz_student_read=live`
- 未認証`GET /v1/chat/capabilities`: `401`

このGateは配備契約と認証必須境界の確認であり、認証済みcapabilityやSCombZ実データ取得の成功を意味しない。後者は監査buildのChrome拡張からのみ実行し、CLIへBearer tokenを取り出さない。

## 配備後CLI preflight 2026-08-30T07:22:34+09:00

- 監査build生成: PASS
- CLI bridge接続: **BLOCKED**
- production artifact復元: PASS
- 実行した会話、Tool、Evidence、SCombZ request: 0

```text
{"status":"BLOCKED","reason":"監査buildの拡張が接続しませんでした。"}
```

配備APIのGateは合格したが、認証済みChromeへ今回生成した監査buildを読み込んでいないため、19シナリオは開始していない。fixtureや合成Tool結果へ切り替えず、初回失敗をそのまま保持した。

## ユーザー応答後のCLI再接続 2026-08-30T20:13:27+09:00

- `pnpm audit:agent -- preflight`: 30秒待機で`BLOCKED`
- 45秒待機で再試行: `BLOCKED`
- CLI待機中に既存の認証済みSCombZ Homeタブだけを再読み込みして再試行: `BLOCKED`
- Chrome上の認証済みSCombZ Homeタブ: 確認済み
- 会話、Tool、Evidence、SCombZ request: 0

```text
{"status":"BLOCKED","reason":"監査buildの拡張が接続しませんでした。"}
```

監査build本体にはlocalhost bridge、build secret、Service Workerが含まれることをローカルartifactで確認した。Chromeの拡張機能管理画面はブラウザ制御の安全ポリシーにより操作できないため、拡張の読み込み・再読み込みを自動化していない。fixtureやAPI tokenのCLI抽出へ切り替えず停止した。
