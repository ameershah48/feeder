#!/bin/sh
# Compiles the native ImageCaptureCore helper (macOS only). Skips the build when it is up to date.
set -e
cd "$(dirname "$0")/.."

SRC=native/scanhelper.swift
OUT=bin/scanhelper

if [ "$(uname)" != "Darwin" ]; then
  echo "scanhelper needs macOS (it uses Apple's ImageCaptureCore framework)." >&2
  exit 1
fi

if [ -x "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p bin
echo "Building $OUT..."
swiftc -O -swift-version 5 -o "$OUT" "$SRC"
