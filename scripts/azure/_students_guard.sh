#!/usr/bin/env bash

# Shared fail-closed guard for every Azure operation in this repository.
# The caller must set ORBIT_AZURE_SUBSCRIPTION and pass the resulting
# subscription_args array to every subsequent Azure CLI command.

require_azure_for_students_subscription() {
  : "${ORBIT_AZURE_SUBSCRIPTION:?Set ORBIT_AZURE_SUBSCRIPTION to an Azure for Students subscription ID.}"

  local subscription_id state quota_id spending_limit
  IFS='|' read -r subscription_id state quota_id spending_limit <<< "$(az account subscription show \
    --subscription "${ORBIT_AZURE_SUBSCRIPTION}" \
    --query "join('|',[id,state,subscriptionPolicies.quotaId,subscriptionPolicies.spendingLimit])" \
    --output tsv)"
  if [[ ! "${subscription_id}" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    printf 'Azure subscription ID could not be resolved from the selected account.\n' >&2
    return 1
  fi
  if [[ "${state}" != "Enabled" ]]; then
    printf 'Azure subscription must be Enabled.\n' >&2
    return 1
  fi
  if [[ ! "${quota_id}" =~ ^AzureForStudents_ ]]; then
    printf 'Azure subscription must be an Azure for Students subscription.\n' >&2
    return 1
  fi
  case "${spending_limit}" in
    On|Enabled|true|True)
      ;;
    *)
      printf 'Azure for Students spending limit must be enabled.\n' >&2
      return 1
      ;;
  esac
  # Keep the resolved immutable ID local to this shell so resource-scope
  # checks remain correct when ORBIT_AZURE_SUBSCRIPTION was a display name.
  export AZURE_STUDENTS_SUBSCRIPTION_ID="${subscription_id}"
}
