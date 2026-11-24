from flask import Flask, jsonify
import requests

app = Flask(__name__)

@app.route('/api/status', methods=['GET'])
def status():
    return jsonify({'ok': True})

@app.route('/api/proxy', methods=['GET'])
def proxy():
    r = requests.get('https://api.external-service.example.com/data')
    return jsonify(r.json())

@app.websocket('/ws/chat')
def chat(ws):
    while True:
        msg = ws.receive()
        ws.send(msg)

if __name__ == '__main__':
    app.run(port=5000)
