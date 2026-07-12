# bullmq-dash README demo — a 2am on-call triage tour:
# launch → rank by size → search → failed filter → stacktrace.
#
# Regenerate (requires: brew install redis vhs, bullmq-dash on PATH):
#   redis-server --port 6379 --daemonize yes --save '' --appendonly no
#   bun docs/demo/seed-demo.ts
#   bun docs/demo/live-traffic.ts &        # keep running while recording
#   cd docs/demo && vhs demo.tape          # writes demo.gif here
#   mv demo.gif ../demo.gif                # replace the README asset
#   kill %1; redis-cli shutdown nosave
Output demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 720
Set Padding 12
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms

Type "bullmq-dash --tui --redis-url redis://localhost:6379"
Sleep 800ms
Enter
Sleep 5s

# Rank queues by task size (busiest first)
Type "s"
Sleep 2s

# Walk the queue list
Type "j"
Sleep 700ms
Type "j"
Sleep 1.2s

# Live queue search
Type "/"
Sleep 900ms
Type@120ms "pay"
Sleep 1.5s
Enter
Sleep 1.5s

# Jump to failed jobs in the payments queue
Type "5"
Sleep 1.8s
Tab
Sleep 1.2s

# Open a failed job: payload + stacktrace
Enter
Sleep 4s
Escape
Sleep 2.5s
