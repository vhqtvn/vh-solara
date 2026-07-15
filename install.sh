#!/bin/bash
set -e

command -v jq >/dev/null 2>&1 || {
    echo "Error: jq is required but not installed." >&2
    exit 1
}

REPO_URL="https://github.com/vhqtvn/vh-solara"
API_URL="https://api.github.com/repos/vhqtvn/vh-solara/releases/latest"
INSTALL_TARGET="/usr/local/bin/vh-solara"

# Temp artifacts cleaned on every exit path (set -e aborts, interrupts, and
# normal completion). Each rm -f is guarded so unset/already-moved temps do
# not error.
TMP_FILE=""
TMP_SUMS=""
STAGED=""
cleanup() {
    rm -f "${TMP_FILE:-}" "${TMP_SUMS:-}" "${STAGED:-}" 2>/dev/null || true
}
trap cleanup EXIT

# verify_sha256 <binary_file> <sums_file> <binary_name>
# Returns 0 iff SHA256SUMS contains an entry for binary_name whose digest
# matches sha256sum(binary_file), compared case-insensitively (parity with
# cmd/update.go's strings.EqualFold). Aborts (return 1 + stderr message) on
# a missing entry or a mismatch -- never installs an unverified binary.
# Mirrors the in-binary update command's mandatory policy (cmd/update.go:103-110).
# --- begin verify_sha256 ---
verify_sha256() {
    bin_file="$1"
    sums_file="$2"
    bin_name="$3"
    expected=$(awk -v want="$bin_name" '{
        name=$2
        sub(/^\*/, "", name)
        if (name == want) { print tolower($1); exit }
    }' "$sums_file")
    if [ -z "$expected" ]; then
        echo "Error: No SHA256SUMS entry for $bin_name; refusing to install unverified binary." >&2
        return 1
    fi
    actual=$(sha256sum "$bin_file" | awk '{print tolower($1)}')
    if [ "$actual" != "$expected" ]; then
        echo "Error: Checksum mismatch for $bin_name: got $actual, expected $expected." >&2
        return 1
    fi
    return 0
}
# --- end verify_sha256 ---

echo "Fetching latest release information..."
LATEST_RELEASE=$(curl -sL $API_URL)

if [ -z "$LATEST_RELEASE" ] || echo "$LATEST_RELEASE" | grep -q "Not Found"; then
    echo "Error: Could not fetch latest release. Make sure the repository is public or you have access."
    exit 1
fi

VERSION=$(echo "$LATEST_RELEASE" | jq -r '.tag_name')
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
    echo "Error: Could not parse release version." >&2
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
    echo "Error: Download failed." >&2
    rm -f "$TMP_FILE"
    exit 1
fi

# Fetch the release's published SHA256SUMS (asset URL taken from the same
# release JSON used for tag_name) and verify the downloaded binary before
# installing. Refuses unverified binaries exactly like cmd/update.go:108-110.
SUMS_URL=$(echo "$LATEST_RELEASE" | jq -r '.assets[] | select(.name == "SHA256SUMS") | .browser_download_url')
if [ -z "$SUMS_URL" ] || [ "$SUMS_URL" = "null" ]; then
    echo "Error: Release $VERSION has no SHA256SUMS asset; refusing to install unverified binary." >&2
    rm -f "$TMP_FILE"
    exit 1
fi

TMP_SUMS=$(mktemp)
if ! curl -f -sL -o "$TMP_SUMS" "$SUMS_URL"; then
    echo "Error: Could not download SHA256SUMS for $VERSION." >&2
    rm -f "$TMP_FILE" "$TMP_SUMS"
    exit 1
fi

if ! verify_sha256 "$TMP_FILE" "$TMP_SUMS" "$BINARY_NAME"; then
    rm -f "$TMP_FILE" "$TMP_SUMS"
    exit 1
fi
rm -f "$TMP_SUMS"

# Install atomically: stage the verified binary as a sibling of the target in
# the SAME filesystem (dirname of INSTALL_TARGET), set mode 0755, then mv -f
# over the target. Because the rename is within one filesystem it is atomic --
# a failed staging (disk full, I/O error) or interrupted rename leaves the
# previously-installed binary intact instead of truncating it. Mirrors
# cmd/update.go's replaceInPlace / replaceWithSudo posture
# (cmd/update.go:205-247). Write directly when the target directory is
# writeable; only elevate via sudo when it is not (e.g. root-owned
# /usr/local/bin on a system/container without passwordless sudo).
TARGET_DIR=$(dirname "$INSTALL_TARGET")
if [ -w "$TARGET_DIR" ]; then
    STAGED=$(mktemp "$TARGET_DIR/.vh-solara.XXXXXX") || {
        echo "Error: cannot stage install file in $TARGET_DIR" >&2
        exit 1
    }
    if ! cp "$TMP_FILE" "$STAGED" || ! chmod 0755 "$STAGED"; then
        rm -f "$STAGED"
        echo "Error: staging install file failed" >&2
        exit 1
    fi
    if ! mv -f "$STAGED" "$INSTALL_TARGET"; then
        rm -f "$STAGED"
        echo "Error: atomic rename to $INSTALL_TARGET failed" >&2
        exit 1
    fi
else
    STAGED=$(sudo mktemp "$TARGET_DIR/.vh-solara.XXXXXX") || {
        echo "Error: cannot stage install file in $TARGET_DIR" >&2
        exit 1
    }
    if ! sudo cp "$TMP_FILE" "$STAGED" || ! sudo chmod 0755 "$STAGED"; then
        sudo rm -f "$STAGED"
        echo "Error: staging install file failed" >&2
        exit 1
    fi
    if ! sudo mv -f "$STAGED" "$INSTALL_TARGET"; then
        sudo rm -f "$STAGED"
        echo "Error: atomic rename to $INSTALL_TARGET failed" >&2
        exit 1
    fi
fi

echo "Installation complete!"
echo "Run 'vh-solara --help' to get started."
