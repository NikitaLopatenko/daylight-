from pathlib import Path
import numpy as np
from rembg import new_session, remove
from PIL import Image, ImageFilter

src = Path(
    r"C:\Users\lopat\.cursor\projects\c-Users-lopat-OneDrive-automaticTools\assets"
    r"\c__Users_lopat_AppData_Roaming_Cursor_User_workspaceStorage_bfa158a1fb6e351beaf1013cf49dd126_images_image-22b01c97-5636-4640-93fe-ec39b05b833b.png"
)
out_dir = Path(__file__).resolve().parents[1] / "public" / "photos"
out_dir.mkdir(parents=True, exist_ok=True)

img = Image.open(src).convert("RGBA")
session = new_session("u2net_human_seg")
cut = remove(img, session=session)

arr = np.array(cut).astype(np.float32)
rgb = arr[:, :, :3]
alpha = arr[:, :, 3]

# Drop weak fringe / grey halo
alpha[alpha < 35] = 0
# Soften remaining edge
soft = alpha.copy()
soft[soft < 90] *= 0.55
alpha = soft
arr[:, :, 3] = np.clip(alpha, 0, 255)
cut = Image.fromarray(arr.astype(np.uint8), "RGBA")

alpha_img = cut.split()[-1]
bbox = alpha_img.getbbox()
if bbox:
    pad = 20
    x0, y0, x1, y1 = bbox
    cut = cut.crop((
        max(0, x0 - pad),
        max(0, y0 - pad),
        min(cut.width, x1 + pad),
        min(cut.height, y1 + pad),
    ))

# Scale for web
target_w = 880
scale = target_w / cut.width
cut = cut.resize((target_w, int(cut.height * scale)), Image.Resampling.LANCZOS)

out_png = out_dir / "hero-portrait.png"
# Also keep a white-backed jpg fallback
white = Image.new("RGB", cut.size, (255, 255, 255))
white.paste(cut, mask=cut.split()[-1])
out_jpg = out_dir / "hero-portrait.jpg"

cut.save(out_png, "PNG")
white.save(out_jpg, "JPEG", quality=94)
print("saved", out_png.name, cut.size)
print("saved", out_jpg.name, white.size)
