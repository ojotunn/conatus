# Build deterministica para o Railway (13/08/2026). O builder automatico deles
# falhou em 4s montando o plano; com Dockerfile nao ha adivinhacao — e a imagem
# fica igual ao ambiente onde o projeto foi escrito (Node 24).
FROM node:24-slim

# O navegador dos agentes e REMOTO (Browserbase): nao baixamos Chrome dentro da
# imagem — sao ~200 MB e um monte de biblioteca de sistema por nada. Consequencia
# assumida: o fallback de Chromium local nao existe la dentro.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    NODE_ENV=production \
    NO_OPEN=1

WORKDIR /app

# Camada de dependencias separada: so reinstala quando o lockfile muda.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# PORT vem do Railway; HOST=0.0.0.0 vem das variaveis do servico (sem ele o
# servidor sobe em loopback e o proxy nao alcanca). O motor NAO sobe junto:
# quem liga os agentes e o /console.
CMD ["node", "src/server.js"]
