#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_SUBSCRIPTION:?Set ORBIT_AZURE_SUBSCRIPTION to the Azure for Students subscription ID.}"
: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to an existing resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to an existing Container App.}"
: "${ORBIT_AZURE_HEALTHY_REVISION:?Set ORBIT_AZURE_HEALTHY_REVISION to the last Healthy revision.}"

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

IFS='|' read -r revision_state revision_health <<< "$(az containerapp revision show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --revision "${ORBIT_AZURE_HEALTHY_REVISION}" \
  "${subscription_args[@]}" \
  --query "join('|',[properties.runningState,properties.healthState])" \
  --output tsv)"
if [[ "${revision_state}" != "Running" && "${revision_state}" != "ScaledToZero" || "${revision_health}" != "Healthy" ]]; then
  printf 'Rollback target is not a Healthy running revision.\n' >&2
  exit 1
fi

az containerapp ingress traffic set \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --revision-weight "${ORBIT_AZURE_HEALTHY_REVISION}=100" \
  "${subscription_args[@]}" \
  --only-show-errors \
  --output none

printf 'Restored Healthy revision %s to 100%% traffic.\n' "${ORBIT_AZURE_HEALTHY_REVISION}"
