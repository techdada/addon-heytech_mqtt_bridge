// @ts-nocheck
'use strict';

const _ = require('lodash');
const EventEmitter = require('events');
//const {Telnet} = require('telnet-rxjs'); // telnet-rxjs
//const {Telnet} = require('telnet-client'); // telnet-client
const net = require('net');
const TelnetStream = require("telnet-stream");


const newLine = String.fromCharCode(13);
const START_SOP = 'start_sop';
const ENDE_SOP = 'ende_sop';
const START_SKD = 'start_skd';
const ENDE_SKD = 'ende_skd';
const START_SMO = 'start_smo';
const ENDE_SMO = 'ende_smo';
const START_SMC = 'start_smc';
const ENDE_SMC = 'ende_smc';
const START_SFI = 'start_sfi';
const ENDE_SFI = 'ende_sfi';
const START_SMN = 'start_smn';
const ENDE_SMN = 'ende_smn';
const ENDE_SMN_START_STI = 'ende_smn\r\nstart_sti';


//let client = null; // telnet-rxjs

// let connected = false; // telnet-rxjs
// let connecting = false; // telnet-rxjs
const commandCallbacks = [];
let runningCommandCallbacks = false;

let controllerChannelCount;
let controllerSoftwareVersion;

let readSop = false;
let readSkd = false;
let readSmo = false;
let readSmc = false;
let readSfi = false;
let readSmn = false;

let lastStrings = '';


const actualPercents = {};
const actualSensors = {};
const actualShutters = {};

/*
 * let retryClient = function(telnetClient) {
 *	this.tclient = telnetClient;
 *	this.send = function telnetClient(self,command) {
 *		try {
 *
 *		} catch(err) {
 *			self.tclient.connect(credentialU,credentialP,Host);
 *
 *		}
 *	}
 * }
 *
 * */

let checkShutterStatusClearTimeoutHandler;
let sleepClearTimeoutHandler;

const memoizeDebounce = function (func, wait = 0, options = {}) {
    const mem = _.memoize(function () {
        return _.debounce(func, wait, options);
    }, options.resolver);
    return function () {
        mem.apply(this, arguments).apply(this, arguments);
    };
};


let start;

class Heytech extends EventEmitter { //extends utils.Adapter {


    constructor(options) {
        super();

        this.config = options.config;
        this.log = [];
        // allow use of hostname, if no ip set.
        if (this.config.ip === undefined ) this.config.ip = this.config.host;

        // IKEA Clock: new Date().toLocaleString("sv-SE");
        //this.log.debug = function (text) {  }; //console.log;
        if ( this.config.debug) {
            if (String(this.config.debug).toLowerCase() == "on" ) {
                this.log.debug = function (text) { console.debug(new Date().toLocaleString("sv-SE") + text); };
            } else {
                this.log.debug = function (text) { } ;
            }
        }
        this.log.info = function (text) { console.info(new Date().toLocaleString("sv-SE") + text); };
        this.log.warn = function (text) { console.log(new Date().toLocaleString("sv-SE") + text); };
        this.log.error = function (text) { console.log(new Date().toLocaleString("sv-SE") + text); }; //function (text) { console.error(new Date() + text); };

        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.config.group = {
        };
        this.config.controller = {
            "model": "",
            "numberOfChannels":0
        };
        this.config.sensor = {};
        this.config.shutter = {};
        this.config.scene = {};
        this.config.device = {};

        //cC = createClient.bind(this);
        this.buffer = '';
        //this.client = new Telnet(); // telnet-client
        this.socket = null; // telnet-stream
        this.telnet = null; // telnet-stream
        this.connected = false;
        this.connecting = false;
        this.reconnectDelay = 5000;


        //temp variable for processIncomingData
        this.smn = '';

        const d = new Date();
        start = d.getTime();

        this.communicator = null;
    }


    async connect() {
        if (this.connected || this.connecting) return;
    
        this.connecting = true;
        this.log.info("🔄 Connecting to Telnet server...");
    
        try {
            this.socket = new net.Socket();
            this.telnet = new TelnetStream.TelnetSocket(this.socket); // ✅ Richtiger Aufruf!
    
            this.socket.connect(this.config.port, this.config.ip, () => {
                this.connected = true;
                this.log.info("✅ Connected to Telnet server");
                this.onConnected();
            });
            
            this.startListening();
            
            this.socket.on("close", () => this.onDisconnected());
            this.socket.on("error", (err) => this.onDisconnected(err));
    
            if (!this.refreshInterval) {
                this.refreshInterval = setInterval(() => {
                    this.sendeRefreshBefehl();
                }, this.config.refresh || 300000);
            }
        } catch (error) {
            this.log.error("❌ Telnet connection error:", error);
        } finally {
            this.connecting = false;
        }
    }

    async disconnect() {
        if (this.socket) {
            this.socket.destroy(); // Verbindung sauber schließen
            this.socket = null;
            this.telnet = null;
            this.connected = false;
            this.log.info("🔌 Disconnected from Telnet server");
        }
    }

    send(group) {
        if (!this.telnet || !this.connected) {
            this.log.error("⚠️ Not connected. Cannot send commands.");
            return;
        }
    
        group.forEach(cmd => {
            this.telnet.write(cmd + "\r\n"); // CRLF für Telnet
            this.log.debug(`📨 Sent: ${cmd}`);
        });
    }

    onConnected() {
        if (this.config.pin) {
            this.send(["rsc", newLine, this.config.pin.toString(), newLine]);
        }
    
        const sendInitialCommands = () => {
            this.send([
                newLine, "sss", newLine,
                "sss", newLine
            ]);
            if (!readSmo) this.send(["smo", newLine]);
            this.send(["sdt", newLine]);
            if (!readSfi) this.send(["sfi", newLine]);
            if (!readSmn) this.send(["smn", newLine]);
            if (!readSkd) this.send(["skd", newLine]);
        };
    
        const checkFirstRun = async () => {
            while (!this.firstRunDone()) {
                sendInitialCommands();
                await this.sleep(5000);
            }
        };
    
        checkFirstRun().then(() => {
            if (commandCallbacks.length > 0) {
                this.waitForRunningCommandCallbacks().then(async () => {
                    runningCommandCallbacks = true;
                    this.checkShutterStatus()();
    
                    for (const commandCallback of commandCallbacks.splice(0)) {
                        commandCallback();
                        await this.sleep(500);
                    }
    
                    runningCommandCallbacks = false;
                });
            }
        });
    }
    
    onDisconnected(error = null) {
        this.log.info("🔴 Disconnected from controller");
    
        if (error) {
            this.log.error("❌ Disconnect due to error:", error);
        }
    
        this.connected = false;
        this.connecting = false;
    
        // Falls ein automatischer Reconnect gewünscht ist:
        if (this.config.autoReconnect) {
            this.log.info(`🔄 Reconnecting in ${this.config.reconnectDelay || 5000}ms...`);
            setTimeout(() => this.connect(), this.config.reconnectDelay || 5000);
        }
    }
    

    
    firstRunDone() {
        const result = readSop && readSkd && readSmo && readSmc && readSfi && readSmn;
        this.log.debug('First run done?: '+(result));
        if (!result) {
            this.log.debug('read: Sop:' + readSop + ' Skd: ' + readSkd + ' Smo: ' + readSmo + ' Smc: ' + readSmc + ' Sfi: ' + readSfi + ' Smn: ' + readSmn);
        } else {
            this.log.debug(that.config.shutter);
            this.log.debug(that.config.group);
            this.log.debug(that.config.scene);
            this.log.debug(that.config.sensor);
            this.triggerSensorMessage();
            this.triggerShutterMessage();
        }
        return result;
    }


    startListening() {
        if (!this.telnet) {
            this.log.error("⚠️ No active Telnet stream.");
            return;
        }
    
        this.telnet.on("data", (data) => {
            const text = data.toString();
            lastStrings += text; // Empfangene Daten speichern
            this.log.debug(`📥 Received data: "${lastStrings}" | Length: ${lastStrings.length}`);
            this.processIncomingData(text);
        });
    }
    

    processIncomingData(data) {
        // 🏡 Rolladen-Status auslesen
        if (!readSmn && (lastStrings.includes(START_SMN) || lastStrings.includes(ENDE_SMN))) {
            if (lastStrings.includes(ENDE_SMN_START_STI)) {
                this.smn += data; 
                const channels = this.smn.match(/\d\d,.*,\d,/gm);
                this.writeOutputs(channels);
                this.smn = "";
                lastStrings = "";
                this.log.debug("✅ Shutters gelesen");
                readSmn = true;
            } else {
                this.smn += data;
            }
        }
    
        // 🏗 SOP (Öffnungsprozente)
        else if (lastStrings.includes(START_SOP) && lastStrings.includes(ENDE_SOP)) {
            const regexpResults = lastStrings.match(/t_sop([^]+?)ende_sop/);
            if (regexpResults) {
                const statusStr = regexpResults[1].replace(ENDE_SOP, "");
                const rolladenStatus = statusStr.split(",").slice(0, controllerChannelCount || 32);
                lastStrings = "";
                this.log.debug("🌡️ Rolladenstatus: " + rolladenStatus);
    
                if (rolladenStatus.every(value => !isNaN(value))) {
                    this.writeStatus(rolladenStatus);
                    readSop = true;
                } else {
                    this.log.error("❌ Rolladenstatus konnte nicht interpretiert werden: " + statusStr);
                }
            }
        }
    
        // 🌡 Klimadaten auslesen (SKD)
        else if (lastStrings.includes(START_SKD) && lastStrings.includes(ENDE_SKD)) {
            const klimaStr = lastStrings.substring(
                lastStrings.indexOf(START_SKD) + START_SKD.length,
                lastStrings.indexOf(ENDE_SKD, lastStrings.indexOf(START_SKD))
            );
            const klimadaten = klimaStr.split(",");
            lastStrings = "";
            this.log.debug("🌡️ Klima gelesen: " + klimadaten);
            this.writeKlima(klimadaten);
            readSkd = true;
        }
    
        // 🔍 Modelkennung (SMO)
        else if (lastStrings.includes(START_SMO) && lastStrings.includes(ENDE_SMO)) {
            let modelStr = lastStrings.substring(
                lastStrings.indexOf(START_SMO) + START_SMO.length,
                lastStrings.indexOf(ENDE_SMO, lastStrings.indexOf(START_SMO))
            );
            this.log.info("🏷 Model: " + modelStr);
            modelStr = modelStr.replace("HEYtech ", "");
            this.updateInventory("controller", "model", {
                model: modelStr,
                status: 0
            });
    
            lastStrings = "";
            readSmo = true;
        }
    
        // 📡 Anzahl der Kanäle (SMC)
        else if (lastStrings.includes(START_SMC) && lastStrings.includes(ENDE_SMC)) {
            const noChannelStr = lastStrings.substring(
                lastStrings.indexOf(START_SMC) + START_SMC.length,
                lastStrings.indexOf(ENDE_SMC, lastStrings.indexOf(START_SMC))
            );
            this.log.debug("🎛 Number of Channels: " + noChannelStr);
            controllerChannelCount = Number(noChannelStr);
            this.updateInventory("controller", "numberOfChannels", {
                numberOfChannels: noChannelStr
            });
    
            lastStrings = "";
            readSmc = true;
        }
    
        // 💾 Software-Version (SFI)
        else if (lastStrings.includes(START_SFI) && lastStrings.includes(ENDE_SFI)) {
            const svStr = lastStrings.substring(
                lastStrings.indexOf(START_SFI) + START_SFI.length,
                lastStrings.indexOf(ENDE_SFI, lastStrings.indexOf(START_SFI))
            );
            this.log.info("📟 Software version: " + svStr);
            controllerSoftwareVersion = svStr;
            this.updateInventory("controller", "version", {
                version: controllerSoftwareVersion
            });
            lastStrings = "";
            readSfi = true;
        }
    }
    

    calculateLuxValueCustom(data) {
        let briV = 0;
        if (data < 19) {
            briV = data * 1;
        } else if (data > 19 && data < 29) {
            briV = data * 4;
        } else if (data > 29 && data < 39) {
            briV = data * 8;
        } else if (data > 39 && data < 49) {
            briV = data * 15;
        } else if (data > 49 && data < 59) {
            briV = data * 22;
        } else if (data > 59 && data < 69) {
            briV = data * 30;
        } else if (data > 69 && data < 79) {
            briV = data * 40;
        } else if (data > 79 && data < 89) {
            briV = data * 50;
        } else if (data > 89 && data < 99) {
            briV = data * 64;
        } else if (data > 99 && data < 109) {
            briV = data * 80;
        } else if (data > 109 && data < 119) {
            briV = data * 100;
        } else if (data > 119 && data < 129) {
            briV = data * 117;
        } else if (data > 129 && data < 139) {
            briV = data * 138;
        } else if (data > 139 && data < 149) {
            briV = data * 157;
        } else if (data > 149 && data < 159) {
            briV = data * 173;
        } else if (data > 159 && data < 169) {
            briV = data * 194;
        } else if (data > 169 && data < 179) {
            briV = data * 212;
        } else if (data > 179 && data < 189) {
            briV = data * 228;
        } else if (data > 189 && data < 199) {
            briV = data * 247;
        } else if (data > 199 && data < 209) {
            briV = data * 265;
        } else if (data > 209 && data < 219) {
            briV = data * 286;
        } else if (data > 219 && data < 229) {
            briV = data * 305;
        } else if (data > 229 && data < 239) {
            briV = data * 322;
        } else if (data > 239 && data < 249) {
            briV = data * 342;
        } else if (data > 249 && data < 259) {
            briV = data * 360;
        }
        return briV;
    }


    calculateLuxValueBasedOnHeytech(wert) {
        let luxPrefix;
        let lux;
    
        if (wert < 10) {              // - LuxPrefix = 1 --> Lux-Wert n steht für   1 ... 900 Lux
            luxPrefix = 0;
            lux = wert;             //  ' - LuxPrefix = 0 --> Lux-Wert n steht für 0,1 ... 0,9 Lux
        } else if (wert <= 19) {     //  ' - LuxPrefix = 2 --> Lux-Wert n steht für   1 ... 900 kLux
            luxPrefix = 1;
            lux = wert - 9;
        } else if (wert <= 28) {
            luxPrefix = 1;
            lux = wert - 20;
            lux = lux * 10;
            lux = lux + 20;
        } else if (wert <= 36) {
            luxPrefix = 1;
            lux = wert - 29;
            lux = lux * 100;
            lux = lux + 200;
        } else if (wert <= 136) {
            luxPrefix = 2;
            lux = wert - 36;
        } else {
            luxPrefix = 2;
            lux = wert - 137;
            lux = lux * 10;
            lux = lux + 110;
        }
    
        let resultLux;
        if (luxPrefix === 0) {
            resultLux = 1 - (10 - lux) / 10;
        } else if (luxPrefix === 1) {
            resultLux = lux;
        } else { // LuxPrefix === 2
            resultLux = lux * 1000;
        }
        return resultLux;
    }


    writeOutputs(data) {
        const that = this;
        const n = data.length;

        for (let i = 0; i < n; i++) {
            const channel = data[i].split(',');
            if (channel[0]<70) {
                const number = parseInt(channel[0]);
                const name = channel[1].trim();
                let vRole;

                if (channel[0] < 65) {
                    switch (channel[2]) {
                        case '1':
                            vRole = 'shutter';
                            break;
                        case '2':
                            vRole = 'device';
                            break;
                        case '3':
                            vRole = 'group';
                            break;
                        case '4':
                            vRole = 'device group';
                            break;
                    }
                } else if (channel[0]<70) {
                    vRole = 'scene';

                }
                if (vRole === 'shutter') {
                    that.updateInventory('shutter',number,{
                        "number": number,
                        "name": channel[1].trim(),
                        "state": 0
                    });
                } else if (vRole === 'scene') {
                    that.updateInventory('scene',number-64,{
                        "number": number,
                        "name": channel[1].trim(),
                        "state": 0
                    });
                } else if (vRole === 'group') {
                    that.updateInventory('group',number,{
                        "number": number,
                        "name": channel[1].trim(),
                        "state": 0
                    });
                } else if (vRole === 'device' || vRole === 'device group') {
                    const patt = new RegExp('~');
                    const dimmer = patt.test(channel[1].trim());

                    if (dimmer === false) {
                        that.updateInventory('devices',number,{
                                "number": number,
                                "name": channel[1].trim(),
                                "state": 0
                        });
                    } else if (dimmer === true) {
                        that.updateInventory('devices',number,{
                            "number": number,
                            "dimmer": true,
                            "name": channel[1].trim(),
                            "state": 0
                        });
                    }
                }
            }
        }
    }

    writeStatus(data) {
        //let actualPercents = {};

        const that = this;
        for (let i = 0 ; i < data.length; i++) {
            const z = i+1;
            let oldVal = null;
            const percent = Number(data[i]);
            if (!isNaN(percent)) {
                actualPercents[String(z)] = percent;
                oldVal = this.getState('shutter',z);
                if (oldVal !== undefined) {
                    if (percent !== oldVal) {
                        this.setState('shutter',z,percent);
                    }
                }
            }
        }
        if (that.config.groups && that.config.groups.length > 0) {
            that.config.groups.forEach(group => {
                const groupId = group.number;
                const shutters = group.shutters;
                let percentSum = 0;
                shutters.forEach(shutter => {
                    percentSum += (actualPercents[String(shutter)] || 0);
                });
                const avgPercent = Math.round(percentSum / shutters.length);
                that.getState('group',groupId, function (err, state) {
                    if (err) {
                        that.log.error(err);
                    } else if (state === null || state !== avgPercent) {
                        that.setState('group',groupId, avgPercent);
                        that.setState('group',groupId, avgPercent);
                    }
                });
            });
        }
    }

    writeKlima(data) {
        const that = this;

        this.getStates('sensor', function (err, states) {
            let st;
            let vAlarm;
            let vWindM;
            let vWindA;
            let vRain;
            let vHumidity;
            let vTiMax;
            let vTiMin;
            let vTi;
            let vToMax;
            let vToMin;
            let vTo;
            let vBriAv;
            let vBriAc;
            for (st in states) {
                let name = st.name;
                if (states[st]) {
                    //switch (name) {
                    switch(st) {
                        case 'alarm':
                            vAlarm = states[st]['state'];
                            break;
                        case 'wind_maximum':
                            vWindM = states[st]['state'];
                            break;
                        case 'wind_actual':
                            vWindA = states[st]['state'];
                            break;
                        case 'rain':
                            vRain = states[st]['state'];
                            break;
                        case 'humidity':
                            vHumidity = states[st]['state'];
                            break;
                        case 'temp_indoor_max':
                            vTiMax = states[st]['state'];
                            break;
                        case 'temp_indoor_min':
                            vTiMin = states[st]['state'];
                            break;
                        case 'temp_indoor':
                            vTi = states[st]['state'];
                            break;
                        case 'temp_outdoor_max':
                            vToMax = states[st]['state'];
                            break;
                        case 'temp_outdoor_min':
                            vToMin = states[st]['state'];
                            break;
                        case 'temp_outdoor':
                            vTo = states[st]['state'].replace(',','.');
                            break;
                        case 'bri_average_sensor_byte':
                            vBriAv = states[st]['state'];
                            break;
                        case 'bri_actual_sensor_byte':
                            vBriAc = states[st]['state'];
                            break;
                    }
                }

            }

            if (vBriAc !== data[0]) {
                that.updateInventory('sensor','bri_actual',{
                    name: "Actual brightness",
                    state: parseInt(data[0]),
                    unit: 'Lux'
                });
                that.updateInventory('sensor','bri_actual_hey',{
                    name: "Actual brightness as in Heytech App",
                    state: parseInt(data[0]),
                    unit: 'Lux'
                });
                that.updateInventory('sensor','bri_actual_sensor_byte',{
                    name: "Actual brightness as byte from sensor",
                    state: parseInt(data[0]),
                    unit: 'Byte'
                });
                
                if (!data || !Array.isArray(data) || data.length === 0) {
                    this.log.error("❌ `data` is undefined or empty in `writeKlima()`");
                } else {
                    const resultLuxCustom = this.calculateLuxValueCustom(data[0]);
                
                    if (resultLuxCustom > 0) {
                        that.setState('sensor','bri_actual', resultLuxCustom);
                    }

                    const resultLuxHeytech = this.calculateLuxValueBasedOnHeytech(data[0]);
                    if (resultLuxHeytech > 0) {
                        that.setState('sensor','bri_actual_hey', resultLuxHeytech);
                    }
                }

            }
            if (vBriAv !== data[14]) {
                that.updateInventory('sensor','bri_average',{
                    name: 'Average brightness',
                    unit: 'lux',
                    state: parseInt(data[14])
                });
                const resultLuxHeytech = this.calculateLuxValueBasedOnHeytech(data[14]);
                if (resultLuxHeytech > 0) {
                    that.updateInventory('sensor','bri_average_hey',{
                        name: 'Average brightness as in Heytech App',
                        unit: 'lux',
                        state: resultLuxHeytech
                    });
                }
                that.updateInventory('sensor','bri_average_byte',{
                    name: 'Average brightness as byte from sensor',
                    unit: 'Byte',
                    state: parseInt(data[14])
                });

                const resultLuxCustom = calculateLuxValueCustom(data[14]);
                if (resultLuxCustom > 0) {
                    that.setState('sensor','bri_average', resultLuxCustom);
                }
            }

            if (data[1] !== 999) {
                if (vTi !== data[1] + '.' + data[2]) {
                    that.updateInventory('sensors','temp_indoor',{
                        name: 'Indoor temperature',
                        type: 'number',
                        unit: '°C',
                        state: data[1] + '.' + data[2]
                    });
                }
                if (vTiMin !== data[3]) {
                    that.updateInventory('sensors','temp_indoor_min',{
                        name: 'Indoor temperature minimum',
                        type: 'number',
                        unit: '°C',
                        state: data[3]
                    });
                }
                if (vTiMax !== data[4]) {
                    that.updateInventory('sensors','temp_indoor_max',{
                        name: 'Indoor temperature maximum',
                        type: 'number',
                        unit: '°C',
                        state: Number(data[4])
                    });
                }
            }

            if (data[5] !== '999') {
                if (vTo !== data[5] + '.' + data[6]) {
                    that.updateInventory('sensors','temp_outdoor',{
                        name: 'Outdoor temperature',
                        type: 'number',
                        unit: '°C',
                        state: data[5]+'.'+data[6]
                    });

                }
                if (vToMin !== data[7]) {
                    that.updateInventory('sensors','outdoor_temp_min',{
                        name: 'Outdoor temperature minimum',
                        type: 'number',
                        unit: '°C',
                        state: Number(data[7])
                    });
                }
                if (vToMax !== data[8]) {
                    that.updateInventory('sensors','temp_outdoor_max',{
                        name: 'Outdoor temperature maximum',
                        type: 'number',
                        unit: '°C',
                        state: Number(data[8])
                    });
                }
            }

            if (vWindA !== data[9]) {
                that.updateInventory('sensors','wind_actual',{
                    name: 'Actual wind speed',
                    type: 'number',
                    unit: 'km/h',
                    state: Number(data[9])
                });
            }
            if (vWindM !== data[10]) {
                that.updateInventory('sensor','wind_maximum',{
                    name: 'Maximum wind speed',
                    unit: 'km/h',
                    state: Number(data[10])
                });
            }

            if (vAlarm !== data[11]) {
                that.updateInventory('sensor','alarm',{
                    name: 'Alarm',
                    state: (data[11] == 1)
                });
            }

            if (vRain !== data[12]) {
                that.updateInventory('sensor','rain',{
                    name: 'Rain',
                    state: (data[12] == 1)
                });
            }

            if (data[15] !== '999' && data[15] !== '0') {
                if (vHumidity !== data[15]) {
                    that.updateInventory('sensor','humidity',{
                        name: 'Humidity',
                        type: 'number',
                        unit: '%',
                        state: Number(data[15])
                    });
                }
            }

        });
        this.log.debug(this.getStates('sensor'));

    }

    

    setCommunicator(communicator) {
        this.communicator = communicator;
    }

    triggerShutterMessage() {
        if (this.communicator === null) return; // silently
        let cleanList = {};
        let pDefault = new RegExp('(Motor [0-9]+)|([0-9]+ LEER)');
        let id;
        for (id in this.config.shutter) {
            if (pDefault.test(this.config.shutter[id].name)) continue;
            cleanList[id] = this.config.shutter[id];
        }
        this.communicator.emit('message','shutters',JSON.stringify(cleanList));
    }

    triggerSensorMessage() {
        if (this.communicator === null) return; // silently
        this.communicator.emit('message','sensors',JSON.stringify(this.config.sensor));
    }

    triggerMessage(suffix,message) {
        if (this.communicator === null) return; // silently
        this.communicator.emit('message',suffix,message);
    }



    getStates(section,cb) {
        let that = this;
        if (that.config[section] === undefined) {
            this.log.warn("Non-existing: "+section);
            return false;
        }
        if (cb !== undefined) cb(0,this.config[section]);
        return this.config[section];
    }

    setState(section,id,value,cb = undefined) {
        // this.log.debug("SETSTATE: " +section+ ":" +id+ " :"+value+"  OK");

        if (section === "sensor") {
            if (this.config.sensor[id] === undefined) {
                this.log.info.err("invalid sensor: "+id);
                return;
            }
            this.config.sensor[id].state = value;
        }

        if (section === "shutter") {
            if (this.config.shutter[id] === undefined) {
                this.log.error("invalid shutter: "+id);
                return;
            }
            this.config.shutter[id].state = value;
        }
        if (section === "group") {
            if (this.config.group[id] === undefined) {
                this.log.error("invalid shutter: "+id);
                return;
            }
            this.config.group[id].state = value;
            //this.config.group[id].shutters.forEach(function () { this.config.group[id].shutters[shutter].state = value})
        }
        if (cb !== undefined) cb(0);
    }

    getState(section,id,cb = undefined) {
        if (this.config[section][id] === undefined) {
            return undefined;
        }
        if (cb !== undefined) cb(0,this.config[section][id].state);
        return this.config[section][id].state;
    }

    getInventoryObject(section,nameid) {
        var found = undefined;

        if (this.config[section] !== undefined) {
            if (this.config[section][nameid] !== undefined) {
                found=this.config[section][nameid];
            }

            for (const [key,value] of Object.entries(this.config[section])) {
                if (key == nameid || value.name == nameid) {
                    found=value;
                }
            }

            // do not return shutters or elements with default names
            // not sure if this works and should stay or not.
            let zep = new RegExp('([0-9]+ LEER)|(Motor [0-9]+)');
            if (zep.test(found.name)) return undefined;
            return found;
        }
    }

    updateInventory(section,id,attributes) {
        if (section === "scene") {
            if (this.config.scene[id] === undefined) this.config.scene[id] = {};

            if (attributes.name !== undefined) this.config.scene[id].name = attributes.name;
            if (attributes.number !== undefined) this.config.scene[id].number = attributes.number;
            if (attributes.state !== undefined) this.config.scene[id].state = attributes.state;
        }
        if (section === "controller") {
            if (id == 'model') {
                this.config.typ = attributes.model;
            }
            if (attributes.numberOfChannels !== undefined) {
                this.config.numberOfChannels = attributes.numberOfChannels;
            }
            if (attributes.numberOfBoxes !== undefined) {
                this.config.numberOfBoxes = attributes.numberOfBoxes;
            }
        }
        if (section === "shutter") {
            if (this.config.shutter[id] === undefined) this.config.shutter[id] = {};
            if (attributes.name !== undefined) this.config.shutter[id].name = attributes.name;
            if (attributes.number !== undefined ) this.config.shutter[id].number = attributes.number;
            if (attributes.state !== undefined ) this.config.shutter[id].state = attributes.state;
        }
        if (section === "device") {
            if (this.config.device[id] === undefined) this.config.device[id] = {};
            if (attributes.name !== undefined) this.config.device[id].name = attributes.name;
            if (attributes.number !== undefined ) this.config.device[id].number = attributes.number;
            if (attributes.state !== undefined ) this.config.device[id].state = attributes.state;
        }
        if (section === "group") {
            if (this.config.group[id] === undefined) this.config.group[id] = {};

            if (attributes.name !== undefined) this.config.group[id].name = attributes.name;
            if (attributes.number !== undefined ) this.config.group[id].number = attributes.number;
            if (attributes.state !== undefined ) this.config.group[id].state = attributes.state;

        }

        if (section === "sensor") {
            if (this.config.sensor[id] === undefined) this.config.sensor[id] = {};
            if (attributes.name !== undefined) this.config.sensor[id].name = attributes.name;
            if (attributes.state !== undefined) this.config.sensor[id].state = attributes.state;
            if (attributes.present !== undefined) this.config.sensor[id].present = attributes.present;

        }
    }

    /**
     * Called when databases are connected and adapter received configuration.
     */
    onReady() {
        if (!this.config.ip) {
            this.log.error("❌ Cannot connect - no IP or hostname configured.");
            return;
        }

        this.log.info("🔄 Adapter is ready, attempting to connect...");
        this.connect();
    }


    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            clearTimeout(checkShutterStatusClearTimeoutHandler);
            clearTimeout(sleepClearTimeoutHandler);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a message appears
     * @param {string} id
     * @param {string} state
     */
    onMessage(id, command) {

        const d = new Date();
        const now = d.getTime();
        const diff = now - start;
        this.log.debug("Heytech onMessage("+id+" - "+command+") diff:"+diff+" readSmn:"+readSmn);
        if (diff > 10000 && readSmn) {

            const patternShutter = new RegExp('shutter');
            const patternGroups = new RegExp('group');

            const pDown = new RegExp('down');
            const pUp = new RegExp('up');
            const pStop = new RegExp('stop');
            const pOn = new RegExp('on');
            const pLevel = new RegExp('level');
			const pTilt = new RegExp('tilt[0-9][0-9][0-9][0-9]?');
            const pActivate = new RegExp('activate');
            const pPercent = new RegExp('[0-9]+percent');

            if (command === undefined) {
                command = id; // option for having it all in one
                              // using type.nr.action notation
                              // e.g. shutter.5.down or group.2.up or scene.2.activate
                              // or even shutter.livingroom.70percent
                              // i personally prefer to have it separated to e.g.
                              // topicroot/shutter.diningroom up

            }

            const isDown     = pDown.test(command);
            const isUp       = pUp.test(command);
            const isStop     = pStop.test(command);
            const isOn       = pOn.test(command);
            const isLevel    = pLevel.test(command);
			const isTilt     = pTilt.test(command);
            const isActivate = pActivate.test(command);
            const isPercent  = pPercent.test(command);

            //let isDimmer = false;


            const actorId = id.split('.');
            const actor = this.getInventoryObject(actorId[0],actorId[1]);

            if (actor === undefined) {
                this.log.warn("invalid device!");
                return;
            }

            let isShutter = ( actorId[0] === "shutter" ); // = patternShutter.test(id);
            let isGroup = ( actorId[0] === "group" ); //   = patternGroups.test(id);
            let isDimmer = ( actorId[0] === "dimmer" );
            let isScene = ( actorId[0] === "scene" && isActivate); //   = pActivate.test(command);



            if (client === null) {
                cC();
            } else {
                if (isDown) {
                    if (isShutter) {
                        this.sendeHandsteuerungsBefehl(actor.number, 'down');
                    } else if (isGroup) {
                        this.sendeHandsteuerungsBefehlToGroup(actor.number, 'down');
                    }
                    this.log.info('down: ' + actor.name);
                }

                if (isUp) {
                    if (isShutter) {
                        this.sendeHandsteuerungsBefehl(actor.number, 'up');
                    } else if (isGroup) {
                        this.sendeHandsteuerungsBefehlToGroup(actor.number, 'up');
                    }

                    this.log.info('up ' + actor.name);
                }

                if (isStop) {
                    if (isShutter) {
                        this.sendeHandsteuerungsBefehl(actor.number, 'off');
                    } else if (isGroup) {
                        this.sendeHandsteuerungsBefehlToGroup(actor.number, 'off');
                    }

                    this.log.info('stop ' + actor.name);
                }

                if (isOn) {

                    if (isDimmer === false) {
                        this.sendeHandsteuerungsBefehl(actor.number, actor.state === true ? 'up' : 'off');
                    } else if (isDimmer === true) {
                        if (actor.state === true) {

                            const lvl = id.replace('on', 'level');
                            this.setState(lvl, 100);
                        } else if (state.val === false) {
                            const lvl = id.replace('on', 'level');
                            this.setState(lvl, 0);

                        }
                    }

                    this.log.info('on '+ actor.name);

                }

                if (isLevel) {

                    const helper = id.replace('.level', '');
                    const no = helper.match(/\d*$/g);

                    this.sendeHandsteuerungsBefehl(no[0], state.val.toString());

                    this.log.info('level: ' + no[0] + ' ' + state.val);

                }


                if (isActivate && isScene) {
                    this.sendeSzenarioBefehl(actor.number);

                    this.log.info('activate '+actor.name );
                }

                if (isPercent) {
                    let pVal = parseInt(pPercent.exec(command)[0].replace("percent",""));
                    if (isShutter) {
                        if (this.checkNewerVersion()) {
                            this.sendeHandsteuerungsBefehl(actor.number, pVal.toString());
                        } else {
                            this.gotoShutterPosition(actor.number, pVal)();
                        }
                    } else if (isGroup) {
                        if (this.checkNewerVersion()) {
                            this.sendeHandsteuerungsBefehlToGroup(actor.number, pVal.toString());
                        } else {
                            this.gotoShutterPositionGroups(actor.number, pVal);
                        }
                    }

                    this.log.info('percent: ' + actor.number + ' ' + pVal);
                }

			if (isTilt) {
				let pVal = parseInt(pTilt.exec(command)[0].replace("tilt",""));
                this.log.info("TILT: "+actor.number+" "+actor.name+" "+pVal+" cmnd:"+pTilt.exec(command)[0]);

				if (isShutter) {
					if (this.checkNewerVersion()) {
						this.sendeHandsteuerungsBefehl(actor.number, 'up', pVal);
					} else {
						// not implemented for older versions
					}
				} else if (isGroup) {
					if (this.checkNewerVersion()) {
						this.sendeHandsteuerungsbefehlToGroup(actor.number,'up', pVal);
					} else {
						// not implemented for older versions
					}

				}
			}

		}

            //this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            //this.log.info(`state ${id} deleted`);
        }
    }

    checkNewerVersion() {
        return (controllerSoftwareVersion[0] === '8' && controllerSoftwareVersion >= '8.027o') ||
            (controllerSoftwareVersion[0] === '1' && controllerSoftwareVersion >= '1.014p');
    }

    checkShutterStatus() {
        return _.debounce(async () => {
            const intervalID = setInterval(() => {
                //client.send('sop');
                //client.send(newLine);
                this.send(['sop',newLine]);
            }, 5000);
            checkShutterStatusClearTimeoutHandler = setTimeout(() => {
                clearInterval(intervalID);
                this.triggerShutterMessage();
                this.triggerSensorMessage();
            }, 30000);
        }, 30000, {
            'leading': true,
            'trailing': false
        });
    }

    async sendeHandsteuerungsBefehlToGroup(groupdId, befehl, terminiereNach = 0) {
        //const shutterRefsState = await this.getStateAsync(`groups.${groupdId}.refs`);
        const shutterRefsState = this.getStates("group",groupId);
        //if (shutterRefsState && shutterRefsState.val) {
        if (shutterRefsState) {
            const shutters = shutterRefsState.val.split(',');
            shutters.forEach(rolladenId => {
                this.sendeHandsteuerungsBefehl(rolladenId, befehl, terminiereNach);
            });
        }
    }

    async waitForRunningCommandCallbacks() {
        while (runningCommandCallbacks) {
            await this.sleep(500);
        }
    }

    async sendeHandsteuerungsBefehl(rolladenId, befehl, terminiereNach = 0) {
        if (!this.connected) {
            this.log.error("⚠️ Connection lost. Reconnecting...");
            await this.connect();
        }
    
        this.log.info(`🔄 HandsteuerungsAusführung: ${rolladenId} ${befehl} ${terminiereNach}`);
    
        // Falls ein PIN erforderlich ist, zuerst authentifizieren
        if (this.config.pin) {
            this.send([
                "rsc", newLine,
                this.config.pin.toString(), newLine
            ]);
        }
    
        /**
         * 🏡 Handsteuerungsbefehl senden (Reihenfolge beachten, aber Ergebnis ignorieren)
         */
        this.send([
            "rhi", newLine, newLine,
            "rhb", newLine,
            String(rolladenId), newLine,
            String(befehl), newLine, newLine,
            "rhe", newLine, newLine
        ]);
    
        // Falls ein Terminierungszeitpunkt gesetzt ist, nach Ablauf "off" senden
        if (terminiereNach > 100) {
            setTimeout(() => {
                this.send([
                    "rhi", newLine, newLine,
                    "rhb", newLine,
                    String(rolladenId), newLine,
                    "off", newLine, newLine,
                    "rhe", newLine, newLine
                ]);
            }, terminiereNach);
        }
    
        this.triggerMessage(rolladenId, befehl);
        this.checkShutterStatus()();
    }
    

    sleep(milliseconds) {
        return new Promise(resolve => {
            sleepClearTimeoutHandler = setTimeout(resolve, milliseconds);
        });
    }

    async gotoShutterPositionGroups(groupdId, prozent) {
        const shutterRefsState = await this.getStateAsync(`groups.${groupdId}.refs`);
        if (shutterRefsState && shutterRefsState.val) {
            const shutters = shutterRefsState.val.split(',');
            shutters.forEach(rolladenId => {
                this.gotoShutterPosition(rolladenId, prozent)();
            });
        }
    }

    gotoShutterPosition(rolladenId, prozent) {
        return memoizeDebounce(async () => {
            this.log.debug(`Percent${rolladenId} ${prozent}`);
            // 100 = auf
            // 0 = zu
            const ziel = Number(prozent);

            if (ziel === 100) {
                this.sendeHandsteuerungsBefehl(rolladenId, 'up');
            } else if (ziel === 0) {
                this.sendeHandsteuerungsBefehl(rolladenId, 'down');
            } else {
                let status = actualPercents[String(rolladenId)];
                let aktuellePosition = Number(status);
                let direction = 'up';
                if (aktuellePosition > ziel) {
                    direction = 'down';
                } else if (aktuellePosition === ziel) {
                    direction = 'off';
                }

                this.sendeHandsteuerungsBefehl(rolladenId, direction);

                while ((direction === 'down' && aktuellePosition > ziel) || (direction === 'up' && aktuellePosition < ziel)) {
                    status = actualPercents[String(rolladenId)];
                    aktuellePosition = Number(status);
                    await this.sleep(100);
                }

                this.sendeHandsteuerungsBefehl(rolladenId, 'off');
            }
        }, 500);
    }

    async sendeRefreshBefehl() {
        const refreshBefehl = () => {
            runningCommandCallbacks = true;
    
            if (this.config.pin) {
                this.send([
                    "rsc", newLine,
                    this.config.pin.toString(), newLine
                ]);
            }
    
            this.send(["skd", newLine]);
            runningCommandCallbacks = false;
        };
    
        if (this.connected) {
            await this.waitForRunningCommandCallbacks();
            refreshBefehl();
        } else {
            if (!this.connecting) {
                this.log.warn("⚠️ Connection lost. Attempting reconnect...");
                this.disconnect(); // `this.client.disconnect();` wurde durch die Methode ersetzt
                this.connect();
            }
            commandCallbacks.push(refreshBefehl);
        }
    }
    
    async sendeSzenarioBefehl(rolladenId) {
        const szenarioAusfuehrung = () => {
            runningCommandCallbacks = true;
    
            if (this.config.pin) {
                this.send([
                    "rsc", newLine,
                    this.config.pin, newLine
                ]);
            }
    
            this.send([
                "rsa", newLine,
                rolladenId, newLine, newLine,
                "sop", newLine, newLine
            ]);
    
            runningCommandCallbacks = false;
        };
    
        if (this.connected) {
            await this.waitForRunningCommandCallbacks();
            szenarioAusfuehrung();
            this.checkShutterStatus()();
        } else {
            if (!this.connecting) {
                this.log.warn("⚠️ Connection lost. Attempting reconnect...");
                this.disconnect();
                this.connect();
            }
            commandCallbacks.push(szenarioAusfuehrung);
        }
    }
    
}


if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Heytech(options);
} else {
    // otherwise start the instance directly
    new Heytech();
}