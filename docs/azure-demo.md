# Azureデモランタイム

SIT ORBITのデモAPIをAzure Container Apps Consumptionへ配置するための手順です。
ここで扱うデータは、公開データまたは合成データに限定します。通常の開発とCIは外部APIを呼ばず、`fixture`バックエンドだけを使います。

## 採用範囲

- FastAPI API：Azure Container Apps
- コンテナ：リポジトリ直下の`Dockerfile`
- スケール：最小レプリカ数0、最大レプリカ数1
- デモの既定Backend：`fixture`
- モデルBackend：明示設定時だけ`azure_openai`
- Web：この手順では配置しない

`az containerapp up`は、ローカルのソースと`Dockerfile`からContainer Appを作成・更新できる公式CLI経路です。[Container Appsへのデプロイ](https://learn.microsoft.com/en-us/azure/container-apps/containerapp-up)

Container Appsは最小レプリカ数を0にでき、待機中のデモを常時起動しない構成にできます。[スケーリング](https://learn.microsoft.com/en-us/azure/container-apps/scale-app)

## 前提

ローカルに次のコマンドがあり、対象サブスクリプションへ`az login`済みであることを確認します。

```bash
az account show
az extension add --name containerapp --upgrade
```

Azure for Studentsの残額、有効期限、当月の利用額はAzure PortalのEducationまたはCost Managementを正本にします。Student Offerのクレジットを使い切ると契約状態が変わる可能性があるため、デモ後に必ず利用状況を確認します。[Azure for Studentsの利用状況](https://learn.microsoft.com/en-us/azure/education-hub/navigate-costs) · [FAQ](https://learn.microsoft.com/en-us/azure/education-hub/faq)

## 合成fixture APIを配置する

デプロイは明示したリソースグループとContainer Appだけを対象にします。次の環境変数は、シェルの一時環境やローカルの`.env`で設定し、リポジトリへ保存しません。

```bash
export ORBIT_AZURE_RESOURCE_GROUP="<resource-group>"
export ORBIT_AZURE_LOCATION="<region>"
export ORBIT_AZURE_CONTAINER_APP="<lowercase-container-app-name>"
# 必要な場合だけ指定
export ORBIT_AZURE_SUBSCRIPTION="<subscription-name-or-id>"
export ORBIT_AZURE_ENVIRONMENT="<existing-container-apps-environment>"

scripts/azure/deploy.sh
scripts/azure/health.sh
```

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
- Container Registry、Log Analyticsなど`az containerapp up`が作成した関連リソース
- Azure OpenAIのモデルデプロイ、トークン使用量、クォータ
- Student Offerの残額と有効期限

必要なときだけ起動し、終了後に`scale-to-zero.sh`を実行します。常時稼働のVMや、デモに不要な検索・Functions・監視サービスはこのBranchでは追加しません。

## Provider Acceptanceとの境界

次はこのBranchのCI完了条件ではありません。

- Azure Portalでのモデルデプロイ可否
- 実Azureモデルへの合成fixtureリクエスト
- Azure OpenAIのリージョン、クォータ、課金の確認
- Managed Identity、RBAC、Key Vaultの本番構成

これらを確認できない場合、ローカルfixtureの成功を実連携の成功として扱いません。Provider Acceptanceの結果は、対象のPRへ記録します。
