const MqttHandler = require('./modules/MqttHandler.js');

const Heytech = require('./modules/heytech.js')({
    "config":{
        "host": process.env.heyhost,
        "port": process.env.heyport,
        "pin": process.env.heypin,
        "debug": process.env.debug
    }
});


let mqttHandler = new MqttHandler({
    "config": {
        "host": process.env.mqtthost,
        "port": process.env.mqttport,
        "user": process.env.mqttuser,
        "pass": process.env.mqttpass,
        "cafile": process.env.mqttcafile,
        "control_topic_root": process.env.control_topic_root,
        "state_topic_root": process.env.state_topic_root,
        "debug": process.env.debug
    },
    "handler": Heytech
});


mqttHandler.connect();
Heytech.emit('ready');

let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    Heytech.onUnload(() => {
        if (mqttHandler.mqttClient) mqttHandler.mqttClient.end(true);
    });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
