#!/bin/bash

set -e

# Allow either `COMPOSIO_API_KEY=... sh scaffold.sh` or a pre-existing .env file.
if [ -z "${COMPOSIO_API_KEY:-}" ] && [ -f .env ]; then
	set -a
	. ./.env
	set +a
fi

if [ -z "${COMPOSIO_API_KEY:-}" ]; then
	echo "Error: COMPOSIO_API_KEY is not set" >&2
	exit 1
fi

echo "Fetching OpenRouter API key..."
if ! OPENROUTER_RESPONSE=$(curl -sS -X POST \
	-H "x-composio-api-key: ${COMPOSIO_API_KEY}" \
	"https://product-eng.hiring.composio.io/api/openrouter-key"); then
	echo "Error: Failed to contact OpenRouter key endpoint" >&2
	exit 1
fi

if command -v jq >/dev/null 2>&1; then
	OPENROUTER_API_KEY=$(echo "$OPENROUTER_RESPONSE" | jq -r '.apiKey')
else
	OPENROUTER_API_KEY=$(echo "$OPENROUTER_RESPONSE" | grep -o '"apiKey":"[^"]*' | cut -d'"' -f4)
fi

if [ -z "$OPENROUTER_API_KEY" ] || [ "$OPENROUTER_API_KEY" = "null" ]; then
	echo "Error: Failed to get openrouter api key" >&2
	echo "Response: $OPENROUTER_RESPONSE" >&2
	exit 1
fi

echo "Writing .env file..."
cat >.env <<EOF_ENV
COMPOSIO_API_KEY=$COMPOSIO_API_KEY
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
EOF_ENV

echo "env file created"
