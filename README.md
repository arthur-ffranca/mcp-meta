# whatsapp-mcp-server

Servidor MCP que liga o Claude à **WhatsApp Cloud API** (API oficial da Meta). O Claude passa a enviar mensagens, templates e mídia, ler as conversas recebidas e acompanhar entrega, tudo pelo número da empresa.

A Cloud API não tem endpoint para ler histórico. Por isso o servidor também recebe o **webhook** da Meta e grava mensagens e status em um SQLite local (`DATA_DIR/whatsapp.sqlite3`). O histórico começa no momento em que o webhook é conectado.

## Ferramentas

| Grupo | Ferramenta | O que faz |
|---|---|---|
| Envio | `whatsapp_send_text` | Texto livre (janela de 24h) |
| | `whatsapp_send_template` | Template aprovado (inicia conversa ou fora das 24h) |
| | `whatsapp_send_media` | Imagem, documento, áudio, vídeo, figurinha |
| | `whatsapp_send_buttons` | Até 3 botões de resposta |
| | `whatsapp_send_list` | Menu em lista (até 10 opções) |
| | `whatsapp_mark_as_read` | Marca como lida e mostra "digitando..." |
| Caixa de entrada | `whatsapp_list_conversations` | Conversas, não lidas, janela de 24h aberta ou não |
| | `whatsapp_get_conversation` | Histórico com um contato |
| | `whatsapp_get_message_status` | accepted / sent / delivered / read / failed, com causa |
| Templates | `whatsapp_list_templates` | Templates, status e número de variáveis |
| | `whatsapp_create_template` | Envia template para aprovação |
| | `whatsapp_delete_template` | Exclui template (irreversível) |
| Mídia | `whatsapp_upload_media` | Sobe arquivo (URL ou base64) e devolve `media_id` |
| | `whatsapp_get_media` | Metadados de mídia recebida; imagens voltam visíveis para o Claude |
| Conta | `whatsapp_get_phone_number` | Qualidade, status e limites do número |
| | `whatsapp_get_business_profile` | Perfil público |
| | `whatsapp_update_business_profile` | Atualiza o perfil público |

## 1. Credenciais na Meta

1. Em [developers.facebook.com](https://developers.facebook.com), crie (ou abra) um app do tipo **Business** e adicione o produto **WhatsApp**.
2. Em **WhatsApp > API Setup**, copie o **Phone number ID** e o **WhatsApp Business Account ID**.
3. Em **Business Settings > Usuários do sistema**, crie um usuário de sistema admin, dê a ele acesso ao app e à conta WhatsApp, e gere um **token permanente** com `whatsapp_business_messaging` e `whatsapp_business_management`. O token temporário do painel expira em 24h e não serve para produção.
4. Em **Configurações do app > Básico**, copie o **App Secret**.

## 2. Deploy no Coolify

1. Suba esta pasta para um repositório Git e crie no Coolify uma aplicação com build pack **Dockerfile**.
2. Porta exposta: `3000`. Health check: `GET /health`.
3. Monte um **volume persistente em `/data`**. Sem ele o histórico some a cada deploy.
4. Preencha as variáveis de ambiente conforme `.env.example`.
5. Aponte um domínio com HTTPS, por exemplo `https://wa-mcp.seudominio.com.br`.

Enquanto estiver testando, preencha `WHATSAPP_ALLOWED_RECIPIENTS` com os seus próprios números. É uma trava no servidor: nenhuma mensagem sai para fora dessa lista, não importa o que seja pedido ao Claude.

## 3. Webhook

Em **WhatsApp > Configuration** no app da Meta:

- **Callback URL:** `https://wa-mcp.seudominio.com.br/webhook`
- **Verify token:** o mesmo valor de `WEBHOOK_VERIFY_TOKEN`
- Assine o campo **messages**.

Um app da Meta aceita uma única Callback URL. Se o backend da plataforma já consome esse webhook, mantenha-o lá e faça o backend repassar a requisição para `/webhook` deste servidor com o **corpo bruto intacto** e o header `X-Hub-Signature-256` original. A assinatura é validada sobre os bytes exatos.

## 4. Conectar ao Claude

**Claude (app web/desktop, Cowork):** Configurações > Conectores > Adicionar conector personalizado, com a URL

```
https://wa-mcp.seudominio.com.br/mcp/SEU_MCP_AUTH_TOKEN
```

O token vai no caminho porque o conector personalizado do Claude não envia header fixo. Trate essa URL inteira como uma senha: quem a tiver envia mensagens pelo seu número.

**Claude Code:**

```bash
claude mcp add --transport http whatsapp https://wa-mcp.seudominio.com.br/mcp \
  --header "Authorization: Bearer SEU_MCP_AUTH_TOKEN"
```

**Local (stdio)**, sem webhook:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/caminho/whatsapp-mcp-server/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "WHATSAPP_ACCESS_TOKEN": "...",
        "WHATSAPP_PHONE_NUMBER_ID": "...",
        "WHATSAPP_BUSINESS_ACCOUNT_ID": "..."
      }
    }
  }
}
```

## Regras da plataforma que o servidor respeita

- **Janela de 24h.** Texto livre, mídia e interativos só chegam até 24h depois da última mensagem do usuário. Fora disso, só template aprovado. A API responde "accepted" mesmo fora da janela e a falha (erro 131047) chega depois pelo webhook; por isso as ferramentas de envio avisam quando não há mensagem recente do contato e `whatsapp_get_message_status` explica a causa.
- **"accepted" não é "entregue".** A confirmação vem por status do webhook.
- **Nono dígito.** O WhatsApp pode identificar um celular brasileiro com ou sem o 9. As buscas de conversa cobrem as duas grafias.
- **Templates são cobrados** pela Meta por entrega, conforme categoria e país.

## Segurança

- `/mcp` exige `MCP_AUTH_TOKEN` (header `Authorization: Bearer` ou no caminho); o servidor não sobe em HTTP sem ele.
- `/webhook` só aceita requisições com assinatura HMAC-SHA256 válida do App Secret.
- `whatsapp_upload_media` por URL só busca `https` e recusa endereços privados ou locais.
- O token no caminho da URL aparece em logs de proxy. Para trocar, mude `MCP_AUTH_TOKEN` e atualize o conector.

## Desenvolvimento

```bash
npm install
npm run build
npm run smoke   # teste ponta a ponta contra uma Graph API simulada; não envia nada real
npm run dev     # precisa das variáveis de ambiente
```

Requer Node 22.13 ou superior (usa `node:sqlite` nativo; o Dockerfile usa Node 24).

## Estrutura

```
src/
  index.ts            servidor HTTP/stdio, autenticação, rotas
  config.ts           variáveis de ambiente
  webhook.ts          assinatura e ingestão do webhook
  services/graph.ts   cliente da Graph API e tradução de erros
  services/store.ts   log de mensagens em SQLite
  services/phone.ts   normalização de números
  services/net.ts     proteção contra SSRF
  tools/              messages, inbox, templates, media, account
scripts/smoke.mjs     teste ponta a ponta
```
