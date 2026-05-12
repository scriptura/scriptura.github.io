#!/usr/bin/env python3
"""
server.py — Serveur de développement local pour liturgical-calendar-wasm.

Réécriture SPA : toute requête vers un chemin non-fichier est servie par
index.html. Permet le routage par chemin (/2026/12/25) sans configuration
supplémentaire.

Usage :
    python3 server.py              # port 8080 par défaut
    python3 server.py 9000         # port personnalisé
"""

import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


WWW_DIR = os.path.dirname(os.path.abspath(__file__))


class SpaHandler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WWW_DIR, **kwargs)

    def do_GET(self):
        # Chemin physique correspondant à la requête.
        candidate = os.path.join(WWW_DIR, self.path.lstrip("/").split("?")[0])

        # Si le fichier n'existe pas (route SPA), on sert index.html.
        if not os.path.exists(candidate):
            self.path = "/index.html"

        super().do_GET()

    def log_message(self, fmt, *args):
        # Silence les logs de ressources statiques (.wasm, .kald, .lits, .js).
        if any(self.path.endswith(ext) for ext in (".wasm", ".kald", ".lits", ".js", ".css")):
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = HTTPServer(("0.0.0.0", port), SpaHandler)
    print(f"http://0.0.0.0:{port}/")
    print(f"Exemples :")
    print(f"  http://0.0.0.0:{port}/             → date du jour")
    print(f"  http://0.0.0.0:{port}/#2026/12/25  → hash (compatible tout hébergeur)")
    print(f"  http://0.0.0.0:{port}/2026/12/25   → chemin (réécriture SPA active)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt.")
