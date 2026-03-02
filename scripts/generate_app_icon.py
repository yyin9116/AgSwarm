from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def _parse_hex_color(value: str) -> tuple[int, int, int, int]:
    text = str(value).strip().lstrip("#")
    if len(text) == 6:
        return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16), 255
    if len(text) == 8:
        return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16), int(text[6:8], 16)
    return 0, 0, 0, 255


def _iter_nodes(node: dict) -> list[dict]:
    items: list[dict] = [node]
    for child in node.get("children", []) or []:
        if isinstance(child, dict):
            items.extend(_iter_nodes(child))
    return items


def _find_node_by_name(root: dict, name: str) -> dict:
    for node in _iter_nodes(root):
        if node.get("name") == name:
            return node
    raise ValueError(f"node not found: {name}")


def _load_font(preferred_family: str, font_size: int, font_weight: str) -> ImageFont.ImageFont:
    weight_is_bold = str(font_weight).strip() in {"700", "800", "900", "bold", "Bold"}
    candidates: list[Path] = []
    if preferred_family.lower() == "inter":
        candidates.extend(
            [
                Path(r"C:\Windows\Fonts\Inter-Bold.ttf"),
                Path(r"C:\Windows\Fonts\Inter-Regular.ttf"),
                Path(r"C:\Windows\Fonts\Inter.ttf"),
            ]
        )
    if weight_is_bold:
        candidates.extend([Path(r"C:\Windows\Fonts\segoeuib.ttf"), Path(r"C:\Windows\Fonts\arialbd.ttf")])
    else:
        candidates.extend([Path(r"C:\Windows\Fonts\segoeui.ttf"), Path(r"C:\Windows\Fonts\arial.ttf")])
    candidates.extend(
        [
            Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
            Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        ]
    )
    for candidate in candidates:
        if candidate.exists():
            try:
                return ImageFont.truetype(str(candidate), font_size)
            except OSError:
                continue
    return ImageFont.load_default()


def _render_from_pen(*, pen_path: Path, size: int) -> Image.Image:
    payload = json.loads(pen_path.read_text(encoding="utf-8"))
    icon_frame = _find_node_by_name(payload, "AgSwarm App Icon")
    width = float(icon_frame.get("width", 440))
    height = float(icon_frame.get("height", 440))
    scale = size / max(width, height)

    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    bg = _parse_hex_color(icon_frame.get("fill", "#050912"))
    radius = int(float(icon_frame.get("cornerRadius", 0)) * scale)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=bg)

    for child in icon_frame.get("children", []) or []:
        if not isinstance(child, dict):
            continue
        node_type = child.get("type")
        x = int(float(child.get("x", 0)) * scale)
        y = int(float(child.get("y", 0)) * scale)

        if node_type == "text":
            content = str(child.get("content", ""))
            fill = _parse_hex_color(child.get("fill", "#FFFFFF"))
            font_size = max(8, int(float(child.get("fontSize", 16)) * scale))
            font = _load_font(str(child.get("fontFamily", "Inter")), font_size, str(child.get("fontWeight", "700")))
            draw.text((x, y), content, fill=fill, font=font)
            continue

        if node_type == "frame":
            w = int(float(child.get("width", 0)) * scale)
            h = int(float(child.get("height", 0)) * scale)
            if w <= 0 or h <= 0:
                continue
            fill = _parse_hex_color(child.get("fill", "#FFFFFF"))
            rr = int(float(child.get("cornerRadius", 0)) * scale)
            draw.rounded_rectangle((x, y, x + w, y + h), radius=rr, fill=fill)

    return image


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    pen_path = root / "prototype" / "prototype.pen"
    if not pen_path.exists():
        raise FileNotFoundError(f"missing pen file: {pen_path}")

    out_dir = root / "assets" / "icons"
    out_dir.mkdir(parents=True, exist_ok=True)

    image = _render_from_pen(pen_path=pen_path, size=1024)
    png_path = out_dir / "app-icon.png"
    ico_path = out_dir / "app-icon.ico"
    icns_path = out_dir / "app-icon.icns"
    image.save(png_path, format="PNG")
    image.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    try:
        image.save(icns_path, format="ICNS")
    except Exception:
        if icns_path.exists():
            icns_path.unlink()

    print(f"source: {pen_path}")
    print(f"generated: {png_path}")
    print(f"generated: {ico_path}")
    if icns_path.exists():
        print(f"generated: {icns_path}")
    else:
        print("skip icns (encoder unavailable)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
