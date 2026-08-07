FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/comments/package.json packages/comments/package.json
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY apps/api/tsconfig.build.json apps/api/tsconfig.build.json
COPY packages/comments/tsconfig.build.json packages/comments/tsconfig.build.json
COPY apps/api/src apps/api/src
COPY packages/comments/src packages/comments/src
RUN npm run build

FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/comments/package.json packages/comments/package.json
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/apps/api/package.json ./apps/api/package.json
COPY --from=production-dependencies /app/packages/comments/package.json ./packages/comments/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/comments/dist ./packages/comments/dist
COPY db/migrations ./db/migrations

USER node
EXPOSE 3000

CMD ["sh", "-c", "node --enable-source-maps --conditions=production apps/api/dist/migrate.js && exec node --enable-source-maps --conditions=production apps/api/dist/index.js"]
