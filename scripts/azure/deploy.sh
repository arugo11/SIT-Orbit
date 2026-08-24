#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"
: "${ORBIT_AZURE_ENVIRONMENT_ID:?Set ORBIT_AZURE_ENVIRONMENT_ID to an existing Container Apps environment resource ID.}"
: "${ORBIT_AZURE_REGISTRY:?Set ORBIT_AZURE_REGISTRY to an existing Azure Container Registry name.}"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
identity_name="${ORBIT_AZURE_IDENTITY:-${ORBIT_AZURE_CONTAINER_APP}-pull}"
image_repository="${ORBIT_AZURE_IMAGE_REPOSITORY:-sit-orbit-api}"
image_tag="${ORBIT_AZURE_IMAGE_TAG:-$(git -C "${project_root}" rev-parse --short=12 HEAD)}"
subscription_args=()

if [[ -n "${ORBIT_AZURE_SUBSCRIPTION:-}" ]]; then
  subscription_args+=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")
fi

az group show \
  --name "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --output none

IFS='|' read -r environment_id environment_type environment_state <<< "$(az resource show \
  --ids "${ORBIT_AZURE_ENVIRONMENT_ID}" \
  --query "join('|',[id,type,properties.provisioningState])" \
  --output tsv)"
if [[ "${environment_type}" != "Microsoft.App/managedEnvironments" || "${environment_state}" != "Succeeded" ]]; then
  printf 'Container Apps environment must exist and be in Succeeded state.\n' >&2
  exit 1
fi

IFS='|' read -r registry_id registry_server registry_role_assignment_mode <<< "$(az acr show \
  --name "${ORBIT_AZURE_REGISTRY}" \
  "${subscription_args[@]}" \
  --query "join('|',[id,loginServer,roleAssignmentMode])" \
  --output tsv)"
case "${registry_role_assignment_mode}" in
  LegacyRegistryPermissions)
    registry_pull_role="AcrPull"
    ;;
  AbacRepositoryPermissions)
    registry_pull_role="Container Registry Repository Reader"
    ;;
  *)
    printf 'Unsupported ACR role assignment mode: %s\n' "${registry_role_assignment_mode}" >&2
    exit 1
    ;;
esac

authentication_as_arm="$(az acr config authentication-as-arm show \
  --registry "${ORBIT_AZURE_REGISTRY}" \
  "${subscription_args[@]}" \
  --query status \
  --output tsv)"
if [[ "${authentication_as_arm}" != "enabled" ]]; then
  printf 'ACR authentication-as-arm must be enabled before deployment.\n' >&2
  exit 1
fi

if ! az identity show \
  --name "${identity_name}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --output none 2>/dev/null; then
  az identity create \
    --name "${identity_name}" \
    --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
    "${subscription_args[@]}" \
    --output none
fi

IFS='|' read -r identity_id identity_principal_id <<< "$(az identity show \
  --name "${identity_name}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "join('|',[id,principalId])" \
  --output tsv)"

acr_pull_assignment="$(az role assignment list \
  --scope "${registry_id}" \
  "${subscription_args[@]}" \
  --query "[?principalId=='${identity_principal_id}' && roleDefinitionName=='${registry_pull_role}'].id | [0]" \
  --output tsv)"
if [[ -z "${acr_pull_assignment}" ]]; then
  az role assignment create \
    --assignee-object-id "${identity_principal_id}" \
    --assignee-principal-type ServicePrincipal \
    --role "${registry_pull_role}" \
    --scope "${registry_id}" \
    "${subscription_args[@]}" \
    --output none
fi

az acr build \
  --registry "${ORBIT_AZURE_REGISTRY}" \
  --image "${image_repository}:${image_tag}" \
  --file "${project_root}/Dockerfile" \
  --platform linux/amd64 \
  "${subscription_args[@]}" \
  "${project_root}"

image="${registry_server}/${image_repository}:${image_tag}"
if current_environment_id="$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query properties.environmentId \
  --output tsv 2>/dev/null)"; then
  if [[ "${current_environment_id}" != "${environment_id}" ]]; then
    printf 'Existing Container App uses a different environment.\n' >&2
    exit 1
  fi

  az containerapp identity assign \
    --name "${ORBIT_AZURE_CONTAINER_APP}" \
    --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
    --user-assigned "${identity_id}" \
    "${subscription_args[@]}" \
    --output none
  az containerapp registry set \
    --name "${ORBIT_AZURE_CONTAINER_APP}" \
    --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
    --server "${registry_server}" \
    --identity "${identity_id}" \
    "${subscription_args[@]}" \
    --output none
  az containerapp ingress enable \
    --name "${ORBIT_AZURE_CONTAINER_APP}" \
    --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
    --type external \
    --target-port 8080 \
    "${subscription_args[@]}" \
    --output none
  az containerapp update \
    --name "${ORBIT_AZURE_CONTAINER_APP}" \
    --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
    --image "${image}" \
    --set-env-vars \
      ORBIT_AGENT_BACKEND=fixture \
      ORBIT_BOOK_DISCOVERY=off \
      ORBIT_OBSERVABILITY=off \
    --min-replicas 0 \
    --max-replicas 1 \
    "${subscription_args[@]}" \
    --output none
else
  az containerapp create \
    --name "${ORBIT_AZURE_CONTAINER_APP}" \
    --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
    --environment "${environment_id}" \
    --image "${image}" \
    --target-port 8080 \
    --ingress external \
    --user-assigned "${identity_id}" \
    --registry-identity "${identity_id}" \
    --registry-server "${registry_server}" \
    --env-vars \
      ORBIT_AGENT_BACKEND=fixture \
      ORBIT_BOOK_DISCOVERY=off \
      ORBIT_OBSERVABILITY=off \
    --min-replicas 0 \
    --max-replicas 1 \
    "${subscription_args[@]}" \
    --output none
fi

IFS='|' read -r deployed_image min_replicas max_replicas fqdn deployed_backend deployed_book_discovery <<< "$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "join('|',[properties.template.containers[0].image,to_string(properties.template.scale.minReplicas),to_string(properties.template.scale.maxReplicas),properties.configuration.ingress.fqdn,properties.template.containers[0].env[?name=='ORBIT_AGENT_BACKEND'].value | [0],properties.template.containers[0].env[?name=='ORBIT_BOOK_DISCOVERY'].value | [0]])" \
  --output tsv)"

if [[ "${deployed_image}" != "${image}" || "${min_replicas}" != "0" || "${max_replicas}" != "1" || "${deployed_backend}" != "fixture" || "${deployed_book_discovery}" != "off" ]]; then
  printf 'Container App deployment verification failed.\n' >&2
  exit 1
fi

printf 'Deployed fixture API: https://%s\n' "${fqdn}"
