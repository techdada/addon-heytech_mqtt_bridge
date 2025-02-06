# Nutzt das offizielle Home Assistant Base-Image mit S6-Overlay
FROM ghcr.io/hassio-addons/base:14.0.3

# Installiere notwendige Abhängigkeiten
RUN apk add --no-cache jq nodejs npm

# Kopiere die Anwendung nach /app
COPY app/ /app/
COPY package*.json /app/

# Kopiere das Start-Skript ins HAOS-verwaltete Service-System
COPY rootfs/ /

RUN cd /app && npm install --only=production

# Stelle sicher, dass das Skript ausführbar ist
COPY run.sh /app/
RUN chmod +x /app/run.sh

# Setze das Arbeitsverzeichnis auf /app
WORKDIR /app

# S6-Overlay wird den Service über /etc/services.d/app/run starten
CMD ["/app/run.sh"]
