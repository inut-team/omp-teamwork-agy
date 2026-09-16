#!/bin/sh
set -e

# OMP Teamwork Agy Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/inut-team/omp-teamwork-agy/feature/teamwork-agy/scripts/install.sh | bash
#
# Options:
#   --binary       Install prebuilt binary (default)
#   --source       Install via bun from source repository
#   --ref <ref>    Install specific release tag or git ref
#   -r <ref>       Shorthand for --ref

REPO="${OMP_REPO:-inut-team/omp-teamwork-agy}"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE="binary"
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            echo "OMP Teamwork Agy Coding Agent Installer"
            echo ""
            echo "Usage: curl -fsSL https://raw.githubusercontent.com/inut-team/omp-teamwork-agy/feature/teamwork-agy/scripts/install.sh | bash"
            echo ""
            echo "Options:"
            echo "  --binary       Install prebuilt binary (default)"
            echo "  --source       Install via bun from source repository"
            echo "  --ref <ref>    Install specific release tag or git ref"
            echo "  -r <ref>       Shorthand for --ref"
            echo "  -h, --help     Show this help message"
            exit 0
            ;;
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Normalized host architecture (x64|arm64)
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Install via bun from git repository
install_via_bun() {
    TARGET_REF="${REF:-feature/teamwork-agy}"
    echo "Installing via bun from ${REPO} (ref: ${TARGET_REF})..."
    if ! has_git; then
        echo "git is required when installing from source"
        exit 1
    fi

    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    if git clone --depth 1 --branch "$TARGET_REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
        :
    else
        git clone "https://github.com/${REPO}.git" "$TMP_DIR"
        (cd "$TMP_DIR" && git checkout "$TARGET_REF")
    fi

    if has_git_lfs; then
        (cd "$TMP_DIR" && git lfs pull)
    fi

    if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
        echo "Expected package at ${TMP_DIR}/packages/coding-agent"
        exit 1
    fi

    bun install -g "$TMP_DIR/packages/coding-agent" || {
        echo "Failed to install from source"
        exit 1
    }
    echo ""
    echo "✓ Successfully installed omp via bun"
    echo "Run 'omp' to get started!"
}

# Install prebuilt binary from GitHub releases
install_binary() {
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS (supported: Linux, Darwin/macOS)"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)         echo "Unsupported architecture: $ARCH (supported: x86_64, arm64)"; exit 1 ;;
    esac

    BINARY="omp-${PLATFORM}-${ARCH}"

    if [ -n "$REF" ]; then
        echo "Fetching release ${REF} from ${REPO}..."
        RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}" 2>/dev/null || true)
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -n1 | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
        if [ -z "$LATEST" ]; then
            echo "Release tag not found: ${REF} on ${REPO}"
            echo "For branch/commit installs, use: --source --ref ${REF}"
            exit 1
        fi
    else
        echo "Fetching latest release from ${REPO}..."
        RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -n1 | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    fi

    if [ -z "$LATEST" ]; then
        echo "No published releases found yet on https://github.com/${REPO}."
        echo "To install from source right now, run:"
        echo "  curl -fsSL https://raw.githubusercontent.com/${REPO}/feature/teamwork-agy/scripts/install.sh | bash -s -- --source --ref feature/teamwork-agy"
        exit 1
    fi

    echo "Target version: ${LATEST}"
    mkdir -p "$INSTALL_DIR"

    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY} from ${BINARY_URL}..."
    if ! curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "${INSTALL_DIR}/omp"; then
        echo "Failed to download ${BINARY} from ${BINARY_URL}"
        exit 1
    fi

    chmod +x "${INSTALL_DIR}/omp"

    # Verify freshly downloaded binary
    if ! SMOKE_OUTPUT="$("${INSTALL_DIR}/omp" --version 2>&1)"; then
        echo ""
        echo "✗ omp was downloaded to ${INSTALL_DIR}/omp but failed to run:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        exit 1
    fi

    echo ""
    echo "✓ Successfully installed omp (${LATEST}) to ${INSTALL_DIR}/omp"

    case ":$PATH:" in
        *":$INSTALL_DIR:"*)
            echo "Run 'omp' to get started!"
            ;;
        *)
            echo "Add ${INSTALL_DIR} to your PATH to use 'omp':"
            echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
            ;;
    esac
}

# Main execution
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        install_via_bun
        ;;
    binary|*)
        install_binary
        ;;
esac
