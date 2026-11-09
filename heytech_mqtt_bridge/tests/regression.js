'use strict';

// No broker, controller, installed dependencies, or real timers required.
async function runTests(sources) {
    let passed = 0;
    function assert(value, message) { if (!value) throw new Error(message); }
    function equal(actual, expected, message) {
        assert(JSON.stringify(actual) === JSON.stringify(expected), message + ': ' + JSON.stringify(actual));
    }
    class Emitter {
        constructor() { this.events = new Map(); }
        on(name, fn) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(fn); return this; }
        emit(name, ...args) { for (const fn of this.events.get(name) || []) fn(...args); return true; }
    }
    const microtasks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    function harness() {
        let now = 0, next = 0;
        const timers = new Map(), writes = [], logs = [], sockets = [];
        const schedule = (fn, delay, repeat = false) => {
            const id = ++next; timers.set(id, {fn, at: now + delay, delay, repeat}); return id;
        };
        async function advance(ms) {
            const target = now + ms;
            await microtasks();
            while (true) {
                const entry = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!entry) break;
                const [id, timer] = entry;
                now = timer.at;
                if (timer.repeat) timer.at += timer.delay; else timers.delete(id);
                timer.fn();
                await microtasks();
            }
            now = target;
            await microtasks();
        }
        class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
        class Socket extends Emitter {
            constructor() { super(); sockets.push(this); }
            connect(port, host, fn) { this.open = fn; }
            destroy() { this.destroyed = true; }
        }
        class Telnet extends Emitter { write(bytes) { writes.push(bytes); } }
        const module = {parent: true, exports: {}};
        const lodash = {
            memoize(fn) { let value; return () => value || (value = fn()); },
            debounce(fn, delay) { return (...args) => schedule(() => fn(...args), delay); }
        };
        new Function('require', 'module', 'Buffer', 'Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', sources.heytech)(
            name => ({lodash, events: Emitter, net: {Socket}, 'telnet-stream': {TelnetSocket: Telnet}}[name]),
            module, Buffer, Clock, (fn, ms) => schedule(fn, ms), id => timers.delete(id),
            (fn, ms) => schedule(fn, ms, true), id => timers.delete(id));
        const bridge = module.exports({config: {host: 'controller', port: 3200, pin: '1234', debug: 'off'}});
        bridge.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, text => logs.push(String(text))]));
        function online() {
            bridge.socket = new Socket(); bridge.telnet = new Telnet(); bridge.connected = true; bridge.connecting = false;
        }
        return {bridge, timers, writes, logs, sockets, advance, online};
    }
    async function test(name, fn) { await fn(); passed++; }

    await test('ordinary command, scene and refresh preserve bytes', async () => {
        const h = harness(); h.online();
        await h.bridge.sendeHandsteuerungsBefehl(7, 'up');
        await h.bridge.sendeSzenarioBefehl(65);
        await h.bridge.sendeRefreshBefehl();
        equal(h.writes, ['rsc\r1234\r', 'rhi\r\rrhb\r7\rup\r\rrhe\r\r',
            'rsc\r1234\r', 'rsa\r65\r\rsop\r\r', 'rsc\r1234\r', 'skd\r'], 'wire bytes');
    });
    await test('tilt waits exactly the requested timer delay', async () => {
        const h = harness(); h.online();
        const movement = h.bridge.sendeHandsteuerungsBefehl(7, 'up', 350);
        await h.advance(349); equal(h.writes.length, 2, 'no early stop');
        await h.advance(1); await movement;
        equal(h.writes[2], 'rhi\r\rrhb\r7\roff\r\rrhe\r\r', 'stop bytes');
    });
    await test('tilt stop is sent before new work after reconnect', async () => {
        const h = harness(); h.online();
        const movement = h.bridge.sendeHandsteuerungsBefehl(7, 'up', 350);
        await h.advance(100); h.bridge.onDisconnected();
        await h.advance(250); await movement;
        equal(h.bridge.pendingStops.size, 1, 'remember stop');
        h.online(); h.bridge.firstRunDone = () => true;
        await h.bridge.onConnected();
        await h.bridge.sendeHandsteuerungsBefehl(8, 'down');
        equal(h.writes.slice(2), ['rsc\r1234\r', 'rhi\r\rrhb\r7\roff\r\rrhe\r\r',
            'rsc\r1234\r', 'rhi\r\rrhb\r8\rdown\r\rrhe\r\r'], 'stop priority');
        equal(h.bridge.pendingStops.size, 0, 'stop cleared');
    });
    await test('early reconnect stops once and does not stop a later command', async () => {
        const h = harness(); h.online();
        const movement = h.bridge.sendeHandsteuerungsBefehl(7, 'up', 350);
        await h.advance(100); h.bridge.onDisconnected(); h.online();
        h.bridge.firstRunDone = () => true; await h.bridge.onConnected();
        await h.advance(250); await movement;
        equal(h.writes.filter(x => x.includes('\roff\r')).length, 1, 'single stop');
    });
    await test('single reconnect timer after error plus close', async () => {
        const h = harness(); await h.bridge.connect(); const original = h.bridge.socket;
        await h.bridge.connect(); equal(h.sockets.length, 1, 'one pending connection');
        original.emit('error', new Error('offline')); original.emit('close');
        equal([...h.timers.values()].filter(x => x.delay === 10000).length, 1, 'one retry');
        await h.advance(9999); equal(h.sockets.length, 1, 'not early');
        await h.advance(1); equal(h.sockets.length, 2, 'retry after ten seconds');
        assert(original.destroyed, 'old socket destroyed');
    });
    await test('split and coalesced Telnet frames', async () => {
        const h = harness(); const input = 'start_smn01,Living,1,\r\nende_smn\r\nstart_sti' +
            'start_smc1ende_smcstart_sop75,ende_sopstart_smoHEYtech RSende_smostart_sfi8.027oende_sfi';
        for (const byte of input) h.bridge.processIncomingData(byte);
        equal(h.bridge.config.shutter[1].state, 75, 'position');
        assert(h.bridge.checkNewerVersion(), 'firmware');
        equal(h.bridge.config.typ, 'RS', 'model');
        h.bridge.processIncomingData('start_sop30,ende_sopstart_sop40,ende_sop');
        equal(h.bridge.config.shutter[1].state, 40, 'both frames consumed');
    });
    await test('oversized and malformed frames cannot block valid following frames', async () => {
        const h = harness(); h.bridge.processIncomingData('start_smn' + 'x'.repeat(70000));
        assert(h.bridge.receivedBuffer.length <= 9, 'bounded buffer');
        h.bridge.processIncomingData('start_smninvalidende_smnstart_smoHEYtech RSende_smo');
        equal(h.bridge.config.typ, 'RS', 'valid frame after invalid');
        assert(h.logs.some(x => x.includes('Invalid Telnet frame')), 'invalid frame logged');
        h.bridge.processIncomingData('start_smnincomplete' + 'start_smoHEYtech Nextende_smo');
        equal(h.bridge.config.typ, 'Next', 'resynchronize after incomplete frame');
    });
    await test('valid channel inventory larger than the former 2048-character limit', async () => {
        const h = harness();
        const rows = Array.from({length: 32}, (_, i) => String(i + 1).padStart(2, '0') + ',' + 'Living'.repeat(15) + ',1,\r\n').join('');
        assert(rows.length > 2048, 'fixture exercises former limit');
        h.bridge.processIncomingData('start_smn' + rows + 'ende_smn');
        equal(Object.keys(h.bridge.config.shutter).length, 32, 'all channels parsed');
    });
    await test('unknown devices and prototype names are rejected', async () => {
        const h = harness();
        equal(h.bridge.getInventoryObject('shutter', 'missing'), undefined, 'missing');
        equal(h.bridge.getInventoryObject('__proto__', 'constructor'), undefined, 'prototype');
        equal(h.bridge.getInventoryObject('shutter', 'constructor'), undefined, 'inherited entry');
        h.bridge.config.shutter = {1: {name: 'Living', number: 1}, 2: {name: 'Living', number: 2}};
        equal(h.bridge.getInventoryObject('shutter', 'Living').number, 2, 'original duplicate-name behavior');
    });
    await test('initialization preserves command order and CR bytes', async () => {
        const h = harness(); h.online(); let checks = 0;
        h.bridge.firstRunDone = () => ++checks > 1;
        const initialization = h.bridge.onConnected();
        await h.advance(5000); await initialization;
        equal(h.writes, ['rsc\r1234\r', '\rsss\rsss\r', 'smo\r', 'sdt\r', 'sfi\r', 'smc\r', 'smn\r', 'skd\r'], 'initial protocol sequence');
    });
    await test('command validation and JSON level values', async () => {
        const h = harness(); h.bridge.processIncomingData('start_smn01,Living,1,\r\nende_smnstart_sfi8.027oende_sfi');
        await h.advance(10001); const commands = [];
        h.bridge.sendeHandsteuerungsBefehl = async (...args) => commands.push(args);
        await h.bridge.onMessage('shutter.1', 'updown');
        await h.bridge.onMessage('shutter.1', '101percent');
        await h.bridge.onMessage('shutter.missing', 'up');
        await h.bridge.onMessage('group.1', 'up');
        equal(commands.length, 0, 'invalid commands ignored');
        await h.bridge.onMessage('shutter.1', {action: 'level', val: 42});
        await h.bridge.onMessage('shutter.1', {action: 'level', value: 23});
        await h.bridge.onMessage('shutter.1', '50percent');
        await h.bridge.onMessage('shutter.1.down');
        equal(commands, [[1, '42'], [1, '23'], [1, '50'], [1, 'down']], 'accepted commands');
        h.bridge.sendeHandsteuerungsBefehl = async () => { throw new Error('test failure'); };
        await h.bridge.onMessage('shutter.1', 'up');
        assert(h.logs.some(x => x.includes('test failure')), 'async error caught');
    });
    await test('status polling starts only once and clears on disconnect', async () => {
        const h = harness(); h.online();
        for (let i = 0; i < 10; i++) h.bridge.checkShutterStatus()();
        equal([...h.timers.values()].filter(x => x.repeat).length, 1, 'one interval');
        await h.advance(5000); equal(h.writes, ['sop\r'], 'one query');
        h.bridge.onDisconnected();
        equal([...h.timers.values()].filter(x => x.repeat).length, 0, 'interval removed');
    });
    await test('climate values reach sensor inventory', async () => {
        const h = harness(); h.bridge.writeKlima(['37', '20', '5', '18', '24', '12', '3', '9', '15', '4', '8', '0', '0', '0', '37', '50']);
        equal(h.bridge.config.sensor.temp_outdoor.state, '12.3', 'temperature');
        equal(h.bridge.config.sensor.wind_actual.state, 4, 'wind');
        h.bridge.writeKlima(['37', '20', '5', '18', '24', '12', '3', '9', '15', '4', '8', '0', '0', '0', '37', '50']);
    });
    await test('PIN masking changes logs only', async () => {
        const h = harness(); h.online(); await h.bridge.sendeHandsteuerungsBefehl(1, 'up');
        equal(h.writes[0], 'rsc\r1234\r', 'actual authentication');
        assert(h.logs.every(x => !x.includes('1234')), 'PIN never logged');
        assert(h.logs.some(x => x.includes('[redacted]')), 'mask present');
    });
    await test('failed queue entry does not block later work', async () => {
        const h = harness(); h.online(); let ran = false;
        const failed = h.bridge.runCommand(() => { throw new Error('test'); }).catch(() => {});
        const next = h.bridge.runCommand(() => { ran = true; });
        await h.advance(500); await Promise.all([failed, next]); assert(ran, 'queue continued');
    });
    await test('queue and movement input bounds', async () => {
        const h = harness(); let rejected = 0;
        for (const args of [[1, '101'], [1, '100.5'], [1, 'up\rrhb'], [1, 'up', 10000]]) {
            try { await h.bridge.sendeHandsteuerungsBefehl(...args); } catch (_) { rejected++; }
        }
        equal(rejected, 4, 'invalid inputs rejected');
        const pending = [];
        for (let i = 0; i < 256; i++) pending.push(h.bridge.runCommand(() => {}).catch(() => {}));
        try { await h.bridge.runCommand(() => {}); } catch (_) { rejected++; }
        equal(rejected, 5, 'queue bounded'); h.bridge.onUnload(); await Promise.all(pending);
    });
    await test('shutdown stops active tilt and removes timers', async () => {
        const h = harness(); h.online(); const move = h.bridge.sendeHandsteuerungsBefehl(1, 'up', 350);
        await microtasks(); h.bridge.onUnload(); await move;
        assert(h.writes.some(x => x.includes('\roff\r')), 'shutdown stop');
        equal(h.timers.size, 0, 'no remaining timers');
    });
    await test('legacy positioning has a finite deadline and requests stop', async () => {
        const h = harness(); h.online();
        h.bridge.processIncomingData('start_smn01,Living,1,\r\nende_smnstart_sop90,ende_sop');
        h.bridge.gotoShutterPosition(1, 50)();
        await h.advance(120600);
        assert(h.writes.some(x => x.includes('\rdown\r')), 'movement');
        assert(h.writes.some(x => x.includes('\roff\r')), 'deadline stop');
    });
    await test('MQTT parsing, handler errors and reconnect independence', async () => {
        const client = new Emitter(), eventHandler = new Emitter(); let connects = 0, ready = 0, delivered = 0;
        client.publish = () => {}; client.subscribe = () => {}; eventHandler.setCommunicator = () => {};
        eventHandler.on('ready', () => ready++);
        eventHandler.on('message', () => { delivered++; throw new Error('bad handler'); });
        const module = {exports: {}};
        new Function('require', 'module', sources.mqtt)(name => ({mqtt: {connect() { connects++; return client; }}, fs: {}, events: Emitter}[name]), module);
        const mqtt = new module.exports({handler: eventHandler, config: {host: 'broker', control_topic_root: 'cmd', state_topic_root: 'state'}});
        mqtt.log = {warn() {}, error() {}, info() {}};
        mqtt.connect(); client.emit('connect'); client.emit('error', new Error('offline')); client.emit('connect'); mqtt.connect();
        equal([connects, ready], [1, 0], 'independent reconnect');
        mqtt.processMessage('cmd/shutter.1', Buffer.from('{"action":"up"}'));
        equal(delivered, 1, 'failed handler never retried');
        mqtt.processMessage('cmd/shutter.1', Buffer.from('x'.repeat(4097)));
        mqtt.processMessage('cmd/shutter.1', Buffer.from('null'));
        equal(delivered, 1, 'invalid payload rejected');
    });
    return passed;
}

module.exports = runTests;
if (require.main === module) {
    const fs = require('fs');
    const path = require('path');
    runTests({
        heytech: fs.readFileSync(path.join(__dirname, '../app/modules/heytech.js'), 'utf8'),
        mqtt: fs.readFileSync(path.join(__dirname, '../app/modules/MqttHandler.js'), 'utf8')
    }).then(count => console.log(count + ' regression tests passed')).catch(error => { console.error(error); process.exitCode = 1; });
}
