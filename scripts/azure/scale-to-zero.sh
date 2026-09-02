#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"
: "${ORBIT_AZURE_SUBSCRIPTION:?Set ORBIT_AZURE_SUBSCRIPTION to the Azure for Students subscription ID.}"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${project_root}/scripts/azure/_students_guard.sh"
require_azure_for_students_subscription

IFS='|' read -r container_app_id container_app_state <<< "$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --subscription "${ORBIT_AZURE_SUBSCRIPTION}" \
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

update_args=(
  containerapp update
  --name "${ORBIT_AZURE_CONTAINER_APP}"
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}"
  --min-replicas 0
  --max-replicas 1
  --only-show-errors
  --output none
)
update_args+=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")

az "${update_args[@]}"
printf 'Scale-to-zero policy applied: min replicas 0, max replicas 1.\n'
