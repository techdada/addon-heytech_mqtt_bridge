#!/usr/bin/with-contenv bashio
set -e  # Beendet das Skript sofort bei Fehlern
set +u

export heyhost=$(bashio::config 'heyhost')
bashio::log.info "Heytech host: ${heyhost}."
export heyport=$(bashio::config 'heyport')
bashio::log.info "Heytech port: ${heyport}."
export heypin=$(bashio::config 'heypin')
export mqtthost=$(bashio::config 'mqtthost')
bashio::log.info "MQTT host: ${mqtthost}."
export mqttport=$(bashio::config 'mqttport')
bashio::log.info "MQTT port: ${mqttport}."
export mqttuser=$(bashio::config 'mqttuser')
bashio::log.info "MQTT user ${mqttuser}."
export mqttpass=$(bashio::config 'mqttpass')
export control_topic_root=$(bashio::config 'control_topic_root')
bashio::log.info "Control topic: ${control_topic_root}."
export state_topic_root=$(bashio::config 'state_topic_root')
bashio::log.info "State topic: ${state_topic_root}."
bashio::log.info "Starting Heytech MQTT Bridge..."

# Set the config directory for the Node.js application
export NODE_CONFIG_DIR=/config

# Ensure the config directory exists
if [ ! -d "$NODE_CONFIG_DIR" ]; then
  bashio::log.error "Error: Config directory $NODE_CONFIG_DIR not found!"
  exit 1
fi

# Gehe ins App-Verzeichnis
cd /usr/src/app || exit 1

# Wichtig: Starte npm korrekt als PID 1!
exec npm start

