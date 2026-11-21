# Offline tool foundations

These tools include both offline helpers and executable integrations. The simulator CLI binds and connects to a configured core and has partial synthetic call and media support. The audio probe includes injectable localhost call/media transport and WAV recording, but is not yet a complete G0 probe. The Shizuku service invokes adb and reports to core for explicitly enrolled serials. The prompt validator does not synthesize or publish audio. Tests use fakes and do not connect to services or devices; consult each tool README for implementation limits.

Run python -m unittest discover -s tools -p test_foundations.py from the repository root.

## Compare saved command inventories

Run `python tools/compare_command_inventories.py --core core.ndjson --android android.json` with explicitly saved Core and Android inventory reports. The tool reads only these files and writes JSON to stdout; it does not access databases, send data, modify inputs, migrate, or activate anything. Each input is limited to 64 MiB.

Core metadata and terminal status, count and ordering, and Android source metadata and selected table coverage are checked. Incomplete input fails by default; `--allow-partial` emits observations marked partial with coverage issues. Invalid formats and ordering are rejected even in partial mode. Hashes identify the supplied report bytes and do not authenticate them; Android source fingerprints are retained claims. The output retains source metadata and report-array row references without reproducing Android payloads.

Only exact case-sensitive string equality is used, including empty or malformed strings; missing and non-string IDs are separate diagnostics. Duplicate occurrences remain distinct; `multiple_occurrences` reports repeated rows, including potentially linked Android command and task rows, without asserting a collision. `core_cross_table_overlap` separately flags a Core row carrying both call and SMS facets; `ambiguous` reflects either condition. Core attempt and registry facets remain available in row fields; Android tables remain distinct. The Android report supplies no independently verified row count or integrity proof, so complete coverage only describes what the report claims. Partial mode does not accept malformed structures. An overlap establishes neither device, generation, ownership nor safety. One-sided means observed in one supplied report, not absent elsewhere. The source snapshots may have different times; Android quiescence is caller asserted, integrity and schema validity are unverified, and volatile histories are excluded.

Run `python -m unittest discover -s tools -p test_compare_command_inventories.py` for synthetic project-local tests.
