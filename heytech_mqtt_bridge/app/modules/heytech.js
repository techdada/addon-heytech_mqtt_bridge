// @ts-nocheck
'use strict';

const _ = require('lodash');
const EventEmitter = require('events');
const net = require('net');
const TelnetStream = require("telnet-stream");


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




let controllerChannelCount;
let controllerSoftwareVersion;

let readSop = false;
let readSkd = false;
let readSmo = false;
let readSmc = false;
let readSfi = false;
let readSmn = false;



const actualPercents = {};




let start;

class Heytech extends EventEmitter { //extends utils.Adapter {


    constructor(options) {
        super();

        this.config = options.config;
        this.log = {};
        this.log.debug = () => {};
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

        this.socket = null; // telnet-stream
        this.telnet = null; // telnet-stream
        this.connected = false;
        this.connecting = false;
        this.reconnectDelay = 10000;
        this.reconnectTimeout = null;
        this.stopping = false;


        //temp variable for processIncomingData
        this.receivedBuffer = '';
        this.commandQueue = [];
        this.draining = false;
        this.pendingStops = new Map();
        this.sleepTimers = new Map();
        this.statusInterval = null;
        this.statusTimeout = null;

        const d = new Date();
        start = d.getTime();

        this.communicator = null;
    }


    async connect() {
        if (this.stopping || this.connected || this.connecting) return;
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
        this.connecting = true;
        try {
            this.disconnect();
            this.connecting = true;
            this.receivedBuffer = '';
            const socket = new net.Socket();
            this.socket = socket;
            this.telnet = new TelnetStream.TelnetSocket(socket);
            const fail = error => {
                if (this.socket === socket) this.onDisconnected(error);
            };
            socket.on('close', () => fail());
            socket.on('error', fail);
            this.telnet.on('error', fail);
            this.telnet.on('data', data => {
                if (this.socket !== socket || !this.connected) return;
                try {
                    this.processIncomingData(data.toString());
                } catch (error) {
                    this.log.error('Invalid Telnet response: ' + error.message);
                }
            });
            socket.connect(this.config.port, this.config.ip, () => {
                if (this.socket !== socket || this.stopping) return;
                this.connected = true;
                this.connecting = false;
                this.log.info('Connected to Telnet server');
                this.onConnected().catch(error => this.log.error('Telnet initialization: ' + error.message));
            });
            if (!this.refreshInterval) {
                this.refreshInterval = setInterval(() => {
                    this.sendeRefreshBefehl().catch(error => this.log.error('Refresh: ' + error.message));
                }, this.config.refresh || 300000);
            }
        } catch (error) {
            this.onDisconnected(error);
        }
    }

    disconnect() {
        const socket = this.socket;
        this.socket = null;
        this.telnet = null;
        this.connected = false;
        this.connecting = false;
        if (socket) socket.destroy();
    }

    send(cmd) {
        if (!this.telnet || !this.connected) return false;
        if (Array.isArray(cmd)) cmd = cmd.join('');
        try {
            this.telnet.write(cmd);
        } catch (error) {
            this.onDisconnected(error);
            throw error;
        }
        // Mask authentication only in the log; the transmitted bytes are unchanged.
        const logged = cmd.replace(/(rsc\r)[^\r]*(\r)/g, '$1[redacted]$2');
        this.log.debug('Sent: ' + logged);
        return true;
    }

    async onConnected() {
        const activeSocket = this.socket;
        // A timed movement interrupted by a lost connection must stop before new work.
        this.flushPendingStops();
        this.drainCommands();
        while (this.connected && this.socket === activeSocket && !this.stopping && !this.firstRunDone()) {
            await this.runCommand(() => {
                if (this.socket !== activeSocket) return;
                if (this.config.pin) this.send(['rsc\r', String(this.config.pin) + '\r']);
                this.send('\rsss\rsss\r');
                if (!readSmo) this.send('smo\r');
                this.send('sdt\r');
                if (!readSfi) this.send('sfi\r');
                if (!readSmc) this.send('smc\r');
                if (!readSmn) this.send('smn\r');
                if (!readSkd) this.send('skd\r');
            });
            await this.sleep(5000);
        }
    }

    runCommand(operation) {
        if (this.stopping) return Promise.reject(new Error('Bridge is stopping'));
        if (this.commandQueue.length >= 256) return Promise.reject(new Error('Command queue is full'));
        const result = new Promise((resolve, reject) => this.commandQueue.push({operation, resolve, reject}));
        if (this.connected) this.drainCommands();
        else if (this.reconnectTimeout === null) this.connect();
        return result;
    }

    async drainCommands() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.connected && !this.stopping && this.commandQueue.length) {
                const entry = this.commandQueue.shift();
                try {
                    this.flushPendingStops();
                    await entry.operation();
                    entry.resolve();
                } catch (error) {
                    entry.reject(error);
                }
                if (this.commandQueue.length) await this.sleep(500);
            }
        } catch (error) {
            this.log.error('Command queue failed: ' + error.message);
        } finally {
            this.draining = false;
        }
    }

    flushPendingStops() {
        for (const [id, movement] of this.pendingStops) {
            if (movement.socket === this.socket) continue;
            this.sendStop(id, true);
            this.pendingStops.delete(id);
        }
    }

    sendStop(id, authenticate = false) {
        if (!this.connected) throw new Error('Cannot send stop while disconnected');
        if (authenticate && this.config.pin !== '') this.send(['rsc\r', String(this.config.pin), '\r']);
        if (!this.send(['rhi\r\r', 'rhb\r', String(id), '\r', 'off', '\r\r', 'rhe\r\r'])) {
            throw new Error('Stop was not sent');
        }
    }
    
    onDisconnected(error = null) {
        this.clearStatusPolling();
        this.connected = false;
        this.connecting = false;
        this.receivedBuffer = '';
        if (error) this.log.error('Telnet disconnect: ' + error.message);
        if (!this.stopping && this.reconnectTimeout === null) {
            this.reconnectTimeout = setTimeout(() => {
                this.reconnectTimeout = null;
                this.connect();
            }, this.reconnectDelay);
        }
    }
    
    firstRunDone() {
        const result = readSop && readSkd && readSmo && readSmc && readSfi && readSmn;
        this.log.debug('First run done?: '+(result));
        if (!result) {
            this.log.debug('read: Sop:' + readSop + ' Skd: ' + readSkd + ' Smo: ' + readSmo + ' Smc: ' + readSmc + ' Sfi: ' + readSfi + ' Smn: ' + readSmn);
        } else {
            this.log.debug(JSON.stringify(this.config.shutter));
            this.log.debug(JSON.stringify(this.config.group));
            this.log.debug(JSON.stringify(this.config.scene));
            this.log.debug(JSON.stringify(this.config.sensor));
            this.triggerSensorMessage();
            this.triggerShutterMessage();
        }
        return result;
    }

    processIncomingData(data) {
        this.receivedBuffer += data;
        while (true) {
            const start = /start_(smn|sop|skd|smo|smc|sfi)/.exec(this.receivedBuffer);
            if (!start) {
                this.receivedBuffer = this.receivedBuffer.slice(-9);
                return;
            }
            this.receivedBuffer = this.receivedBuffer.slice(start.index);
            const endMarker = 'ende_' + start[1];
            // SMN is a streamed inventory. Preserve the original completion boundary:
            // the controller must have moved on to STI before we commit its channels.
            const inventoryEnd = start[1] === 'smn'
                ? /ende_smn\s*start_sti/.exec(this.receivedBuffer) : null;
            const end = start[1] === 'smn'
                ? (inventoryEnd ? inventoryEnd.index : -1)
                : this.receivedBuffer.indexOf(endMarker, start[0].length);
            const next = /start_(smn|sop|skd|smo|smc|sfi)/.exec(this.receivedBuffer.slice(start[0].length));
            if (start[1] !== 'smn' && next && (end < 0 || start[0].length + next.index < end)) {
                this.log.warn('Incomplete Telnet frame discarded');
                this.receivedBuffer = this.receivedBuffer.slice(start[0].length + next.index);
                continue;
            }
            if (end < 0) {
                if (this.receivedBuffer.length > 65536) {
                    this.log.warn('Oversized Telnet frame discarded');
                    this.receivedBuffer = this.receivedBuffer.slice(-9);
                }
                return;
            }
            const frame = this.receivedBuffer.slice(0, end + endMarker.length);
            this.receivedBuffer = this.receivedBuffer.slice(inventoryEnd
                ? end + inventoryEnd[0].length : end + endMarker.length);
            if (frame.length > 65536) {
                this.log.warn('Oversized Telnet frame discarded');
                continue;
            }
            try {
                this.processFrame(frame);
            } catch (error) {
                this.log.warn('Invalid Telnet frame: ' + error.message);
            }
        }
    }

    processFrame(lastStrings) {
        // 🏡 Rolladen-Status auslesen
        if (!readSmn && lastStrings.includes(START_SMN)) {
            // Match individual records even when the controller separates them with CR only.
            const channels = lastStrings.match(/\d{2},[^,\r\n]*,\d,/g);
            if (!channels) throw new Error('Invalid SMN channel list');
            this.writeOutputs(channels);
            readSmn = true;
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
            if (klimadaten.length < 16 || klimadaten.slice(0, 16).some(value => value.trim() === '' || !Number.isFinite(Number(value)))) {
                throw new Error('Invalid climate data');
            }
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
                        that.updateInventory('device',number,{
                                "number": number,
                                "name": channel[1].trim(),
                                "state": 0
                        });
                    } else if (dimmer === true) {
                        that.updateInventory('device',number,{
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

        this.getStates('sensor', (err, states) => {
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
                            vTo = String(states[st]['state']).replace(',','.');
                            break;
                        case 'bri_average_byte':
                            vBriAv = states[st]['state'];
                            break;
                        case 'bri_actual_sensor_byte':
                            vBriAc = states[st]['state'];
                            break;
                    }
                }

            }

            if (vBriAc !== data[0]) {
                this.updateInventory('sensor','bri_actual',{
                    name: "Actual brightness",
                    state: parseInt(data[0]),
                    unit: 'Lux'
                });
                this.updateInventory('sensor','bri_actual_hey',{
                    name: "Actual brightness as in Heytech App",
                    state: parseInt(data[0]),
                    unit: 'Lux'
                });
                this.updateInventory('sensor','bri_actual_sensor_byte',{
                    name: "Actual brightness as byte from sensor",
                    state: parseInt(data[0]),
                    unit: 'Byte'
                });

                if (!data || !Array.isArray(data) || data.length === 0) {
                    this.log.error("❌ `data` is undefined or empty in `writeKlima()`");
                } else {
                    const resultLuxCustom = this.calculateLuxValueCustom(data[0]);
                
                    if (resultLuxCustom > 0) {
                        this.setState('sensor','bri_actual', resultLuxCustom);
                    }

                    const resultLuxHeytech = this.calculateLuxValueBasedOnHeytech(data[0]);
                    if (resultLuxHeytech > 0) {
                        this.setState('sensor','bri_actual_hey', resultLuxHeytech);
                    }
                }

            }
            if (vBriAv !== data[14]) {
                this.updateInventory('sensor','bri_average',{
                    name: 'Average brightness',
                    unit: 'lux',
                    state: parseInt(data[14])
                });
                const resultLuxHeytech = this.calculateLuxValueBasedOnHeytech(data[14]);
                if (resultLuxHeytech > 0) {
                    this.updateInventory('sensor','bri_average_hey',{
                        name: 'Average brightness as in Heytech App',
                        unit: 'lux',
                        state: resultLuxHeytech
                    });
                }
                this.updateInventory('sensor','bri_average_byte',{
                    name: 'Average brightness as byte from sensor',
                    unit: 'Byte',
                    state: parseInt(data[14])
                });

                const resultLuxCustom = this.calculateLuxValueCustom(data[14]);
                if (resultLuxCustom > 0) {
                    this.setState('sensor','bri_average', resultLuxCustom);
                }
            }

            if (data[1] !== '999') {
                if (vTi !== data[1] + '.' + data[2]) {
                    this.updateInventory('sensor','temp_indoor',{
                        name: 'Indoor temperature',
                        type: 'number',
                        unit: '°C',
                        state: data[1] + '.' + data[2]
                    });
                }
                if (vTiMin !== data[3]) {
                    this.updateInventory('sensor','temp_indoor_min',{
                        name: 'Indoor temperature minimum',
                        type: 'number',
                        unit: '°C',
                        state: data[3]
                    });
                }
                if (vTiMax !== data[4]) {
                    this.updateInventory('sensor','temp_indoor_max',{
                        name: 'Indoor temperature maximum',
                        type: 'number',
                        unit: '°C',
                        state: Number(data[4])
                    });
                }
            }

            if (data[5] !== '999') {
                if (vTo !== data[5] + '.' + data[6]) {
                    this.updateInventory('sensor','temp_outdoor',{
                        name: 'Outdoor temperature',
                        type: 'number',
                        unit: '°C',
                        state: data[5]+'.'+data[6]
                    });

                }
                if (vToMin !== data[7]) {
                    this.updateInventory('sensor','temp_outdoor_min',{
                        name: 'Outdoor temperature minimum',
                        type: 'number',
                        unit: '°C',
                        state: Number(data[7])
                    });
                }
                if (vToMax !== data[8]) {
                    this.updateInventory('sensor','temp_outdoor_max',{
                        name: 'Outdoor temperature maximum',
                        type: 'number',
                        unit: '°C',
                        state: Number(data[8])
                    });
                }
            }

            if (vWindA !== data[9]) {
                this.updateInventory('sensor','wind_actual',{
                    name: 'Actual wind speed',
                    type: 'number',
                    unit: 'km/h',
                    state: Number(data[9])
                });
            }
            if (vWindM !== data[10]) {
                this.updateInventory('sensor','wind_maximum',{
                    name: 'Maximum wind speed',
                    unit: 'km/h',
                    state: Number(data[10])
                });
            }

            if (vAlarm !== data[11]) {
                this.updateInventory('sensor','alarm',{
                    name: 'Alarm',
                    state: (data[11] == 1)
                });
            }

            if (vRain !== data[12]) {
                this.updateInventory('sensor','rain',{
                    name: 'Rain',
                    state: (data[12] == 1)
                });
            }

            if (data[15] !== '999' && data[15] !== '0') {
                if (vHumidity !== data[15]) {
                    this.updateInventory('sensor','humidity',{
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
                this.log.error("invalid sensor: "+id);
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

    getInventoryObject(section, nameid) {
        if (!['shutter', 'scene', 'device', 'dimmer', 'group'].includes(section)) return undefined;
        const inventory = this.config[section === 'dimmer' ? 'device' : section];
        if (!inventory || typeof nameid !== 'string') return undefined;
        // Preserve the original last-match behavior for duplicate configured names.
        const found = Object.entries(inventory).filter(([key, value]) =>
            key === nameid || value.name === nameid).pop()?.[1];
        if (!found || (section === 'dimmer' && !found.dimmer)) return undefined;
        if (/([0-9]+ LEER)|(Motor [0-9]+)/.test(found.name)) return undefined;
        return found;
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
            if (attributes.dimmer !== undefined) {
                if (!this.config.device[id]) this.config.device[id] = {};
                this.config.device[id].dimmer = attributes.dimmer;
            }
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
    onUnload(callback = () => {}) {
        this.stopping = true;
        clearTimeout(this.reconnectTimeout);
        clearInterval(this.refreshInterval);
        this.clearStatusPolling();
        for (const entry of this.commandQueue.splice(0)) entry.reject(new Error('Bridge stopped'));
        // Stop active timed movements while the connection is still available.
        for (const id of this.pendingStops.keys()) {
            try { this.sendStop(id); } catch (error) { this.log.error(error.message); }
        }
        this.disconnect();
        for (const [timer, resolve] of this.sleepTimers) { clearTimeout(timer); resolve(); }
        this.sleepTimers.clear();
        callback();
    }

    /**
     * Is called if a message appears
     * @param {string} id
     * @param {string} state
     */
    async onMessage(id, command) {
        try {
            if (Date.now() - start <= 10000 || !readSmn) return;
            if (typeof id !== 'string') return;
            const actorId = id.split('.');
            if (actorId[0] === 'group') {
                this.log.warn('Software group command ignored: ' + id);
                return;
            }
            const actor = this.getInventoryObject(actorId[0], actorId[1]);
            if (!actor) { this.log.warn('Invalid device: ' + id); return; }
            if (Buffer.isBuffer(command)) command = command.toString();
            let value;
            if (command && typeof command === 'object' && !Array.isArray(command)) {
                value = command.val !== undefined ? command.val : command.value;
                command = command.action;
            }
            if (command === undefined) command = actorId.slice(2).join('.');
            if (typeof command !== 'string') return;
            const action = command.trim();
            const shutter = actorId[0] === 'shutter';
            const dimmer = actorId[0] === 'dimmer';
            const percent = /^(\d+)percent$/.exec(action);
            const tilt = /^tilt(\d{3,4})$/.exec(action);
            if (shutter && ['up', 'down', 'stop'].includes(action)) {
                await this.sendeHandsteuerungsBefehl(actor.number, action === 'stop' ? 'off' : action);
            } else if (actorId[0] === 'scene' && action === 'activate') {
                await this.sendeSzenarioBefehl(actor.number);
            } else if (shutter && percent) {
                const target = Number(percent[1]);
                if (target > 100) { this.log.warn('Invalid percentage: ' + action); return; }
                if (this.checkNewerVersion()) await this.sendeHandsteuerungsBefehl(actor.number, String(target));
                else this.gotoShutterPosition(actor.number, target)();
            } else if (shutter && tilt) {
                if (this.checkNewerVersion()) await this.sendeHandsteuerungsBefehl(actor.number, 'up', Number(tilt[1]));
            } else if (action === 'level') {
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
                    this.log.warn('level requires a numeric val/value between 0 and 100');
                    return;
                }
                if (shutter || dimmer) await this.sendeHandsteuerungsBefehl(actor.number, String(value));
            } else if (action === 'on') {
                if (dimmer) {
                    if (value === undefined) value = true;
                    if (typeof value !== 'boolean') return;
                    await this.sendeHandsteuerungsBefehl(actor.number, value ? '100' : '0');
                } else if (actorId[0] === 'device' || shutter) {
                    await this.sendeHandsteuerungsBefehl(actor.number, actor.state === true ? 'up' : 'off');
                }
            } else {
                this.log.warn('Unsupported command: ' + action);
            }
        } catch (error) {
            this.log.error('Command failed: ' + error.message);
        }
    }

    checkNewerVersion() {
        return typeof controllerSoftwareVersion === 'string' && ((controllerSoftwareVersion[0] === '8' && controllerSoftwareVersion >= '8.027o') ||
            (controllerSoftwareVersion[0] === '1' && controllerSoftwareVersion >= '1.014p'));
    }

    checkShutterStatus() {
        return () => {
            if (this.statusInterval !== null || !this.connected || this.stopping) return;
            this.statusInterval = setInterval(() => {
                try { this.send('sop\r'); } catch (error) { this.onDisconnected(error); }
            }, 5000);
            this.statusTimeout = setTimeout(() => {
                this.clearStatusPolling();
                this.triggerShutterMessage();
                this.triggerSensorMessage();
            }, 30000);
        };
    }

    clearStatusPolling() {
        clearInterval(this.statusInterval);
        clearTimeout(this.statusTimeout);
        this.statusInterval = null;
        this.statusTimeout = null;
    }

    async sendeHandsteuerungsBefehlToGroup() {
        this.log.warn('Software groups are disabled');
    }


    async sendeHandsteuerungsBefehl(rolladenId, befehl, terminiereNach = 0) {
        if (!Number.isInteger(Number(rolladenId)) || Number(rolladenId) < 1 || Number(rolladenId) > 69) throw new Error('Invalid channel');
        if (!['up', 'down', 'off'].includes(String(befehl)) &&
            (!/^(?:100|[0-9]{1,2})(?:\.\d+)?$/.test(String(befehl)) || Number(befehl) > 100)) throw new Error('Invalid movement');
        if (!Number.isFinite(terminiereNach) || terminiereNach < 0 || terminiereNach > 9999) throw new Error('Invalid duration');
        return this.runCommand(async () => {
            let movement;
            if (terminiereNach > 100) {
                movement = {socket: this.socket};
                this.pendingStops.set(rolladenId, movement);
            }
            try {
                if (this.config.pin !== '') this.send(['rsc\r', this.config.pin.toString(), '\r']);
                if (!this.send(['rhi\r\r', 'rhb\r', String(rolladenId), '\r', String(befehl), '\r\r', 'rhe\r\r'])) throw new Error('Movement was not sent');
                if (movement) {
                    await this.sleep(terminiereNach);
                    if (this.pendingStops.get(rolladenId) === movement) {
                        if (this.connected) {
                            this.sendStop(rolladenId, movement.socket !== this.socket);
                            this.pendingStops.delete(rolladenId);
                        } else {
                            this.log.warn('Tilt stop pending until Telnet reconnect: ' + rolladenId);
                        }
                    }
                }
                this.checkShutterStatus()();
            } catch (error) {
                if (movement && this.connected) {
                    try { this.sendStop(rolladenId); this.pendingStops.delete(rolladenId); } catch (_) { /* retry after reconnect */ }
                }
                throw error;
            }
        });
    }
    

    sleep(milliseconds) {
        if (this.stopping) return Promise.resolve();
        return new Promise(resolve => {
            const timer = setTimeout(() => { this.sleepTimers.delete(timer); resolve(); }, milliseconds);
            this.sleepTimers.set(timer, resolve);
        });
    }

    async gotoShutterPositionGroups() {
        this.log.warn('Software groups are disabled');
    }

    gotoShutterPosition(rolladenId, prozent) {
        return _.debounce(() => {
            const position = async () => {
                const ziel = Number(prozent);
                if (!Number.isFinite(ziel) || ziel < 0 || ziel > 100) throw new Error('Invalid position');
                if (ziel === 100 || ziel === 0) {
                    await this.sendeHandsteuerungsBefehl(rolladenId, ziel === 100 ? 'up' : 'down');
                    return;
                }
                let aktuellePosition = actualPercents[String(rolladenId)];
                if (!Number.isFinite(aktuellePosition)) throw new Error('No current shutter position');
                const direction = aktuellePosition > ziel ? 'down' : aktuellePosition < ziel ? 'up' : 'off';
                await this.sendeHandsteuerungsBefehl(rolladenId, direction);
                const deadline = Date.now() + 120000;
                while ((direction === 'down' && aktuellePosition > ziel) || (direction === 'up' && aktuellePosition < ziel)) {
                    if (this.stopping || !this.connected || Date.now() >= deadline) {
                        this.pendingStops.set(rolladenId, {socket: null});
                        if (this.connected) this.flushPendingStops();
                        return;
                    }
                    aktuellePosition = actualPercents[String(rolladenId)];
                    await this.sleep(100);
                }
                await this.sendeHandsteuerungsBefehl(rolladenId, 'off');
            };
            position().catch(error => this.log.error('Positioning failed: ' + error.message));
        }, 500);
    }

    async sendeRefreshBefehl() {
        // Keep at most one refresh waiting during an outage.
        if (this.refreshPending) return;
        this.refreshPending = true;
        try {
            await this.runCommand(() => {
                if (this.config.pin) this.send(['rsc\r', String(this.config.pin) + '\r']);
                this.send('skd\r');
            });
        } finally { this.refreshPending = false; }
    }
    
    async sendeSzenarioBefehl(rolladenId) {
        return this.runCommand(() => {
            if (this.config.pin) this.send(['rsc\r', String(this.config.pin) + '\r']);
            this.send(['rsa\r', String(rolladenId) + '\r\r', 'sop\r\r']);
            this.checkShutterStatus()();
        });
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
