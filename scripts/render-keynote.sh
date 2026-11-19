#!/bin/bash
# Renders a .pptx to PNG pages through Keynote, to check what a real
# presentation app makes of the export. macOS only; needs Keynote and pdftoppm.
set -euo pipefail
input="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
outdir="${2:-$(dirname "$input")/render}"
mkdir -p "$outdir"
outdir="$(cd "$outdir" && pwd)"
name="$(basename "$input" .pptx)"
pdf="$outdir/$name.pdf"
rm -f "$pdf"
osascript <<APPLESCRIPT
with timeout of 120 seconds
  tell application "Keynote"
    set theDoc to open POSIX file "$input"
    delay 1
    export theDoc to POSIX file "$pdf" as PDF
    close theDoc saving no
  end tell
end timeout
APPLESCRIPT
rm -f "$outdir/$name"-[0-9]*.png
pdftoppm -r 50 -png "$pdf" "$outdir/$name"
ls "$outdir" | grep -c "^$name-[0-9]"
