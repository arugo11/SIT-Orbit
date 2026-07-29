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
