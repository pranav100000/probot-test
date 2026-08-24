#!/usr/bin/env bash
set -euo pipefail
# Print the latest release tag, failing loudly when none exists.
git describe --tags --abbrev=0
