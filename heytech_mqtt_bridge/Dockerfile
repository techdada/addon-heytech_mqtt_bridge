ARG BUILD_FROM
#FROM $BUILD_FROM
FROM docker.io/library/node:lts-bullseye-slim

#ENV LANG C.UTF-8
#SHELL ["/bin/bash", "-o", "pipefail", "-c"]

#RUN apk add --no-cache \
#    nodejs \
#    npm \
#    git

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./

RUN npm install && npm audit fix

# Bundle app source
COPY app/ ./

# Copy run script
COPY run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh

ENTRYPOINT  ["/usr/local/bin/run.sh"]
