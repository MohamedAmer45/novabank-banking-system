FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000 \
    QA_MODE=true \
    DATABASE_SSL=false

EXPOSE 3000

# DATABASE_URL must be supplied at run time; see docker-compose.yml.
CMD ["node", "server.js"]
