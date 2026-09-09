# Guia da API de Leitura Pública (Read-All API) — MakitaClicker

Como o repositório do **MakitaClicker** e o painel de produção são privados, este documento descreve como qualquer serviço externo, desenvolvedor ou agente de inteligência artificial pode consultar dados de telemetria, lista de usuários, ranking, estado do hardware e histórico de builds/deployments em tempo real através da **API Read-All da Cloudflare**.

---

## 🔑 1. Credenciais e Identificadores (Cloudflare API)

| Parâmetro | Valor | Descrição |
|---|---|---|
| **API Token (Bearer)** | `$CF_READ_TOKEN` | Token de Leitura (Read-Only) gerado na Cloudflare |
| **Account ID** | `<CLOUDFLARE_ACCOUNT_ID>` | Identificador da conta Cloudflare |
| **D1 Database ID** | `<SEU_D1_DATABASE_ID>` | Banco de dados SQL `makitaclicker-db` (D1 Primário) |
| **KV Namespace ID** | `<SEU_KV_NAMESPACE_ID>` | Namespace `MAKITA_KV` (Cache e Redundância) |
| **Pages Project** | `makitaclicker` | Nome do projeto no Cloudflare Pages |
| **URL de Produção** | `https://makitaclicker.pages.dev` | URL pública da aplicação |

> **Dica:** Para rodar os comandos no seu terminal, exporte as variáveis:
> ```bash
> export CF_READ_TOKEN="<SUA_API_KEY_CFAT>"
> export CF_ACCOUNT_ID="<CLOUDFLARE_ACCOUNT_ID>"
> export CF_D1_DATABASE_ID="<SEU_D1_DATABASE_ID>"
> export CF_KV_NAMESPACE="<SEU_KV_NAMESPACE_ID>"
> ```

---

## 🗄️ 2. Consultando o Cloudflare D1 (Banco SQL Relacional Primário)

O Cloudflare D1 armazena os dados autoritativos relacionais com cota de até 100.000 gravações gratuitas por dia. A Cloudflare expõe a API REST v4 para executar queries SQL:

### 2.1. Listar todos os usuários no D1 (`users`)
```bash
curl -s -X POST \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT id, name, makitas, created_at, last_seen FROM users ORDER BY makitas DESC;"}' \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/d1/database/<SEU_D1_DATABASE_ID>/query"
```

### 2.2. Ler o Estado Completo de um Usuário no D1 (`user_states`)
```bash
curl -s -X POST \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT user_id, state_json, reset_epoch, updated_at FROM user_states WHERE user_id = ?;", "params": ["<USER_ID>"]}' \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/d1/database/<SEU_D1_DATABASE_ID>/query"
```

### 2.3. Consultar Dono Atual do Hardware Físico (`hardware_lease`)
```bash
curl -s -X POST \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM hardware_lease WHERE id = 1;"}' \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/d1/database/<SEU_D1_DATABASE_ID>/query"
```

---

## 📦 3. Consultando o Cloudflare KV (Cache Rápido e Redundância)

O KV atua em conjunto como camada de cache rápido e réplica de segurança:

### 3.1. Listar todas as chaves do KV
```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/keys"
```

### 3.2. Ler o Ranking e Lista de Usuários no KV (`users:list`)
Retorna a lista de perfis com nomes automaticamente desduplicados:

```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/values/users:list"
```

### 3.3. Ler o Estado de um Usuário no KV (`user:<userId>:state`)
```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/values/user:<USER_ID>:state"
```

### 3.4. Ler o Estado do Hardware ESP8266 no KV
```bash
# Dono temporário ativo do console físico ESP8266 (Snapshot no KV)
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/values/hardware:controller"

# Estado operacional / telemetria da placa
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/values/gamestate"
```

---

## 🚀 4. Consultando Projetos e Deploys (Cloudflare Pages)

### 4.1. Informações do Projeto Pages
Retorna o status do projeto, branch de produção, bindings configurados (`DB`, `MAKITA_KV`) e comando de build:

```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/pages/projects/makitaclicker"
```

### 4.2. Histórico de Deployments e Status do Build
Verifica o status dos últimos builds (ex: compilação do firmware e Pages Functions):

```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/pages/projects/makitaclicker/deployments"
```

---

## 🌐 5. Endpoints Públicos da Aplicação (Sem Necessidade de Token)

O jogo disponibiliza endpoints HTTP abertos diretamente em `makitaclicker.pages.dev`:

| Endpoint | Método | Descrição |
|---|---|---|
| `https://makitaclicker.pages.dev/api/state?action=list_users` | GET | Lista de usuários com nomes desduplicados e líder do ranking |
| `https://makitaclicker.pages.dev/api/state?action=get_hardware_status` | GET | Status de posse do console físico ESP8266 (`isClaimed`, `controllerName`, etc.) |
| `https://makitaclicker.pages.dev/api/state?userId=<ID>` | GET | Estado de jogo de um perfil (retorna `userFound: false` caso o perfil precise de auto-upload) |
| `https://makitaclicker.pages.dev/api/state` | POST | Dispara salvamento (`save_user_state`), criação (`create_user`) ou posse (`claim_hardware`) |
| `https://makitaclicker.pages.dev/version.json` | GET | Versão atual do firmware da ESP8266 e hash MD5 |
| `https://makitaclicker.pages.dev/game-config.json` | GET | Configurações da loja e árvore de tecnologias |

---

## 💻 6. Exemplos de Código

### Exemplo em JavaScript / Node.js (Consulta SQL via D1 REST API)
```javascript
const ACCOUNT_ID = '<CLOUDFLARE_ACCOUNT_ID>';
const D1_DB_ID = '<SEU_D1_DATABASE_ID>';
const API_TOKEN = process.env.CF_READ_TOKEN || '<SUA_API_KEY_CFAT>';

async function getMakitaUsersFromD1() {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sql: 'SELECT id, name, makitas, created_at FROM users ORDER BY makitas DESC;'
    })
  });
  const data = await res.json();
  console.log('Usuários cadastrados no Cloudflare D1:', data.result[0].results);
  return data.result[0].results;
}

getMakitaUsersFromD1();
```

### Exemplo em Python (Consulta D1 SQL ou KV)
```python
import os
import requests

ACCOUNT_ID = "<CLOUDFLARE_ACCOUNT_ID>"
D1_DB_ID = "<SEU_D1_DATABASE_ID>"
API_TOKEN = os.getenv("CF_READ_TOKEN", "<SUA_API_KEY_CFAT>")

headers = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json"
}

# Consulta SQL no Cloudflare D1
url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{D1_DB_ID}/query"
query = {"sql": "SELECT id, name, makitas, created_at FROM users ORDER BY makitas DESC LIMIT 10;"}

response = requests.post(url, headers=headers, json=query)

if response.status_code == 200:
    rows = response.json().get("result", [{}])[0].get("results", [])
    print("Top 10 Jogadores (D1):", rows)
else:
    print(f"Erro {response.status_code}:", response.text)
```
