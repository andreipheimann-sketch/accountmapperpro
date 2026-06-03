# Account Mapper Pro — Versão com Busca Online (Vercel)

App de account mapping para prospecção enterprise da Certta, com busca de
dados reais e atualizados via Tavily. O backend resolve o problema de CORS
e mantém sua API key segura no servidor.

---

## O que você vai precisar (tudo grátis)

1. Conta no GitHub — https://github.com
2. Conta na Vercel — https://vercel.com (faça login com o GitHub)
3. Sua API key da Tavily — https://tavily.com (você já tem)

---

## Passo a passo para publicar (~10 minutos)

### 1. Subir o código para o GitHub

- Crie um repositório novo no GitHub (botão "New", pode ser privado)
- **A forma mais segura de subir mantendo a pasta `api/`:**
  - Na página do repositório vazio, clique em "uploading an existing file"
  - Arraste TODOS os arquivos da raiz (App.jsx, main.jsx, index.html, package.json, vite.config.js, .npmrc, .gitignore, README.md)
  - Para a pasta `api/`: no GitHub, ao arrastar o arquivo `search.js`, digite `api/search.js` no campo de nome do arquivo para recriar a pasta — OU use o GitHub Desktop / git que preserva pastas automaticamente
- Confirme na página do repositório que você vê: os arquivos na raiz E uma pasta `api/` com o `search.js` dentro

> Dica: se tiver o Git instalado, o jeito mais confiável é:
> ```
> git init
> git add .
> git commit -m "primeira versao"
> git remote add origin URL_DO_SEU_REPO
> git push -u origin main
> ```
> O git preserva toda a estrutura de pastas automaticamente.

### 2. Conectar na Vercel

- Acesse https://vercel.com e faça login com sua conta GitHub
- Clique em "Add New..." → "Project"
- Selecione o repositório que você acabou de criar
- A Vercel detecta automaticamente que é um projeto Vite — não mude nada
- **ANTES de clicar em Deploy**, abra "Environment Variables" e adicione:
  - Name: `TAVILY_API_KEY`
  - Value: sua chave da Tavily (começa com `tvly-`)
- Clique em "Deploy"

### 3. Pronto

- Em ~1 minuto a Vercel te dá um link público (ex: `account-mapper-pro.vercel.app`)
- Abra o link, digite o nome de uma empresa e clique em Analisar
- O badge no topo deve mostrar "● LIVE" — significa que a busca real está ativa

---

## Como funciona

- O app (frontend) chama `/api/search` no seu próprio domínio Vercel
- A função `api/search.js` (backend) chama a Tavily do lado do servidor
- Sem CORS, e sua chave fica secreta na variável de ambiente da Vercel
- Se a busca falhar por algum motivo, o app cai automaticamente no modo offline

---

## Rodar localmente (opcional, para testar antes)

```bash
npm install
# crie um arquivo .env com: TAVILY_API_KEY=sua_chave
npm run dev
```

Obs: a função `/api` só roda de verdade na Vercel ou com `vercel dev`.
Localmente com `npm run dev` o app funciona em modo offline.

---

## Estrutura do projeto

```
account-mapper-vercel/
├── api/
│   └── search.js          ← backend que chama a Tavily (resolve CORS)
├── App.jsx                ← o app completo
├── main.jsx               ← ponto de entrada React
├── index.html
├── package.json
├── vite.config.js
└── README.md             ← este arquivo
```

IMPORTANTE: ao subir para o GitHub, mantenha a pasta `api/` como pasta.
Os demais arquivos ficam todos na raiz do repositório.

---

## Trocar para outra empresa (ex: Zendesk)

Todo o conteúdo específico da Certta está na função `buildAccountData`
dentro de `App.jsx`. Para criar uma versão de outra empresa, edite os
segmentos, dores, soluções e stakeholders nessa função.
