ARG NODE_IMAGE=docker.io/node:22-alpine3.24
FROM ${NODE_IMAGE}

# Required by the existing run.sh entrypoint.
RUN apk add --no-cache bash

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY app/package*.json ./

RUN npm install

# Bundle app source
COPY app/ /usr/src/app/

# Copy run script
COPY run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh

CMD ["/usr/local/bin/run.sh"]

