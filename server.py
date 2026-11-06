"""Local server for the Windows app.

Serves the pages in www/ and saves files into folders next to this script:
pictures in picture/, microphone recordings in record/, sounds made from
pictures in sound/.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
WWW = ROOT / "www"
FOLDERS = {
    "picture": ROOT / "picture",
    "record": ROOT / "record",
    "sound": ROOT / "sound",
}
for folder in FOLDERS.values():
    folder.mkdir(exist_ok=True)

SAFE_NAME = re.compile(r"[\w.\- ]+\.(png|wav)\Z", re.IGNORECASE)
MAX_BYTES = 512_000_000


def destination(name):
    lower = name.lower()
    if lower.endswith(".png"):
        key = "picture"
    elif lower.startswith("zapis-"):
        key = "record"
    else:
        key = "sound"
    return key, FOLDERS[key] / name


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WWW), **kwargs)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/save":
            self.send_error(404)
            return
        name = Path(self.headers.get("X-Filename", "")).name
        length = int(self.headers.get("Content-Length", "0") or "0")
        if not SAFE_NAME.fullmatch(name) or length <= 0 or length > MAX_BYTES:
            self.send_error(400)
            return
        data = self.rfile.read(length)
        if len(data) != length:
            self.send_error(400)
            return
        key, path = destination(name)
        path.write_bytes(data)
        body = f"{key}/{name}".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
