
# Dockerfile

FROM apify/actor-node-playwright-chrome:22-1.56.1

# Copy package files first for better layer caching
COPY --chown=myuser:myuser package*.json ./

# Install dependencies
# Do NOT install playwright manually
RUN npm install --omit=dev --omit=optional

# Copy source code
COPY --chown=myuser:myuser . ./

# Run actor
CMD ["node", "src/main.js"]

