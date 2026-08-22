#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"
: "${ORBIT_AZURE_API_TOKEN:?Set ORBIT_AZURE_API_TOKEN to a random demo access token.}"

subscription_args=()
if [[ -n "${ORBIT_AZURE_SUBSCRIPTION:-}" ]]; then
  subscription_args+=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")
fi

secret_name="${ORBIT_AZURE_API_TOKEN_SECRET_NAME:-orbit-api-token}"
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
  --set-env-vars "ORBIT_API_TOKEN=secretref:${secret_name}" \
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

printf 'Enabled Bearer authentication for %s.\n' "${ORBIT_AZURE_CONTAINER_APP}"
