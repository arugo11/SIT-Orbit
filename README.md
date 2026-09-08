# SIT ORBIT

> 二つのキャンパス、四年間、一つの軌道。

芝浦工業大学向けの個人用キャンパスエージェントです。

キャンパスで起きる出来事を次の行動に変え、その結果を記録し、日々の学びを長期的な成長の証拠へつなげます。

このリポジトリは、AI Innovators Cup 2026のデモに向けた初期基盤です。

次の構成要素を含みます。

- FastAPIで実装したエージェントAPI
- Next.jsのWebアプリケーション
- Expoのモバイルアプリケーション
- Azure OpenAI Responses APIのnative Tool Searchに対応した本番アダプター
- 外部モデルを呼び出さない決定論的なfixture（Chatは一般回答のみ）

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

APIまたはW&Bのトレースを使う場合だけ、`.env.example`を`.env`へコピーしてください。

標準設定では、決定論的なfixtureバックエンドを使用します。

Azure Container Appsへの合成デモ配置手順は[`docs/azure-demo.md`](docs/azure-demo.md)にまとめています。

## 起動

```bash
ORBIT_AGENT_BACKEND=fixture ORBIT_OBSERVABILITY=off ORBIT_CORS_ORIGINS=http://localhost:3000 uv run uvicorn orbit_api.main:app --app-dir services/api --reload
pnpm --filter @sit-orbit/web dev
pnpm --filter @sit-orbit/mobile start
```

WebとMobileの行動画面は、合成データの提案を取得し、所要時間の変更、承認、却下、完了まで操作できます。
fixture以外のAPIに接続した場合は体験を開始しません。
Webの接続先を変える場合は`NEXT_PUBLIC_ORBIT_API_BASE_URL`、Mobileでは`EXPO_PUBLIC_ORBIT_API_BASE_URL`を起動時に設定します（既定は`http://localhost:8000`）。
Mobileの実機からはlocalhostで開発マシンへ接続できないため、同じネットワークから到達できる開発マシンのアドレスを使い、APIを`--host 0.0.0.0`で起動してください。
Webのポートを変える場合は`ORBIT_CORS_ORIGINS`も実際のoriginに合わせます。

完了記録は発行済みの提案と照合し、同じ完了要求の再送には同じイベントを返します。
提案と完了応答は同じAPIプロセス内に最大256件、24時間保持し、再起動で消えます。
期限切れや再起動後は提案を取得し直してください。
監査で見つかった不足と実環境での未確認事項は、[2026年9月8日の実装監査](docs/completion-audit-2026-09-08.md)にまとめています。

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

W&B WeaveとAzure OpenAIは、標準では無効になっています。

W&Bには公開・合成データだけを送信します。Azure OpenAIは、`docs/data-policy.md`に定めた
認証済み・最小化・仮名化済みの狭い例外を除き、公開・合成データだけを送信します。

このリポジトリに、学生の記録、成績、非公開の授業資料、未公開の研究、APIキー、OAuthトークンを追加しないでください。

MVPのデータポリシーについては、[`docs/data-policy.md`](docs/data-policy.md)を参照してください。

## Resumable Agent run

Extensionの明示的な提案クリックは`POST /v1/agent/runs`から開始します。Google Calendar接続中だけ`google_calendar_availability` v1を広告し、要求された場合はService Workerの非対話refreshで得た導出済み空き時間だけを`POST /v1/agent/runs/{run_id}/tool-results`へ返します。

runはAPIプロセスのメモリ内に600秒だけ保持し、完了・失敗・期限切れで削除します。OAuth token、予定の詳細、Google Drive情報はAPIやrun storeへ送信しません。
