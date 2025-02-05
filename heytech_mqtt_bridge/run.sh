#!/usr/bin/with-contenv bash
set -e  # Beendet das Skript sofort bei Fehlern

# Funktion zum Laden von Home Assistant Add-On Konfigurationswerten
get_config() {
    jq -r ".$1" /data/options.json
}

export heyhost=$(get_config 'heyhost')
echo "Heytech host: ${heyhost}."
export heyport=$(get_config 'heyport')
echo "Heytech port: ${heyport}."
export heypin=$(get_config 'heypin')
export mqtthost=$(get_config 'mqtthost')
echo "MQTT host: ${mqtthost}."
export mqttport=$(get_config 'mqttport')
echo "MQTT port: ${mqttport}."
export mqttuser=$(get_config 'mqttuser')
echo "MQTT user: ${mqttuser}."
export mqttpass=$(get_config 'mqttpass')
export control_topic_root=$(get_config 'control_topic_root')
echo "Control topic: ${control_topic_root}."
export state_topic_root=$(get_config 'state_topic_root')
echo "State topic: ${state_topic_root}."
echo "Starting Heytech MQTT Bridge..."

# Set the config directory for the Node.js application
export NODE_CONFIG_DIR=/config

# Ensure the config directory exists
if [ ! -d "$NODE_CONFIG_DIR" ]; then
  echo "Error: Config directory $NODE_CONFIG_DIR not found!" >&2
  exit 1
fi

# Gehe ins App-Verzeichnis
cd /app || exit 1

# Wichtig: Starte npm korrekt als PID 1!
exec npm start
