#!/bin/bash

THING_NAME=$1
DIR="./certs/$THING_NAME"
ZIP_FILE="./certs/${THING_NAME}.zip"

# Step 0: Check if the Thing already exists and skip if already created
EXISTING_THING=$(aws iot describe-thing --thing-name "$THING_NAME" 2>/dev/null)

if [[ -n "$EXISTING_THING" && -f "$ZIP_FILE" ]]; then
  echo "⚠️  Skipping creation: Thing '$THING_NAME' already exists and bundle is downloaded."
  echo "ℹ️  To recreate, delete the Thing from AWS IoT and remove: $ZIP_FILE"
  exit 0
fi

# Step 1: Create the Thing only if it does not exist
if [[ -z "$EXISTING_THING" ]]; then
  echo "🛠️  Creating AWS IoT Thing: $THING_NAME"
  aws iot create-thing --thing-name "$THING_NAME"
else
  echo "ℹ️  Thing '$THING_NAME' exists. Continuing with cert generation."
fi

mkdir -p "$DIR"

# Step 2: Create certificate and key pair
CERT_OUTPUT=$(aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile "$DIR/certificate.pem.crt" \
  --public-key-outfile "$DIR/public.pem.key" \
  --private-key-outfile "$DIR/private.pem.key")

# Step 3: Extract Certificate ARN & ID
CERT_ARN=$(echo "$CERT_OUTPUT" | jq -r '.certificateArn')
CERT_ID=$(echo "$CERT_OUTPUT" | jq -r '.certificateId')

# Step 4: Download Amazon Root CA
curl -s -o "$DIR/AmazonRootCA1.pem" https://www.amazontrust.com/repository/AmazonRootCA1.pem

# Step 5: Attach IoT policy
aws iot attach-policy --policy-name "IOTIQ_IoTPolicy" --target "$CERT_ARN"

# Step 6: Attach certificate to Thing
aws iot attach-thing-principal --thing-name "$THING_NAME" --principal "$CERT_ARN"

# Step 7: Download optional firmware & config from S3
FIRMWARE_PATH="s3://your-bucket-name/$THING_NAME/firmware.bin"
CONFIG_PATH="s3://your-bucket-name/$THING_NAME/config.json"

aws s3 cp "$FIRMWARE_PATH" "$DIR/firmware.bin" \
  && echo "✅ firmware.bin downloaded" || echo "⚠️  firmware.bin not found"

aws s3 cp "$CONFIG_PATH" "$DIR/config.json" \
  && echo "✅ config.json downloaded" || echo "⚠️  config.json not found"

# Step 9: Create meta.json with device metadata
cat > "$DIR/meta.json" <<EOF
{
  "thingName": "$THING_NAME",
  "userName": "Unknown",
  "deviceId": "dev-$(date +%s)",
  "company": "IOTIQ",
  "deviceStatus": "active",
  "thingAttached": true,
  "createdAt": "$(date --utc +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "📝 meta.json created"


# ✅ Step 9: Package everything into ZIP
zip -rq "$ZIP_FILE" "$DIR"
echo "📦 Done: $ZIP_FILE created"

