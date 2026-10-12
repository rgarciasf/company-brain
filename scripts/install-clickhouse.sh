#!/bin/sh
# Downloads the official single-file ClickHouse binary into .clickhouse/ (no Docker needed).
set -e
cd "$(dirname "$0")/.."
OS=$(uname -s); ARCH=$(uname -m)
case "$OS-$ARCH" in
  Darwin-arm64)  DIR=macos-aarch64 ;;
  Darwin-x86_64) DIR=macos ;;
  Linux-aarch64|Linux-arm64) DIR=aarch64 ;;
  Linux-x86_64)  DIR=amd64 ;;
  *) echo "Unsupported platform $OS-$ARCH"; exit 1 ;;
esac
mkdir -p .clickhouse
if [ -x .clickhouse/clickhouse ]; then echo "ClickHouse already installed: $(.clickhouse/clickhouse local --query 'SELECT version()')"; exit 0; fi
echo "Downloading ClickHouse for $DIR…"
curl -fL --progress-bar -o .clickhouse/clickhouse "https://builds.clickhouse.com/master/$DIR/clickhouse"
chmod +x .clickhouse/clickhouse
[ "$OS" = Darwin ] && xattr -d com.apple.quarantine .clickhouse/clickhouse 2>/dev/null || true
echo "Installed ClickHouse $(.clickhouse/clickhouse local --query 'SELECT version()')"
