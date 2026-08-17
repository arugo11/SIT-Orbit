#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"

update_args=(
  containerapp update
  --name "${ORBIT_AZURE_CONTAINER_APP}"
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}"
  --min-replicas 0
  --max-replicas 1
  --only-show-errors
  --output none
)
if [[ -n "${ORBIT_AZURE_SUBSCRIPTION:-}" ]]; then
  update_args+=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")
fi

az "${update_args[@]}"
printf 'Scale-to-zero policy applied: min replicas 0, max replicas 1.\n'
