# Container recipe used by Fly.io (and any Docker host) to run PostForge
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# install app packages first (cached between deploys when package files don't change)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

# app code
COPY . .

# database, uploads and backups live on the persistent volume mounted here
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
