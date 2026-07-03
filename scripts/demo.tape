# Ayo demo tape. Record the README GIF with:  vhs scripts/demo.tape
#
# Requires charmbracelet/vhs (`brew install vhs`) and the local dev rig from
# the README's "Try it solo" section running as persona "you" (so `ayo` is
# aliased and AYO_RELAY_URL points at the local relay). Writes docs/demo.gif.
#
# The story is the wedge: one handoff, and the link that works for anyone.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 600
Set Padding 22
Set Theme "Catppuccin Mocha"

Sleep 500ms

Type "ayo handoff maya 'oauth callback 400s, the token exchange rejects redirect_uri'"
Sleep 800ms
Enter
Sleep 3s

# prints: ✓ handoff sent  /  ✓ share link  https://…/h/AbCd…
Type "# that link renders your branch, diff, and blocker for anyone,"
Sleep 900ms
Enter
Type "# even before they install Ayo, and they can reply from the page."
Sleep 2500ms
Enter
Sleep 1500ms
