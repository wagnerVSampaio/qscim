
  # Set Node version
  FROM keymetrics/pm2:18-alpine
  
  ENV NODE_ENV=production

  # Installing Process Manager v5.2.2
  # RUN npm install pm2@5.2.2 -g
  
  RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app
  RUN mkdir -p /home/node/app/data && chown -R node:node /home/node/app/data
  
  # Directory app into container
  WORKDIR /home/node/app
  
  # Copy package.json to container
  COPY package*.json ./
  
  # Switch the user to "node" before running npm install
  USER node
  
  # Docker won't have to install the dependencies again if you change the file
  RUN npm install 
  
  # Copy app to Docker container
  COPY --chown=node:node . .
  
  EXPOSE 8885

  # Copy prisma/ to container
  COPY prisma/ prisma

  ENV DATABASE_URL=mongodb+srv://wagner:wagner@cluster0.jhyywl0.mongodb.net/scim?retryWrites=true&w=majority&appName=Cluster0

  # Running migration to create database tables with Prisma Migrate
  RUN npx prisma generate
  RUN npx prisma db push
  
  # Running application (single proccess)
  # CMD ["/bin/ash", "-c", "node index.js"],
  
  # Running production  (multi proccess)
  CMD ["pm2-runtime", "ecosystem.config.cjs"]