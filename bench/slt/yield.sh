#!/bin/bash
# yield.sh <pid...>: while a queue job (timing) holds ~/BENCH_LOCK, keep these processes and their
# descendants stopped; exits when they have all ended (it runs while any is alive)
tree() { for p in "$@"; do echo $p; tree $(ps -o pid= --ppid $p); done; }
while ps -p "$(echo $* | tr " " ,)" >/dev/null; do
  if grep -qs "^queue:" ~/BENCH_LOCK; then kill -STOP $(tree "$@") 2>/dev/null; else kill -CONT $(tree "$@") 2>/dev/null; fi
  sleep 3
done
