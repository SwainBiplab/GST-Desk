#!/bin/sh
# Daily Postgres backup to object storage, keeping RETENTION_DAYS days. Runs inside the `backup` service of
# compose.prod.yml (the postgres image plus curl), or by hand: PG_URL, S3_* and RETENTION_DAYS from the env.
# The dump is the custom format (`pg_restore`-able, compressed) and is uploaded with a signed S3 PUT.
set -eu

: "${PG_URL:?PG_URL is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"
S3_BUCKET="${S3_BUCKET:-gstdesk}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
REGION="${S3_REGION:-ap-south-1}"

stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
file="/tmp/gst-${stamp}.dump"
key="backups/postgres/gst-${stamp}.dump"

pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$file" "$PG_URL"
size=$(stat -c %s "$file")

# AWS signature v4 for one PUT, with no SDK in the image
sha256() { sha256sum "$1" | cut -d' ' -f1; }
hmac() { printf '%s' "$2" | openssl dgst -sha256 -mac HMAC -macopt "$1" -binary; }
host=$(printf '%s' "$S3_ENDPOINT" | sed -e 's#^https\?://##' -e 's#/.*##')
scheme=$(printf '%s' "$S3_ENDPOINT" | sed -e 's#://.*##')
date_s=$(date -u +%Y%m%d)
date_l=$(date -u +%Y%m%dT%H%M%SZ)
payload=$(sha256 "$file")
canonical="PUT
/${S3_BUCKET}/${key}

host:${host}
x-amz-content-sha256:${payload}
x-amz-date:${date_l}
x-amz-tagging:kind=backup

host;x-amz-content-sha256;x-amz-date;x-amz-tagging
${payload}"
scope="${date_s}/${REGION}/s3/aws4_request"
to_sign="AWS4-HMAC-SHA256
${date_l}
${scope}
$(printf '%s' "$canonical" | sha256sum | cut -d' ' -f1)"
k_date=$(hmac "key:AWS4${S3_SECRET_KEY}" "$date_s" | xxd -p -c 256)
k_region=$(hmac "hexkey:${k_date}" "$REGION" | xxd -p -c 256)
k_service=$(hmac "hexkey:${k_region}" "s3" | xxd -p -c 256)
k_signing=$(hmac "hexkey:${k_service}" "aws4_request" | xxd -p -c 256)
signature=$(printf '%s' "$to_sign" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${k_signing}" | sed 's/^.* //')

curl --fail --silent --show-error --upload-file "$file" \
  -H "Host: ${host}" \
  -H "x-amz-content-sha256: ${payload}" \
  -H "x-amz-date: ${date_l}" \
  -H "x-amz-tagging: kind=backup" \
  -H "Authorization: AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-tagging, Signature=${signature}" \
  "${scheme}://${host}/${S3_BUCKET}/${key}" >/dev/null

rm -f "$file"
echo "backup ${key} (${size} bytes) uploaded; objects tagged kind=backup expire after ${RETENTION_DAYS} days by the bucket's lifecycle rule"
# Retention: the API's `ensureBucket` sets a 30-day expiry on objects tagged kind=backup. On a store that
# refuses lifecycle rules, prune by hand: list backups/postgres/ and delete anything older than RETENTION_DAYS.
