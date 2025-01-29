#!/usr/bin/env bash
set -e

echo "Starting Heytech MQTT Bridge..."

# Set the config directory for the Node.js application
export NODE_CONFIG_DIR=/config

# Ensure the config directory exists
if [ ! -d "$NODE_CONFIG_DIR" ]; then
  echo "Error: Config directory $NODE_CONFIG_DIR not found!"
  exit 1
fi

# Navigate to the application directory
cd /usr/src/app

# Start the Node.js application
npm start

