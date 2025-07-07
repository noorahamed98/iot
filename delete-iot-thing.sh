#!/bin/bash

THING_NAME=$1
if [ -z "$THING_NAME" ]; then
  echo "❌ Thing name is required"
  exit 1
fi

# Get all principals (certificates) attached to the Thing
CERTS=$(aws iot list-thing-principals --thing-name "$THING_NAME" --query "principals" --output text)

for CERT_ARN in $CERTS; do
  echo "🔗 Detaching certificate $CERT_ARN from thing $THING_NAME"
  aws iot detach-thing-principal --thing-name "$THING_NAME" --principal "$CERT_ARN"

  # Detach all attached policies from the certificate
  POLICIES=$(aws iot list-attached-policies --target "$CERT_ARN" --query "policies[].policyName" --output text)
  for POLICY_NAME in $POLICIES; do
    echo "🔐 Detaching policy $POLICY_NAME"
    aws iot detach-policy --policy-name "$POLICY_NAME" --target "$CERT_ARN"
  done

  # Deactivate and delete the certificate
  CERT_ID=$(basename "$CERT_ARN")
  echo "🚫 Deactivating certificate $CERT_ID"
  aws iot update-certificate --certificate-id "$CERT_ID" --new-status INACTIVE

  echo "❌ Deleting certificate $CERT_ID"
  aws iot delete-certificate --certificate-id "$CERT_ID"
done

# Delete the IoT Thing
echo "🗑️ Deleting Thing $THING_NAME"
aws iot delete-thing --thing-name "$THING_NAME"

echo "✅ Deleted $THING_NAME and all associated certificates and policies."

