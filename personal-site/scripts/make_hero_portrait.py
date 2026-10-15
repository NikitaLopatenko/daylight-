from pathlib import Path
import numpy as np
from rembg import new_session, remove
from PIL import Image, ImageFilter

src = Path(
    r"C:\Users\lopat\.cursor\projects\c-Users-lopat-OneDrive-automaticTools\assets"
    r"\c__Users_lopat_AppData_Roaming_Cursor_User_workspaceStorage_bfa158a1fb6e351beaf1013cf49dd126_images_image-b5dcfaf2-7bf0-4cdf-a129-12d44f75c4a0.png"
)
out_dir = Path(__file__).resolve().parents[1] / "public" / "photos"
out_dir.mkdir(parents=True, exist_ok=True)

img = Image.open(src).convert("RGBA")
w, h = img.size
# Tight crop around the portrait (right side), cut most of the red graphic
crop = img.crop((int(w * 0.48), int(h * 0.04), int(w * 0.97), int(h * 0.88)))

session = new_session("u2net_human_seg")
cut = remove(crop, session=session)

arr = np.array(cut).astype(np.float32)
rgb = arr[:, :, :3]
alpha = arr[:, :, 3]

# Kill leftover club-graphic reds (not skin / hair / shirt)
reddish = (rgb[:, :, 0] > 170) & (rgb[:, :, 1] < 120) & (rgb[:, :, 2] < 120)
# Also kill near-white red tint leftovers
red_tint = (rgb[:, :, 0] > 200) & (rgb[:, :, 1] < 160) & (rgb[:, :, 2] < 160) & (rgb[:, :, 0] - rgb[:, :, 1] > 40)
kill = reddish | red_tint
alpha[kill] = 0

# Soften fringe: low-alpha edge noise -> transparent
alpha[alpha < 28] = 0

cut = Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8), "RGBA")
# Slight feather
cut = cut.filter(ImageFilter.SMOOTH_MORE)

alpha_img = cut.split()[-1]
bbox = alpha_img.getbbox()
if bbox:
    pad = 18
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(cut.width, x1 + pad)
    y1 = min(cut.height, y1 + pad)
    cut = cut.crop((x0, y0, x1, y1))

side = int(max(cut.width, cut.height) * 1.08)
canvas = Image.new("RGBA", (side, side), (255, 255, 255, 255))
ox = (side - cut.width) // 2
oy = max(0, (side - cut.height) // 2 + side // 20)
canvas.paste(cut, (ox, oy), cut)

final = Image.new("RGB", canvas.size, (255, 255, 255))
final.paste(canvas, mask=canvas.split()[-1])

# Final scrub: any remaining saturated red -> white
fa = np.array(final)
still_red = (fa[:, :, 0] > 190) & (fa[:, :, 1] < 130) & (fa[:, :, 2] < 130)
fa[still_red] = [255, 255, 255]
final = Image.fromarray(fa)

out = out_dir / "hero-portrait.jpg"
final.save(out, "JPEG", quality=93)
print("saved", out.name, final.size)
