import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--log', required=True)
args = parser.parse_args()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def _record(self):
        with open(args.log, 'a', encoding='utf-8') as f:
            f.write(f"{self.command} {self.path}\n")

    def _json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._record()
        parsed = urlparse(self.path)
        if parsed.path == '/api/v1/phase7c/bot-mode':
            return self._json(200, {'state': {'mode': 'AUTO'}})
        if parsed.path == '/health':
            return self._json(200, {
                'status': 'ok', 'connected': True, 'accountMode': 'real',
                'configuredAccountMode': 'LIVE', 'accountLogin': 123456,
                'tradingEnabled': True, 'liveExecutionArmed': True,
                'liveArmStatus': 'ARMED', 'bridgeSessionId': 'ci-session'
            })
        if parsed.path == '/account':
            return self._json(200, {'valid': True, 'accountMode': 'real', 'login': 123456, 'server': 'DBGMarkets-Live'})
        if parsed.path in ('/v1/positions', '/v1/orders'):
            return self._json(200, [])
        return self._json(404, {'error': 'not found'})

    def _reject(self):
        self._record()
        return self._json(405, {'error': 'mutation forbidden'})

    do_POST = _reject
    do_PATCH = _reject
    do_PUT = _reject
    do_DELETE = _reject

HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
