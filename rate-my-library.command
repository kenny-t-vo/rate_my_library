#!/bin/sh
# Double-click this in Finder to start rate-my-library.
cd "$(dirname "$0")" || exit 1
exec /usr/bin/python3 rate.py "$@"
