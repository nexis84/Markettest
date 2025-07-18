# Use a lightweight Node.js image
FROM node:20

# Set working directory
WORKDIR /usr/src/app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY . .

# Expose the port
EXPOSE 8080

# Start the application
CMD ["node", "server.js"]
