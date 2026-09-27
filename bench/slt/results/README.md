# sqllogictest results, 2026-09-27

The run BENCHMARKS.md §13 reports. `<engine>.counts`: one line per corpus file,
`file records passed failed skipped`. `chronos-only.failures`: every record that
fails on Chronos DB and passes on Postgres 17 (all 63 are division by zero beside a
NULL constant). The full failure logs of both engines aren't kept here (2 MB).
