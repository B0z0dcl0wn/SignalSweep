#!/usr/bin/env bash
# Host-side C++ tests for the attack-detector window logic and the Axon
# payload checks (v23). Pure functions, no ESP headers, so plain g++
# compiles them. Runs locally (WSL) and in CI.
set -euo pipefail
cd "$(dirname "$0")"
CXX="${CXX:-g++}"
dir="$(mktemp -d)"
for t in attack_detectors_test axon_checks_test; do
    "$CXX" -std=c++17 -Wall -Wextra -O1 "$t.cpp" -o "$dir/$t"
    "$dir/$t"
done
