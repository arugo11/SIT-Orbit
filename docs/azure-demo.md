# Azureデモランタイム

SIT ORBITのデモAPIをAzure Container Apps Consumptionへ配置するための手順です。
ここで扱うデータは、公開データまたは合成データに限定します。通常の開発とCIは外部APIを呼ばず、`fixture`バックエンドだけを使います。

## 採用範囲

- FastAPI API：Azure Container Apps
- コンテナ：リポジトリ直下の`Dockerfile`をACRでremote build
- Image pull：ユーザー割り当てManaged Identity
- スケール：最小レプリカ数0、最大レプリカ数1
- デモの既定Backend：`fixture`
- モデルBackend：明示設定時だけ`azure_openai`
- Web：この手順では配置しない

`deploy.sh`は既存のContainer Apps environmentとAzure Container Registry（ACR）を再利用します。`az acr build`と`az containerapp create`を分けることで、`az containerapp up`によるEnvironment、Log Analytics workspace、ACRの暗黙作成を避けます。[ソースからのbuildとdeploy](https://learn.microsoft.com/en-us/azure/container-apps/tutorial-deploy-from-code)

Private ACRからのimage pullには管理者資格情報を使わず、ユーザー割り当てManaged Identityを使います。[Managed IdentityによるACR image pull](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity-image-pull)

Container Appsは最小レプリカ数を0にでき、待機中のデモを常時起動しない構成にできます。[スケーリング](https://learn.microsoft.com/en-us/azure/container-apps/scale-app)

## 前提

ローカルに次のコマンドがあり、対象サブスクリプションへ`az login`済みであることを確認します。対象のresource group、Container Apps environment、ACRは事前に存在している必要があります。

```bash
az account show
if az extension show --name containerapp >/dev/null 2>&1; then
  az extension remove --name containerapp
fi
az containerapp create --help
az containerapp update --help
az containerapp identity assign --help
az containerapp registry set --help
```

`containerapp` preview extensionが入っている場合は、Core Azure CLIの同名コマンドを上書きします。今回のsource build障害を起こしたpreview extensionは外し、Core実装で必要な操作が利用できることを確認します。拡張が未導入なら、削除操作は不要です。

Azure for Studentsの残額、有効期限、当月の利用額はAzure PortalのEducationまたはCost Managementを正本にします。Student Offerのクレジットを使い切ると契約状態が変わる可能性があるため、デモ後に必ず利用状況を確認します。[Azure for Studentsの利用状況](https://learn.microsoft.com/en-us/azure/education-hub/navigate-costs) · [FAQ](https://learn.microsoft.com/en-us/azure/education-hub/faq)

## 合成fixture APIを配置する

デプロイは明示したリソースグループとContainer Appだけを対象にします。次の環境変数は、シェルの一時環境やローカルの`.env`で設定し、リポジトリへ保存しません。

```bash
export ORBIT_AZURE_RESOURCE_GROUP="<resource-group>"
export ORBIT_AZURE_CONTAINER_APP="<lowercase-container-app-name>"
export ORBIT_AZURE_ENVIRONMENT_ID="<existing-environment-resource-id>"
export ORBIT_AZURE_REGISTRY="<existing-acr-name>"
# 必要な場合だけ指定
export ORBIT_AZURE_SUBSCRIPTION="<subscription-name-or-id>"
export ORBIT_AZURE_IDENTITY="<user-assigned-identity-name>"
export ORBIT_AZURE_IMAGE_REPOSITORY="sit-orbit-api"
export ORBIT_AZURE_IMAGE_TAG="<immutable-image-tag>"

scripts/azure/deploy.sh
scripts/azure/health.sh
```

`ORBIT_AZURE_IMAGE_TAG`を省略した場合は、現在のGit commitの短縮SHAを使います。`deploy.sh`は次を順に行います。

1. 既存environmentとACRを検証する
2. ユーザー割り当てManaged Identityを作成または再利用する
3. ACRの認可モードを確認し、Identityへimage pull用roleを付与する
4. ACR上で`linux/amd64` imageをremote buildする
5. Container Appを作成または新しいimageへ更新する
6. image、最小レプリカ数0、最大レプリカ数1を読み戻す

RBAC modeのACRでは`AcrPull`、ABAC repository permissions modeでは`Container Registry Repository Reader`を使用します。既存ACRの認可モード自体は変更しません。[ACRの組み込みRole](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-rbac-built-in-roles-overview)

`deploy.sh`は`ORBIT_AGENT_BACKEND=fixture`と`ORBIT_OBSERVABILITY=off`を渡します。したがって、この手順のデプロイ、`/health`確認、B1大宮fixtureのリクエストは、OpenAI、Azure OpenAI、W&B、GoogleのAPIを呼びません。

## デモ後にscale-to-zeroへ戻す

Container Appを削除せず、待機時のレプリカ数を0へ戻します。

```bash
scripts/azure/scale-to-zero.sh
```

完全な削除はこのスクリプトの責務に含めません。リソースグループを削除する場合は、対象名を確認したうえでAzure PortalまたはAzure CLIから別途実行します。

## Azure OpenAIを使うデモ

Azure OpenAI v1はOpenAI互換クライアントの`/openai/v1/`エンドポイントを利用できます。SIT ORBITではAzure専用SDKやAgent Frameworkを必須にせず、既存の`openai`依存のAdapterを使います。[Azure OpenAI Responses API](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)

Azure OpenAIの設定は、次の3つがすべて揃った場合だけ有効です。

```text
ORBIT_AGENT_BACKEND=azure_openai
ORBIT_WEB_SEARCH=azure
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_MODEL=<deployment-name>
AZURE_OPENAI_API_KEY=<secret>
```

`AZURE_OPENAI_MODEL`はモデルの表示名ではなく、Azure側のデプロイ名です。API versionをアプリケーションへ固定せず、v1のベースURLを利用します。

デプロイ時にAPIキーを通常の環境変数へ直書きしないでください。Container AppsのSecretへ登録し、環境変数から`secretref:`で参照します。[Container AppsのSecret](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets)

```bash
# 値はシェル履歴や共有ログへ残さない方法で登録する。
az containerapp secret set \
  --name "$ORBIT_AZURE_CONTAINER_APP" \
  --resource-group "$ORBIT_AZURE_RESOURCE_GROUP" \
  --secrets azure-openai-api-key=<secret-value>

az containerapp update \
  --name "$ORBIT_AZURE_CONTAINER_APP" \
  --resource-group "$ORBIT_AZURE_RESOURCE_GROUP" \
  --set-env-vars \
    ORBIT_AGENT_BACKEND=azure_openai \
    ORBIT_OBSERVABILITY=off \
    AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com \
    AZURE_OPENAI_MODEL=<deployment-name> \
    AZURE_OPENAI_API_KEY=secretref:azure-openai-api-key
```

このProvider確認は通常のCIと分離します。実行する場合も、公開・合成データだけを使い、応答、キー、OAuth token、個人情報をPR、ログ、W&Bへ残しません。Azure認証をManaged Identityへ移行する場合は、権限範囲を確認してから別の変更として扱います。[Managed Identity](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity)

設定不足時は`RuntimeError`となり、fixtureやOpenAIへ暗黙に切り替わりません。

既存Container AppへAzure OpenAIと一般Web検索を設定する場合は、API keyをシェルへ手入力せず、Azure CLIからContainer Apps Secretへ移す次のスクリプトを使います。
`deploy.sh`は安全側の既定としてBackendを`fixture`へ戻すため、モデルを使うデモではimage配置後に実行します。

```bash
export ORBIT_AZURE_RESOURCE_GROUP="<resource-group>"
export ORBIT_AZURE_CONTAINER_APP="<container-app-name>"
export ORBIT_AZURE_OPENAI_ACCOUNT="<azure-openai-account-name>"
export ORBIT_AZURE_OPENAI_DEPLOYMENT="<deployment-name>"
# 必要な場合だけ指定
export ORBIT_AZURE_SUBSCRIPTION="<subscription-name-or-id>"

scripts/azure/configure-openai.sh
scripts/azure/health.sh
```

`configure-openai.sh`はAzure OpenAI accountとdeploymentが`Succeeded`であることを確認し、API keyをContainer Apps Secretへ登録する。
その後、`azure_openai`、`ORBIT_WEB_SEARCH=azure`、`ORBIT_OBSERVABILITY=off`、endpoint、deployment名、Secret参照を設定し、秘密値を表示せずに設定名だけを読み戻す。

### Chrome拡張機能から接続する

外部公開したAgent APIは、`ORBIT_API_TOKEN`が設定されている場合だけ`/v1/*`へBearer認証を要求する。ランダムなデモ用tokenをContainer Apps Secretへ登録する。

```bash
export ORBIT_AZURE_RESOURCE_GROUP="<resource-group>"
export ORBIT_AZURE_CONTAINER_APP="<container-app-name>"
export ORBIT_AZURE_API_TOKEN="$(openssl rand -hex 32)"
export ORBIT_EXTENSION_ORIGIN="chrome-extension://<extension-id>"
scripts/azure/configure-api-auth.sh
```

拡張機能の「接続設定 → Agent API」で「Azureデモを選択」を押し、同じtokenを入力して「保存して接続確認」を押す。endpointとtokenは`chrome.storage.session`だけに保持され、Chrome終了後には復元しない。TokenをChat履歴、IndexedDB、Chrome Sync、FastAPIログへ保存しない。

`ORBIT_EXTENSION_ORIGIN`を指定した場合だけ、その拡張機能originからの`GET`、`POST`、CORS preflightと`Authorization`、`Content-Type` headerを許可する。ワイルドカードoriginは設定せず、`chrome://extensions`に表示された実際のIDを使う。

`/health`は監視用に認証なしで応答する。Bearer tokenの正否は実際のChat送信時に検証され、無効なtokenでは`401`となる。ローカル開発とCIは`ORBIT_API_TOKEN`を設定しないため、従来どおり認証なしでfixture APIを利用できる。

## 2026年8月22日のProvider Acceptance

Azure for Students subscriptionのJapan Eastに、専用OpenAI account `sit-orbit-aoai-argo11`と`gpt-5.6-terra` version `2026-07-09`のGlobalStandard deployment `gpt-5-6-terra`を作成した。
capacity 1では親ChatのpromptがTPM上限を超えて429になったため、従量課金のままcapacity 10へ変更した。

Container App `sit-orbit-demo-api`へmain commit `49963f203ff1`のimageを配置し、revision `sit-orbit-demo-api--0000003`で一般Web検索を有効化した。
外部FQDNから公開情報だけを使ったChat requestを実行し、HTTP 200、`completed`、`web-search-v1-*` Evidence 2件、公式`www.shibaura-it.ac.jp`出典を確認した。
応答本文、検索の生レスポンス、API keyは文書やW&Bへ保存していない。

## モデル選定の暫定方針

モデルの役割は、実測前の暫定順位として次のように置く。

| 役割 | 候補 | 用途 |
| --- | --- | --- |
| Primary | Azure OpenAI GPT-5.6 Terra | 通常デモ |
| Quality demo | Azure OpenAI GPT-5.6 Sol | 品質を優先するデモ |
| Challenger | Azure OpenAI GPT-5.6 Luna | 低コスト候補 |

Azure側のdeployment名は固定せず、`evals.run_model_selection`へrole mappingとして渡す。
この比較Runnerは通常のCIや`run_eval`とは別で、16件の合成・公開ケースを順番に実行する。

```bash
ORBIT_OBSERVABILITY=off \
AZURE_OPENAI_ENDPOINT="https://<resource>.openai.azure.com" \
AZURE_OPENAI_API_KEY="<secret>" \
PYTHONPATH=services/api uv run python -m evals.run_model_selection \
  --role terra=<terra-deployment> \
  --role luna=<luna-deployment> \
  --role sol=<sol-deployment>
```

暫定のAzure Standard Global単価は、入力／出力100万tokenあたりTerraが$2／$12、Lunaが$0.20／$1.20、Solが$5／$30である。
Global deploymentでは複数リージョンで処理され得るため、実データ利用前にはdeployment type、リージョン、データ処理方針を確認する。
実測後も、hard failureが0件であることを必要条件に、提案本文の人手確認、品質、コストを比較してPrimaryを見直す。case-defined trapはすべての根拠外事実を自動検出するものではないため、hard failure 0だけではPrimaryを確定しない。

Gemini 3.7 Flash Paidは将来のsynthetic/public-only challengerとする。
このbranchではGoogle Adapterや依存を追加せず、実Calendar派生値をGeminiへ送信しない。
Geminiの単価は2026年12月31日までは入力$0.75／出力$3.75、2027年1月1日から入力$1.50／出力$7.50（100万tokenあたり）と記録するが、実行時点の公式料金を再確認する。

参考：
[Microsoft FoundryのGPT-5.6発表](https://azure.microsoft.com/en-us/blog/gpt-5-6-now-available-in-microsoft-foundry/)、
[Azureのデータ処理方針](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy)、
[Google公式リリースノート](https://ai.google.dev/gemini-api/docs/changelog)、
[Gemini API料金表](https://ai.google.dev/gemini-api/docs/pricing)、
[PydanticAI Googleモデル](https://pydantic.dev/docs/ai/models/google/)。

## 費用と停止の確認

デモ開始前後に、Azure PortalのEducation／Cost Managementで次を確認します。

- 対象リソースグループとContainer App
- Container Appsのレプリカ数と実行時間
- Container Registry、Managed Identity、Log Analyticsなどの関連リソース
- Azure OpenAIのモデルデプロイ、トークン使用量、クォータ
- Student Offerの残額と有効期限

必要なときだけ起動し、終了後に`scale-to-zero.sh`を実行します。常時稼働のVMや、デモに不要な検索・Functions・監視サービスはこのBranchでは追加しません。

## Provider Acceptanceとの境界

通常CIはAzure資格情報を持たないため、次はProvider Acceptanceとして分離します。

- Azure Portalでのモデルデプロイ可否
- 実Azureモデルへの合成fixtureリクエスト
- Azure OpenAIのリージョン、クォータ、課金の確認
- Managed Identity、RBAC、Key Vaultの本番構成

これらを確認できない場合、ローカルfixtureの成功を実連携の成功として扱いません。Provider Acceptanceでは、実際のFQDNから`/health`とB1大宮fixtureの提案・完了記録を確認し、Container Appのscale設定を読み戻します。可能なら実レプリカ数が0になった後のcold startでも`/health`を再確認します。結果は対象のPRへ記録します。

## 失敗途中のresourceを整理する場合

`deploy.sh`は既存environmentとACRを再利用するため、resource groupやenvironmentを削除しません。失敗した過去の`az containerapp up`が作成した未使用workspaceなどを削除する場合は、resource IDと依存関係を読み取ってから別操作として行います。resource group全体の削除は、同じgroupに残すresourceがないと確認できた場合だけ実行します。
