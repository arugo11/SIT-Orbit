# SIT ORBIT Product Brief

## Product definition

SIT ORBITは、芝浦工業大学で生じる授業・研究・課外活動を横断し、学生一人ひとりに「次の一手」を提案するPersonal Campus Agentである。

単なる情報集約や汎用チャットではなく、現実のイベントから行動を提案し、実行結果を将来利用できる証跡として残す。

## Core loop

```text
イベントを観測する
    ↓
関係する証跡を選ぶ
    ↓
実行可能な行動を一つ提案する
    ↓
学生が承認・変更・却下する
    ↓
完了結果を新しいイベントとして残す
```

## Chat and campus evidence

Chatは一般的な会話、推論、公開Web調査、公開ページ・PDF読解、下書き、計画作成をToolなしでも行える。認証済み学内情報が必要な場合だけAgent Harnessが利用可能なSCombZ、Calendar、Moodle、My Library、CAST、SITRUS、シラバス、図書館Toolを絞り込み、最小化したEvidenceを回答へ戻す。

SITRUSについては、「私の成績を教えて」「何単位取れている？」のような個人成績の意図をTool Routerが検出する。
管理者がAzure OpenAI向けのlive personal contextを有効化し、利用者がSITRUSへログイン済みの場合だけ、取得済み科目と単位集計を回答へ利用する。

学内Toolを利用できない場合は一般論を実取得結果として補わず、`partial`、`unavailable`、`reauth_required`または「学内情報を確認していない」と表示する。Extensionが認証済みConnectorの中心であり、WebとMobileのfixture画面を実連携として提示しない。

## Runtime profiles

本番と収録用デモは、明示した実行プロファイルと別々のAPI originで分離する。本番は`ORBIT_RUNTIME_PROFILE=production`でfixture backendを拒否し、デモは`ORBIT_RUNTIME_PROFILE=demo`、`ORBIT_AGENT_BACKEND=fixture`、`ORBIT_SCOMBZ_STUDENT_READ=fixture`、observability無効の組合せだけを許可する。拡張機能もproduction buildからデモfixtureを除外し、demo buildでだけ合成結果を接続する。どちらのプロファイルも、失敗時に他方へ自動切替しない。

収録用デモでは画面上のモード表示を追加しない。モードの識別はデプロイ先、build profile、APIのread-backで行い、利用者向けChatは製品と同じ表示を保つ。

## Foundation scenario

B1の学生が大宮キャンパスへ到着する。

次の授業まで18分あり、翌日締切の微分積分学課題と直近の誤答履歴が存在する。

SIT ORBITは、合成関数の微分を2問確認する12分間の行動を提案する。

学生が承認して完了した場合、その結果を`action_completed`イベントとして記録する。

このシナリオはすべて合成データで再現する。

## Non-goals for the foundation

- ScombZ、SIT Portfolio、My Libraryへの実接続
- 大学認証情報の取得・保存
- 課題や応募書類の自動提出
- 成績や技能の公式認定
- 常時位置追跡
- 複数Agentによる自律実行
- B1からB4までのLearner Twinの完成

図書館操作はfoundation loopの外側にあるBranch 3として、公式ページからのread-only options、棚／公式viewerの案内、明示確認付きのbounded previewまでを提供する。予約・延長・購入・ILLなどのlive writeは、providerのform/CSRF/submit/read-backを検証できるまで利用不可として表示し、成功をシミュレートしない。

## Product language

- Product name: `SIT ORBIT`
- Main message: `Two Campuses. Four Years. One Orbit.`
- Japanese message: `点だった今日が、未来の軌道になる。`
- Daily action: `Next Vector`
- Trace and context display: `Telemetry`
