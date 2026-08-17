#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_LOCATION:?Set ORBIT_AZURE_LOCATION to an Azure region with the required services.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
azure_args=(
  containerapp up
  --name "${ORBIT_AZURE_CONTAINER_APP}"
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}"
  --location "${ORBIT_AZURE_LOCATION}"
  --source "${project_root}"
  --ingress external
  --target-port 8080
  --env-vars ORBIT_AGENT_BACKEND=fixture ORBIT_OBSERVABILITY=off
  --only-show-errors
  --output none
)

if [[ -n "${ORBIT_AZURE_SUBSCRIPTION:-}" ]]; then
  azure_args+=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")
fi

if [[ -n "${ORBIT_AZURE_ENVIRONMENT:-}" ]]; then
  azure_args+=(--environment "${ORBIT_AZURE_ENVIRONMENT}")
fi

az "${azure_args[@]}"

# Keep the demo idle between requests. This changes scaling only; it does not delete data.
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
printf 'Deployed fixture API: %s\n' "${ORBIT_AZURE_CONTAINER_APP}"
