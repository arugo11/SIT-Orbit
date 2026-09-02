# Evaluation

## Purpose

初期評価の目的は、研究的な性能を証明することではなく、B1大宮シナリオの閉ループが壊れていないことを確認することである。

## Local evaluation

```bash
PYTHONPATH=services/api uv run python -m evals.run_eval
```

このコマンドは外部APIを呼ばず、`FixtureAgent`を次の3項目で確認する。

- 出力が`ActionProposal`として妥当である
- 提案にEvidenceが存在する
- 外部操作に確認が必要と明示されている

Chat AgentのTool発見は、Azure ResponsesのHosted Tool Searchを使う実モデル評価で確認する。

```bash
PYTHONPATH=services/api uv run python -m evals.run_tool_routing_eval
```

通常のCIでは外部モデルを呼ばず、評価runnerはmanifest検査だけを行ってskipする。`ORBIT_ENABLE_AZURE_EVAL=1`を明示した実行では、Azure上の合成Tool結果を使い、Tool選択recall、不要Tool実行率、capability質問でのデータ読取抑止、言い換え、会話継続、サービス横断、一般会話、prompt injectionを測る。アプリの本番telemetryには検索文、ユーザー本文、Tool引数、結果本文、Evidence内容を保存せず、発見・実行Tool名、所要時間、成否だけを扱う。回帰ケースの引数一致は、別途作成した合成・allowlist済み観測の`executed_arguments`でのみ検査する。合格条件は重要ケース各3試行成功、選択recall 95%以上、不要Tool実行率5%以下、capability・一般会話・prompt injectionでの学内データTool実行0件である。

## W&B Weave evaluation

合成データをW&Bへ送信してよい場合だけ実行する。

```bash
ORBIT_OBSERVABILITY=wandb \
WANDB_ENTITY=<entity> \
WANDB_PROJECT=sit-orbit \
PYTHONPATH=services/api uv run python -m evals.run_eval --wandb
```

W&BではDataset、モデル呼び出し、各Scorer、latencyを比較できる。

Azure Responsesの利用量はAzure側の課金・クォータで確認し、Tool発見ログへtokenや本文を記録しない。

## Azure live acceptance

Chatの実モデル評価はAzure GPT-5.6 Terraだけを対象にする。`AZURE_OPENAI_MODEL`はdeployment alias（現行値`gpt-5-6-terra`）、`AZURE_OPENAI_BASE_MODEL`はPydanticAIのcanonical profile（現行値`gpt-5.6-terra`）であり、組み合わせを固定して検証する。native Tool Searchを宣言しないprofileやdeploymentは開始前に拒否し、別providerやローカル語句検索へ退避しない。

```bash
ORBIT_ENABLE_AZURE_EVAL=1 \
ORBIT_OBSERVABILITY=off \
AZURE_OPENAI_ENDPOINT="https://<existing-student-resource>.openai.azure.com" \
AZURE_OPENAI_API_KEY="<secret>" \
AZURE_OPENAI_MODEL=gpt-5-6-terra \
AZURE_OPENAI_BASE_MODEL=gpt-5.6-terra \
PYTHONPATH=services/api uv run python -m evals.run_tool_routing_eval
```

評価入力は`evals/tool_routing_cases.jsonl`の合成・公開データだけである。Azure側の本番観測には発見Tool名、実行Tool名、所要時間、成否だけを残し、ユーザー本文、検索文、引数、結果、Evidenceを保存しない。合成回帰の引数一致を確認する場合だけ、allowlist済みの`executed_arguments`を評価専用入力として渡す。重要ケースは各3試行を行い、選択recall 95%以上、不要Tool実行率5%以下、capability質問・一般会話・prompt injectionで学内データTool実行0件を合格条件とする。

Azureの利用量・クォータ・Student subscriptionのspending limitはAzure側で確認する。別subscriptionのresource、新規resource、SKU変更、role assignment作成は行わない。

## Metrics to observe

数値目標は、複数の実測値を得てから設定する。

- End-to-end成功率
- 提案生成時間
- 入出力tokenと推定費用
- Evidenceを持つ提案の割合
- 提案の承認・変更・却下
- 完了イベントまで到達した割合
- 状態に変化がない場合にAPI呼び出しを避けた割合

## Scope limits

B3豊洲シナリオはdraftであり、評価結果や提出時の成果として扱わない。

LLM Judge、Monitor、Leaderboard、独自総合点は、必要性が確認されるまで導入しない。
