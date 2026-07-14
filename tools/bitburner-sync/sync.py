#!/usr/bin/env python3
"""
sync.py — Sincronização editor -> Bitburner via Remote API (WebSocket).

Substitui o BitburnerGoFilesync, que NÃO observa subpastas (testado: na raiz
create/modify funcionam, mas subpastas ficam de fora).
Este watcher faz poll RECURSIVO por hash de conteúdo, então pega qualquer
mudança (criar/editar/excluir) em qualquer pasta. Ao conectar, envia TODOS os
arquivos (full push), resolvendo também o problema do "baseline".

- Sem dependências: só a stdlib do Python 3. Rode com:  python3 sync.py
- Servidor WebSocket em 127.0.0.1:PORT. No jogo: Options -> Remote API ->
  hostname 127.0.0.1, port PORT, Connect.
- Mão única (local -> jogo, servidor "home"). Espelha a estrutura de pastas
  dentro de src/: src/controller.js -> /controller.js.

Protocolo: docs/reference/programming/remote_api.md (JSON-RPC sobre WebSocket).
"""
import os, sys, json, time, socket, base64, hashlib, struct, selectors
from pathlib import Path

# ─── CONFIG ──────────────────────────────────────────────────────────────────
PORT          = 8080                       # deve bater com Options -> Remote API
ROOT          = Path(__file__).resolve().parents[2] / "src"  # tools/bitburner-sync/ -> ../../src
INCLUDE_EXT   = (".js", ".txt")            # extensões sincronizadas
EXCLUDE_DIRS  = set()                       # pastas ignoradas dentro de src/ (nenhuma por padrão)
SCAN_INTERVAL = 0.3                         # s entre varreduras (sync ~instantâneo)
HEARTBEAT     = 5.0                         # s entre pings (detecta conexão morta após sleep)
SERVER        = "home"                      # servidor de destino no jogo
WS_GUID       = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"  # RFC 6455

# PULL (jogo -> disco): arquivos lidos do jogo via getFile e espelhados em
# game-logs/ na raiz do projeto, para inspecionar logs de debug sem abrir o jogo.
# Mão contrária do push e fora de src/, então nunca colide com a sincronização.
PULL_FILES    = ("data/booster-debug.txt", "data/orbiter-debug.txt",
                 "data/pilot-debug.txt", "data/lifecycle-debug.txt", "data/servers.json")
PULL_DIR      = Path(__file__).resolve().parents[2] / "game-logs"
PULL_INTERVAL = 15.0                        # s entre leituras do jogo

def log(msg):
    print(f"{time.strftime('%H:%M:%S')}  {msg}", flush=True)

# ─── WebSocket (mínimo, lado servidor) ───────────────────────────────────────
def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("conexão fechada")
        buf += chunk
    return buf

def ws_handshake(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("fechou durante handshake")
        data += chunk
    key = None
    for line in data.decode("latin1").split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
    if not key:
        raise ConnectionError("Sec-WebSocket-Key ausente")
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    sock.sendall(
        ("HTTP/1.1 101 Switching Protocols\r\n"
         "Upgrade: websocket\r\n"
         "Connection: Upgrade\r\n"
         f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode()
    )

def _ws_read_raw_frame(sock):
    """Lê 1 frame bruto. Retorna (fin, opcode, payload_bytes). Desmascara."""
    b0, b1 = _recv_exact(sock, 2)
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(sock, 8))[0]
    mask = _recv_exact(sock, 4) if masked else b""
    payload = _recv_exact(sock, length) if length else b""
    if masked:
        payload = bytes(payload[i] ^ mask[i % 4] for i in range(length))
    return fin, opcode, payload

def ws_read_message(sock):
    """Lê 1 MENSAGEM completa, remontando fragmentos (RFC 6455 §5.4).

    O navegador fragmenta mensagens grandes: o 1º frame vem com FIN=0 e o
    conteúdo continua em frames de opcode 0x0 (continuation) até um com FIN=1.
    A versão antiga lia 1 frame por vez e descartava as continuações — respostas
    grandes de getFile (logs de debug > dezenas de KB) viravam JSON truncado e
    eram perdidas em silêncio. Frames de CONTROLE (ping/pong/close) podem chegar
    intercalados no meio de uma mensagem fragmentada; ping é respondido inline,
    pong é ignorado, close é devolvido ao chamador.
    """
    opcode = None
    buf = b""
    while True:
        fin, op, payload = _ws_read_raw_frame(sock)
        if op == 0x8:                    # close — devolve já (aborta remontagem)
            return op, payload
        if op in (0x9, 0xA):             # ping -> pong inline; pong -> ignora
            if op == 0x9:
                ws_send(sock, payload, 0xA)
            # SEM remontagem em andamento: devolve o controle ao loop principal.
            # Continuar lendo aqui bloqueava em _recv_exact à espera de um frame
            # de dados que podia nunca vir (um ping do jogo num momento ocioso
            # congelava pulls/heartbeat até o timeout de 60 s derrubar a sessão —
            # a "desconexão ~1 min após conectar"). No MEIO de uma mensagem
            # fragmentada, continuar é correto: o resto dela está a caminho.
            if opcode is None:
                return op, payload
            continue
        if op != 0x0:                    # frame inicial (texto/binário)
            opcode = op
        buf += payload
        if fin:
            return opcode, buf

def ws_send(sock, payload_bytes, opcode=0x1):
    """Envia 1 frame (servidor -> cliente, sem máscara)."""
    n = len(payload_bytes)
    header = bytes([0x80 | opcode])
    if n < 126:
        header += bytes([n])
    elif n < 65536:
        header += bytes([126]) + struct.pack(">H", n)
    else:
        header += bytes([127]) + struct.pack(">Q", n)
    sock.sendall(header + payload_bytes)

# ─── Varredura de arquivos ───────────────────────────────────────────────────
def scan():
    """{ caminho_relativo: (conteúdo_str, hash) } para todos os arquivos incluídos."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith(".")]
        for fn in filenames:
            if fn.endswith(".d.ts") or not fn.endswith(INCLUDE_EXT):
                continue
            full = os.path.join(dirpath, fn)
            try:
                with open(full, "rb") as f:
                    raw = f.read()
                content = raw.decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            out[rel] = (content, hashlib.sha1(raw).hexdigest())
    return out

# ─── Sessão de conexão (um jogo por vez) ─────────────────────────────────────
def handle(conn):
    # Timeout em TODO recv/send: sem isso, um jogo que trava NO MEIO do envio de
    # uma resposta grande (fragmentada) deixa _recv_exact bloqueado para sempre —
    # o loop inteiro (pulls, heartbeat) congela com a conexão ainda ESTABLISHED
    # (observado: pulls parados por 20 min com o jogo lagado). Com timeout, o
    # recv estoura socket.timeout (OSError) -> a sessão encerra e o servidor
    # volta a aceitar a próxima conexão.
    conn.settimeout(60.0)
    ws_handshake(conn)
    log("✅ jogo conectado — enviando todos os arquivos…")
    sel = selectors.DefaultSelector()
    sel.register(conn, selectors.EVENT_READ)
    idc = 0
    state = {}     # rel -> hash já enviado nesta sessão
    pending = {}   # id de getFile em voo -> nome do arquivo pedido
    pulled = {}    # nome -> último conteúdo gravado (evita reescrever igual)

    def send(method, params):
        nonlocal idc
        idc += 1
        msg = json.dumps({"jsonrpc": "2.0", "id": idc, "method": method, "params": params})
        ws_send(conn, msg.encode("utf-8"))
        return idc

    def pull_once():
        """Pede ao jogo os arquivos de PULL_FILES (respostas chegam async)."""
        for name in PULL_FILES:
            pending[send("getFile", {"filename": name, "server": SERVER})] = name

    def pull_store(name, content):
        """Grava uma resposta de getFile em game-logs/, se mudou."""
        if not isinstance(content, str) or pulled.get(name) == content:
            return
        dest = PULL_DIR / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
        pulled[name] = content

    def sync_once():
        nonlocal state
        current = scan()
        for rel, (content, h) in current.items():
            if state.get(rel) != h:
                send("pushFile", {"filename": rel, "content": content, "server": SERVER})
                log(("＋ novo   " if rel not in state else "↻ enviado ") + rel)
        for rel in [r for r in state if r not in current]:
            send("deleteFile", {"filename": rel, "server": SERVER})
            log("－ apagado " + rel)
        state = {rel: h for rel, (_, h) in current.items()}

    last_ping = time.monotonic()
    last_pull = 0.0
    try:
        sync_once()  # full push imediato
        while True:
            events = sel.select(timeout=SCAN_INTERVAL)
            if events:
                # há dados do jogo: mensagem JSON-RPC completa (remontada) ou close.
                # ping/pong são tratados dentro de ws_read_message.
                opcode, payload = ws_read_message(conn)
                if opcode == 0x8:            # close
                    break
                elif opcode == 0x1:          # resposta
                    try:
                        r = json.loads(payload.decode("utf-8"))
                        name = pending.pop(r.get("id"), None)
                        if r.get("error"):
                            # getFile de arquivo inexistente é esperado (ex.: log do
                            # orbiter antes do orbiter rodar) — só loga erros de push.
                            if name is None:
                                log(f"⚠️  erro do jogo: {r['error']}")
                        elif name is not None:
                            pull_store(name, r.get("result"))
                    except Exception as e:
                        # Antes: `pass` silencioso — respostas grandes fragmentadas
                        # falhavam o parse e sumiam sem rastro. Agora loga sempre.
                        log(f"⚠️  resposta ilegível ({len(payload)} bytes): {e}")
            else:
                sync_once()                  # timeout -> varre e sincroniza mudanças
            # Heartbeat: ping periódico. Se a conexão morreu (ex.: Mac dormiu), o
            # envio falha e caímos no except -> a sessão encerra e o servidor volta
            # a aceitar conexões, de modo que o Connect seguinte no jogo já funciona.
            now = time.monotonic()
            if now - last_ping >= HEARTBEAT:
                ws_send(conn, b"", 0x9)      # ping
                last_ping = now
            if now - last_pull >= PULL_INTERVAL:
                # BACKPRESSURE: só pede a próxima leva quando a anterior já foi
                # toda respondida. Antes, um novo trio de getFile era enviado a
                # cada 2 s INDEPENDENTE de o jogo ter respondido — num jogo já
                # lagado os pedidos se empilhavam e cada um exige serializar o
                # log de debug inteiro (que só cresce), realimentando o lag
                # (suspeito de derrubar o jogo com o sync ligado).
                if pending and now - last_pull >= 4 * PULL_INTERVAL:
                    # Respostas perdidas (ex.: reconexão no meio) travariam o pull
                    # para sempre; após ~60 s sem resposta, descarta e recomeça.
                    log(f"⚠️  {len(pending)} getFile sem resposta — descartando e repedindo")
                    pending.clear()
                if not pending:
                    pull_once()              # espelha logs do jogo em game-logs/
                    last_pull = now
    except (ConnectionError, OSError, BrokenPipeError):
        pass
    finally:
        sel.close()
        try:
            conn.close()
        except OSError:
            pass
        log("⏹  jogo desconectado")

# ─── Loop principal ──────────────────────────────────────────────────────────
def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", PORT))
    srv.listen(1)
    log(f"servidor ouvindo em 127.0.0.1:{PORT}  |  raiz: {ROOT}")
    log(f"No jogo: Options -> Remote API -> hostname 127.0.0.1, port {PORT}, Connect")
    try:
        while True:
            conn, _ = srv.accept()
            try:
                handle(conn)
            except Exception as e:
                log(f"erro na conexão: {e}")
    except KeyboardInterrupt:
        log("encerrado (Ctrl+C)")
    finally:
        srv.close()

if __name__ == "__main__":
    main()
