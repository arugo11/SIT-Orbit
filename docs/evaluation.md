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

Agent Harnessのclient Tool shortlistは、別のsynthetic/public held-out setで確認する。

```bash
PYTHONPATH=services/api uv run python -m evals.run_tool_routing_eval
```

この評価は外部モデルや認証済みConnectorを呼ばず、一般質問のno-tool判定、各学内familyの候補recall、追質問、混合依頼、prompt injectionを確認する。合格条件は、重要ケースのrecall 100%、全候補recall 95%以上、一般質問の学内Tool呼び出し0件、禁止・不正Tool 0件、候補数5件以下である。p50／p95はルーター処理時間であり、Connectorやモデル全体の高速化を表さない。

## W&B Weave evaluation

合成データをW&Bへ送信してよい場合だけ実行する。

```bash
ORBIT_OBSERVABILITY=wandb \
WANDB_ENTITY=<entity> \
WANDB_PROJECT=sit-orbit \
PYTHONPATH=services/api uv run python -m evals.run_eval --wandb
```

W&BではDataset、モデル呼び出し、各Scorer、latencyを比較できる。

OpenAI Backendを利用した場合は、対応するモデル呼び出しのtokenとcostもtraceへ記録される。

## Azureモデル選定の暫定評価

モデルの初期順位は、実測前の暫定判断として次のように置く。

| 役割 | Azure deploymentの候補 | 用途 |
| --- | --- | --- |
| Primary | GPT-5.6 Terra | 通常デモ |
| Quality demo | GPT-5.6 Sol | 決勝など品質重視のデモ |
| Challenger | GPT-5.6 Luna | 低コスト候補 |

deployment名はAzure側で利用者が決めるため、アプリケーションへ埋め込まない。
同じ16件の合成ケースを、明示したroleとdeploymentの組み合わせへ順番に実行して比較する。

```bash
ORBIT_OBSERVABILITY=off \
AZURE_OPENAI_ENDPOINT="https://<resource>.openai.azure.com" \
AZURE_OPENAI_API_KEY="<secret>" \
PYTHONPATH=services/api uv run python -m evals.run_model_selection \
  --role terra=<terra-deployment> \
  --role luna=<luna-deployment> \
  --role sol=<sol-deployment> \
  --output /tmp/sit-orbit-model-selection.json
```

このコマンドは通常の`run_eval`やCIとは別であり、環境変数、Azure endpoint、deployment mapping、`ORBIT_OBSERVABILITY=off`が揃わない場合は開始しない。
実行対象は`evals/model_selection_cases.jsonl`のsynthetic/public dataだけである。
モデルの応答をLLM Judgeで採点せず、次のhard failureと、ケースごとの提案本文、Evidence ID、経過時間、token、best-effort costを記録する。提案本文を残すのは合成・公開ケースだけであり、モデル間の定性的な差を人が確認するために使う。

- Calendar Toolの予期しない呼び出し、未呼び出し、複数回呼び出し、未対応呼び出し
- 未知のEvidence IDまたは根拠の完全性の破れ
- 根拠にない事実の追加
- 外部操作に対する利用者確認の欠落
- 構造化出力の失敗
- ケースに明示した利用可能時間を超える提案

根拠外事実の自動判定は、各ケースの`forbidden_terms`に定義した既知のtrapだけを対象とする。別表現を含むすべての幻覚を機械的に判定するものではない。
そのため、hard failureが0件であることはPrimary候補に残るための必要条件であり、十分条件ではない。JSONに記録された提案本文とEvidence IDを人が確認してから、Primaryを確定する。

いずれかのdeploymentでhard failureが発生した場合、Runnerは非ゼロ終了する。
結果は明確な`--output`を指定した場合だけJSONファイルへ保存し、指定しなければ標準出力に表示する。

Azure Standard Globalの暫定単価は、入力／出力100万tokenあたりTerraが$2／$12、Lunaが$0.20／$1.20、Solが$5／$30である。
PydanticAIがcostを返さない場合だけ、この単価から推定する。
Global deploymentは複数リージョンで処理され得るため、実データ利用前にdeployment type、リージョン、データ処理条件を別途確認する。

参考：
[Microsoft FoundryのGPT-5.6発表](https://azure.microsoft.com/en-us/blog/gpt-5-6-now-available-in-microsoft-foundry/)、
[Azureのデータ処理方針](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy)。

Gemini 3.7 Flash Paidは、同じ合成ケースで比較する将来のchallenger候補とする。
このbranchではGoogle用Adapterや依存を追加せず、実Calendar派生値を送信しない。
Geminiの価格は2026年12月31日までは入力$0.75／出力$3.75、2027年1月1日から入力$1.50／出力$7.50（いずれも100万tokenあたり）と記録するが、実行時点の公式料金を再確認する。
[Google公式リリースノート](https://ai.google.dev/gemini-api/docs/changelog)、
[Gemini API料金表](https://ai.google.dev/gemini-api/docs/pricing)、
[PydanticAI Googleモデル](https://pydantic.dev/docs/ai/models/google/)。

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
