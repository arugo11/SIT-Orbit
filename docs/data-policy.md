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

W&Bについても、初期版では同じ区分だけを対象とする。

## Complimentary API usage

OpenAIのData Sharingに伴う無料枠は、対象Projectに適用表示がある場合だけ利用する。

無料枠の有無や上限をアプリの成立条件にしない。

Data Sharingを有効にするProjectには、公開・合成データ以外を送らない。

## Repository

`.env`、秘密鍵、API key、個人資料、提出フォームの原本はGitへ追加しない。

公開へ切り替える前に、履歴を含めた秘密情報と個人情報の確認を別途行う。

## Browser extension and connectors

Chrome拡張機能は、初期版ではScombZの表示中ページから必要な情報だけを読み取る。

ページのHTML全体、Cookie、OAuth token、パスワード、ブラウザ履歴をAgent APIへ送信しない。

ScombZ以外のサービスは、サービスごとのOAuth同意、正式API、または利用者が明示的に開いたページの読み取りを必要とする。

ScombZへのログイン状態を、Google Drive、Google Calendar、Microsoft Graph、SIT Portfolio、CAST、OPACの認証として扱わない。

Connectorは、`not_connected`、`connected`、`reauth_required`、`unavailable`の状態を表示する。

外部サービスへの書き込みは、Agentが候補を作成した後、利用者が確認した場合だけ実行する。

拡張機能のローカルキャッシュは短期間の表示補助に限り、長期的な証跡の正本にはしない。

実データを扱うConnectorを追加する場合は、送信先、保存期間、削除方法、利用目的、大学の許可範囲を個別に確認する。
