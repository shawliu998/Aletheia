#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="${ROOT_DIR}/desktop"
DIST_DIR="${DESKTOP_DIR}/dist"
DESKTOP_VERSION="$(node -p "require('${DESKTOP_DIR}/package.json').version")"
RELEASE_SIGNING="${VERA_RELEASE_SIGNING:-false}"
LOCAL_ZIP_ONLY="${VERA_LOCAL_ZIP_ONLY:-false}"

if [ "${RELEASE_SIGNING}" != "false" ] && [ "${RELEASE_SIGNING}" != "true" ]; then
  echo "VERA_RELEASE_SIGNING must be exactly true or false." >&2
  exit 1
fi
if [ "${LOCAL_ZIP_ONLY}" != "false" ] && [ "${LOCAL_ZIP_ONLY}" != "true" ]; then
  echo "VERA_LOCAL_ZIP_ONLY must be exactly true or false." >&2
  exit 1
fi
if [ "${RELEASE_SIGNING}" = "true" ] && [ "${LOCAL_ZIP_ONLY}" = "true" ]; then
  echo "VERA_LOCAL_ZIP_ONLY is only available for unsigned local builds." >&2
  exit 1
fi

echo "==> Checking macOS signing mode"
VERA_RELEASE_SIGNING="${RELEASE_SIGNING}" \
  npm run signing:preflight --prefix "${DESKTOP_DIR}"
VERA_RELEASE_SIGNING="${RELEASE_SIGNING}" \
  npm run signing:readiness --prefix "${DESKTOP_DIR}" -- --no-artifacts

echo "==> Building Vera connected backend"
npm run build --prefix "${ROOT_DIR}/backend"

echo "==> Verifying Vera connected frontend"
(cd "${ROOT_DIR}/frontend" && ./node_modules/.bin/tsc --noEmit)
(cd "${ROOT_DIR}/frontend" && npm run lint -- \
  src/app/components/agent/AgentTaskWorkspace.tsx \
  src/app/lib/agentClient.ts)
npm run build --prefix "${ROOT_DIR}/frontend" -- --webpack

echo "==> Installing Electron packaging dependencies"
npm ci --prefix "${DESKTOP_DIR}"

echo "==> Verifying connected desktop security and startup"
npm run test:connected --prefix "${DESKTOP_DIR}"

if [ "${RELEASE_SIGNING}" = "true" ]; then
  echo "==> Release build; Developer ID signature and notarization are required"
  npm run dist:mac --prefix "${DESKTOP_DIR}"
else
  echo "==> Packaging local-only macOS client (signed=false notarized=false)"
  if [ "${LOCAL_ZIP_ONLY}" = "true" ]; then
    echo "==> ZIP-only mode explicitly enabled; DMG creation and verification will be skipped"
    (cd "${DESKTOP_DIR}" && env -u CSC_NAME -u CSC_LINK -u CSC_KEY_PASSWORD \
      -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID \
      -u APPLE_API_KEY -u APPLE_API_KEY_ID -u APPLE_API_ISSUER \
      CSC_IDENTITY_AUTO_DISCOVERY=false \
      VERA_RELEASE_SIGNING=false \
      ./node_modules/.bin/electron-builder --mac zip)
  else
    env -u CSC_NAME -u CSC_LINK -u CSC_KEY_PASSWORD \
      -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID \
      -u APPLE_API_KEY -u APPLE_API_KEY_ID -u APPLE_API_ISSUER \
      CSC_IDENTITY_AUTO_DISCOVERY=false \
      VERA_RELEASE_SIGNING=false \
      npm run dist:mac --prefix "${DESKTOP_DIR}"
  fi
fi

PACKAGED_APP="${DIST_DIR}/mac-${HOSTTYPE:-arm64}/Vera.app"
if [ ! -d "${PACKAGED_APP}" ]; then
  PACKAGED_APP="$(find "${DIST_DIR}" -maxdepth 2 -type d -name Vera.app -print -quit)"
fi
if [ -z "${PACKAGED_APP}" ] || [ ! -d "${PACKAGED_APP}" ]; then
  echo "Vera.app was not produced." >&2
  exit 1
fi

echo "==> Verifying packaged Vera.app"
VERA_PACKAGED_APP_PATH="${PACKAGED_APP}" npm run test:connected-smoke --prefix "${DESKTOP_DIR}"
VERA_PACKAGED_APP_PATH="${PACKAGED_APP}" npm run test:connected-first-run --prefix "${DESKTOP_DIR}"

echo "==> Generating checksums"
if [ "${LOCAL_ZIP_ONLY}" = "true" ]; then
  (cd "${DIST_DIR}" && shasum -a 256 \
    "Vera-Connected-${DESKTOP_VERSION}-"*.zip \
    > "Vera-Connected-${DESKTOP_VERSION}-SHA256SUMS.txt")
else
  (cd "${DIST_DIR}" && shasum -a 256 \
    "Vera-Connected-${DESKTOP_VERSION}-"*.dmg \
    "Vera-Connected-${DESKTOP_VERSION}-"*.zip \
    > "Vera-Connected-${DESKTOP_VERSION}-SHA256SUMS.txt")
fi

DMG_PATH="$(find "${DIST_DIR}" -maxdepth 1 -type f -name "Vera-Connected-${DESKTOP_VERSION}-*.dmg" -print -quit)"
ZIP_PATH="$(find "${DIST_DIR}" -maxdepth 1 -type f -name "Vera-Connected-${DESKTOP_VERSION}-*.zip" -print -quit)"
CHECKSUM_PATH="${DIST_DIR}/Vera-Connected-${DESKTOP_VERSION}-SHA256SUMS.txt"

if [ -z "${ZIP_PATH}" ]; then
  echo "Vera ZIP artifact was not produced." >&2
  exit 1
fi
if [ "${LOCAL_ZIP_ONLY}" != "true" ] && [ -z "${DMG_PATH}" ]; then
  echo "Vera DMG and ZIP artifacts were not both produced." >&2
  exit 1
fi

echo "==> Verifying package containers and checksums"
if [ -n "${DMG_PATH}" ]; then
  hdiutil verify "${DMG_PATH}"
fi
unzip -tq "${ZIP_PATH}"
(cd "${DIST_DIR}" && shasum -a 256 -c "$(basename "${CHECKSUM_PATH}")")

ARTIFACT_ARGUMENTS=(
  --app "${PACKAGED_APP}"
  --zip "${ZIP_PATH}"
  --checksum-manifest "${CHECKSUM_PATH}"
)
if [ -n "${DMG_PATH}" ]; then
  ARTIFACT_ARGUMENTS+=(--dmg "${DMG_PATH}")
fi

if [ "${RELEASE_SIGNING}" = "true" ]; then
  echo "==> Verifying Developer ID, Gatekeeper, notarization tickets, and checksums"
  npm run signing:verify --prefix "${DESKTOP_DIR}" -- "${ARTIFACT_ARGUMENTS[@]}"
else
  echo "==> Reporting local-only package readiness"
  VERA_RELEASE_SIGNING=false npm run signing:readiness --prefix "${DESKTOP_DIR}" -- \
    "${ARTIFACT_ARGUMENTS[@]}"
fi

echo "==> Connected desktop artifacts"
find "${DIST_DIR}" -maxdepth 2 -type f -print | sort
