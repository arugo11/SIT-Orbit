# SIT ORBITエージェント契約

## ミッション

SIT ORBITは、芝浦工業大学向けのパーソナルキャンパスエージェントです。

現在のMVPは、キャンパスイベントを証拠に基づいたアクションに変換し、
ユーザーの明示的な承認を記録し、完了を新しいイベントに変換します。

## 現在のスコープ

- `services/api`にあるFastAPIエージェントAPI。

- `apps/web`にあるNext.js Web UI。

- `apps/mobile`にあるExpoモバイルUI。

- `packages/api-client`にあるOpenAPIで生成されたTypeScript型。


具体的な現在の要件がない限り、グラフデータベース、メッセージブローカー、マルチエージェントフレームワーク、ポリシーエンジン、
または新しいサービスを追加しないでください。


## 信頼できる情報源

- `services/api/orbit_api/models` にある Pydantic モデルが API 契約を定義します。

- `docs/product.md` は製品の意図を定義します。

- `docs/data-policy.md`に従ってください.

- `docs/contest.md` は、独自の重み付けをすることなく、公式の審査基準を再現します。


## 開発コマンド

Python は `uv` を介してのみ使用してください。

```bash
uv sync
uv run ruff check .
uv run pyright
uv run pytest
PYTHONPATH=services/api uv run python -m evals.run_eval
```

Node.js の開発には pnpm を使用してください。


```bash
pnpm install
pnpm generate:api
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## モデルと可観測性に関するポリシー

- 通常の開発およびCIでは、`ORBIT_AGENT_BACKEND=fixture`を使用します。

- 通常のテストの作成または実行中に、外部モデルを呼び出さないでください。

- あるモデルまたはバックエンドから別のモデルまたはバックエンドに自動的にフォールバックしないでください。

- Azure OpenAIでは、`ORBIT_AGENT_BACKEND=azure_openai`、エンドポイント、デプロイメント名、canonical profile（`AZURE_OPENAI_BASE_MODEL`）、およびAPIキーが必要です。

- Azure操作は、利用者が明示指定した既存のAzure for Students subscription内に限定してください。別subscriptionの利用、新規resource作成、SKU変更、role assignment作成は行わないでください。

- W&Bでは、`ORBIT_OBSERVABILITY=wandb`と明示的なW&B構成が必要です。

- 個人データの外部送信は、`docs/data-policy.md`に明記した送信先・項目・実行条件を満たす例外だけを許可します。

- 匿名化する情報は匿名化の機能を用いて匿名化後送信してください. 

## 製品の不変条件

- 外部への書き込みは、ユーザーが明示的に承認するまで提案のままです。

- AIによって生成されたテキストは、大学の公式記録ではありません。

- すべてのアクション提案には、その生成に使用された証拠を明記してください。

- 正式な承認済み統合が存在するまでは、ScombZ、SIT Portfolio、My Library、またはキャンパスインフラストラクチャが統合されていると主張しないでください。

- 継続的な位置情報履歴を保持しないでください。

- 要求された統合が利用できない場合は、隠されたフォールバックや成功をシミュレートするのではなく、制限事項を説明してください。

## Gitワークフロー

- `codex/`ブランチで作業してください。

- `main`ブランチに直接プッシュしないでください。

- 関連性のないユーザー変更は保持してください。

- `chore:`、`feat:`、`docs:`、`ci:`などのプレフィックス付きコミットサブジェクトを使用してください。

- 1タスクにつき1つの`codex/`ブランチとworktreeを使い、同じworktreeを並行共有しない。

- タスク終了時は未コミット差分をコミットするか、引継ぎ先を明記する。

- 統合済みと確認できたbranch/worktreeだけを削除する。

破壊的な操作、強制プッシュ、一括削除、または
チェックポイントの上書きを行う前に確認してください。

## 検証

変更後、必要最小限のチェックを実行してください。

プルリクエストを送信する前に、上記のPythonおよびpnpmコマンドセットをすべて実行してください。

APIコントラクトの変更には、`pnpm generate:api`と生成されたタイプのレビューが必要です。

長時間実行される処理では、名前付きtmuxセッションと明示的なログパスを使用する必要があります。

## 停止条件

実装に、
大学への不正アクセス、実際の学生データ、不明な外部書き込み権限、または
現在のMVPを超える大幅な拡張が必要となる場合は、停止して理由を報告してください。
