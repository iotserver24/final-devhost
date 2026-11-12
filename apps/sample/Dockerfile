FROM node:22-slim
WORKDIR /app
COPY apps/sample/package.json apps/sample/package.json
COPY package.json ./
RUN npm install --no-save --no-audit --no-fund
COPY apps/sample apps/sample
WORKDIR /app/apps/sample
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "start"]
