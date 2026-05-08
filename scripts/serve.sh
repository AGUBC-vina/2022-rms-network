#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
exec python3 -c "
import http.server, socketserver, os, sys
os.chdir(os.path.abspath('.'))
with socketserver.TCPServer(('', 8765), http.server.SimpleHTTPRequestHandler) as httpd:
    sys.stdout.write(f'serving on :8765 from {os.getcwd()}\n')
    sys.stdout.flush()
    httpd.serve_forever()
"
