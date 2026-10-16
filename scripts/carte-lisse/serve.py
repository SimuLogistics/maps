"""Visionneuse locale de la carte lissée (serveur avec Range, requis par PMTiles).

Usage : python serve.py [port]     puis ouvrir http://localhost:8766
Les .pmtiles sont lus dans le sous-dossier tiles/.
"""
import os, sys, http.server, socketserver

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".pmtiles": "application/octet-stream"}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            path = "/index.html"
        file = os.path.normpath(os.path.join(HERE, path.lstrip("/")))
        if not file.startswith(HERE):
            return self.send_error(403)
        if not os.path.isfile(file):
            return self.send_error(404)
        size = os.path.getsize(file)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            a, b = rng[6:].split("-")
            start = int(a) if a else size - int(b)
            end = min(int(b), size - 1) if a and b else size - 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", TYPES.get(os.path.splitext(file)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(file, "rb") as f:
            f.seek(start)
            self.wfile.write(f.read(end - start + 1))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"Carte lissée : http://localhost:{PORT}")
    Server(("127.0.0.1", PORT), Handler).serve_forever()
