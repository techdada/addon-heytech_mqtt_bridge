## 1.0.11

- Erkannte Kanäle werden beim Start mit Typ, Kanalnummer und Namen im normalen Log ausgegeben.
- Aktionslogs für Auf, Ab, Stopp, Prozent, Tilt, Level, Ein und Szenen wiederhergestellt.

## 1.0.10

- SMN-Kanallisten werden wieder bis zum anschließenden `start_sti` gesammelt, bevor das Geräteinventar übernommen wird.
- Die allgemeine Frame-Resynchronisierung verwirft keine laufende SMN-Kanalliste mehr.

## 1.0.8

- Kanallisten mit CR-Trennzeichen werden korrekt eingelesen, damit benannte MQTT-Ziele wie `shutter.Buero` erreichbar bleiben.

## 1.0.7

- MQTT- und Telnet-Verbindungen voneinander entkoppelt.
- Telnet-Wiederverbindung nach 10 Sekunden.
- Wartezeit bei Tilt-Befehlen korrigiert.
- Fehlerhafte Software-Gruppenbefehle vorläufig deaktiviert.
- Ausstehende Tilt-Stopps werden nach einer Telnet-Wiederverbindung zuerst gesendet.
- MQTT-Befehle, Geräte und Prozentwerte werden geprüft; asynchrone Fehler abgefangen.
- Telnet-Antworten werden auch bei aufgeteilten und zusammengefassten Paketen verarbeitet.
- Statusabfragen starten nur einmal; Empfangspuffer und Befehlswarteschlange sind begrenzt.
- Level-Werte werden aus JSON-`val` oder `value` gelesen und auf 0 bis 100 begrenzt.
- Temperatur- und Winddaten werden im Sensorinventar korrekt übernommen.
- Die Steuerungs-PIN wird im Debugprotokoll maskiert.
- Ungenutzte Alt-Skripte und die ungenutzte `config`-Abhängigkeit entfernt.
