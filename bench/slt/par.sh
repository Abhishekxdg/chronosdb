#!/bin/bash
# par.sh <chronos|postgres> <out dir> <workers> <test files...>: run.sh on W shards at once (files
# dealt out biggest first, each to the shard with the fewest bytes), into <out>/w<N>; then the totals.
set -u
E=$1 O=$2 W=$3; shift 3
D=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$O"
stat -c "%s %n" "$@" | sort -rn | awk -v w=$W -v o="$O" '{m=0; for (i=1;i<w;i++) if (b[i]<b[m]) m=i; b[m]+=$1; print $2 > (o "/shard" m)}'
for ((i = 0; i < W; i++)); do
  [ -s "$O/shard$i" ] && N=$i "$D/run.sh" "$E" "$O/w$i" $(cat "$O/shard$i") > "$O/w$i.summary" 2>&1 &
done
wait
cat "$O"/w*/counts > "$O/counts"
awk '{r+=$2; o+=$3; f+=$4; s+=$5} END {printf "%d files, %d records run, %d passed (%.3f%%), %d failed, %d skipped for postgresql\n", NR, r, o, 100*o/r, f, s}' "$O/counts"
