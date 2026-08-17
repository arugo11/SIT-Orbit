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
