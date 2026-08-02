FROM node:24.15.0-alpine

WORKDIR /app

COPY . .

RUN npm ci

ENV NODE_ENV=production

EXPOSE 3000

CMD ["sh", "-c", "npm exec -- tsx apps/api/src/migrate.ts && exec npm exec -- tsx apps/api/src/index.ts"]
