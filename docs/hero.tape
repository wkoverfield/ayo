Regenerate docs/hero.png (the README banner) from the real logo:

1. sips -Z 256 docs/ayo-logo.png --out /tmp/ayo256.png
2. Build /tmp/banner-render.html: a 1000px .banner div (cream #F4EDE1, border
   #E7DCC9, radius 18) with the logo (embedded as a data: URI, 124px, radius 27),
   the tagline (Sora 26px bold: "Keep communicating and keep coding.") over a subline (19px, .82 opacity: "Terminal-native pings for small teams, git context attached."), and a mono prompt line
   ($ in sage #3E9A6E, command in ink — a PING, e.g. `ayo maya "auth endpoint is live, you're unblocked"`, never a handoff — and a coral #E15C3D block cursor). Sage glow
   top-right. Load Sora from Google Fonts.
3. "Google Chrome" --headless=new --force-device-scale-factor=2
   --default-background-color=00000000 --window-size=1120,500
   --screenshot=/tmp/shot.png file:///tmp/banner-render.html
4. magick /tmp/shot.png -trim +repage -bordercolor transparent -border 2 docs/hero.png
