# SIT ORBIT

> 二つのキャンパス、四年間、一つの軌道。

芝浦工業大学向けの個人用キャンパスエージェントです。

キャンパスで起きる出来事を次の行動に変え、その結果を記録し、日々の学びを長期的な成長の証拠へつなげます。

このリポジトリは、AI Innovators Cup 2026のデモに向けた初期基盤です。

次の構成要素を含みます。

- FastAPIで実装したエージェントAPI
- Next.jsのWebアプリケーション
- Expoのモバイルアプリケーション
- 外部モデルを呼び出さない決定論的なfixture
- 合成デモデータ向けのOpenAI、Azure OpenAI、およびW&B Weaveのオプションアダプター

## 環境要件

- Python 3.13
- uv
- Node.js 24 LTS
- pnpm 11.9.0

## セットアップ

```bash
uv sync
pnpm install
pnpm generate:api
```

APIデモまたはW&Bのトレースを使う場合だけ、`.env.example`を`.env`へコピーしてください。

標準設定では、決定論的なfixtureバックエンドを使用します。

Azure Container Appsへの合成デモ配置手順は[`docs/azure-demo.md`](docs/azure-demo.md)にまとめています。

## 起動

```bash
uv run uvicorn orbit_api.main:app --app-dir services/api --reload
pnpm --filter @sit-orbit/web dev
pnpm --filter @sit-orbit/mobile start
```

## 検証

```bash
uv run ruff check .
uv run pyright
uv run pytest
PYTHONPATH=services/api uv run python -m evals.run_eval
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## データポリシー

W&B WeaveとOpenAIは、標準では無効になっています。

どちらのサービスにも、公開データまたは合成デモデータだけを送信できます。

このリポジトリに、学生の記録、成績、非公開の授業資料、未公開の研究、APIキー、OAuthトークンを追加しないでください。

MVPのデータポリシーについては、[`docs/data-policy.md`](docs/data-policy.md)を参照してください。
