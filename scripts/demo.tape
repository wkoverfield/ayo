# Ayo demo tape — an on-demand terminal demo gif (NOT committed; the README
# leads with the handoff-page screenshot, since the terminal is only one of
# Ayo's surfaces). Record it (relay + team + seed state) with:
#
#     pnpm -r build && scripts/record-demo.sh
#
# Requires charmbracelet/vhs. record-demo.sh boots a local relay, seeds an
# inbound handoff (with real git context) and a blocked agent ask, then runs
# this tape. Every frame below is genuine `ayo` output.
#
# The story, from your seat at the terminal: work arrives WITH its context, your
# own agent asks you before it acts, and you hand off with a link anyone can
# open — all without leaving the terminal. Typed lines stay ASCII (VHS mangles
# the cursor on typed em-dashes); the product's own output carries the rest.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 17
Set Width 1280
Set Height 600
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

# ── setup (not recorded): env + the clean `ayo` wrapper on PATH ──
Hide
Type "source /tmp/ayo-demo-rec/env.sh && clear"
Enter
Show

Sleep 600ms

# 1 — work arrives with its context: a teammate's handoff + a pinned agent ask
Type "ayo inbox"
Sleep 400ms
Enter
Sleep 3s

# 2 — your own agent hit a fork and is waiting on you, instead of guessing
Type "ayo agents"
Sleep 400ms
Enter
Sleep 3s

Type "ayo answer 1 backoff"
Sleep 400ms
Enter
Sleep 2.5s

# 3 — hand your work off with a link that works for anyone (its output says so)
Type "ayo handoff maya "
Type "'the staging deploy is yours'"
Sleep 500ms
Enter
Sleep 4s
