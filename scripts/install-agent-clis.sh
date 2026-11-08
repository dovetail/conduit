#!/bin/bash
# Install the current Claude Code, Amp, and Cursor agent CLIs.
#
# Each vendor's installer resolves "latest" when it runs. The image build
# invokes this only after GIT_SHA is set, so a new commit cannot replay a
# cached install layer from an earlier release.
#
# Installers key off $HOME (and, for a `curl | bash` pipeline, an assignment
# prefixed to `curl` would not reach `bash`). This script exports HOME itself
# before launching them, into a shared directory the runtime `node` user can
# read. Launchers are then symlinked onto the default PATH.
set -euo pipefail

home_dir="${AGENT_CLI_HOME:-/opt/agent-clis}"
bin_dir="${AGENT_CLI_BIN_DIR:-/usr/local/bin}"

mkdir -p "$home_dir" "$bin_dir"
export HOME="$home_dir"

echo "Refreshing agent CLIs (GIT_SHA=${GIT_SHA:-unset})"

# Native installer, `latest` channel (every release, not the week-behind
# stable channel). npm install of @anthropic-ai/claude-code is deprecated.
curl -fsSL https://claude.ai/install.sh | bash -s latest

# Official installer. An empty AMP_VERSION means the current latest build.
# @sourcegraph/amp is a compatibility alias for @ampcode/cli.
curl -fsSL https://ampcode.com/install.sh | bash

# The install script is rendered with the current Cursor agent build.
curl -fsS https://cursor.com/install | bash

# Amp only links into ~/.local/bin when that directory is already on PATH.
# Create the launcher ourselves so the layout does not depend on that.
if [ ! -x "$home_dir/.local/bin/amp" ]; then
  mkdir -p "$home_dir/.local/bin"
  ln -sfn "$home_dir/.amp/bin/amp" "$home_dir/.local/bin/amp"
fi

# Names the runner and `which` look up. `test -x` follows the symlink chain.
for name in claude amp cursor-agent; do
  src="$home_dir/.local/bin/$name"
  dest="$bin_dir/$name"
  if [ ! -e "$src" ]; then
    echo "agent CLI installer did not produce $src" >&2
    exit 1
  fi
  ln -sfn "$src" "$dest"
done

# The installers drop per-user state (machine id, first-run config, shell
# snippets) into this shared home. Runtime config belongs to the user who
# runs the CLI.
rm -rf \
  "$home_dir/.claude" \
  "$home_dir/.claude.json" \
  "$home_dir/.npm" \
  "$home_dir/.cache" \
  "$home_dir/.cursor" \
  "$home_dir/.local/state" \
  "$home_dir/.bashrc" \
  "$home_dir/.bash_profile" \
  "$home_dir/.profile" \
  "$home_dir/.zshrc"

chmod -R a+rX "$home_dir"

for name in claude amp cursor-agent; do
  test -x "$bin_dir/$name"
done

# Resolve the launchers just installed, not any older copy earlier on PATH.
# Version probes write first-run files into $HOME; keep those out of the image.
export PATH="$bin_dir:$PATH"
probe_home=$(mktemp -d)
HOME="$probe_home"

echo "Installed agent CLIs:"
echo "  claude: $(claude --version) ($(command -v claude))"
echo "  amp: $(amp version) ($(command -v amp))"
echo "  cursor-agent: $(cursor-agent --version) ($(command -v cursor-agent))"
rm -rf "$probe_home"
