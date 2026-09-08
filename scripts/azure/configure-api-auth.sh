#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"
: "${ORBIT_AZURE_SUBSCRIPTION:?Set ORBIT_AZURE_SUBSCRIPTION to the Azure for Students subscription ID.}"
: "${ORBIT_AZURE_API_TOKEN:?Set ORBIT_AZURE_API_TOKEN to a random demo access token.}"
: "${ORBIT_GOOGLE_OAUTH_CLIENT_ID:?Set ORBIT_GOOGLE_OAUTH_CLIENT_ID to the public Agent Web application OAuth client ID.}"
: "${ORBIT_GOOGLE_OAUTH_CLIENT_SECRET:?Set ORBIT_GOOGLE_OAUTH_CLIENT_SECRET without writing it to the repository.}"
: "${ORBIT_GOOGLE_OAUTH_REDIRECT_URI:?Set ORBIT_GOOGLE_OAUTH_REDIRECT_URI to the exact chromiumapp.org Agent callback.}"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${project_root}/scripts/azure/_students_guard.sh"
require_azure_for_students_subscription
subscription_args=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")

IFS='|' read -r container_app_id container_app_state <<< "$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "join('|',[id,properties.provisioningState])" \
  --output tsv)"
if [[ "${container_app_id,,}" != "/subscriptions/${AZURE_STUDENTS_SUBSCRIPTION_ID,,}"/* ]]; then
  printf 'Container App is outside the selected subscription.\n' >&2
  exit 1
fi
if [[ "${container_app_state}" != "Succeeded" ]]; then
  printf 'Container App must be in Succeeded state.\n' >&2
  exit 1
fi

secret_name="${ORBIT_AZURE_API_TOKEN_SECRET_NAME:-orbit-api-token}"
google_secret_name="${ORBIT_GOOGLE_OAUTH_CLIENT_SECRET_NAME:-orbit-google-oauth-client-secret}"
env_vars=(
  "ORBIT_API_TOKEN=secretref:${secret_name}"
  "ORBIT_GOOGLE_OAUTH_CLIENT_ID=${ORBIT_GOOGLE_OAUTH_CLIENT_ID}"
  "ORBIT_GOOGLE_OAUTH_CLIENT_SECRET=secretref:${google_secret_name}"
  "ORBIT_GOOGLE_OAUTH_REDIRECT_URI=${ORBIT_GOOGLE_OAUTH_REDIRECT_URI}"
)
if [[ -n "${ORBIT_EXTENSION_ORIGIN:-}" ]]; then
  env_vars+=("ORBIT_CORS_ORIGINS=${ORBIT_EXTENSION_ORIGIN%/}")
fi
az containerapp secret set \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --secrets \
    "${secret_name}=${ORBIT_AZURE_API_TOKEN}" \
    "${google_secret_name}=${ORBIT_GOOGLE_OAUTH_CLIENT_SECRET}" \
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

google_secret_readback="$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "properties.template.containers[0].env[?name=='ORBIT_GOOGLE_OAUTH_CLIENT_SECRET'].secretRef | [0]" \
  --output tsv)"
if [[ "${google_secret_readback}" != "${google_secret_name}" ]]; then
  printf 'Google OAuth client secret reference verification failed.\n' >&2
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
  "${subscription_args[@]}" \
  --query "properties.template.containers[0].env[?name=='ORBIT_GOOGLE_OAUTH_CLIENT_ID'].value | [0]" \
  --output tsv)"
if [[ "${google_client_readback}" != "${ORBIT_GOOGLE_OAUTH_CLIENT_ID}" ]]; then
  printf 'Google OAuth client ID verification failed.\n' >&2
  exit 1
fi

google_redirect_readback="$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "properties.template.containers[0].env[?name=='ORBIT_GOOGLE_OAUTH_REDIRECT_URI'].value | [0]" \
  --output tsv)"
if [[ "${google_redirect_readback}" != "${ORBIT_GOOGLE_OAUTH_REDIRECT_URI}" ]]; then
  printf 'Google OAuth redirect URI verification failed.\n' >&2
  exit 1
fi

printf 'Enabled managed Agent authentication for %s.\n' "${ORBIT_AZURE_CONTAINER_APP}"
