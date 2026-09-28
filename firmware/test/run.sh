#!/usr/bin/env bash
# Host-side C++ tests for the attack-detector window logic. Pure functions,
# no ESP headers, so plain g++ compiles them. Runs locally (WSL) and in CI.
set -euo pipefail
cd "$(dirname "$0")"
CXX="${CXX:-g++}"
out="$(mktemp -d)/attack_detectors_test"
"$CXX" -std=c++17 -Wall -Wextra -O1 attack_detectors_test.cpp -o "$out"
"$out"
