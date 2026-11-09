# Nutzt das offizielle Home Assistant Base-Image mit S6-Overlay
FROM ghcr.io/home-assistant/base:latest

# Installiere notwendige Abhängigkeiten
RUN apk add --no-cache jq nodejs npm

# Kopiere die Anwendung nach /app
COPY app/ /app/
COPY package*.json /app/

RUN cd /app && npm install --only=production

# Stelle sicher, dass das Skript ausführbar ist
COPY run.sh /app/
RUN chmod +x /app/run.sh

# Setze das Arbeitsverzeichnis auf /app
WORKDIR /app

# Starte die Bridge über das vorhandene Start-Skript.
CMD ["/app/run.sh"]
