#!/bin/sh
# Keep a long-running process alive: start it again whenever it exits. The keeper exits on purpose after
# repeated failed rounds, because a wedged network stack inside one process does not heal by itself.
#   scripts/supervise.sh node indexer/zk-keeper.mjs
# To stop for good, stop this script first (it restarts anything it runs).
while :; do
  "$@"
  code=$?
  echo "$(date -u +%H:%M:%S) supervise: '$*' exited with $code; restarting in 30 s"
  sleep 30
done
