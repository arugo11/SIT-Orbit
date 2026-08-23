#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"
: "${ORBIT_AZURE_API_TOKEN:?Set ORBIT_AZURE_API_TOKEN to a random demo access token.}"
: "${ORBIT_GOOGLE_OAUTH_CLIENT_ID:?Set ORBIT_GOOGLE_OAUTH_CLIENT_ID to the public Agent Web application OAuth client ID.}"

subscription_args=()
if [[ -n "${ORBIT_AZURE_SUBSCRIPTION:-}" ]]; then
  subscription_args+=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")
fi

secret_name="${ORBIT_AZURE_API_TOKEN_SECRET_NAME:-orbit-api-token}"
env_vars=(
  "ORBIT_API_TOKEN=secretref:${secret_name}"
  "ORBIT_GOOGLE_OAUTH_CLIENT_ID=${ORBIT_GOOGLE_OAUTH_CLIENT_ID}"
)
if [[ -n "${ORBIT_EXTENSION_ORIGIN:-}" ]]; then
  env_vars+=("ORBIT_CORS_ORIGINS=${ORBIT_EXTENSION_ORIGIN%/}")
fi
az containerapp secret set \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --secrets "${secret_name}=${ORBIT_AZURE_API_TOKEN}" \
  "${subscription_args[@]}" \
  --only-show-errors \
  --output none

az containerapp update \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --set-env-vars "${env_vars[@]}" \
  "${subscription_args[@]}" \
  --only-show-errors \
  --output none

readback="$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "properties.template.containers[0].env[?name=='ORBIT_API_TOKEN'].secretRef | [0]" \
  --output tsv)"
if [[ "${readback}" != "${secret_name}" ]]; then
  printf 'Container App API authentication verification failed.\n' >&2
  exit 1
fi

if [[ -n "${ORBIT_EXTENSION_ORIGIN:-}" ]]; then
  cors_readback="$(az containerapp show \
    --name "${ORBIT_AZURE_CONTAINER_APP}" \
    --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
    "${subscription_args[@]}" \
    --query "properties.template.containers[0].env[?name=='ORBIT_CORS_ORIGINS'].value | [0]" \
    --output tsv)"
  if [[ "${cors_readback}" != "${ORBIT_EXTENSION_ORIGIN%/}" ]]; then
    printf 'Container App CORS origin verification failed.\n' >&2
    exit 1
  fi
fi

google_client_readback="$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --query "properties.template.containers[0].env[?name=='ORBIT_GOOGLE_OAUTH_CLIENT_ID'].value | [0]" \
  --output tsv)"
if [[ "${google_client_readback}" != "${ORBIT_GOOGLE_OAUTH_CLIENT_ID}" ]]; then
  printf 'Google OAuth client ID verification failed.\n' >&2
  exit 1
fi

printf 'Enabled managed Agent authentication for %s.\n' "${ORBIT_AZURE_CONTAINER_APP}"
