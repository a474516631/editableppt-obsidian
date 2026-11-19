"""Tiles rendered slide PNGs into contact sheets: contact-sheet.py <dir> <name> [columns] [per-sheet]"""
import glob, sys
from PIL import Image

folder, name = sys.argv[1], sys.argv[2]
columns = int(sys.argv[3]) if len(sys.argv) > 3 else 3
per_sheet = int(sys.argv[4]) if len(sys.argv) > 4 else 9
files = sorted(glob.glob(f"{folder}/{name}-[0-9]*.png"))
for sheet, start in enumerate(range(0, len(files), per_sheet)):
    images = [Image.open(f).convert("RGB") for f in files[start:start + per_sheet]]
    w, h = images[0].size
    rows = -(-len(images) // columns)
    canvas = Image.new("RGB", (columns * (w + 8) + 8, rows * (h + 8) + 8), (120, 120, 120))
    for i, image in enumerate(images):
        canvas.paste(image, (8 + (i % columns) * (w + 8), 8 + (i // columns) * (h + 8)))
    out = f"{folder}/{name}-sheet{sheet + 1}.png"
    canvas.save(out)
    print(out, canvas.size)
