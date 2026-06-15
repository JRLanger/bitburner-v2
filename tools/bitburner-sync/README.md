# Sincronização com o Bitburner (Remote API)

Sincroniza **automaticamente** os arquivos deste projeto com o jogo, usando o
[Remote API](../../docs/reference/programming/remote_api.md) do Bitburner (WebSocket + JSON-RPC).
Implementação: [`sync.py`](sync.py) — watcher próprio, **sem dependências** (só a
stdlib do Python 3).

- **Sentido único:** local → jogo (servidor `home`). Editar no jogo **não** volta pro disco.
- **Recursivo:** observa `src/` inteira. Espelha a estrutura relativa a `src/`:
  `src/controller.js` → `/controller.js`, `src/utils/foo.js` → `/utils/foo.js`.
- **Push completo ao conectar:** ao ligar o jogo, envia todos os arquivos de uma vez.
- **Detecção por hash de conteúdo:** só envia quando o conteúdo muda de fato.
- Filtra extensões: `*.js` e `*.txt`. Só observa `src/` (docs, tools, etc. ficam de fora
  automaticamente, por estarem fora de `src/`).

## Como usar

1. **Inicie o sync** (deixe o terminal aberto enquanto joga). Três formas:
   - Atalho (após reabrir o Terminal): `bbsync`
   - Duplo-clique no Finder: `start-sync.command`
   - Comando completo:
     ```bash
     python3 /Users/jrlanger/Documents/Claude/Projects/Bitburner-v2/tools/bitburner-sync/sync.py
     ```
   Espere ver `servidor ouvindo em 127.0.0.1:8080`. Pare com `Ctrl+C`.

2. **No jogo:** `Options` → `Remote API` → hostname `127.0.0.1`, port `8080` → **Connect**.
   No connect, todos os `.js` são gravados no `home` (o terminal lista cada envio).

3. Edite os arquivos aqui — cada salvamento é enviado ao jogo em ~0,3 s.

> O alias `bbsync` está no `~/.zshrc`. Em um Terminal já aberto antes de criá-lo,
> rode `source ~/.zshrc` uma vez (ou abra uma janela nova) para ele ficar disponível.

## Por que não o BitburnerGoFilesync?

Foi a primeira tentativa, mas testes mostraram que ele **só observa o diretório raiz,
não as subpastas** (na raiz create/modify funcionam; em `config/ managers/ utils/
workers/` nada dispara). Como este projeto é todo em subpastas, ele era inviável.
O `sync.py` resolve isso com poll recursivo.

## Configuração

Edite as constantes no topo de [`sync.py`](sync.py):

| Constante | Padrão | Descrição |
|-----------|--------|-----------|
| `PORT` | `8080` | Porta do servidor. Deve bater com Options → Remote API no jogo. |
| `ROOT` | `src/` | Pasta observada (calculada a partir do local do script). |
| `INCLUDE_EXT` | `(".js", ".txt")` | Extensões sincronizadas. |
| `EXCLUDE_DIRS` | (vazio) | Pastas ignoradas dentro de `src/`. |
| `SCAN_INTERVAL` | `0.3` | Segundos entre varreduras. |

## Sleep e restart

- **Mac dorme (sleep):** o `sync.py` **continua rodando** (sobrevive ao sleep) — não
  precisa reiniciá-lo. Só dê **Connect** de novo no jogo, que derruba a conexão ao
  dormir e não reconecta sozinho. Um **heartbeat** (ping a cada 5 s, const `HEARTBEAT`)
  faz o servidor detectar a conexão morta em segundos e ficar pronto pra reconexão.
- **Mac reinicia:** mata tudo. Reabra o Terminal e rode `bbsync` (ou o `.command`),
  depois **Connect** no jogo.
- O terminal que roda o `sync.py` precisa ficar **aberto**; fechá-lo encerra o processo.

> Auto-start no login (LaunchAgent) foi descartado de propósito: o `launchd` não tem
> acesso à pasta `~/Documents` (proteção TCC do macOS), e liberar isso exigiria dar
> **Full Disk Access** ao `python3` — permissão ampla demais. Por isso o start é manual.

## Observações

- A porta (`8080`) precisa ser a mesma nos dois lados.
- Pode ter sobrado um `synctest.js` no `home` de testes antigos — inofensivo;
  remova no terminal do jogo com `rm synctest.js` se quiser.
