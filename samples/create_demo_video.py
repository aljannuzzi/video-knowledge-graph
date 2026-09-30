"""Generate original illustrated footage; no third-party media or real identities."""

import argparse
import json
import subprocess
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont


BG = "#f5efe4"
INK = "#292927"
ROSE = "#ae3153"
GREEN = "#476c56"
SKIN = "#c68d69"
WIDTH, HEIGHT = 1280, 720


def font(size):
    for candidate in (
        Path("C:\\Windows\\Fonts\\segoeui.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ):
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default(size=size)


def room(title):
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    d = ImageDraw.Draw(image)
    d.rectangle((0, 505, WIDTH, HEIGHT), fill="#dfc8a8")
    d.rectangle((820, 96, 1150, 358), fill="#e9f0e5", outline="#b9b7a4", width=9)
    d.line((985, 96, 985, 358), fill="#b9b7a4", width=7)
    d.line((820, 226, 1150, 226), fill="#b9b7a4", width=7)
    d.text((48, 30), "CENA / ACERVO ILUSTRADO", font=font(20), fill=ROSE)
    d.text((48, 74), title, font=font(36), fill=INK)
    d.text((48, 671), "Amostra original sintetica. Sem pessoas reais, voz ou identificacao biometrica.", font=font(18), fill=INK)
    return image, d


def person(d, x, y, scale=1, shirt=ROSE, seated=True, child=False):
    def box(a, b, c, e):
        return (x + a * scale, y + b * scale, x + c * scale, y + e * scale)
    d.rounded_rectangle(box(-58, 27, 58, 164), radius=int(28 * scale), fill=shirt)
    d.ellipse(box(-41, -67, 41, 28), fill=SKIN)
    d.pieslice(box(-43, -73, 44, 18), 175, 365, fill="#4a3a33")
    d.ellipse(box(-20, -24, -13, -17), fill=INK)
    d.ellipse(box(13, -24, 20, -17), fill=INK)
    d.arc(box(-12, -11, 13, 10), 5, 175, fill=INK, width=max(1, int(2 * scale)))
    d.line((x - 38 * scale, y + 60 * scale, x - 69 * scale, y + 145 * scale), fill=SKIN, width=int(24 * scale))
    d.line((x + 38 * scale, y + 60 * scale, x + 84 * scale, y + 109 * scale), fill=SKIN, width=int(24 * scale))
    if seated:
        d.line((x - 35 * scale, y + 151 * scale, x - 38 * scale, y + 205 * scale, x - 66 * scale, y + 260 * scale), fill="#475464", width=int(33 * scale))
        d.line((x + 30 * scale, y + 151 * scale, x + 58 * scale, y + 205 * scale, x + 57 * scale, y + 260 * scale), fill="#475464", width=int(33 * scale))
        d.ellipse(box(-94, 246, -42, 269), fill=INK)
        d.ellipse(box(40, 246, 98, 269), fill=INK)


def cat(d, x, y):
    d.arc((x - 65, y + 24, x + 53, y + 108), 10, 300, fill="#b16f3f", width=19)
    d.ellipse((x - 37, y - 8, x + 38, y + 85), fill="#d39b60")
    d.polygon([(x - 37, y - 20), (x - 30, y - 70), (x - 4, y - 38)], fill="#d39b60")
    d.polygon([(x + 35, y - 20), (x + 28, y - 70), (x + 2, y - 38)], fill="#d39b60")
    d.ellipse((x - 41, y - 52, x + 40, y + 17), fill="#d39b60")
    for sx in (-16, 16):
        d.ellipse((x + sx - 6, y - 26, x + sx + 6, y - 15), fill=GREEN)
        d.line((x + sx, y - 25, x + sx, y - 15), fill=INK, width=3)
    d.polygon([(x - 5, y - 9), (x + 5, y - 9), (x, y - 3)], fill=ROSE)
    for sign in (-1, 1):
        d.line((x + 9 * sign, y, x + 56 * sign, y - 8), fill=INK, width=2)
        d.line((x + 9 * sign, y + 4, x + 56 * sign, y + 9), fill=INK, width=2)
    d.ellipse((x - 31, y + 63, x - 4, y + 85), fill="#ebc18c")
    d.ellipse((x + 7, y + 63, x + 34, y + 85), fill="#ebc18c")


def sofa_scene():
    image, d = room("01  /  Uma tarde na sala")
    d.ellipse((230, 553, 1040, 625), fill="#c4b6a5")
    d.rounded_rectangle((255, 280, 994, 519), radius=52, fill="#778984")
    d.rounded_rectangle((274, 434, 970, 547), radius=30, fill="#96a7a0")
    d.rounded_rectangle((225, 377, 324, 554), radius=30, fill="#63766f")
    d.rounded_rectangle((940, 377, 1039, 554), radius=30, fill="#63766f")
    d.rectangle((275, 542, 306, 580), fill=INK)
    d.rectangle((957, 542, 986, 580), fill=INK)
    person(d, 490, 265, shirt=ROSE)
    cat(d, 793, 365)
    d.rounded_rectangle((1120, 410, 1205, 552), radius=13, fill="#ba7960")
    d.line((1162, 410, 1162, 298), fill=GREEN, width=8)
    d.ellipse((1103, 315, 1169, 370), fill=GREEN)
    d.ellipse((1153, 288, 1219, 349), fill=GREEN)
    return image


def conversation_scene():
    image, d = room("02  /  Encontro entre geracoes")
    for x in (327, 883):
        d.rounded_rectangle((x - 85, 308, x + 86, 522), radius=30, fill="#c2a68a")
        d.line((x - 60, 520, x - 75, 597), fill=INK, width=14)
        d.line((x + 60, 520, x + 75, 597), fill=INK, width=14)
    person(d, 327, 287, shirt=GREEN)
    person(d, 883, 361, scale=0.72, shirt="#bf965a", child=True)
    d.rounded_rectangle((437, 185, 676, 263), radius=22, fill="#ffffff", outline="#cbbdab", width=2)
    d.polygon([(452, 252), (431, 298), (489, 256)], fill="#ffffff")
    d.rounded_rectangle((678, 307, 800, 377), radius=22, fill="#ffffff", outline="#cbbdab", width=2)
    d.polygon([(786, 353), (828, 394), (773, 370)], fill="#ffffff")
    for x in (495, 549, 603):
        d.ellipse((x, 215, x + 15, 230), fill=ROSE)
    for x in (701, 736, 771):
        d.ellipse((x, 333, x + 10, 343), fill=GREEN)
    return image


def christmas_scene():
    image, d = room("03  /  Mesa de celebracao")
    for x, shirt in ((335, GREEN), (630, ROSE), (918, "#bf965a")):
        d.rounded_rectangle((x - 76, 298, x + 76, 547), radius=20, fill="#af8c6c")
        person(d, x, 279, scale=0.9, shirt=shirt)
    d.rectangle((197, 479, 1100, 525), fill="#855b45")
    d.polygon([(180, 414), (1100, 414), (1153, 492), (128, 492)], fill="#ece7d9")
    d.rectangle((208, 510, 238, 624), fill="#855b45")
    d.rectangle((1051, 510, 1081, 624), fill="#855b45")
    for x in (324, 617, 918):
        d.ellipse((x - 60, 432, x + 60, 469), fill="#fffaf1", outline="#b79d80", width=3)
    d.line((425, 452, 820, 452), fill=GREEN, width=13)
    for x in range(430, 820, 35):
        d.ellipse((x - 12, 440, x + 11, 459), fill=GREEN)
        d.ellipse((x, 440, x + 11, 451), fill=ROSE)
    for x in (529, 722):
        d.rectangle((x, 383, x + 16, 451), fill="#f4cd75")
        d.ellipse((x + 2, 365, x + 15, 386), fill="#dc8b3d")
    d.rectangle((113, 327, 132, 430), fill="#855b45")
    for y, half in ((198, 36), (239, 55), (284, 73), (329, 90)):
        d.polygon([(122, y - 57), (122 - half, y + 33), (122 + half, y + 33)], fill=GREEN)
    for x, y in ((93, 269), (154, 309), (107, 341), (120, 218)):
        d.ellipse((x - 9, y - 9, x + 9, y + 9), fill=ROSE)
    d.polygon([(122, 122), (131, 145), (155, 145), (137, 160), (143, 184), (122, 170), (101, 184), (107, 160), (89, 145), (113, 145)], fill="#d6a84d")
    return image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(".local") / "sample")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    scenes = [sofa_scene(), conversation_scene(), christmas_scene()]
    for index, image in enumerate(scenes):
        image_path = args.output / f"scene-{index + 1}.png"
        image.save(image_path)
        subprocess.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-loop", "1",
            "-i", str(image_path), "-t", "12", "-r", "24", "-c:v", "libx264",
            "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
            str(args.output / f"part-{index + 1}.mp4"),
        ], check=True)
    concat = args.output / "concat.txt"
    concat.write_text("".join(f"file 'part-{i + 1}.mp4'\n" for i in range(3)), encoding="utf-8")
    video = args.output / "cena-acervo-ilustrado.mp4"
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat",
        "-safe", "0", "-i", str(concat), "-c", "copy", "-movflags", "+faststart", str(video),
    ], check=True)
    manifest = {
        "source": "original synthetic illustrations, generated by this repository",
        "realPeople": False,
        "audio": False,
        "scenes": [
            {"start": 0, "end": 12, "expected": "pessoa e gato sentados no mesmo sofa"},
            {"start": 12, "end": 24, "expected": "adulto e crianca em uma conversa ilustrada"},
            {"start": 24, "end": 36, "expected": "pessoas a mesa decorada para o natal"},
        ],
        "identityNote": "Use a clearly fictional editorial name; these drawings do not depict real actors.",
    }
    (args.output / "ground-truth.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(video.resolve())


if __name__ == "__main__":
    main()
