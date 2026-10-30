# One box for a demo: the API plus both websites (customer at /, staff at /staff).
# Production uses the same image with `node apps/api/dist/main.js` and real keys.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dawgs/core --filter @dawgs/db build && cd apps/api && npx tsc -p tsconfig.json
RUN cd apps/staff && EXPO_PUBLIC_BASE_URL=/staff EXPO_PUBLIC_API_URL=/api npx expo export --platform web --output-dir /app/web/staff
RUN cd apps/customer && EXPO_PUBLIC_API_URL=/api npx expo export --platform web --output-dir /app/web/customer

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DAWGS_WEB_DIR=/app/web
COPY --from=build /app /app
EXPOSE 3001
CMD ["node", "apps/api/dist/demo.js"]
