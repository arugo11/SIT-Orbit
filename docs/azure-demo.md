# Azure Container Apps運用

SIT ORBITのproduction Chatは、Azure Responses APIのHosted Tool Searchを利用する。通常の開発・CIは外部APIを呼ばず、Chat fixtureは一般回答だけを返す。Action Agentの合成fixtureデモと、ChatのAzure acceptanceを混同しない。

## 固定するモデル契約

```text
AZURE_OPENAI_MODEL=gpt-5-6-terra       # Azure deployment alias
AZURE_OPENAI_BASE_MODEL=gpt-5.6-terra  # PydanticAI canonical profile
```

この組み合わせは`native_tool_search.py`のallowlistで検証する。PydanticAI profileが`ToolSearchTool`とResponsesの`with_tool_search` / `with_definitions`を宣言しない場合は、起動・deploy前に停止する。別モデル、通常OpenAI backend、ローカル語句検索、provider fallbackは用意しない。

## Student subscription境界

Azure操作は、利用者が明示したAzure for Students subscription内の既存resourceだけを対象にする。`scripts/azure/_students_guard.sh`は次をread-backしてから各スクリプトを続行する。

- `ORBIT_AZURE_SUBSCRIPTION`が設定され、対象subscriptionが`Enabled`
- `quotaId`が`AzureForStudents_`系で、spending limitが有効
- Resource Group、Container Apps environment、ACR、Managed Identity、Container App、Azure OpenAI account、deploymentが同じsubscription内で`Succeeded`

別subscriptionの利用、新規resource作成、SKU変更、role assignment作成は行わない。不足や不一致があれば停止し、既存resourceを変更しない。

## 既存resourceへrevisionを出す

事前に既存resource名とimage tagを環境変数へ設定する。秘密値は`.env`やログへ保存しない。

```bash
export ORBIT_AZURE_SUBSCRIPTION="<existing-student-subscription-id>"
export ORBIT_AZURE_RESOURCE_GROUP="<existing-resource-group>"
export ORBIT_AZURE_ENVIRONMENT_ID="<existing-container-apps-environment-id>"
export ORBIT_AZURE_REGISTRY="<existing-acr-name>"
export ORBIT_AZURE_CONTAINER_APP="<existing-container-app>"
export ORBIT_AZURE_IDENTITY="<existing-user-assigned-identity>"
export ORBIT_AZURE_OPENAI_ACCOUNT="<existing-azure-openai-account>"
export ORBIT_AZURE_IMAGE_TAG="<candidate-tag>"

scripts/azure/deploy.sh
scripts/azure/health.sh
```

`deploy.sh`はresourceを作成せず、既存ACRでimageをbuildし、Container AppsをMultiple revision modeへ設定する。直前のHealthy revisionを100%のまま保持し、新revisionは0% trafficで作成する。candidateのhealth、environment、backend、deployment alias、canonical profile、synthetic API確認をread-backしてからだけ100%へ昇格する。失敗時は`rollback.sh`で直前のHealthy revisionへtrafficを100%戻し、candidateは診断用に0%で残す。

```bash
scripts/azure/rollback.sh
```

待機時は`scale-to-zero.sh`を使う。削除やresource group全体の操作はこの手順に含めない。

## Azure OpenAI設定

既存のAzure OpenAI accountとdeploymentだけを対象に、`configure-openai.sh`でContainer App Secretと環境変数を更新する。account/deploymentのsubscription、provisioning state、model name、Responses対応、native Tool Search profileをread-backする。

```bash
export ORBIT_AZURE_OPENAI_ACCOUNT="<existing-account>"
export ORBIT_AZURE_OPENAI_DEPLOYMENT="gpt-5-6-terra"
export AZURE_OPENAI_MODEL="gpt-5-6-terra"
export AZURE_OPENAI_BASE_MODEL="gpt-5.6-terra"
scripts/azure/configure-openai.sh
```

一般Web検索、関連書籍探索、server-side OPACは、構成済みの場合だけTool Catalogへ登録される。SITRUSは`azure_openai + live + observability=off + auth-only preflight`の交差が成立した場合だけeligibleであり、GPA、氏名、学籍番号、生レスポンスは送信しない。

## Chrome live acceptance

production extensionを再build・再読込し、同じ会話で次を確認する。

1. 「去年の情報工学科で卒業した人の就職先」から`cast_search(kind="hiring_record", filters.graduation_years=[2025], filters.academic_programs=["情報工学科"])`を選ぶ。
2. 続く「それを仕事として体験するなら今参加できるもの」から`cast_search(kind="internship", filters.include_closed=false)`を選ぶ。
3. 「CASTとの連携機能では何ができる？」では`describe_available_capabilities`だけを使い、CASTデータを読まない。

Tool実行表示、条件、端末内詳細とAgent向け匿名集計の分離、Evidenceを確認する。`reauth_required`は再認証を一度だけ許し、`form_changed`、再失敗、条件不一致、Evidence欠落、privacy境界違反は成功扱いにしない。live acceptance失敗時はアプリ内fallbackを追加せず、直前のHealthy revisionへ戻す。

## 診断ログと停止

アプリのtelemetryは発見Tool名、実行Tool名、所要時間、成否だけを記録する。ユーザー本文、Tool Search文、引数、結果、Evidence内容、例外本文はAzureやログへ残さない。

`health.sh`はrevisionのhealth、traffic、backend、canonical profileを読み戻す。確認できない状態を成功とは扱わず、Container Appは0% candidateのまま停止する。
