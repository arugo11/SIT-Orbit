#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"
: "${ORBIT_AZURE_OPENAI_ACCOUNT:?Set ORBIT_AZURE_OPENAI_ACCOUNT to the Azure OpenAI account name.}"
: "${ORBIT_AZURE_OPENAI_DEPLOYMENT:?Set ORBIT_AZURE_OPENAI_DEPLOYMENT to the model deployment name.}"
: "${ORBIT_AZURE_BOOK_DISCOVERY_MODE:?Set ORBIT_AZURE_BOOK_DISCOVERY_MODE to off, multi_query, or semantic.}"
: "${ORBIT_SCOMBZ_STUDENT_READ:?Set ORBIT_SCOMBZ_STUDENT_READ=live for the real SCombZ student reader.}"

if [[ "${ORBIT_SCOMBZ_STUDENT_READ}" != "live" ]]; then
  printf 'Azure OpenAI live audit requires ORBIT_SCOMBZ_STUDENT_READ=live.\n' >&2
  exit 1
fi

opac_transport="${ORBIT_OPAC_TRANSPORT:-server}"
opac_base_url="${ORBIT_OPAC_BASE_URL:-https://library.shibaura-it.ac.jp}"
opac_min_interval_ms="${ORBIT_OPAC_MIN_INTERVAL_MS:-10000}"
opac_search_cache_ttl="${ORBIT_OPAC_SEARCH_CACHE_TTL_SECONDS:-300}"
opac_detail_cache_ttl="${ORBIT_OPAC_DETAIL_CACHE_TTL_SECONDS:-30}"
sitrus_personal_context_mode="${ORBIT_SITRUS_PERSONAL_CONTEXT:-off}"

case "${ORBIT_AZURE_BOOK_DISCOVERY_MODE}" in
  off|multi_query|semantic)
    ;;
  *)
    printf 'ORBIT_AZURE_BOOK_DISCOVERY_MODE must be off, multi_query, or semantic.\n' >&2
    exit 1
    ;;
esac
case "${sitrus_personal_context_mode}" in
  off|live)
    ;;
  *)
    printf 'Production ORBIT_SITRUS_PERSONAL_CONTEXT must be off or live.\n' >&2
    exit 1
    ;;
esac

if [[ "${opac_transport}" != "server" || "${opac_base_url}" != "https://library.shibaura-it.ac.jp" ]]; then
  printf 'Azure OpenAI configuration requires the official server OPAC transport and base URL.\n' >&2
  exit 1
fi
if [[ ! "${opac_min_interval_ms}" =~ ^[0-9]+$ || ! "${opac_search_cache_ttl}" =~ ^[0-9]+$ || ! "${opac_detail_cache_ttl}" =~ ^[0-9]+$ ]]; then
  printf 'OPAC interval and cache TTL settings must be non-negative integers.\n' >&2
  exit 1
fi

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
    ORBIT_RUNTIME_PROFILE=production \
    ORBIT_AGENT_BACKEND=azure_openai \
    ORBIT_WEB_SEARCH=azure \
    ORBIT_BOOK_DISCOVERY="${ORBIT_AZURE_BOOK_DISCOVERY_MODE}" \
    ORBIT_OPAC_TRANSPORT="${opac_transport}" \
    ORBIT_OPAC_BASE_URL="${opac_base_url}" \
    ORBIT_OPAC_MIN_INTERVAL_MS="${opac_min_interval_ms}" \
    ORBIT_OPAC_SEARCH_CACHE_TTL_SECONDS="${opac_search_cache_ttl}" \
    ORBIT_OPAC_DETAIL_CACHE_TTL_SECONDS="${opac_detail_cache_ttl}" \
    ORBIT_SCOMBZ_STUDENT_READ=live \
    ORBIT_SITRUS_PERSONAL_CONTEXT="${sitrus_personal_context_mode}" \
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
  --query "join('|',[properties.template.containers[0].env[?name=='ORBIT_RUNTIME_PROFILE'].value | [0],properties.template.containers[0].env[?name=='ORBIT_AGENT_BACKEND'].value | [0],properties.template.containers[0].env[?name=='ORBIT_WEB_SEARCH'].value | [0],properties.template.containers[0].env[?name=='ORBIT_BOOK_DISCOVERY'].value | [0],properties.template.containers[0].env[?name=='ORBIT_OPAC_TRANSPORT'].value | [0],properties.template.containers[0].env[?name=='ORBIT_OPAC_BASE_URL'].value | [0],properties.template.containers[0].env[?name=='ORBIT_OPAC_MIN_INTERVAL_MS'].value | [0],properties.template.containers[0].env[?name=='ORBIT_OPAC_SEARCH_CACHE_TTL_SECONDS'].value | [0],properties.template.containers[0].env[?name=='ORBIT_OPAC_DETAIL_CACHE_TTL_SECONDS'].value | [0],properties.template.containers[0].env[?name=='ORBIT_SCOMBZ_STUDENT_READ'].value | [0],properties.template.containers[0].env[?name=='ORBIT_SITRUS_PERSONAL_CONTEXT'].value | [0],properties.template.containers[0].env[?name=='ORBIT_OBSERVABILITY'].value | [0],properties.template.containers[0].env[?name=='AZURE_OPENAI_MODEL'].value | [0],properties.template.containers[0].env[?name=='AZURE_OPENAI_API_KEY'].secretRef | [0]])" \
  --output tsv)"
expected="production|azure_openai|azure|${ORBIT_AZURE_BOOK_DISCOVERY_MODE}|${opac_transport}|${opac_base_url}|${opac_min_interval_ms}|${opac_search_cache_ttl}|${opac_detail_cache_ttl}|live|${sitrus_personal_context_mode}|off|${ORBIT_AZURE_OPENAI_DEPLOYMENT}|${secret_name}"
if [[ "${readback}" != "${expected}" ]]; then
  printf 'Container App model configuration verification failed.\n' >&2
  exit 1
fi

printf 'Enabled Azure OpenAI web search and book discovery (%s) for %s.\n' \
  "${ORBIT_AZURE_BOOK_DISCOVERY_MODE}" \
  "${ORBIT_AZURE_CONTAINER_APP}"
