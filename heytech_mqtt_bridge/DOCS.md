# Befehle und Fehlerbehandlung

Die MQTT-Topics bleiben konfigurierbar über `control_topic_root` und
`state_topic_root`. Ein Steuer-Topic endet zum Beispiel auf `shutter.1` oder
`shutter.Wohnzimmer`.

Als Nachricht werden `up`, `down`, `stop`, `0percent` bis `100percent` und
`tilt350` unterstützt. Tilt nutzt weiterhin das Format mit drei bis vier Ziffern;
der zeitgesteuerte Stopp wird wie bisher nur bei Werten über 100 ms aktiviert.
Ein Szenario wird über `scene.1` mit der Nachricht `activate` gestartet.

JSON-Befehle verwenden `action`. Für `level` muss `val` oder `value` eine Zahl
zwischen 0 und 100 sein, zum Beispiel `{"action":"level","val":50}`.
Dimmer akzeptieren außerdem `{"action":"on","val":true}` beziehungsweise
`false`. Unbekannte Geräte, mehrdeutige Befehle und ungültige Werte werden
ignoriert und protokolliert. Software-Gruppen bleiben deaktiviert;
Hardware-Splitter werden weiterhin über ihren normalen Kanal angesteuert.

Telnet und MQTT verbinden sich unabhängig voneinander. Nach einem
Telnet-Abbruch erfolgt der automatische Verbindungsversuch nach 10 Sekunden.
Ein beim Abbruch ausstehender Tilt-Stopp wird nach Wiederverbindung vor neuen
Befehlen gesendet. Während eines Verbindungsabbruchs kann der Motor nicht
zeitgenau gestoppt werden; Timer und Telnet garantieren keine exakte physische
Motorlaufzeit. Ausstehende Stopps werden im Arbeitsspeicher gehalten und
überleben keinen Prozess- oder Stromausfall.

Die Positionsregelung für ältere Firmware wird nach 120 Sekunden abgebrochen
und fordert dann einen Stopp an. Ein erneuter Positionsbefehl sollte erst nach
Abschluss der vorherigen Fahrt erfolgen.

Die Warteschlange ist auf 256 ausstehende Befehle, MQTT-Nachrichten auf 4096
Bytes und Telnet-Antworten auf 65536 Zeichen begrenzt. Überzählige oder
übergroße Eingaben werden verworfen. Beim Debuggen wird die Steuerungs-PIN
in gesendeten Authentifizierungsbefehlen maskiert.

Die Regressionstests lassen sich lokal aus dem Add-on-Ordner mit `npm test`
oder `node tests/regression.js` ausführen. Sie benötigen keine installierten
Abhängigkeiten und keine Verbindung zu Broker oder Steuerung.
