============== Summary ==============
Run: 1
Trace Duration: 15.58 s
Summary of Hangs (Sorted by Hang Type Ascending)
Hang Type  Count  Min Duration  Avg Duration  Std Dev Duration  Max Duration  Range
* All *        1     843.57 ms     843.57 ms               n/a     843.57 ms    n/a
└─ Hang        1     843.57 ms     843.57 ms               n/a     843.57 ms    n/a

Hangs By Duration (Limit = 5, Sorted by Duration Descending):
==============Hang #1==============
Start Time: 00:04.000.079
Duration: 843.57 ms
Hang Type: Hang

CPU Usage of Main Thread (Sorted by Category Ascending)
Category  Avg CPU Usage  Min CPU Usage  Max CPU Usage  Std Dev CPU Usage
* All *           99.2%          40.0%         100.0%               6.6%
Run `xctrace show --input "/Users/me/PhoneDock/traces/x/trace.trace" --track "Perf Demo (5417)/Main Thread (0x2b02da5)" --summary "Summary: CPU Usage" --time-start 4000079291ns --duration 843567459ns` to see this in full.

Profile of Main Thread (Min Samples = 10, System Libraries Flattened, Sorted by Weight Descending):
|is heaviest|tree level|Weight|Self Weight|Symbol Names|
|---|---|---|---|---|
|*|1|843.00 ms	100.0%|0 s|Perf Demo (5417)|
|*|2|843.00 ms	100.0%|0 s|Main Thread (0x2b02da5)|
|*|3|843.00 ms	100.0%|0 s|start|
|*|4|843.00 ms	100.0%|0 s|main|
|*|5|843.00 ms	100.0%|0 s|static PerfDemoApp.$main()|
|*|6|843.00 ms	100.0%|7.00 ms|static App.main()|
|*|7|836.00 ms	99.2%|0 s|closure #1 in closure #1 in closure #1 in closure #1 in ContentView.body.getter|
|*|8|836.00 ms	99.2%|0 s|ContentView.loadReport()|
|*|9|836.00 ms	99.2%|830.00 ms|countPrimesSlowly(upTo:)|
Run `xctrace show --input "/Users/me/PhoneDock/traces/x/trace.trace" --track "Perf Demo (5417)/Main Thread (0x2b02da5)" --calltree "Profile" --time-start 4000079291ns --duration 843567459ns` to see this in full.

Summary of SwiftUI Long Updates: N/A

Summary of OS Signposts: N/A

Summary of System Calls: N/A
