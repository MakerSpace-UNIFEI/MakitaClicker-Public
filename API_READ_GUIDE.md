# Guia da API de Leitura Pública (Read-All API) — MakitaClicker

Como o repositório do **MakitaClicker** e o painel de produção são privados, este documento descreve como qualquer serviço externo, desenvolvedor ou agente de inteligência artificial pode consultar dados de telemetria, lista de usuários, ranking, estado do hardware e histórico de builds/deployments em tempo real através da **API Read-All da Cloudflare**.

---

## 🔑 1. Credenciais e Identificadores (Cloudflare API)

| Parâmetro | Valor | Descrição |
|---|---|---|
| **API Token (Bearer)** | `$CF_READ_TOKEN` | Token de Leitura (Read-Only) gerado na Cloudflare |
| **Account ID** | `<CLOUDFLARE_ACCOUNT_ID>` | Identificador da conta Cloudflare |
| **KV Namespace ID** | `<SEU_KV_NAMESPACE_ID>` | Namespace `makita-kv` em produção |
| **Pages Project** | `makitaclicker` | Nome do projeto no Cloudflare Pages |
| **URL de Produção** | `https://makitaclicker.pages.dev` | URL pública da aplicação |

> **Dica:** Para rodar os comandos no seu terminal, exporte a variável com a sua chave de leitura:
> ```bash
> export CF_READ_TOKEN="<SUA_API_KEY_CFAT>"
> export CF_ACCOUNT_ID="<CLOUDFLARE_ACCOUNT_ID>"
> export CF_KV_NAMESPACE="<SEU_KV_NAMESPACE_ID>"
> ```

---

## 📦 2. Consultando o Cloudflare KV Diretamente

A Cloudflare expõe uma API REST v4 para leitura direta de chaves e valores armazenados no banco KV.

### 2.1. Listar todas as chaves do KV
Lista todas as chaves presentes no banco de dados (`users:list`, perfis individuais, `gamestate`, etc.):

```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/keys"
```

### 2.2. Ler o Ranking e Lista de Usuários (`users:list`)
Retorna o JSON completo com todos os perfis registrados, saldo e makitas acumuladas:

```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/values/users:list"
```

### 2.3. Ler o Estado de um Usuário Específico (`user:<userId>:state`)
Substitua `<USER_ID>` pelo ID do usuário (ex: `u_mtuf9ulk_znnm`):

```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/values/user:<USER_ID>:state"
```

### 2.4. Ler o Estado do Hardware ESP8266 e Lease de Controle
- **Lease do dono temporário do hardware:** chave `hardware:controller`
- **Estado global da ESP8266:** chave `gamestate`

```bash
# Dono temporário ativo do console físico ESP8266
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/values/hardware:controller"

# Estado operacional / telemetria da placa
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/storage/kv/namespaces/<SEU_KV_NAMESPACE_ID>/values/gamestate"
```

---

## 🚀 3. Consultando Projetos e Deploys (Cloudflare Pages)

### 3.1. Informações do Projeto Pages
Retorna o status do projeto, branch de produção, bindings configurados (`MAKITA_KV`) e comando de build:

```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/pages/projects/makitaclicker"
```

### 3.2. Histórico de Deployments e Status do Build
Verifica o status dos últimos builds (ex: compilação do firmware e Pages Functions):

```bash
curl -s -X GET \
  -H "Authorization: Bearer $CF_READ_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/pages/projects/makitaclicker/deployments"
```

---

## 🌐 4. Endpoints Públicos da Aplicação (Sem Necessidade de Token)

O jogo também disponibiliza endpoints HTTP abertos diretamente em `makitaclicker.pages.dev`:

| Endpoint | Método | Descrição |
|---|---|---|
| `https://makitaclicker.pages.dev/api/state?action=list_users` | GET | Lista resumida de usuários e líder do ranking |
| `https://makitaclicker.pages.dev/api/state?action=get_hardware_status` | GET | Status de posse do console físico ESP8266 |
| `https://makitaclicker.pages.dev/api/state?userId=<ID>` | GET | Estado de jogo de um perfil específico |
| `https://makitaclicker.pages.dev/version.json` | GET | Versão atual do firmware da ESP8266 e hash MD5 |
| `https://makitaclicker.pages.dev/game-config.json` | GET | Configurações da loja e árvore de tecnologias |

---

## 💻 5. Exemplos de Código

### Exemplo em JavaScript / Node.js
```javascript
const ACCOUNT_ID = '<CLOUDFLARE_ACCOUNT_ID>';
const KV_NAMESPACE_ID = '<SEU_KV_NAMESPACE_ID>';
const API_TOKEN = process.env.CF_READ_TOKEN || '<SUA_API_KEY_CFAT>';

async function getMakitaUsers() {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/users:list`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` }
  });
  const users = await res.json();
  console.log('Usuários cadastrados no MakitaClicker:', users);
  return users;
}

getMakitaUsers();
```

### Exemplo em Python
```python
import os
import requests

ACCOUNT_ID = "<CLOUDFLARE_ACCOUNT_ID>"
KV_NAMESPACE_ID = "<SEU_KV_NAMESPACE_ID>"
API_TOKEN = os.getenv("CF_READ_TOKEN", "<SUA_API_KEY_CFAT>")

headers = {
    "Authorization": f"Bearer {API_TOKEN}"
}

# Ler a lista de usuários do KV
url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{KV_NAMESPACE_ID}/values/users:list"
response = requests.get(url, headers=headers)

if response.status_code == 200:
    print("Ranking:", response.json())
else:
    print(f"Erro {response.status_code}:", response.text)
```
