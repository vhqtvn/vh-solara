#!/bin/bash
set -e

REPO_URL="https://github.com/vhqtvn/vh-solara"
API_URL="https://api.github.com/repos/vhqtvn/vh-solara/releases/latest"

echo "Fetching latest release information..."
LATEST_RELEASE=$(curl -sL $API_URL)

if [ -z "$LATEST_RELEASE" ] || echo "$LATEST_RELEASE" | grep -q "Not Found"; then
    echo "Error: Could not fetch latest release. Make sure the repository is public or you have access."
    exit 1
fi

VERSION=$(echo "$LATEST_RELEASE" | jq -r '.tag_name')
if [ -z "$VERSION" ]; then
    echo "Error: Could not parse release version."
    exit 1
fi

echo "Latest version is $VERSION"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case $ARCH in
    x86_64) ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    armv7l) ARCH="arm" ;;
    i386 | i686) ARCH="386" ;;
esac

BINARY_NAME="vh-solara-${OS}-${ARCH}"
if [ "$OS" == "windows" ]; then
    BINARY_NAME="${BINARY_NAME}.exe"
fi

DOWNLOAD_URL="${REPO_URL}/releases/download/${VERSION}/${BINARY_NAME}"

echo "Downloading $BINARY_NAME from $DOWNLOAD_URL..."
TMP_FILE=$(mktemp)
if ! curl -f -sL -o "$TMP_FILE" "$DOWNLOAD_URL"; then
    echo "Error: Download failed."
    rm -f "$TMP_FILE"
    exit 1
fi

chmod +x "$TMP_FILE"
sudo mv "$TMP_FILE" /usr/local/bin/vh-solara

echo "Installation complete!"
echo "Run 'vh-solara --help' to get started."
