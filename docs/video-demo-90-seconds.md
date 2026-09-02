# 90秒デモ収録手順

## デモの主題

機能名を列挙するデモではなく、学生の曖昧な関心を、現在の授業、仕事体験、今日読める本へつなぐ一続きの相談を見せる。

収録用のfixture、mock、固定回答は使用しない。

Chat、SCombZ、CAST、公式OPACを実際に呼び出し、取得不能、再認証要求、結果0件を成功へ置き換えない。

## 収録で使う3つの質問

1. 「今受けている授業の中で、AIをもっと深く学べそうなテーマを一つ見つけて。」
2. 「それを仕事として体験できる機会もある？」
3. 「まず今日から理解を深めたい。芝浦で今借りられる本を一冊探して。」

ユーザーはSCombZ、CAST、OPACという機能名を言わない。

Agentが会話の文脈から、順に`SCombZ course list/read`、`CAST search`、`library catalog search/item read`を選ぶ。

## 90秒の構成

| 時刻 | 画面操作 | 見せる価値 |
| --- | --- | --- |
| 0:00から0:05 | SIT ORBITの新規Chatを表示する | 一般的な相談から始められること |
| 0:05から0:27 | 質問1を送る | 現在の履修授業を根拠に、関心のあるテーマを一つ選ぶこと |
| 0:27から0:49 | 質問2を送る | 前のテーマを引き継ぎ、仕事体験の機会をCASTで探すこと |
| 0:49から1:13 | 質問3を送る | 同じテーマを引き継ぎ、公式OPACで実在する所蔵本を探すこと |
| 1:13から1:25 | 最終回答とEvidenceを表示する | 授業、仕事体験、書籍が一つの次の行動につながること |
| 1:25から1:30 | 画面を静止する | 読み取りだけで完結し、外部書き込みをしていないこと |

各回答が完了してから次の質問を送る。

待ち時間を編集で削って90秒に見せない。1分25秒までに第3回答が完了しなければ、そのテイクは不採用にする。

## 実装済みの抽象質問ルーティング

Tool Routerは次の自然な表現をサービス名なしで判定する。

- 「今受けている授業の中で…」はSCombZの履修一覧と授業詳細。
- 「仕事として体験できる？」はCAST検索。
- 「芝浦で今借りられる本」は公式OPAC検索と書誌詳細。
- 「この興味を授業・仕事体験・読める本につなげたい」のような横断相談は、シラバス、CAST、OPACを最大5候補へ均等に収める。

個別機能を名指しした質問は、従来どおりその機能を優先する。

## 2026年9月2日の検証結果

### 通過

- Routerの対象テストは39件すべて通過した。
- 43件のrouting evalで`critical_recall=1.0`、`shortlist_recall=1.0`、`no_tool_accuracy=1.0`、禁止Tool呼び出し0件だった。
- 評価中の外部モデル呼び出しは0で、Routerのp95は0.290msだった。
- production preflightはAzure OpenAI backend、21個のread-only Tool、認証済みSCombZ sourceを検出した。
- 公式OPACへの実検索は`status=known`で3件を取得した。
- 公式OPACの実検索は6.216秒、書誌詳細取得は8.225秒だった。
- 『Pythonで学ぶ強化学習 : 入門から実践まで. 改訂第2版』は、豊洲図書館と大宮図書館で`available`、請求記号は`007.13/Ku11`だった。

### 本線から除外

- 公式シラバス検索は実通信に成功したが、「人工知能」「強化学習」「情報セキュリティ」「ロボット」などで結果が0件だった。
- 0件を成功へ置き換えられないため、収録本線ではシラバスを呼び出さない。
- SITRUSは成績等の個人情報を含むため、この90秒デモでは使用しない。

### 未通過

- preflight時点のSCombZ外部送信同意は`false`だった。
- 実Chatはsource選択までは動作したが、その後、監査buildとの接続が切れて完走しなかった。
- CASTの認証済み検索結果と所要時間は、今回の実Chatではまだ取得できていない。
- したがって、現時点で上記3ターンを「確実に通る収録経路」とは判定しない。

## 収録前の実受入

productionの監査buildを生成し、Chromeの拡張機能管理画面でSIT ORBITを再読み込みする。

```bash
ORBIT_EXTENSION_PROFILE=production \
ORBIT_PRODUCTION_AGENT_API_BASE=https://sit-orbit-demo-api.grayground-578aed68.japaneast.azurecontainerapps.io \
pnpm --filter @sit-orbit/extension build:audit
```

preflightは次のコマンドで確認する。

```bash
pnpm audit:agent preflight
```

次を満たしてから、3質問を同じ会話で3回連続実行する。

- ユーザー自身がSCombZの最小化projection送信へ同意している。
- SCombZにログイン済みで、履修授業が取得できる。
- CASTにログイン済みで、検索対象ページを開いている。
- Chrome ChatからAgent APIへの認証が成功している。
- 画面に氏名、学籍番号、メールアドレス、Cookie、内部IDが映っていない。
- 3回とも1分25秒以内に第3回答が完了する。
- 3回とも同じTool系列が呼ばれ、回答とEvidenceがTool Resultに一致する。

1回でも`unavailable`、`reauth_required`、0件、timeout、Evidence不一致になった場合は収録を開始しない。

## 合格条件

- 質問1で`scombz_course_list`の後に`scombz_course_read`が呼ばれる。
- 質問2で`cast_search`が呼ばれる。
- 質問3で`library_catalog_search`が呼ばれ、必要なら`library_item_read`へ進む。
- 三つの回答が同じAIテーマを引き継ぐ。
- タイトル、所在地、貸出状態、仕事体験の集計がTool Resultと一致する。
- `unknown`を貸出可または貸出中へ置き換えない。
- Evidenceが表示される。
- 予約、応募、連絡、延長などの外部書き込みを行わない。
- 最終回答の静止表示まで90秒以内に収まる。

## 現在の停止条件

Routerの実装と回帰検証は完了している。

収録可否を確定するには、ユーザー本人によるSCombZ送信同意とCASTログイン後に、production Chatで3ターンを実測する必要がある。
