# Dockerfile — multi-stage TypeScript build
# Base image WORKDIR is /home/myuser and it runs as the non-root user `myuser`.

# ---- Build stage: install all deps (incl. TypeScript) and compile to dist/ ----
FROM apify/actor-node-playwright-chrome:22-1.56.1 AS builder

# Copy package files first for better layer caching
COPY --chown=myuser:myuser package*.json ./

# Install ALL dependencies, including devDependencies (TypeScript, etc.)
# Do NOT install playwright manually — it ships in the base image.
RUN npm install --include=dev

# Copy the rest of the source and compile TypeScript -> dist/
COPY --chown=myuser:myuser . ./
RUN npm run build

# ---- Runtime stage: production deps + compiled output only ----
FROM apify/actor-node-playwright-chrome:22-1.56.1

# Copy package files and install only production dependencies
COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev --omit=optional

# Copy the compiled JavaScript from the build stage
COPY --chown=myuser:myuser --from=builder /home/myuser/dist ./dist

# Run the compiled actor
CMD ["node", "dist/main.js"]
