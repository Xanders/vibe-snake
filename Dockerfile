FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src

RUN npm install
RUN npm install typescript -g
RUN tsc

EXPOSE 3000

CMD ["node", "dist/server.js"]