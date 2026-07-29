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
