#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"
: "${ORBIT_AZURE_OPENAI_ACCOUNT:?Set ORBIT_AZURE_OPENAI_ACCOUNT to the Azure OpenAI account name.}"
: "${ORBIT_AZURE_OPENAI_DEPLOYMENT:?Set ORBIT_AZURE_OPENAI_DEPLOYMENT to the model deployment name.}"

subscription_args=()
if [[ -n "${ORBIT_AZURE_SUBSCRIPTION:-}" ]]; then
  subscription_args+=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")
fi

endpoint="$(az cognitiveservices account show \
  --name "${ORBIT_AZURE_OPENAI_ACCOUNT}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query properties.endpoint \
  --output tsv)"
deployment_state="$(az cognitiveservices account deployment show \
  --name "${ORBIT_AZURE_OPENAI_ACCOUNT}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --deployment-name "${ORBIT_AZURE_OPENAI_DEPLOYMENT}" \
  "${subscription_args[@]}" \
  --query properties.provisioningState \
  --output tsv)"
if [[ -z "${endpoint}" || "${deployment_state}" != "Succeeded" ]]; then
  printf 'Azure OpenAI account and deployment must exist and be ready.\n' >&2
  exit 1
fi

api_key="$(az cognitiveservices account keys list \
  --name "${ORBIT_AZURE_OPENAI_ACCOUNT}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query key1 \
  --output tsv)"
if [[ -z "${api_key}" ]]; then
  printf 'Azure OpenAI did not return an API key.\n' >&2
  exit 1
fi

secret_name="${ORBIT_AZURE_OPENAI_SECRET_NAME:-azure-openai-api-key}"
az containerapp secret set \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --secrets "${secret_name}=${api_key}" \
  "${subscription_args[@]}" \
  --only-show-errors \
  --output none
unset api_key

az containerapp update \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --set-env-vars \
    ORBIT_AGENT_BACKEND=azure_openai \
    ORBIT_WEB_SEARCH=azure \
    ORBIT_OBSERVABILITY=off \
    "AZURE_OPENAI_ENDPOINT=${endpoint%/}" \
    "AZURE_OPENAI_MODEL=${ORBIT_AZURE_OPENAI_DEPLOYMENT}" \
    "AZURE_OPENAI_API_KEY=secretref:${secret_name}" \
  --min-replicas 0 \
  --max-replicas 1 \
  "${subscription_args[@]}" \
  --only-show-errors \
  --output none

readback="$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "join('|',[properties.template.containers[0].env[?name=='ORBIT_AGENT_BACKEND'].value | [0],properties.template.containers[0].env[?name=='ORBIT_WEB_SEARCH'].value | [0],properties.template.containers[0].env[?name=='ORBIT_OBSERVABILITY'].value | [0],properties.template.containers[0].env[?name=='AZURE_OPENAI_MODEL'].value | [0],properties.template.containers[0].env[?name=='AZURE_OPENAI_API_KEY'].secretRef | [0]])" \
  --output tsv)"
expected="azure_openai|azure|off|${ORBIT_AZURE_OPENAI_DEPLOYMENT}|${secret_name}"
if [[ "${readback}" != "${expected}" ]]; then
  printf 'Container App model configuration verification failed.\n' >&2
  exit 1
fi

printf 'Enabled Azure OpenAI web search for %s.\n' "${ORBIT_AZURE_CONTAINER_APP}"
